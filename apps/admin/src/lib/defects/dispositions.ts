import "server-only";
import { eq } from "drizzle-orm";
import {
  accessories,
  DEFECT_DISPOSAL_TYPES,
  defectMovements,
  fabricColors,
  fabrics,
  productionBatches,
  productionBatchItems,
  products,
  productVariants,
  purchaseItems,
  purchases,
  type DefectDisposalType,
  type ProductionReceiptStatus,
  type PurchaseStatus,
} from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { lockAccessoryForUpdate, lockFabricForUpdate } from "@/lib/inventory/db";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { lockProductionBatchForUpdate } from "@/lib/production/db";
import { batchStatusAfterReceiptChange } from "@/lib/production/receipt-status";
import { formatPurchaseQty, getLineProgress, getLineQuantities, hasAtMostTwoDecimals, lockPurchaseForUpdate } from "@/lib/purchases/queries";
import { statusAfterReceiptChange, TERMINAL_PURCHASE_STATUSES } from "@/lib/purchases/status";
import { getBatchLineProgress, getBatchQuantitiesByLine } from "@/lib/receipts/production";
import { toCentiQty } from "@/lib/receipts/valuation";
import { lockVariantForUpdate } from "@/lib/stock/db";
import { DEFECT_MOVEMENT_TYPE_LABELS } from "./labels";
import { getLineDefectTotals, type DefectItemRef, type DefectSourceLine } from "./queries";
import { lineOutflowValue } from "./valuation";

// Defect dispositions (docs/plans/suppliers-goods-receipt.md §5, D15/D16/D18/D24/D29, session S6):
// returning defects to the supplier/tailor for a replacement, releasing them ("Pelepasan": Lelang,
// Hibah, Dibuang/Dimusnahkan), and reversing either by copy-and-negate (D8). All need
// inventory.manage (D10), checked by the server actions.
//
// Every write takes §5's shared lock order: the source DOCUMENT row first (purchases /
// production_batches, the same lock every receipt and receipt reversal takes, so a disposition can
// never interleave with a receipt or with reverseRejectsInTx's "no live disposition" check), then
// the ITEM row (fabric / accessory / variant, the same lock the sellable path takes), and only then
// reads the line's held quantity and defect value.
//
// Valuation (§4.2, §10 R1): an outflow is valued at its SOURCE LINE's own defect value
// (lineOutflowValue, cumulative rounding over the line's net rejects), never at the item's pooled
// average, so a line that reaches 0 held is exactly Rp 0 and no value moves between documents of
// the same item bought or made at different costs. The item pool is just the sum of its lines.
// Proceeds are stored on the row, never netted into value_amount and never booked anywhere (D24).

/** Same cap the server actions apply, re-checked here for any other caller. */
const MAX_TEXT = 1000;

type PurchaseRow = typeof purchases.$inferSelect;
type BatchRow = typeof productionBatches.$inferSelect;

interface LockedLine {
  source: DefectSourceLine;
  item: DefectItemRef;
  label: string;
  /** qty_ordered (purchase) or planned pcs (batch). */
  lineQty: number;
  formatQty: (qty: number) => string;
  document: { kind: "purchase"; row: PurchaseRow } | { kind: "batch"; row: BatchRow };
}

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

/** Peek the line (unlocked, to learn its document and item), then lock the document row, then the
 * item row. Throws ActionError when the line does not exist. */
