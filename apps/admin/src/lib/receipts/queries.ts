import "server-only";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accessories,
  accessoryMovements,
  fabrics,
  fabricStockMovements,
  goodsReceiptItems,
  goodsReceipts,
  purchaseItems,
  purchases,
  staffUsers,
  suppliers,
  type GoodsReceiptKind,
  type PurchaseItemType,
} from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { nextDocumentNumber } from "@/lib/documents/document-number";
import { lockAccessoryForUpdate, lockFabricForUpdate } from "@/lib/inventory/db";
import { getAccessoryBalance } from "@/lib/inventory/accessories";
import { getFabricBalance } from "@/lib/inventory/fabric-stock";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { getDefectSettledByPurchaseLine, insertRejectMovements, reverseRejectsInTx } from "@/lib/defects/queries";
import { formatPurchaseQty, getLineProgress, getLineQuantities, hasAtMostTwoDecimals, isUuid, lockPurchaseForUpdate } from "@/lib/purchases/queries";
import { isOpenPurchaseStatus, statusAfterReceiptChange } from "@/lib/purchases/status";
import { reverseProductionReceiptInTx } from "./production";
import { assertReceivedAt } from "./received-at";
import { sliceValue, splitSlice, toCentiQty } from "./valuation";

// Goods receipts against purchase documents (docs/plans/suppliers-goods-receipt.md §5, sessions
// S3 + S5). A receipt is the ONLY way a purchase document's goods enter raw-material stock (D3).
// Rejected units (S5) go to the defect ledger with their value, never to sellable stock.

export interface ReceiptLineInput {
  purchaseItemId: string;
  qtyAccepted: number;
  /** Units that arrived defective ("Ditolak (cacat)"); 0 when omitted. */
  qtyRejected?: number;
}

export interface PostPurchaseReceiptInput {
  purchaseId: string;
  receivedAt: string;
  receivedByName?: string | null;
  note?: string | null;
  lines: ReceiptLineInput[];
}

interface LockedLine {
  id: string;
  itemType: PurchaseItemType;
  itemId: string;
  itemName: string;
  qtyOrdered: number;
  totalAmount: number;
}

/** Lock the raw-material item rows in §5's shared order — fabrics then accessories, each by id —
 * the same order postBatch and saveStockCount establish, so nothing here can deadlock against
 * them. The purchase row must already be locked (it always comes first). */
async function lockItemsInOrder(tx: Tx, lines: readonly { itemType: PurchaseItemType; itemId: string }[]): Promise<void> {
  const fabricIds = [...new Set(lines.filter((line) => line.itemType === "fabric").map((line) => line.itemId))].sort();
  const accessoryIds = [...new Set(lines.filter((line) => line.itemType === "accessory").map((line) => line.itemId))].sort();
  for (const id of fabricIds) {
    if (!(await lockFabricForUpdate(tx, id))) throw new Error(`fabric ${id} not found for a purchase line`);
  }
  for (const id of accessoryIds) {
    if (!(await lockAccessoryForUpdate(tx, id))) throw new Error(`accessory ${id} not found for a purchase line`);
  }
}

/** Net value already booked against each purchase line's settled quantity, keyed by
 * purchase_items.id: its sellable receipt rows plus their reversals' void rows, plus the defect
 * rows that are part of qtySettled (rejects, returns and their reversals; never releases — see
 * getDefectSettledByPurchaseLine). This is the `valueBefore` of the next §4.2 slice. */
async function bookedValueByLine(tx: Database, purchaseItemIds: readonly string[]): Promise<Map<string, number>> {
  if (purchaseItemIds.length === 0) return new Map();
  const fromLedger = async (ledger: typeof fabricStockMovements | typeof accessoryMovements) =>
    tx
      .select({
        purchaseItemId: goodsReceiptItems.purchaseItemId,
        value: sql<string>`sum(${ledger.valueAmount})::bigint`,
      })
      .from(ledger)
      .innerJoin(goodsReceiptItems, sql`${goodsReceiptItems.id}::text = ${ledger.refId}`)
      .where(and(eq(ledger.refType, "goods_receipt"), inArray(goodsReceiptItems.purchaseItemId, purchaseItemIds)))
      .groupBy(goodsReceiptItems.purchaseItemId);
  const rows = [...(await fromLedger(fabricStockMovements)), ...(await fromLedger(accessoryMovements))];
  const byLine = new Map<string, number>();
  for (const row of rows) byLine.set(row.purchaseItemId!, (byLine.get(row.purchaseItemId!) ?? 0) + Number(row.value));
  for (const [lineId, defect] of await getDefectSettledByPurchaseLine(purchaseItemIds, tx)) {
    byLine.set(lineId, (byLine.get(lineId) ?? 0) + defect.valueAmount);
  }
  return byLine;
}

