import "server-only";
import { and, count, desc, eq, gte, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  GOODS_RECEIPT_SOURCE_TYPES,
  goodsReceiptItems,
  goodsReceipts,
  productionBatchCosts,
  productionBatches,
  purchases,
  staffUsers,
  suppliers,
  type GoodsReceiptKind,
  type GoodsReceiptSourceType,
} from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { defaultDb, type Database } from "@/lib/db";
import { isUuid } from "@/lib/purchases/queries";

// The all-receipts list (/receipts, docs/plans/suppliers-goods-receipt.md §7, S7): every goods
// receipt and reversal, both sources, newest first. Read-only; no cost data (every figure here is
// a count or a flag), so nothing is gated behind finance.view_profit.

/** "active" = a receipt not reversed; "reversed" = a receipt later cancelled ("Dibatalkan");
 * "reversal" = the cancelling document itself ("Pembatalan"). */
export const RECEIPT_LIST_STATUSES = ["active", "reversed", "reversal"] as const;
export type ReceiptListStatus = (typeof RECEIPT_LIST_STATUSES)[number];

export interface ReceiptListFilters {
  source?: GoodsReceiptSourceType;
  /** A purchase's supplier, or any supplier on one of a batch's cost lines (its tailor). */
  supplierId?: string;
  /** Inclusive Jakarta calendar dates on `received_at`. */
  dateFrom?: string;
  dateTo?: string;
  status?: ReceiptListStatus;
}

function isCalendarDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** URL search params to filters: anything malformed is dropped (the list then shows unfiltered on
 * that axis) rather than reaching SQL. A range typed backwards is swapped. */
export function parseReceiptListFilters(raw: { source?: string; supplier?: string; from?: string; to?: string; status?: string }): ReceiptListFilters {
  const filters: ReceiptListFilters = {};
  const source = GOODS_RECEIPT_SOURCE_TYPES.find((value) => value === raw.source);
  if (source) filters.source = source;
  if (raw.supplier && isUuid(raw.supplier)) filters.supplierId = raw.supplier;
  const status = RECEIPT_LIST_STATUSES.find((value) => value === raw.status);
  if (status) filters.status = status;
  let from = isCalendarDate(raw.from) ? raw.from : undefined;
  let to = isCalendarDate(raw.to) ? raw.to : undefined;
  if (from && to && from > to) [from, to] = [to, from];
  if (from) filters.dateFrom = from;
  if (to) filters.dateTo = to;
  return filters;
}

export type ReceiptListSource =
  | { type: "purchase"; id: string; documentNo: string }
  | { type: "production_batch"; id: string; documentNo: string };

export interface GoodsReceiptListRow {
  id: string;
  receiptNo: string;
  kind: GoodsReceiptKind;
  status: ReceiptListStatus;
  receivedAt: string;
  receivedByName: string | null;
  createdAt: Date;
  createdByName: string | null;
  reversesReceiptNo: string | null;
  source: ReceiptListSource;
  /** The purchase's supplier; for a batch, the suppliers on its cost lines (often none). */
  supplierNames: string[];
  lineCount: number;
  /** Any line recorded a "Ditolak (cacat)" quantity. */
  hasRejects: boolean;
}

