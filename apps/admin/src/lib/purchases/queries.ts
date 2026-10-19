import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accessories,
  fabrics,
  goodsReceiptItems,
  goodsReceipts,
  purchaseItems,
  purchases,
  staffUsers,
  suppliers,
  type PurchaseItemType,
  type PurchaseStatus,
} from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { nextDocumentNumber } from "@/lib/documents/document-number";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { lockSelectableSuppliers } from "@/lib/suppliers/queries";
import { closedStatus, isOpenPurchaseStatus, type LineProgress } from "./status";

// Purchase documents (docs/plans/suppliers-goods-receipt.md D1/§3.2, session S3). Creating or
// editing one moves NO stock — only a goods receipt does (lib/receipts/queries.ts, D3).

export interface PurchaseLineInput {
  itemType: PurchaseItemType;
  itemId: string;
  qtyOrdered: number;
  /** What the owner paid for this line, ongkir included (D6). */
  totalAmount: number;
}

export interface PurchaseInput {
  supplierId: string;
  orderedAt: string;
  notes?: string | null;
  lines: PurchaseLineInput[];
}

/** numeric(10,2)'s ceiling — anything above would surface as a raw Postgres 22003 (a 500) instead
 * of a field error. */
export const MAX_QTY = 99_999_999.99;
export const MAX_LINES = 50;

/** A positive quantity with at most two decimals, within numeric(10,2). Compared with a tolerance because `0.29 * 100`
 * is 28.999999999999996 in IEEE 754; numeric(10,2) is the real backstop. */
export function hasAtMostTwoDecimals(qty: number): boolean {
  if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY) return false;
  return Math.abs(qty * 100 - Math.round(qty * 100)) < 1e-6;
}

/** Two decimals at most, and whole pcs for accessories (purchase_items_accessory_whole_qty_check
 * is the backstop). Duplicate items are refused here with a readable message instead of surfacing
 * the partial unique index's 23505. */
function validateLines(lines: readonly PurchaseLineInput[]): void {
  if (lines.length === 0) throw new FieldError("lines", "Tambahkan minimal satu barang.");
  if (lines.length > MAX_LINES) throw new FieldError("lines", `Maksimal ${MAX_LINES} barang dalam satu pesanan.`);
  const seen = new Set<string>();
  for (const line of lines) {
    if (!hasAtMostTwoDecimals(line.qtyOrdered)) {
      throw new FieldError("lines", "Jumlah dipesan tidak valid.");
    }
    if (line.itemType === "accessory" && !Number.isInteger(line.qtyOrdered)) {
      throw new FieldError("lines", "Jumlah aksesoris harus bilangan bulat.");
    }
    if (!Number.isSafeInteger(line.totalAmount) || line.totalAmount < 0) throw new FieldError("lines", "Total harga tidak valid.");
    const key = `${line.itemType}:${line.itemId}`;
    if (seen.has(key)) throw new FieldError("lines", "Barang yang sama tidak boleh muncul dua kali dalam satu pesanan.");
    seen.add(key);
  }
}

/** Every line's item must exist; an accessory must still be active to be newly ordered. Read with
 * FOR SHARE so a concurrent deactivation can't slip between this check and the insert. */
async function assertItemsOrderable(tx: Tx, lines: readonly PurchaseLineInput[]): Promise<void> {
  const fabricIds = [...new Set(lines.filter((line) => line.itemType === "fabric").map((line) => line.itemId))].sort();
  const accessoryIds = [...new Set(lines.filter((line) => line.itemType === "accessory").map((line) => line.itemId))].sort();
  if (fabricIds.length > 0) {
    const rows = await tx.select({ id: fabrics.id }).from(fabrics).where(inArray(fabrics.id, fabricIds)).orderBy(fabrics.id).for("share");
    if (rows.length !== fabricIds.length) throw new FieldError("lines", "Bahan tidak ditemukan.");
  }
  if (accessoryIds.length > 0) {
    const rows = await tx
      .select({ id: accessories.id, name: accessories.name, isActive: accessories.isActive })
      .from(accessories)
      .where(inArray(accessories.id, accessoryIds))
      .orderBy(accessories.id)
      .for("share");
    if (rows.length !== accessoryIds.length) throw new FieldError("lines", "Aksesoris tidak ditemukan.");
    const inactive = rows.find((row) => !row.isActive);
    if (inactive) throw new FieldError("lines", `Aksesoris "${inactive.name}" sudah nonaktif dan tidak bisa dipesan.`);
  }
}