/** §5 `postGoodsReceiptForPurchase`, one transaction:
 * 1. lock the purchase row FIRST (two phones receiving the same purchase serialize; the second
 *    re-reads and either posts the remainder or fails cleanly);
 * 2. require an open status (ordered / partially received);
 * 3. recompute qtySettled/outstanding per line INSIDE the lock and reject over-receipt (D17:
 *    accepted + rejected together may not exceed what is left) with a message naming the line and
 *    what is left, and reject a receipt where every line is zero;
 * 4. lock the item rows in sorted order;
 * 5. insert the receipt header and its items;
 * 6. per line, value the arrival (accepted + rejected) as the §4.2 slice and split it between the
 *    two ledgers in proportion: the accepted part as one 'purchase' movement on the raw-material
 *    ledger (ref_type 'goods_receipt', ref_id = the receipt item, purchased_at = received_at,
 *    supplier id + name snapshot), the rejected part as one 'reject' row on the defect ledger. So
 *    a reject never touches the sellable balance or the sellable moving average (D14);
 * 7. recompute and store the document status;
 * 8. one audit entry for the whole receipt. */
export async function postGoodsReceiptForPurchase(input: PostPurchaseReceiptInput, actorStaffUserId: string, db: Database = defaultDb) {
  assertReceivedAt(input.receivedAt);
  const requested = input.lines
    .map((line) => ({ ...line, qtyRejected: line.qtyRejected ?? 0 }))
    .filter((line) => line.qtyAccepted !== 0 || line.qtyRejected !== 0);
  if (requested.length === 0) throw new FieldError("lines", "Isi jumlah diterima minimal untuk satu barang.");
  const seen = new Set<string>();
  for (const line of requested) {
    if (line.qtyAccepted !== 0 && !hasAtMostTwoDecimals(line.qtyAccepted)) throw new FieldError("lines", "Jumlah diterima tidak valid.");
    if (line.qtyRejected !== 0 && !hasAtMostTwoDecimals(line.qtyRejected)) throw new FieldError("lines", "Jumlah ditolak tidak valid.");
    if (seen.has(line.purchaseItemId)) throw new FieldError("lines", "Satu barang hanya boleh muncul sekali dalam satu penerimaan.");
    seen.add(line.purchaseItemId);
  }

  return db.transaction(async (tx) => {
    const purchase = await lockPurchaseForUpdate(tx, input.purchaseId);
    if (!purchase) throw new ActionError("Pesanan pembelian tidak ditemukan.");
    if (!isOpenPurchaseStatus(purchase.status)) {
      throw new ActionError(
        purchase.status === "received"
          ? "Semua barang di pesanan ini sudah diterima."
          : "Pesanan ini sudah ditutup, tidak bisa menerima barang lagi.",
      );
    }

    const lineRows = await tx
      .select({
        id: purchaseItems.id,
        itemType: purchaseItems.itemType,
        fabricId: purchaseItems.fabricId,
        accessoryId: purchaseItems.accessoryId,
        fabricName: fabrics.name,
        accessoryName: accessories.name,
        qtyOrdered: purchaseItems.qtyOrdered,
        totalAmount: purchaseItems.totalAmount,
      })
      .from(purchaseItems)
      .leftJoin(fabrics, eq(fabrics.id, purchaseItems.fabricId))
      .leftJoin(accessories, eq(accessories.id, purchaseItems.accessoryId))
      .where(eq(purchaseItems.purchaseId, purchase.id));
    const linesById = new Map<string, LockedLine>(
      lineRows.map((row) => [
        row.id,
        {
          id: row.id,
          itemType: row.itemType,
          itemId: (row.fabricId ?? row.accessoryId)!,
          itemName: (row.fabricName ?? row.accessoryName)!,
          qtyOrdered: row.qtyOrdered,
          totalAmount: row.totalAmount,
        },
      ]),
    );
    const quantitiesBefore = await getLineQuantities(purchase.id, tx);

    const planned = requested.map((request) => {
      const line = linesById.get(request.purchaseItemId);
      if (!line) throw new FieldError("lines", "Barang ini bukan bagian dari pesanan.");
      if (line.itemType === "accessory" && !(Number.isInteger(request.qtyAccepted) && Number.isInteger(request.qtyRejected))) {
        throw new FieldError("lines", `Jumlah diterima dan ditolak untuk ${line.itemName} harus bilangan bulat.`);
      }
      const settledBefore = quantitiesBefore.get(line.id)?.settled ?? 0;
      const outstandingCenti = toCentiQty(line.qtyOrdered) - toCentiQty(settledBefore);
      // D17: accepted AND rejected both use up what is left; over-receipt is refused entirely.
      if (toCentiQty(request.qtyAccepted) + toCentiQty(request.qtyRejected) > outstandingCenti) {
        const remaining = Number(outstandingCenti) / 100;
        throw new FieldError(
          "lines",
          remaining <= 0
            ? `${line.itemName} sudah diterima lengkap, tidak bisa menerima lagi.`
            : request.qtyRejected === 0
              ? `Jumlah diterima untuk ${line.itemName} melebihi sisa pesanan. Sisa yang belum diterima: ${formatPurchaseQty(line.itemType, remaining)}.`
              : `Jumlah diterima ditambah ditolak untuk ${line.itemName} melebihi sisa pesanan. Sisa yang belum diterima: ${formatPurchaseQty(line.itemType, remaining)}.`,
        );
      }
      return { line, qtyAccepted: request.qtyAccepted, qtyRejected: request.qtyRejected, settledBefore };
    });

    await lockItemsInOrder(tx, planned.map((plan) => plan.line));
    const bookedBefore = await bookedValueByLine(tx, planned.map((plan) => plan.line.id));

    const [supplier] = await tx.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(eq(suppliers.id, purchase.supplierId));
    if (!supplier) throw new Error("supplier not found for an existing purchase");

    const receiptNo = await nextDocumentNumber(tx, "GR", goodsReceipts.receiptNo);
    const [receipt] = await tx
      .insert(goodsReceipts)
      .values({
        receiptNo,
        sourceType: "purchase",
        purchaseId: purchase.id,
        kind: "receipt",
        receivedAt: input.receivedAt,
        receivedByName: input.receivedByName?.trim() || null,
        note: input.note?.trim() || null,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!receipt) throw new Error("failed to insert goods receipt");

    const items = await tx
      .insert(goodsReceiptItems)
      .values(
        planned.map((plan) => ({
          goodsReceiptId: receipt.id,
          sourceType: "purchase" as const,
          kind: "receipt" as const,
          purchaseItemId: plan.line.id,
          qtyAccepted: plan.qtyAccepted,
          qtyRejected: plan.qtyRejected,
        })),
      )
      .returning();
    const itemByLine = new Map(items.map((item) => [item.purchaseItemId!, item]));

    const movements = [];
    const rejects = [];
    for (const plan of planned) {
      const item = itemByLine.get(plan.line.id)!;
      const slice = sliceValue({
        totalAmount: plan.line.totalAmount,
        qtyOrdered: plan.line.qtyOrdered,
        settledBefore: plan.settledBefore,
        valueBefore: bookedBefore.get(plan.line.id) ?? 0,
        qtyNow: Number(toCentiQty(plan.qtyAccepted) + toCentiQty(plan.qtyRejected)) / 100,
      });
      const value = splitSlice(slice, plan.qtyAccepted, plan.qtyRejected);
      if (plan.qtyRejected !== 0) {
        rejects.push({
          item: plan.line.itemType === "fabric" ? { kind: "fabric" as const, fabricId: plan.line.itemId } : { kind: "accessory" as const, accessoryId: plan.line.itemId },
          source: { purchaseItemId: plan.line.id },
          goodsReceiptItemId: item.id,
          qty: plan.qtyRejected,
          valueAmount: value.rejected,
          occurredAt: input.receivedAt,
          note: `${purchase.purchaseNo} · ${receiptNo}`,
        });
      }
      if (plan.qtyAccepted === 0) continue;
      const common = {
        qty: plan.qtyAccepted,
        valueAmount: value.accepted,
        type: "purchase" as const,
        refType: "goods_receipt" as const,
        refId: item.id,
        purchasedAt: input.receivedAt,
        supplier: supplier.name,
        supplierId: supplier.id,
        note: `${purchase.purchaseNo} · ${receiptNo}`,
        createdByStaffUserId: actorStaffUserId,
      };
      const [movement] =
        plan.line.itemType === "fabric"
          ? await tx.insert(fabricStockMovements).values({ ...common, fabricId: plan.line.itemId }).returning()
          : await tx.insert(accessoryMovements).values({ ...common, accessoryId: plan.line.itemId }).returning();
      if (!movement) throw new Error("failed to insert receipt ledger movement");
      movements.push(movement);
    }
    const defects = await insertRejectMovements(tx, rejects, actorStaffUserId);

    const status = statusAfterReceiptChange(purchase.status, await getLineProgress(purchase.id, tx));
    if (status !== purchase.status) await tx.update(purchases).set({ status }).where(eq(purchases.id, purchase.id));

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "receive",
      entityType: "goods_receipt",
      entityId: receipt.id,
      after: { receipt, items, movements, defects, purchaseStatus: { before: purchase.status, after: status } },
    });
    return { receipt, status };
  });
}

