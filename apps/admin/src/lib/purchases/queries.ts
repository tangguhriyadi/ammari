import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accessories,
  fabricColors,
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
  /** Fabric lines only (docs/plans/fabric-colour-stock.md D4). Null/absent = "Tanpa warna", allowed
   * only for a fabric without active colours, or kept from an existing line on an edit (decision
   * A2). */
  fabricColorId?: string | null;
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
    if (line.itemType !== "fabric" && line.fabricColorId) throw new FieldError("lines", "Warna hanya untuk barang jenis kain.");
    // One line per (fabric, colour): the two partial unique indexes from 0046 are the backstop.
    const key = line.itemType === "fabric" ? `fabric:${line.itemId}:${line.fabricColorId ?? "none"}` : `${line.itemType}:${line.itemId}`;
    if (seen.has(key)) throw new FieldError("lines", "Barang yang sama tidak boleh muncul dua kali dalam satu pesanan.");
    seen.add(key);
  }
}

/** What an edit keeps from the document's current lines: a choice that was valid when it was made
 * stays allowed even if the master data has changed since (same rule as the supplier). */
interface AlreadyOrdered {
  accessoryIds: ReadonlySet<string>;
  /** Colours already on the document (may have been deactivated since). */
  fabricColorIds: ReadonlySet<string>;
  /** Fabrics the document already orders as a colourless line (from before colours existed on the
   * fabric, or before fabric colour stock): such a line may be kept as is. */
  colorlessFabricIds: ReadonlySet<string>;
}

const NOTHING_ORDERED: AlreadyOrdered = { accessoryIds: new Set(), fabricColorIds: new Set(), colorlessFabricIds: new Set() };

/** Every line's item must exist; an accessory must still be active to be newly ordered. Read with
 * FOR SHARE so a concurrent deactivation can't slip between this check and the insert.
 * `alreadyOrdered`: on an edit, what the document already orders stays allowed even if the master
 * data changed since (same rule as the supplier: keeping the current choice is fine).
 *
 * Fabric colours (docs/plans/fabric-colour-stock.md D4, decision A2): a colour must belong to the
 * line's fabric and be active (or already on this document); a fabric with ≥1 active colour needs
 * a colour on every line, except a colourless line the document already had. The fabric's colours
 * are read FOR SHARE in the same transaction, so a concurrent deactivation of a chosen colour
 * waits for this one (a colour created concurrently is not seen; it only matters for the next
 * save). */
async function assertItemsOrderable(tx: Tx, lines: readonly PurchaseLineInput[], alreadyOrdered: AlreadyOrdered = NOTHING_ORDERED): Promise<void> {
  const fabricIds = [...new Set(lines.filter((line) => line.itemType === "fabric").map((line) => line.itemId))].sort();
  const accessoryIds = [...new Set(lines.filter((line) => line.itemType === "accessory").map((line) => line.itemId))].sort();
  if (fabricIds.length > 0) {
    const rows = await tx
      .select({ id: fabrics.id, name: fabrics.name })
      .from(fabrics)
      .where(inArray(fabrics.id, fabricIds))
      .orderBy(fabrics.id)
      .for("share");
    if (rows.length !== fabricIds.length) throw new FieldError("lines", "Bahan tidak ditemukan.");
    const fabricNames = new Map(rows.map((row) => [row.id, row.name]));
    const colors = await tx
      .select({ id: fabricColors.id, fabricId: fabricColors.fabricId, name: fabricColors.name, isActive: fabricColors.isActive })
      .from(fabricColors)
      .where(inArray(fabricColors.fabricId, fabricIds))
      .orderBy(fabricColors.id)
      .for("share");
    const colorsById = new Map(colors.map((color) => [color.id, color]));
    const fabricsWithActiveColors = new Set(colors.filter((color) => color.isActive).map((color) => color.fabricId));
    for (const line of lines) {
      if (line.itemType !== "fabric") continue;
      const fabricName = fabricNames.get(line.itemId)!;
      if (line.fabricColorId) {
        const color = colorsById.get(line.fabricColorId);
        if (!color || color.fabricId !== line.itemId) throw new FieldError("lines", `Warna tidak ditemukan untuk ${fabricName}.`);
        if (!color.isActive && !alreadyOrdered.fabricColorIds.has(color.id)) {
          throw new FieldError("lines", `Warna ${color.name} sudah nonaktif dan tidak bisa dipesan.`);
        }
      } else if (fabricsWithActiveColors.has(line.itemId) && !alreadyOrdered.colorlessFabricIds.has(line.itemId)) {
        throw new FieldError("lines", `Pilih warna untuk ${fabricName}.`);
      }
    }
  }
  if (accessoryIds.length > 0) {
    const rows = await tx
      .select({ id: accessories.id, name: accessories.name, isActive: accessories.isActive })
      .from(accessories)
      .where(inArray(accessories.id, accessoryIds))
      .orderBy(accessories.id)
      .for("share");
    if (rows.length !== accessoryIds.length) throw new FieldError("lines", "Aksesoris tidak ditemukan.");
    const inactive = rows.find((row) => !row.isActive && !alreadyOrdered.accessoryIds.has(row.id));
    if (inactive) throw new FieldError("lines", `Aksesoris "${inactive.name}" sudah nonaktif dan tidak bisa dipesan.`);
  }
}