function lineValues(purchaseId: string, lines: readonly PurchaseLineInput[]) {
  return lines.map((line) => ({
    purchaseId,
    itemType: line.itemType,
    fabricId: line.itemType === "fabric" ? line.itemId : null,
    accessoryId: line.itemType === "accessory" ? line.itemId : null,
    qtyOrdered: line.qtyOrdered,
    totalAmount: line.totalAmount,
  }));
}

function assertOrderedAt(orderedAt: string): void {
  if (orderedAt > todayInJakarta()) throw new FieldError("orderedAt", "Tanggal pesan tidak boleh di masa depan.");
}

export async function createPurchase(input: PurchaseInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  validateLines(input.lines);
  assertOrderedAt(input.orderedAt);

  return db.transaction(async (tx) => {
    await lockSelectableSuppliers(tx, [input.supplierId], "supplierId");
    await assertItemsOrderable(tx, input.lines);
    const purchaseNo = await nextDocumentNumber(tx, "PO", purchases.purchaseNo);

    const [purchase] = await tx
      .insert(purchases)
      .values({
        purchaseNo,
        supplierId: input.supplierId,
        orderedAt: input.orderedAt,
        notes: input.notes ?? null,
        createdByStaffUserId: actorStaffUserId,
      })
      .returning();
    if (!purchase) throw new Error("failed to insert purchase");
    const lines = await tx.insert(purchaseItems).values(lineValues(purchase.id, input.lines)).returning();

    await writeAuditLog(tx, { actorStaffUserId, action: "create", entityType: "purchase", entityId: purchase.id, after: { purchase, lines } });
    return purchase;
  });
}

/** `SELECT ... FOR UPDATE` on one purchases row — the FIRST lock of every write against a
 * document (edit, receipt, reversal, close), so two people acting on the same document from two
 * phones serialize (§5's shared lock order: document row first, then item rows). */
export async function lockPurchaseForUpdate(tx: Tx, id: string): Promise<typeof purchases.$inferSelect | null> {
  const [purchase] = await tx.select().from(purchases).where(eq(purchases.id, id)).for("update");
  return purchase ?? null;
}

async function hasAnyReceipt(tx: Database, purchaseId: string): Promise<boolean> {
  const [row] = await tx.select({ id: goodsReceipts.id }).from(goodsReceipts).where(eq(goodsReceipts.purchaseId, purchaseId)).limit(1);
  return row !== undefined;
}

/** Header and lines are editable only while the document has no receipt at all (§7, D7) — the
 * prevent_received_purchase_item_change trigger is the DB backstop for the lines. The supplier
 * follows S2's rule: a NEW choice must be an active supplier; keeping the current one (even if it
 * has since been deactivated) is always allowed. Lines are replaced as a set. */
export async function updatePurchase(id: string, input: PurchaseInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  validateLines(input.lines);
  assertOrderedAt(input.orderedAt);

  return db.transaction(async (tx) => {
    const before = await lockPurchaseForUpdate(tx, id);
    if (!before) throw new ActionError("Pesanan pembelian tidak ditemukan.");
    if (before.status !== "ordered" || (await hasAnyReceipt(tx, id))) {
      throw new ActionError("Pesanan yang sudah ada penerimaan barangnya, atau sudah ditutup, tidak bisa diubah.");
    }
    if (input.supplierId !== before.supplierId) await lockSelectableSuppliers(tx, [input.supplierId], "supplierId");
    await assertItemsOrderable(tx, input.lines);

    const beforeLines = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, id));
    await tx.delete(purchaseItems).where(eq(purchaseItems.purchaseId, id));
    const lines = await tx.insert(purchaseItems).values(lineValues(id, input.lines)).returning();
    const [purchase] = await tx
      .update(purchases)
      .set({ supplierId: input.supplierId, orderedAt: input.orderedAt, notes: input.notes ?? null })
      .where(eq(purchases.id, id))
      .returning();
    if (!purchase) throw new Error("failed to update purchase");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update",
      entityType: "purchase",
      entityId: id,
      before: { purchase: before, lines: beforeLines },
      after: { purchase, lines },
    });
    return purchase;
  });
}