const BLOCKING_VOID_TYPES = ["production", "adjustment", "purchase_void"] as const;

/** Is there a consumption/adjustment/void for the same item inserted AFTER `original`? Same rule,
 * same typed operators, as voidAccessoryPurchase/voidFabricPurchase (see their doc comments for
 * why a raw `sql` row-constructor comparison is avoided). */
async function hasLaterBlockingMovement(
  tx: Tx,
  ledger: typeof fabricStockMovements | typeof accessoryMovements,
  itemCondition: ReturnType<typeof eq>,
  original: { id: string; createdAt: Date },
): Promise<boolean> {
  const [row] = await tx
    .select({ id: ledger.id })
    .from(ledger)
    .where(
      and(
        itemCondition,
        inArray(ledger.type, BLOCKING_VOID_TYPES),
        or(gt(ledger.createdAt, original.createdAt), and(eq(ledger.createdAt, original.createdAt), gt(ledger.id, original.id))),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** §5 `reverseGoodsReceipt`. A production-batch receipt is handed to
 * reverseProductionReceiptInTx (./production.ts, S4); a purchase receipt mirrors
 * voidAccessoryPurchase:
 * 1. lock the purchase row, then the item rows in sorted order;
 * 2. reject if the receipt is already reversed or is itself a reversal;
 * 3. reject if any later consumption/adjustment/void exists for an affected item (you cannot
 *    un-receive fabric a batch has already cut), pointing at "Sesuaikan stok" instead; and reject
 *    if the receipt's defects have since been returned or released (reverseRejectsInTx);
 * 4. insert a kind='reversal' receipt whose items are the exact negation (accepted AND rejected),
 *    one exact 'purchase_void' row per original ledger row (voids_movement_id set), one exact
 *    'reversal' row per original 'reject' defect row, stamp voided_at / reversed_at on the
 *    originals and reversed_at on the original receipt, recompute the document's status, one
 *    audit entry. */
export async function reverseGoodsReceipt(receiptId: string, actorStaffUserId: string, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ purchaseId: goodsReceipts.purchaseId }).from(goodsReceipts).where(eq(goodsReceipts.id, receiptId));
    if (!peek) throw new ActionError("Penerimaan tidak ditemukan.");
    if (!peek.purchaseId) return reverseProductionReceiptInTx(tx, receiptId, actorStaffUserId);

    const purchase = await lockPurchaseForUpdate(tx, peek.purchaseId);
    if (!purchase) throw new Error("purchase not found for an existing receipt");
    const [receipt] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, receiptId)).for("update");
    if (!receipt) throw new ActionError("Penerimaan tidak ditemukan.");
    if (receipt.kind !== "receipt") throw new ActionError("Pembatalan penerimaan tidak bisa dibatalkan lagi.");
    if (receipt.reversedAt !== null) throw new ActionError("Penerimaan ini sudah dibatalkan sebelumnya.");

    const items = await tx
      .select({
        id: goodsReceiptItems.id,
        purchaseItemId: goodsReceiptItems.purchaseItemId,
        qtyAccepted: goodsReceiptItems.qtyAccepted,
        qtyRejected: goodsReceiptItems.qtyRejected,
        itemType: purchaseItems.itemType,
        fabricId: purchaseItems.fabricId,
        accessoryId: purchaseItems.accessoryId,
      })
      .from(goodsReceiptItems)
      .innerJoin(purchaseItems, eq(purchaseItems.id, goodsReceiptItems.purchaseItemId))
      .where(eq(goodsReceiptItems.goodsReceiptId, receipt.id));
    await lockItemsInOrder(
      tx,
      items.map((item) => ({ itemType: item.itemType, itemId: (item.fabricId ?? item.accessoryId)! })),
    );

    const itemIds = items.map((item) => item.id);
    const [fabricRows, accessoryRows] = await Promise.all([
      tx
        .select()
        .from(fabricStockMovements)
        .where(and(eq(fabricStockMovements.refType, "goods_receipt"), eq(fabricStockMovements.type, "purchase"), inArray(fabricStockMovements.refId, itemIds))),
      tx
        .select()
        .from(accessoryMovements)
        .where(and(eq(accessoryMovements.refType, "goods_receipt"), eq(accessoryMovements.type, "purchase"), inArray(accessoryMovements.refId, itemIds))),
    ]);
    // A line that only rejected (accepted 0) has no sellable ledger row.
    if (fabricRows.length + accessoryRows.length !== items.filter((item) => item.qtyAccepted !== 0).length) {
      throw new Error("receipt items and ledger rows disagree");
    }

    for (const row of fabricRows) {
      if (row.voidedAt !== null) throw new Error("a receipt ledger row was voided outside its receipt");
      if (await hasLaterBlockingMovement(tx, fabricStockMovements, eq(fabricStockMovements.fabricId, row.fabricId), row)) {
        throw new ActionError(
          'Penerimaan ini tidak bisa dibatalkan karena bahannya sudah dipakai atau disesuaikan sesudahnya. Gunakan "Sesuaikan stok" untuk mengoreksi jumlahnya.',
        );
      }
      // Defensive backstop, same reasoning as voidAccessoryPurchase's.
      const balance = await getFabricBalance(row.fabricId, tx);
      if (toCentiQty(balance.qty) < toCentiQty(row.qty)) throw new ActionError("Pembatalan ini akan membuat stok menjadi negatif.");
    }
    for (const row of accessoryRows) {
      if (row.voidedAt !== null) throw new Error("a receipt ledger row was voided outside its receipt");
      if (await hasLaterBlockingMovement(tx, accessoryMovements, eq(accessoryMovements.accessoryId, row.accessoryId), row)) {
        throw new ActionError(
          'Penerimaan ini tidak bisa dibatalkan karena aksesorisnya sudah dipakai atau disesuaikan sesudahnya. Gunakan "Sesuaikan stok" untuk mengoreksi jumlahnya.',
        );
      }
      const balance = await getAccessoryBalance(row.accessoryId, tx);
      if (toCentiQty(balance.qty) < toCentiQty(row.qty)) throw new ActionError("Pembatalan ini akan membuat stok menjadi negatif.");
    }

    const receiptNo = await nextDocumentNumber(tx, "GR", goodsReceipts.receiptNo);
    const [reversal] = await tx
      .insert(goodsReceipts)
      .values({
        receiptNo,
        sourceType: "purchase",
        purchaseId: purchase.id,
        kind: "reversal",
        receivedAt: todayInJakarta(),
        reversesReceiptId: receipt.id,
        note: `Pembatalan ${receipt.receiptNo}`,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!reversal) throw new Error("failed to insert reversal receipt");

    const reversalItems = await tx
      .insert(goodsReceiptItems)
      .values(
        items.map((item) => ({
          goodsReceiptId: reversal.id,
          sourceType: "purchase" as const,
          kind: "reversal" as const,
          purchaseItemId: item.purchaseItemId,
          qtyAccepted: -item.qtyAccepted,
          qtyRejected: -item.qtyRejected,
        })),
      )
      .returning();
    const reversalItemByLine = new Map(reversalItems.map((item) => [item.purchaseItemId, item.id]));
    const lineByReceiptItem = new Map(items.map((item) => [item.id, item.purchaseItemId]));
    /** The reversal item that negates the receipt item a ledger row points at. Throws on a miss
     * rather than writing a NULL ref_id, which would drop the void row out of the per-line value
     * sum and over-value every later slice. */
    const reversalRefFor = (receiptItemId: string | null): string => {
      const line = receiptItemId ? lineByReceiptItem.get(receiptItemId) : undefined;
      const reversalItemId = line ? reversalItemByLine.get(line) : undefined;
      if (!reversalItemId) throw new Error(`no reversal item for receipt item ${receiptItemId}`);
      return reversalItemId;
    };
    const now = new Date();

    const voids = [];
    for (const row of fabricRows) {
      const [voidRow] = await tx
        .insert(fabricStockMovements)
        .values({
          fabricId: row.fabricId,
          qty: -row.qty,
          valueAmount: -row.valueAmount,
          type: "purchase_void",
          refType: "goods_receipt",
          refId: reversalRefFor(row.refId),
          voidsMovementId: row.id,
          supplier: row.supplier,
          supplierId: row.supplierId,
          note: `Pembatalan ${receipt.receiptNo}`,
          createdByStaffUserId: actorStaffUserId,
        })
        .returning();
      await tx.update(fabricStockMovements).set({ voidedAt: now, voidedByStaffUserId: actorStaffUserId }).where(eq(fabricStockMovements.id, row.id));
      voids.push(voidRow);
    }
    for (const row of accessoryRows) {
      const [voidRow] = await tx
        .insert(accessoryMovements)
        .values({
          accessoryId: row.accessoryId,
          qty: -row.qty,
          valueAmount: -row.valueAmount,
          type: "purchase_void",
          refType: "goods_receipt",
          refId: reversalRefFor(row.refId),
          voidsMovementId: row.id,
          supplier: row.supplier,
          supplierId: row.supplierId,
          note: `Pembatalan ${receipt.receiptNo}`,
          createdByStaffUserId: actorStaffUserId,
        })
        .returning();
      await tx.update(accessoryMovements).set({ voidedAt: now, voidedByStaffUserId: actorStaffUserId }).where(eq(accessoryMovements.id, row.id));
      voids.push(voidRow);
    }

    const { reversals: defectReversals } = await reverseRejectsInTx(
      tx,
      { items, reversalItemIdFor: reversalRefFor, occurredAt: reversal.receivedAt, note: `Pembatalan ${receipt.receiptNo}` },
      actorStaffUserId,
    );

    await tx.update(goodsReceipts).set({ reversedAt: now, reversedByStaffUserId: actorStaffUserId }).where(eq(goodsReceipts.id, receipt.id));

    const status = statusAfterReceiptChange(purchase.status, await getLineProgress(purchase.id, tx));
    if (status !== purchase.status) await tx.update(purchases).set({ status }).where(eq(purchases.id, purchase.id));

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "reverse",
      entityType: "goods_receipt",
      entityId: receipt.id,
      before: receipt,
      after: { reversal, items: reversalItems, voids, defectReversals, purchaseStatus: { before: purchase.status, after: status } },
    });
    return { reversal, status };
  });
}