async function lockSourceLine(tx: Tx, source: DefectSourceLine): Promise<LockedLine> {
  if ("purchaseItemId" in source) {
    const [line] = await tx
      .select({
        purchaseId: purchaseItems.purchaseId,
        itemType: purchaseItems.itemType,
        fabricId: purchaseItems.fabricId,
        accessoryId: purchaseItems.accessoryId,
        fabricName: fabrics.name,
        accessoryName: accessories.name,
        qtyOrdered: purchaseItems.qtyOrdered,
      })
      .from(purchaseItems)
      .leftJoin(fabrics, eq(fabrics.id, purchaseItems.fabricId))
      .leftJoin(accessories, eq(accessories.id, purchaseItems.accessoryId))
      .where(eq(purchaseItems.id, source.purchaseItemId));
    if (!line) throw new ActionError("Barang ini tidak ditemukan di pesanan.");
    const purchase = await lockPurchaseForUpdate(tx, line.purchaseId);
    if (!purchase) throw new Error("purchase not found for an existing line");
    if (line.fabricId) {
      if (!(await lockFabricForUpdate(tx, line.fabricId))) throw new Error(`fabric ${line.fabricId} not found`);
    } else if (!(await lockAccessoryForUpdate(tx, line.accessoryId!))) {
      throw new Error(`accessory ${line.accessoryId} not found`);
    }
    return {
      source,
      item: line.fabricId ? { kind: "fabric", fabricId: line.fabricId } : { kind: "accessory", accessoryId: line.accessoryId! },
      label: (line.fabricName ?? line.accessoryName)!,
      lineQty: line.qtyOrdered,
      formatQty: (qty) => formatPurchaseQty(line.itemType, qty),
      document: { kind: "purchase", row: purchase },
    };
  }

  const [line] = await tx
    .select({
      batchId: productionBatchItems.productionBatchId,
      sku: productionBatchItems.sku,
      qty: productionBatchItems.qty,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
    })
    .from(productionBatchItems)
    .innerJoin(productVariants, eq(productVariants.sku, productionBatchItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productionBatchItems.id, source.productionBatchItemId));
  if (!line) throw new ActionError("SKU ini tidak ditemukan di batch.");
  const batch = await lockProductionBatchForUpdate(tx, line.batchId);
  if (!batch) throw new Error("production batch not found for an existing line");
  if (!(await lockVariantForUpdate(tx, line.sku))) throw new Error(`variant ${line.sku} not found`);
  return {
    source,
    item: { kind: "sku", sku: line.sku },
    label: `${line.productName} · ${line.colorName} · ${sizeLabel(line.size)}`,
    lineQty: line.qty,
    formatQty: (qty) => `${qty} pcs`,
    document: { kind: "batch", row: batch },
  };
}

/** Outstanding (qty_ordered / planned − qtySettled) on the line, in centi-units. */
async function outstandingCentiOnLine(tx: Database, line: LockedLine): Promise<bigint> {
  if (line.document.kind === "purchase") {
    const settled = (await getLineQuantities(line.document.row.id, tx)).get((line.source as { purchaseItemId: string }).purchaseItemId)?.settled ?? 0;
    return toCentiQty(line.lineQty) - toCentiQty(settled);
  }
  const settled = (await getBatchQuantitiesByLine(line.document.row.id, tx)).get((line.source as { productionBatchItemId: string }).productionBatchItemId)?.settled ?? 0;
  return toCentiQty(line.lineQty) - toCentiQty(settled);
}

/** A real Jakarta calendar date (round-trips through Date, so 2026-02-30 is refused here rather
 * than as a raw Postgres error), never in the future. */