/** Net accepted quantity per purchase line (receipts minus reversals) — always a SUM over
 * goods_receipt_items, never a stored counter. Safe to call unlocked for display; a write that
 * decides on it must have locked the purchase row first. */
export async function getAcceptedByLine(purchaseId: string, db: Database = defaultDb): Promise<Map<string, number>> {
  const rows = await db
    .select({
      purchaseItemId: goodsReceiptItems.purchaseItemId,
      accepted: sql<string>`sum(${goodsReceiptItems.qtyAccepted})`,
    })
    .from(goodsReceiptItems)
    .innerJoin(purchaseItems, eq(purchaseItems.id, goodsReceiptItems.purchaseItemId))
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .groupBy(goodsReceiptItems.purchaseItemId);
  return new Map(rows.map((row) => [row.purchaseItemId!, Number(row.accepted)]));
}

export async function getLineProgress(purchaseId: string, db: Database): Promise<LineProgress[]> {
  const [lines, accepted] = await Promise.all([
    db.select({ id: purchaseItems.id, qtyOrdered: purchaseItems.qtyOrdered }).from(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)),
    getAcceptedByLine(purchaseId, db),
  ]);
  return lines.map((line) => ({ qtyOrdered: line.qtyOrdered, accepted: accepted.get(line.id) ?? 0 }));
}

/** D19: one close action with a required reason. `cancelled` when nothing arrived (net accepted
 * 0 on every line), `closed` otherwise. Moves no stock and changes no cost. Only an open document
 * (ordered / partially received) can be closed; a fully received one has nothing left to close. */
export async function closePurchase(id: string, reason: string, actorStaffUserId: string, db: Database = defaultDb) {
  const trimmed = reason.trim();
  if (trimmed === "") throw new FieldError("reason", "Alasan wajib diisi.");

  return db.transaction(async (tx) => {
    const before = await lockPurchaseForUpdate(tx, id);
    if (!before) throw new ActionError("Pesanan pembelian tidak ditemukan.");
    if (!isOpenPurchaseStatus(before.status)) throw new ActionError("Pesanan ini sudah selesai atau sudah ditutup.");

    const status = closedStatus(await getLineProgress(id, tx));
    const [purchase] = await tx
      .update(purchases)
      .set({ status, closedAt: new Date(), closedByStaffUserId: actorStaffUserId, closeReason: trimmed })
      .where(eq(purchases.id, id))
      .returning();
    if (!purchase) throw new Error("failed to close purchase");

    await writeAuditLog(tx, { actorStaffUserId, action: "close", entityType: "purchase", entityId: id, before, after: purchase });
    return purchase;
  });
}

// ---------- Reads ----------

export type PurchaseStatusFilter = PurchaseStatus | undefined;

export interface PurchaseDocumentListRow {
  id: string;
  purchaseNo: string;
  supplierName: string;
  orderedAt: string;
  status: PurchaseStatus;
  itemCount: number;
  /** Sum of the lines' total_amount; cost data, stripped (null) for a viewer without
   * finance.view_profit by the caller via stripPurchaseAmounts (lib/inventory/purchases.ts). */
  totalAmountPaid: number | null;
}