// ---------- Reads ----------

export interface ReceiptListItem {
  purchaseItemId: string;
  itemType: PurchaseItemType;
  itemName: string;
  qtyAccepted: number;
  qtyRejected: number;
}

export interface PurchaseReceiptRow {
  id: string;
  receiptNo: string;
  kind: GoodsReceiptKind;
  receivedAt: string;
  receivedByName: string | null;
  note: string | null;
  createdAt: Date;
  createdByName: string | null;
  reversedAt: Date | null;
  reversesReceiptNo: string | null;
  items: ReceiptListItem[];
}

/** Every receipt and reversal of one purchase, newest first, each with its lines. */
export async function listReceiptsForPurchase(purchaseId: string, db: Database = defaultDb): Promise<PurchaseReceiptRow[]> {
  const reversed = alias(goodsReceipts, "reversed");
  const headers = await db
    .select({
      id: goodsReceipts.id,
      receiptNo: goodsReceipts.receiptNo,
      kind: goodsReceipts.kind,
      receivedAt: goodsReceipts.receivedAt,
      receivedByName: goodsReceipts.receivedByName,
      note: goodsReceipts.note,
      createdAt: goodsReceipts.createdAt,
      createdByName: staffUsers.name,
      reversedAt: goodsReceipts.reversedAt,
      reversesReceiptNo: reversed.receiptNo,
    })
    .from(goodsReceipts)
    .leftJoin(staffUsers, eq(staffUsers.id, goodsReceipts.createdByStaffUserId))
    .leftJoin(reversed, eq(reversed.id, goodsReceipts.reversesReceiptId))
    .where(eq(goodsReceipts.purchaseId, purchaseId))
    .orderBy(desc(goodsReceipts.createdAt), desc(goodsReceipts.id));
  if (headers.length === 0) return [];

  const itemRows = await db
    .select({
      goodsReceiptId: goodsReceiptItems.goodsReceiptId,
      purchaseItemId: goodsReceiptItems.purchaseItemId,
      qtyAccepted: goodsReceiptItems.qtyAccepted,
      qtyRejected: goodsReceiptItems.qtyRejected,
      itemType: purchaseItems.itemType,
      fabricName: fabrics.name,
      accessoryName: accessories.name,
    })
    .from(goodsReceiptItems)
    .innerJoin(purchaseItems, eq(purchaseItems.id, goodsReceiptItems.purchaseItemId))
    .leftJoin(fabrics, eq(fabrics.id, purchaseItems.fabricId))
    .leftJoin(accessories, eq(accessories.id, purchaseItems.accessoryId))
    .where(inArray(goodsReceiptItems.goodsReceiptId, headers.map((header) => header.id)))
    .orderBy(asc(goodsReceiptItems.createdAt), asc(goodsReceiptItems.id));

  const itemsByReceipt = new Map<string, ReceiptListItem[]>();
  for (const row of itemRows) {
    const list = itemsByReceipt.get(row.goodsReceiptId) ?? [];
    list.push({
      purchaseItemId: row.purchaseItemId!,
      itemType: row.itemType,
      itemName: (row.fabricName ?? row.accessoryName)!,
      qtyAccepted: row.qtyAccepted,
      qtyRejected: row.qtyRejected,
    });
    itemsByReceipt.set(row.goodsReceiptId, list);
  }
  return headers.map((header) => ({ ...header, items: itemsByReceipt.get(header.id) ?? [] }));
}

/** For a raw-material ledger row written by a goods receipt: the purchase document it belongs to.
 * Lets the stock ledgers' existing `/purchases/<movement id>` links land on the right document. */
export async function findPurchaseIdForReceiptMovement(movementId: string, db: Database = defaultDb): Promise<string | null> {
  // Two primary-key lookups rather than a join on `goods_receipt_items.id::text = ref_id`, which
  // would cast the PK side and keep its index from being used.
  for (const ledger of [fabricStockMovements, accessoryMovements] as const) {
    const [row] = await db
      .select({ refId: ledger.refId })
      .from(ledger)
      .where(and(eq(ledger.id, movementId), eq(ledger.refType, "goods_receipt")))
      .limit(1);
    if (!row?.refId || !isUuid(row.refId)) continue;
    const [receipt] = await db
      .select({ purchaseId: goodsReceipts.purchaseId })
      .from(goodsReceiptItems)
      .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.goodsReceiptId))
      .where(eq(goodsReceiptItems.id, row.refId))
      .limit(1);
    if (receipt?.purchaseId) return receipt.purchaseId;
  }
  return null;
}
