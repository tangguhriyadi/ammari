import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accessories,
  fabrics,
  goodsReceiptItems,
  goodsReceipts,
  purchaseItems,
  purchases,
  staffUsers,
  supplierPayments,
  suppliers,
  type PurchaseItemType,
  type PurchaseStatus,
} from "@ammari/db/schema";
import { formatRupiah, resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { nextDocumentNumber } from "@/lib/documents/document-number";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { getDefectDispositionsByPurchaseLine, getDefectSettledByPurchaseLine } from "@/lib/defects/queries";
import { toCentiQty } from "@/lib/receipts/valuation";
import { lockSelectableSuppliers } from "@/lib/suppliers/queries";
import { getPurchasePaidState } from "@/lib/supplier-payments/purchase-paid";
import { purchaseLineTagihanSql } from "@/lib/supplier-payments/purchase-tagihan-sql";
import { summarizePayment, type PaymentSummary } from "@/lib/supplier-payments/status";
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
 * FOR SHARE so a concurrent deactivation can't slip between this check and the insert.
 * `alreadyOrderedAccessoryIds`: on an edit, accessories the document already orders stay allowed
 * even if deactivated since (same rule as the supplier: keeping the current choice is fine). */
async function assertItemsOrderable(
  tx: Tx,
  lines: readonly PurchaseLineInput[],
  alreadyOrderedAccessoryIds: ReadonlySet<string> = new Set(),
): Promise<void> {
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
    const inactive = rows.find((row) => !row.isActive && !alreadyOrderedAccessoryIds.has(row.id));
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
    // Supplier payments (docs/plans/purchase-payments.md §3.1), decided under the row lock above,
    // which every payment write takes first too. While a document is editable (ordered, nothing
    // received) its tagihan is the order total.
    const { paid, hasAnyPayment } = await getPurchasePaidState(id, tx);
    if (input.supplierId !== before.supplierId) {
      // The payee of a payment is history, voided ones included; the composite FK
      // supplier_payments_purchase_supplier_fk is the backstop for this friendly refusal.
      if (hasAnyPayment) throw new FieldError("supplierId", "Pemasok tidak bisa diganti karena sudah ada pembayaran.");
      await lockSelectableSuppliers(tx, [input.supplierId], "supplierId");
    }
    const newTotal = input.lines.reduce((sum, line) => sum + line.totalAmount, 0);
    if (newTotal < paid) {
      throw new FieldError("lines", `Total pembelian tidak boleh lebih kecil dari yang sudah dibayar (${formatRupiah(paid)}).`);
    }
    const beforeLines = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, id));
    const currentAccessoryIds = new Set(beforeLines.flatMap((line) => (line.accessoryId ? [line.accessoryId] : [])));
    await assertItemsOrderable(tx, input.lines, currentAccessoryIds);

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

export interface PurchaseLineQuantities {
  /** Net accepted into sellable stock (receipts minus reversals). */
  accepted: number;
  /** Net rejected into defect stock at receipt (receipts minus reversals, S5). */
  rejected: number;
  /** §4.2/D16 qtySettled = accepted + rejected − returned out (all net of reversals): what has used
   * up the line's ordered quantity. Outstanding is always qty_ordered − settled. */
  settled: number;
}

/** Per purchase line, always SUMs (over goods_receipt_items and the defect ledger), never a stored
 * counter. Lines with no receipt yet are absent (read as all zeros). Safe to call unlocked for
 * display; a write that decides on it must have locked the purchase row first. */
export async function getLineQuantities(purchaseId: string, db: Database = defaultDb): Promise<Map<string, PurchaseLineQuantities>> {
  const rows = await db
    .select({
      purchaseItemId: goodsReceiptItems.purchaseItemId,
      accepted: sql<string>`sum(${goodsReceiptItems.qtyAccepted})`,
      rejected: sql<string>`sum(${goodsReceiptItems.qtyRejected})`,
    })
    .from(goodsReceiptItems)
    .innerJoin(purchaseItems, eq(purchaseItems.id, goodsReceiptItems.purchaseItemId))
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .groupBy(goodsReceiptItems.purchaseItemId);
  const defectSettled = await getDefectSettledByPurchaseLine(
    rows.map((row) => row.purchaseItemId!),
    db,
  );
  return new Map(
    rows.map((row) => {
      const accepted = Number(row.accepted);
      const defect = defectSettled.get(row.purchaseItemId!)?.qty ?? 0;
      const settled = Number(toCentiQty(accepted) + toCentiQty(defect)) / 100;
      return [row.purchaseItemId!, { accepted, rejected: Number(row.rejected), settled }];
    }),
  );
}