export async function listPurchaseDocuments(
  filters: { status?: PurchaseStatusFilter; q?: string },
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: PurchaseDocumentListRow[]; pagination: Pagination }> {
  const conditions = [
    filters.status ? eq(purchases.status, filters.status) : undefined,
    filters.q ? or(ilike(purchases.purchaseNo, `%${filters.q}%`), ilike(suppliers.name, `%${filters.q}%`)) : undefined,
  ].filter((c) => c !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const totals = db
    .select({
      purchaseId: purchaseItems.purchaseId,
      itemCount: sql<number>`count(*)::int`.as("item_count"),
      totalAmount: sql<string>`sum(${purchaseItems.totalAmount})::bigint`.as("total_amount"),
    })
    .from(purchaseItems)
    .groupBy(purchaseItems.purchaseId)
    .as("totals");

  const rows = await db
    .select({
      id: purchases.id,
      purchaseNo: purchases.purchaseNo,
      supplierName: suppliers.name,
      orderedAt: purchases.orderedAt,
      status: purchases.status,
      itemCount: sql<number>`coalesce(${totals.itemCount}, 0)`,
      totalAmount: sql<string>`coalesce(${totals.totalAmount}, 0)`,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .leftJoin(totals, eq(totals.purchaseId, purchases.id))
    .where(where)
    // Newest order date first (backed by purchases_ordered_at_idx), newest record within a day.
    .orderBy(desc(purchases.orderedAt), desc(purchases.createdAt), desc(purchases.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return {
    rows: rows.map(({ totalAmount, ...row }) => ({ ...row, itemCount: Number(row.itemCount), totalAmountPaid: Number(totalAmount) })),
    pagination,
  };
}

export interface PurchaseDocumentLine {
  id: string;
  itemType: PurchaseItemType;
  itemId: string;
  itemName: string;
  qtyOrdered: number;
  accepted: number;
  outstanding: number;
  /** Cost data — stripped by the caller for a viewer without finance.view_profit. */
  totalAmountPaid: number | null;
}

export interface PurchaseDocument {
  id: string;
  purchaseNo: string;
  supplierId: string;
  supplierName: string;
  supplierIsActive: boolean;
  orderedAt: string;
  notes: string | null;
  status: PurchaseStatus;
  closedAt: Date | null;
  closedByName: string | null;
  closeReason: string | null;
  createdAt: Date;
  createdByName: string | null;
  hasReceipts: boolean;
  lines: PurchaseDocumentLine[];
}

/** Outstanding in integer hundredths, so a fabric line of 10.00 with 9.90 accepted reads 0.10, not
 * 0.09999999999999964. */
function outstandingQty(qtyOrdered: number, accepted: number): number {
  return (Math.round(qtyOrdered * 100) - Math.round(accepted * 100)) / 100;
}

export async function getPurchaseDocument(id: string, db: Database = defaultDb): Promise<PurchaseDocument | null> {
  const createdBy = alias(staffUsers, "created_by");
  const closedBy = alias(staffUsers, "closed_by");
  const [header] = await db
    .select({
      id: purchases.id,
      purchaseNo: purchases.purchaseNo,
      supplierId: purchases.supplierId,
      supplierName: suppliers.name,
      supplierIsActive: suppliers.isActive,
      orderedAt: purchases.orderedAt,
      notes: purchases.notes,
      status: purchases.status,
      closedAt: purchases.closedAt,
      closedByName: closedBy.name,
      closeReason: purchases.closeReason,
      createdAt: purchases.createdAt,
      createdByName: createdBy.name,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .leftJoin(createdBy, eq(createdBy.id, purchases.createdByStaffUserId))
    .leftJoin(closedBy, eq(closedBy.id, purchases.closedByStaffUserId))
    .where(eq(purchases.id, id))
    .limit(1);
  if (!header) return null;

  const [lineRows, accepted, hasReceipts] = await Promise.all([
    db
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
      .where(eq(purchaseItems.purchaseId, id))
      .orderBy(asc(purchaseItems.createdAt), asc(purchaseItems.id)),
    getAcceptedByLine(id, db),
    hasAnyReceipt(db, id),
  ]);

  return {
    ...header,
    hasReceipts,
    lines: lineRows.map((line) => {
      const lineAccepted = accepted.get(line.id) ?? 0;
      return {
        id: line.id,
        itemType: line.itemType,
        itemId: (line.fabricId ?? line.accessoryId)!,
        itemName: (line.fabricName ?? line.accessoryName)!,
        qtyOrdered: line.qtyOrdered,
        accepted: lineAccepted,
        outstanding: outstandingQty(line.qtyOrdered, lineAccepted),
        totalAmountPaid: line.totalAmount,
      };
    }),
  };
}

/** The document's cost figures (each line's total) stripped for a viewer without
 * finance.view_profit — same discipline as stripPurchaseAmount, applied to every line. */
export function stripPurchaseDocumentAmounts(document: PurchaseDocument, canViewProfit: boolean): PurchaseDocument {
  if (canViewProfit) return document;
  return { ...document, lines: document.lines.map((line) => ({ ...line, totalAmountPaid: null })) };
}

export function formatPurchaseQty(itemType: PurchaseItemType, qty: number): string {
  return itemType === "fabric" ? `${qty.toFixed(2)} yard` : `${qty} pcs`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params are user input: a non-UUID id must 404, not reach Postgres as a uuid cast (22P02). */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