function lineValues(purchaseId: string, lines: readonly PurchaseLineInput[]) {
  return lines.map((line) => ({
    purchaseId,
    itemType: line.itemType,
    fabricId: line.itemType === "fabric" ? line.itemId : null,
    accessoryId: line.itemType === "accessory" ? line.itemId : null,
    fabricColorId: line.itemType === "fabric" ? (line.fabricColorId ?? null) : null,
    qtyOrdered: line.qtyOrdered,
    totalAmount: line.totalAmount,
  }));
}

/** Audit `lines` with each line's colour name next to its id (D10), so the activity log reads
 * "Sage" without a lookup. One query for every colour on the lines. */
async function withColorNames<T extends { fabricColorId: string | null }>(tx: Tx, lines: readonly T[]): Promise<(T & { fabricColorName: string | null })[]> {
  const colorIds = [...new Set(lines.flatMap((line) => (line.fabricColorId ? [line.fabricColorId] : [])))];
  const names =
    colorIds.length === 0
      ? new Map<string, string>()
      : new Map(
          (await tx.select({ id: fabricColors.id, name: fabricColors.name }).from(fabricColors).where(inArray(fabricColors.id, colorIds))).map((row) => [
            row.id,
            row.name,
          ]),
        );
  return lines.map((line) => ({ ...line, fabricColorName: line.fabricColorId ? (names.get(line.fabricColorId) ?? null) : null }));
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

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "create",
      entityType: "purchase",
      entityId: purchase.id,
      after: { purchase, lines: await withColorNames(tx, lines) },
    });
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
    await assertItemsOrderable(tx, input.lines, {
      accessoryIds: new Set(beforeLines.flatMap((line) => (line.accessoryId ? [line.accessoryId] : []))),
      fabricColorIds: new Set(beforeLines.flatMap((line) => (line.fabricColorId ? [line.fabricColorId] : []))),
      colorlessFabricIds: new Set(beforeLines.flatMap((line) => (line.fabricId && !line.fabricColorId ? [line.fabricId] : []))),
    });

    const beforeAudit = await withColorNames(tx, beforeLines);
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
      before: { purchase: before, lines: beforeAudit },
      after: { purchase, lines: await withColorNames(tx, lines) },
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
  /** Fabric lines (docs/plans/fabric-colour-stock.md D4); all null = "Tanpa warna" (and always
   * null on an accessory line). */
  fabricColorId: string | null;
  colorName: string | null;
  colorHex: string | null;
  colorIsActive: boolean | null;
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
        fabricColorId: purchaseItems.fabricColorId,
        colorName: fabricColors.name,
        colorHex: fabricColors.hex,
        colorIsActive: fabricColors.isActive,
        qtyOrdered: purchaseItems.qtyOrdered,
        totalAmount: purchaseItems.totalAmount,
      })
      .from(purchaseItems)
      .leftJoin(fabrics, eq(fabrics.id, purchaseItems.fabricId))
      .leftJoin(accessories, eq(accessories.id, purchaseItems.accessoryId))
      .leftJoin(fabricColors, eq(fabricColors.id, purchaseItems.fabricColorId))
      .where(eq(purchaseItems.purchaseId, id))
      // Lines saved together share created_at; within one save, a fabric's colours sit together
      // (by name), "Tanpa warna" first.
      .orderBy(
        asc(purchaseItems.createdAt),
        asc(sql`coalesce(${fabrics.name}, ${accessories.name})`),
        sql`${fabricColors.name} asc nulls first`,
        asc(purchaseItems.id),
      ),
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
        fabricColorId: line.fabricColorId,
        colorName: line.colorName,
        colorHex: line.colorHex,
        colorIsActive: line.colorIsActive,
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

export interface PurchaseFabricColorOption {
  id: string;
  name: string;
  hex: string | null;
  supplierColorCode: string | null;
  isActive: boolean;
}

export interface PurchaseFabricOption {
  id: string;
  name: string;
  /** Active colours, plus `keepColorIds` (an edited document's current colours) even if inactive. */
  colors: PurchaseFabricColorOption[];
}

/** Every fabric for the purchase form's "Bahan" picker, each with the colours a line may pick
 * (docs/plans/fabric-colour-stock.md §4.1). Two queries, no N+1. */
export async function listPurchaseFabricOptions(keepColorIds: readonly string[] = [], db: Database = defaultDb): Promise<PurchaseFabricOption[]> {
  const [fabricRows, colorRows] = await Promise.all([
    db.select({ id: fabrics.id, name: fabrics.name }).from(fabrics).orderBy(asc(fabrics.name)),
    db
      .select({
        id: fabricColors.id,
        fabricId: fabricColors.fabricId,
        name: fabricColors.name,
        hex: fabricColors.hex,
        supplierColorCode: fabricColors.supplierColorCode,
        isActive: fabricColors.isActive,
      })
      .from(fabricColors)
      .where(keepColorIds.length > 0 ? or(eq(fabricColors.isActive, true), inArray(fabricColors.id, [...keepColorIds])) : eq(fabricColors.isActive, true))
      .orderBy(asc(fabricColors.name)),
  ]);
  const colorsByFabric = new Map<string, PurchaseFabricColorOption[]>();
  for (const { fabricId, ...color } of colorRows) {
    const list = colorsByFabric.get(fabricId) ?? [];
    list.push(color);
    colorsByFabric.set(fabricId, list);
  }
  return fabricRows.map((fabric) => ({ ...fabric, colors: colorsByFabric.get(fabric.id) ?? [] }));
}

export function formatPurchaseQty(itemType: PurchaseItemType, qty: number): string {
  return itemType === "fabric" ? `${qty.toFixed(2)} yard` : `${qty} pcs`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params are user input: a non-UUID id must 404, not reach Postgres as a uuid cast (22P02). */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