const NO_QUANTITIES: PurchaseLineQuantities = { accepted: 0, rejected: 0, settled: 0 };

export async function getLineProgress(purchaseId: string, db: Database): Promise<LineProgress[]> {
  const [lines, quantities] = await Promise.all([
    db.select({ id: purchaseItems.id, qtyOrdered: purchaseItems.qtyOrdered }).from(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)),
    getLineQuantities(purchaseId, db),
  ]);
  return lines.map((line) => {
    const { accepted, rejected } = quantities.get(line.id) ?? NO_QUANTITIES;
    return { qtyOrdered: line.qtyOrdered, accepted, rejected };
  });
}

/** D19: one close action with a required reason. `cancelled` when nothing arrived (net accepted
 * AND net rejected 0 on every line), `closed` otherwise. Moves no stock and changes no cost. Only an open document
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

/** The /purchases "Pembayaran" filter (docs/plans/purchase-payments.md §9). "Tanpa tagihan" is
 * listed under "Semua" only; "Lunas" includes "Lebih bayar" (§3.3). */
export const PURCHASE_PAYMENT_FILTERS = ["unpaid", "partial", "paid"] as const;
export type PurchasePaymentFilter = (typeof PURCHASE_PAYMENT_FILTERS)[number];

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
  /** Derived payment state. The status is visible to every viewer of the page (A8); the amounts
   * are cost data, stripped by the caller (stripPurchaseListPaymentAmounts). */
  payment: PaymentSummary | { status: PaymentSummary["status"] };
}