function assertOccurredAt(occurredAt: string): void {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(occurredAt) ? new Date(`${occurredAt}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== occurredAt) {
    throw new FieldError("occurredAt", "Tanggal tidak valid.");
  }
  if (occurredAt > todayInJakarta()) throw new FieldError("occurredAt", "Tanggal tidak boleh di masa depan.");
}

/** A positive quantity, at most two decimals, whole pcs unless fabric. */
function assertDispositionQty(qty: number, item: DefectItemRef): void {
  if (!hasAtMostTwoDecimals(qty)) throw new FieldError("qty", "Jumlah tidak valid.");
  if (item.kind !== "fabric" && !Number.isInteger(qty)) throw new FieldError("qty", "Jumlah harus bilangan bulat.");
}

/** The shared outflow write: refuse more than the line still holds, value it at the line's own
 * defect value (§10 R1), insert one negative row. Caller holds the document + item locks. */
async function insertOutflow(
  tx: Tx,
  line: LockedLine,
  params: {
    type: "return_out" | "dispose";
    qty: number;
    occurredAt: string;
    note: string;
    disposalType?: DefectDisposalType;
    proceedsAmount?: number;
  },
  actorStaffUserId: string,
) {
  assertDispositionQty(params.qty, line.item);
  const totals = await getLineDefectTotals(line.source, tx);
  const heldCenti = toCentiQty(totals.rejectedQty) - toCentiQty(totals.outQty);
  const held = Number(heldCenti) / 100;
  if (toCentiQty(params.qty) > heldCenti) {
    throw new FieldError(
      "qty",
      held <= 0
        ? `Tidak ada stok cacat ${line.label} dari dokumen ini.`
        : `Jumlah melebihi stok cacat ${line.label} dari dokumen ini. Stok cacat tersedia: ${line.formatQty(held)}.`,
    );
  }
  const qtyDelta = -Number(toCentiQty(params.qty)) / 100;
  const valueAmount = -lineOutflowValue(totals, params.qty);

  const [movement] = await tx
    .insert(defectMovements)
    .values({
      itemKind: line.item.kind,
      sku: line.item.kind === "sku" ? line.item.sku : null,
      fabricId: line.item.kind === "fabric" ? line.item.fabricId : null,
      accessoryId: line.item.kind === "accessory" ? line.item.accessoryId : null,
      type: params.type,
      qty: qtyDelta,
      valueAmount,
      purchaseItemId: "purchaseItemId" in line.source ? line.source.purchaseItemId : null,
      productionBatchItemId: "productionBatchItemId" in line.source ? line.source.productionBatchItemId : null,
      disposalType: params.disposalType ?? null,
      proceedsAmount: params.disposalType ? (params.proceedsAmount ?? 0) : null,
      occurredAt: params.occurredAt,
      note: params.note,
      createdByStaffUserId: actorStaffUserId,
    })
    .returning();
  if (!movement) throw new Error("failed to insert defect movement");
  return movement;
}

export interface ReturnDefectsInput {
  source: DefectSourceLine;
  qty: number;
  /** Why the units go back (required); also the re-open reason when the document was closed. */
  reason: string;
  occurredAt: string;
}

export type DocumentStatus = PurchaseStatus | ProductionReceiptStatus;

/** §5 `returnDefectsToSupplier` ("Kembalikan ke supplier", D15/D16/D18):
 * 1. lock the document row, then the item row;
 * 2. require 0 < qty ≤ stillHeld(line) and a non-blank reason;
 * 3. insert one 'return_out' row (qty negative, valued at the line's own defect value, §10 R1),
 *    so the replacement receipt's slice enters sellable stock at this line's price;
 * 4. qtySettled drops by qty, so outstanding grows by EXACTLY qty: the replacement then arrives
 *    through the normal receipt flow on the same document and can complete it;
 * 5. a closed/cancelled document is re-opened to partially_received (the only path that re-opens
 *    one, D18), stamping reopened_at / reopened_by / reopen_reason; an open one just follows its
 *    receipts;
 * 6. one audit entry for the return, plus one for the re-open when it happened. */
export async function returnDefectsToSupplier(input: ReturnDefectsInput, actorStaffUserId: string, db: Database = defaultDb) {
  const reason = input.reason.trim();
  if (reason === "") throw new FieldError("reason", "Alasan wajib diisi.");
  if (reason.length > MAX_TEXT) throw new FieldError("reason", "Alasan terlalu panjang.");
  assertOccurredAt(input.occurredAt);

  return db.transaction(async (tx) => {
    const line = await lockSourceLine(tx, input.source);
    const movement = await insertOutflow(tx, line, { type: "return_out", qty: input.qty, occurredAt: input.occurredAt, note: reason }, actorStaffUserId);

    const now = new Date();
    const reopenStamp = { reopenedAt: now, reopenedByStaffUserId: actorStaffUserId, reopenReason: reason };
    let before: DocumentStatus;
    let after: DocumentStatus;
    let reopened = false;
    if (line.document.kind === "purchase") {
      const purchase = line.document.row;
      before = purchase.status;
      reopened = TERMINAL_PURCHASE_STATUSES.includes(purchase.status);
      after = reopened ? "partially_received" : statusAfterReceiptChange(purchase.status, await getLineProgress(purchase.id, tx));
      if (reopened || after !== before) {
        const [updated] = await tx
          .update(purchases)
          .set(reopened ? { status: after as PurchaseStatus, ...reopenStamp } : { status: after as PurchaseStatus })
          .where(eq(purchases.id, purchase.id))
          .returning();
        if (reopened) {
          await writeAuditLog(tx, { actorStaffUserId, action: "reopen", entityType: "purchase", entityId: purchase.id, before: purchase, after: updated });
        }
      }
    } else {
      const batch = line.document.row;
      before = batch.receiptStatus;
      reopened = batch.receiptStatus === "closed";
      after = reopened ? "partially_received" : batchStatusAfterReceiptChange(batch.receiptStatus, await getBatchLineProgress(batch.id, tx));
      if (reopened || after !== before) {
        const [updated] = await tx
          .update(productionBatches)
          .set(reopened ? { receiptStatus: after as ProductionReceiptStatus, ...reopenStamp } : { receiptStatus: after as ProductionReceiptStatus })
          .where(eq(productionBatches.id, batch.id))
          .returning();
        if (reopened) {
          await writeAuditLog(tx, { actorStaffUserId, action: "reopen", entityType: "production_batch", entityId: batch.id, before: batch, after: updated });
        }
      }
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "return_to_supplier",
      entityType: "defect_movement",
      entityId: movement.id,
      after: { movement, documentStatus: { before, after }, reopened },
    });
    return { movement, status: after, reopened };
  });
}

export interface DisposeDefectsInput {
  source: DefectSourceLine;
  qty: number;
  disposalType: DefectDisposalType;
  /** Gross cash actually received (D24): > 0 for Lelang, exactly 0 for Hibah and Dibuang. */
  proceedsAmount: number;
  note: string;
  occurredAt: string;
}

/** D24/D29: Lelang needs proceeds > 0; Hibah and Dibuang/Dimusnahkan are exactly Rp 0. Pure, so the
 * server action and this module apply the same rule (the DB CHECKs are the backstop). */
export function validateDisposal(disposalType: DefectDisposalType, proceedsAmount: number): string | null {
  if (!DEFECT_DISPOSAL_TYPES.includes(disposalType)) return "Jenis pelepasan tidak valid.";
  if (!Number.isSafeInteger(proceedsAmount) || proceedsAmount < 0) return "Hasil lelang tidak valid.";
  if (disposalType === "auction" && proceedsAmount <= 0) return "Hasil lelang wajib diisi dan lebih dari Rp 0.";
  if (disposalType !== "auction" && proceedsAmount !== 0) return "Hibah dan barang yang dibuang tidak punya hasil (Rp 0).";
  return null;
}

/** §5 `disposeDefects` ("Pelepasan barang cacat", D24/D29): same locks and checks as a return, a
 * required note and date, the proceeds rule above; inserts one 'dispose' row (qty negative, value
 * at the line's own defect value, disposal_type + proceeds_amount). NO change to qtySettled, outstanding or
 * status: releasing is the owner accepting the shortfall, never room for a replacement. No journal
 * entry anywhere — the proceeds are stored for a future accounting module. One audit entry. */
export async function disposeDefects(input: DisposeDefectsInput, actorStaffUserId: string, db: Database = defaultDb) {
  const note = input.note.trim();
  if (note === "") throw new FieldError("note", "Catatan wajib diisi.");
  if (note.length > MAX_TEXT) throw new FieldError("note", "Catatan terlalu panjang.");
  const invalid = validateDisposal(input.disposalType, input.proceedsAmount);
  if (invalid) throw new FieldError("proceedsAmount", invalid);
  assertOccurredAt(input.occurredAt);

  return db.transaction(async (tx) => {
    const line = await lockSourceLine(tx, input.source);
    const movement = await insertOutflow(
      tx,
      line,
      { type: "dispose", qty: input.qty, occurredAt: input.occurredAt, note, disposalType: input.disposalType, proceedsAmount: input.proceedsAmount },
      actorStaffUserId,
    );
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "dispose",
      entityType: "defect_movement",
      entityId: movement.id,
      after: { movement, disposalType: movement.disposalType, proceedsAmount: movement.proceedsAmount },
    });
    return { movement };
  });
}

/** §5 `reverseDefectMovement` ("Batalkan", D8) for a return or a release — copy-and-negate:
 * 1. lock the document row, then the item row, then the movement row;
 * 2. refuse a reject (it is reversed with its receipt, "Batalkan penerimaan", so qty_rejected and
 *    its reject row stay 1:1), a reversal, or a row already reversed;
 * 3. a return's reversal puts the units back on the line's qtySettled: refused when the line no
 *    longer has that much outstanding (its replacement has already been received), so a reversal
 *    can never turn into over-receipt (D17);
 * 4. insert the exact negation (same item, source line and disposal_type; qty, value and proceeds
 *    negated — check_defect_reversal_matches is the DB backstop), stamp the original, recompute the
 *    document status for a return (never re-closes a re-opened document: close it again through
 *    the normal close action), one audit entry. A reversed release's negated proceeds bring the
 *    net-loss figures back to exactly their prior values. */
export async function reverseDefectMovement(movementId: string, actorStaffUserId: string, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const [peek] = await tx.select().from(defectMovements).where(eq(defectMovements.id, movementId));
    if (!peek) throw new ActionError("Catatan barang cacat tidak ditemukan.");
    if (peek.type === "reject") {
      throw new ActionError('Barang cacat yang ditolak saat diterima dibatalkan lewat penerimaannya ("Batalkan penerimaan").');
    }
    if (peek.type === "reversal") throw new ActionError("Pembatalan tidak bisa dibatalkan lagi.");

    const source: DefectSourceLine = peek.purchaseItemId ? { purchaseItemId: peek.purchaseItemId } : { productionBatchItemId: peek.productionBatchItemId! };
    const line = await lockSourceLine(tx, source);
    const [original] = await tx.select().from(defectMovements).where(eq(defectMovements.id, movementId)).for("update");
    if (!original) throw new Error("defect movement vanished under lock");
    if (original.reversedAt !== null) throw new ActionError("Catatan ini sudah dibatalkan sebelumnya.");

    if (original.type === "return_out") {
      const outstanding = await outstandingCentiOnLine(tx, line);
      if (outstanding < toCentiQty(-original.qty)) {
        throw new ActionError(
          "Pengembalian ini tidak bisa dibatalkan karena barang penggantinya sudah diterima. Batalkan penerimaan pengganti dulu.",
        );
      }
    }

    const [reversal] = await tx
      .insert(defectMovements)
      .values({
        itemKind: original.itemKind,
        sku: original.sku,
        fabricId: original.fabricId,
        accessoryId: original.accessoryId,
        type: "reversal",
        qty: -original.qty,
        valueAmount: -original.valueAmount,
        purchaseItemId: original.purchaseItemId,
        productionBatchItemId: original.productionBatchItemId,
        disposalType: original.disposalType,
        proceedsAmount: original.proceedsAmount === null ? null : -original.proceedsAmount,
        occurredAt: todayInJakarta(),
        reversesMovementId: original.id,
        note: `Pembatalan ${DEFECT_MOVEMENT_TYPE_LABELS[original.type].toLowerCase()}`,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!reversal) throw new Error("failed to insert defect reversal");
    await tx.update(defectMovements).set({ reversedAt: new Date(), reversedByStaffUserId: actorStaffUserId }).where(eq(defectMovements.id, original.id));

    let documentStatus: { before: DocumentStatus; after: DocumentStatus } | null = null;
    if (original.type === "return_out") {
      if (line.document.kind === "purchase") {
        const purchase = line.document.row;
        const after = statusAfterReceiptChange(purchase.status, await getLineProgress(purchase.id, tx));
        if (after !== purchase.status) await tx.update(purchases).set({ status: after }).where(eq(purchases.id, purchase.id));
        documentStatus = { before: purchase.status, after };
      } else {
        const batch = line.document.row;
        const after = batchStatusAfterReceiptChange(batch.receiptStatus, await getBatchLineProgress(batch.id, tx));
        if (after !== batch.receiptStatus) await tx.update(productionBatches).set({ receiptStatus: after }).where(eq(productionBatches.id, batch.id));
        documentStatus = { before: batch.receiptStatus, after };
      }
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "reverse",
      entityType: "defect_movement",
      entityId: original.id,
      before: original,
      after: { reversal, documentStatus },
    });
    return { reversal };
  });
}