function filterConditions(filters: ReceiptListFilters): SQL | undefined {
  const supplierMatch = filters.supplierId
    ? or(
        and(eq(goodsReceipts.sourceType, "purchase"), eq(purchases.supplierId, filters.supplierId)),
        and(
          eq(goodsReceipts.sourceType, "production_batch"),
          sql`exists (select 1 from ${productionBatchCosts} where ${qualifiedColumn(productionBatchCosts, productionBatchCosts.productionBatchId)} = ${qualifiedColumn(goodsReceipts, goodsReceipts.productionBatchId)} and ${qualifiedColumn(productionBatchCosts, productionBatchCosts.supplierId)} = ${filters.supplierId})`,
        ),
      )
    : undefined;
  const statusMatch =
    filters.status === "reversal"
      ? eq(goodsReceipts.kind, "reversal")
      : filters.status === "reversed"
        ? and(eq(goodsReceipts.kind, "receipt"), isNotNull(goodsReceipts.reversedAt))
        : filters.status === "active"
          ? and(eq(goodsReceipts.kind, "receipt"), isNull(goodsReceipts.reversedAt))
          : undefined;
  const conditions = [
    filters.source ? eq(goodsReceipts.sourceType, filters.source) : undefined,
    supplierMatch,
    filters.dateFrom ? gte(goodsReceipts.receivedAt, filters.dateFrom) : undefined,
    filters.dateTo ? lte(goodsReceipts.receivedAt, filters.dateTo) : undefined,
    statusMatch,
  ].filter((condition) => condition !== undefined);
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function listGoodsReceipts(
  filters: ReceiptListFilters,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: GoodsReceiptListRow[]; pagination: Pagination }> {
  const where = filterConditions(filters);
  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(goodsReceipts)
    .leftJoin(purchases, eq(purchases.id, goodsReceipts.purchaseId))
    .where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const reversed = alias(goodsReceipts, "reversed");
  const receiptId = qualifiedColumn(goodsReceipts, goodsReceipts.id);
  const itemReceiptId = qualifiedColumn(goodsReceiptItems, goodsReceiptItems.goodsReceiptId);
  const rows = await db
    .select({
      id: goodsReceipts.id,
      receiptNo: goodsReceipts.receiptNo,
      kind: goodsReceipts.kind,
      sourceType: goodsReceipts.sourceType,
      receivedAt: goodsReceipts.receivedAt,
      receivedByName: goodsReceipts.receivedByName,
      reversedAt: goodsReceipts.reversedAt,
      createdAt: goodsReceipts.createdAt,
      createdByName: staffUsers.name,
      reversesReceiptNo: reversed.receiptNo,
      purchaseId: purchases.id,
      purchaseNo: purchases.purchaseNo,
      purchaseSupplierName: suppliers.name,
      batchId: productionBatches.id,
      batchNo: productionBatches.batchNo,
      // Correlated subqueries run only for the page's rows (goods_receipt_items_goods_receipt_id
      // backs both; production_batch_costs_production_batch_id the third).
      lineCount: sql<number>`(select count(*)::int from ${goodsReceiptItems} where ${itemReceiptId} = ${receiptId})`,
      hasRejects: sql<boolean>`exists (select 1 from ${goodsReceiptItems} where ${itemReceiptId} = ${receiptId} and ${qualifiedColumn(goodsReceiptItems, goodsReceiptItems.qtyRejected)} <> 0)`,
      batchSupplierNames: sql<string[]>`array(select distinct ${qualifiedColumn(suppliers, suppliers.name)}::text from ${productionBatchCosts} join ${suppliers} on ${qualifiedColumn(suppliers, suppliers.id)} = ${qualifiedColumn(productionBatchCosts, productionBatchCosts.supplierId)} where ${qualifiedColumn(productionBatchCosts, productionBatchCosts.productionBatchId)} = ${qualifiedColumn(goodsReceipts, goodsReceipts.productionBatchId)} order by 1)`,
    })
    .from(goodsReceipts)
    .leftJoin(purchases, eq(purchases.id, goodsReceipts.purchaseId))
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .leftJoin(productionBatches, eq(productionBatches.id, goodsReceipts.productionBatchId))
    .leftJoin(staffUsers, eq(staffUsers.id, goodsReceipts.createdByStaffUserId))
    .leftJoin(reversed, eq(reversed.id, goodsReceipts.reversesReceiptId))
    .where(where)
    // Newest receipt date first (goods_receipts_received_at_idx), newest record within a day.
    .orderBy(desc(goodsReceipts.receivedAt), desc(goodsReceipts.createdAt), desc(goodsReceipts.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return {
    rows: rows.map((row) => {
      const source: ReceiptListSource =
        row.sourceType === "purchase"
          ? { type: "purchase", id: row.purchaseId!, documentNo: row.purchaseNo! }
          : { type: "production_batch", id: row.batchId!, documentNo: row.batchNo! };
      return {
        id: row.id,
        receiptNo: row.receiptNo,
        kind: row.kind,
        status: row.kind === "reversal" ? "reversal" : row.reversedAt ? "reversed" : "active",
        receivedAt: row.receivedAt,
        receivedByName: row.receivedByName,
        createdAt: row.createdAt,
        createdByName: row.createdByName,
        reversesReceiptNo: row.reversesReceiptNo,
        source,
        supplierNames: row.sourceType === "purchase" ? [row.purchaseSupplierName!] : row.batchSupplierNames,
        lineCount: Number(row.lineCount),
        hasRejects: row.hasRejects,
      };
    }),
    pagination,
  };
}