export async function listPurchaseDocuments(
  filters: { status?: PurchaseStatusFilter; payment?: PurchasePaymentFilter; q?: string },
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: PurchaseDocumentListRow[]; pagination: Pagination }> {
  const totals = db
    .select({
      purchaseId: purchaseItems.purchaseId,
      itemCount: sql<number>`count(*)::int`.as("item_count"),
      totalAmount: sql<string>`sum(${purchaseItems.totalAmount})::bigint`.as("total_amount"),
      tagihan: sql<string>`sum(${purchaseLineTagihanSql()})::bigint`.as("tagihan"),
    })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
    .groupBy(purchaseItems.purchaseId)
    .as("totals");
  const paidTotals = db
    .select({
      purchaseId: supplierPayments.purchaseId,
      paid: sql<string>`sum(${supplierPayments.amount})::bigint`.as("paid"),
    })
    .from(supplierPayments)
    .where(and(isNull(supplierPayments.voidedAt), isNotNull(supplierPayments.purchaseId)))
    .groupBy(supplierPayments.purchaseId)
    .as("paid_totals");

  const tagihan = sql`coalesce(${totals.tagihan}, 0)`;
  const paid = sql`coalesce(${paidTotals.paid}, 0)`;
  const paymentCondition = {
    unpaid: sql`${paid} = 0 and ${tagihan} > 0`,
    partial: sql`${paid} > 0 and ${paid} < ${tagihan}`,
    paid: sql`${paid} > 0 and ${paid} >= ${tagihan}`,
  } satisfies Record<PurchasePaymentFilter, SQL>;

  const conditions = [
    filters.status ? eq(purchases.status, filters.status) : undefined,
    filters.payment ? paymentCondition[filters.payment] : undefined,
    filters.q ? or(ilike(purchases.purchaseNo, `%${filters.q}%`), ilike(suppliers.name, `%${filters.q}%`)) : undefined,
  ].filter((c) => c !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // The count needs the two aggregates only when it filters on them.
  const countQuery = db.select({ totalCount: count() }).from(purchases).innerJoin(suppliers, eq(suppliers.id, purchases.supplierId)).$dynamic();
  const [totalCountRow] = await (filters.payment
    ? countQuery.leftJoin(totals, eq(totals.purchaseId, purchases.id)).leftJoin(paidTotals, eq(paidTotals.purchaseId, purchases.id))
    : countQuery
  ).where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const rows = await db
    .select({
      id: purchases.id,
      purchaseNo: purchases.purchaseNo,
      supplierName: suppliers.name,
      orderedAt: purchases.orderedAt,
      status: purchases.status,
      itemCount: sql<number>`coalesce(${totals.itemCount}, 0)`,
      totalAmount: sql<string>`coalesce(${totals.totalAmount}, 0)`,
      tagihan: sql<string>`${tagihan}`,
      paid: sql<string>`${paid}`,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .leftJoin(totals, eq(totals.purchaseId, purchases.id))
    .leftJoin(paidTotals, eq(paidTotals.purchaseId, purchases.id))
    .where(where)
    // Newest order date first (backed by purchases_ordered_at_idx), newest record within a day.
    .orderBy(desc(purchases.orderedAt), desc(purchases.createdAt), desc(purchases.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return {
    rows: rows.map(({ totalAmount, tagihan: rowTagihan, paid: rowPaid, ...row }) => ({
      ...row,
      itemCount: Number(row.itemCount),
      totalAmountPaid: Number(totalAmount),
      payment: summarizePayment(Number(rowTagihan), Number(rowPaid)),
    })),
    pagination,
  };
}

/** The list's payment amounts stripped for a viewer without finance.view_profit: the badge
 * stays (A8), every amount goes. */
export function stripPurchaseListPaymentAmounts(rows: PurchaseDocumentListRow[], canViewProfit: boolean): PurchaseDocumentListRow[] {
  if (canViewProfit) return rows;
  return rows.map((row) => ({ ...row, payment: { status: row.payment.status } }));
}

export interface PurchaseDocumentLine {
  id: string;
  itemType: PurchaseItemType;
  itemId: string;
  itemName: string;
  qtyOrdered: number;
  accepted: number;
  /** Net rejected into defect stock at receipt (everything that ever arrived defective). */
  rejected: number;
  /** Still held in defect stock from this line ("Cacat"): rejected − returned − released. */
  defectHeld: number;
  /** Net returned to the supplier ("Ditukar", S6). */
  returned: number;
  /** Net released by lelang/hibah/dibuang ("Dilepas", S6). */
  released: number;
  /** qty_ordered − qtySettled (§4.2): rejects use up the ordered quantity too. */
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
  /** D18: set when a return-to-supplier re-opened a closed document ("Dibuka kembali"). */
  reopenedAt: Date | null;
  reopenedByName: string | null;
  reopenReason: string | null;
  createdAt: Date;
  createdByName: string | null;
  hasReceipts: boolean;
  lines: PurchaseDocumentLine[];
}

/** Outstanding in integer hundredths, so a fabric line of 10.00 with 9.90 settled reads 0.10, not
 * 0.09999999999999964. */
function outstandingQty(qtyOrdered: number, settled: number): number {
  return (Math.round(qtyOrdered * 100) - Math.round(settled * 100)) / 100;
}

export async function getPurchaseDocument(id: string, db: Database = defaultDb): Promise<PurchaseDocument | null> {
  const createdBy = alias(staffUsers, "created_by");
  const closedBy = alias(staffUsers, "closed_by");
  const reopenedBy = alias(staffUsers, "reopened_by");
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
      reopenedAt: purchases.reopenedAt,
      reopenedByName: reopenedBy.name,
      reopenReason: purchases.reopenReason,
      createdAt: purchases.createdAt,
      createdByName: createdBy.name,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .leftJoin(createdBy, eq(createdBy.id, purchases.createdByStaffUserId))
    .leftJoin(closedBy, eq(closedBy.id, purchases.closedByStaffUserId))
    .leftJoin(reopenedBy, eq(reopenedBy.id, purchases.reopenedByStaffUserId))
    .where(eq(purchases.id, id))
    .limit(1);
  if (!header) return null;

  const [lineRows, quantities, hasReceipts] = await Promise.all([
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
    getLineQuantities(id, db),
    hasAnyReceipt(db, id),
  ]);
  const dispositions = await getDefectDispositionsByPurchaseLine(lineRows.map((line) => line.id), db);

  return {
    ...header,
    hasReceipts,
    lines: lineRows.map((line) => {
      const { accepted, rejected, settled } = quantities.get(line.id) ?? NO_QUANTITIES;
      return {
        id: line.id,
        itemType: line.itemType,
        itemId: (line.fabricId ?? line.accessoryId)!,
        itemName: (line.fabricName ?? line.accessoryName)!,
        qtyOrdered: line.qtyOrdered,
        accepted,
        rejected,
        defectHeld: dispositions.get(line.id)?.held ?? 0,
        returned: dispositions.get(line.id)?.returned ?? 0,
        released: dispositions.get(line.id)?.released ?? 0,
        outstanding: outstandingQty(line.qtyOrdered, settled),
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
