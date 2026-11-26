import "server-only";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { productionBatchCosts, productionBatches, purchaseItems, purchases, supplierPayments, type PurchaseItemType } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";
import { purchaseLineTagihanSql } from "@/lib/supplier-payments/purchase-tagihan-sql";
import { monthRange } from "./figures";
import {
  batchItemLabel,
  batchPayeeOutflowStatus,
  NO_PAYEE_LABEL,
  outflowSourceHref,
  outflowTargetKey,
  paymentOrdinals,
  PRODUCTION_OUTFLOW_CATEGORY_LABEL,
  PURCHASE_OUTFLOW_ITEM_LABEL,
  purchaseItemDetail,
  purchaseOutflowStatus,
  type OutflowTarget,
  type ProductionOutflowRow,
  type ProductionOutflowSource,
} from "./production-outflow-rows";

// "Pengeluaran produksi" (docs/plans/expense-master-data.md §3.9, session S6): cash paid to
// suppliers for purchases and production batches, read LIVE from supplier_payments. Nothing is
// copied and nothing here writes. Imported only by the Biaya page (and cash-outflow.ts): the P&L
// path (summary.ts, figures.ts, report*.ts) never reads supplier_payments, so these payments reach
// Laba bersih only as HPP of sold orders (§3.11). The caller has checked ads_expenses.manage +
// finance.view_profit.

export interface ProductionOutflowFilters {
  /** "YYYY-MM": paid_at (a Jakarta calendar date) inside this month. */
  month: string;
  source?: ProductionOutflowSource;
  q?: string;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toAmount(value: string | number | null | undefined): number {
  const amount = Number(value ?? 0);
  if (!Number.isSafeInteger(amount)) throw new Error("payment amount overflow");
  return amount;
}

function targetOf(row: { targetType: string; purchaseId: string | null; productionBatchId: string | null; supplierId: string | null }): OutflowTarget {
  if (row.targetType === "purchase" && row.purchaseId) return { type: "purchase", purchaseId: row.purchaseId };
  if (row.targetType === "production_batch" && row.productionBatchId) {
    return { type: "production_batch", productionBatchId: row.productionBatchId, supplierId: row.supplierId };
  }
  // supplier_payments_exactly_one_target_check makes this unreachable.
  throw new Error("supplier payment without a target");
}

/** One month of non-voided supplier payments, newest paid date first, paginated, plus the total
 * of every row matching the filter. Range on paid_at (supplier_payments_paid_at_idx); the item
 * labels, numbering and bill status are batched lookups over the targets on THIS page only. */
export async function listProductionOutflows(
  filters: ProductionOutflowFilters,
  permissionKeys: readonly string[],
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: ProductionOutflowRow[]; pagination: Pagination; total: number }> {
  const range = monthRange(filters.month);
  const q = filters.q?.trim();
  const pattern = q ? `%${escapeLike(q)}%` : null;
  const where = and(
    isNull(supplierPayments.voidedAt),
    gte(supplierPayments.paidAt, range.from),
    lte(supplierPayments.paidAt, range.to),
    filters.source === "purchase" ? eq(supplierPayments.targetType, "purchase") : undefined,
    filters.source === "production" ? eq(supplierPayments.targetType, "production_batch") : undefined,
    pattern
      ? or(
          ilike(supplierPayments.paymentNo, pattern),
          ilike(supplierPayments.supplierName, pattern),
          ilike(purchases.purchaseNo, pattern),
          ilike(productionBatches.batchNo, pattern),
        )
      : undefined,
  );
  const [aggregate] = await db
    .select({ totalCount: count(), total: sql<string>`coalesce(sum(${supplierPayments.amount}), 0)::text` })
    .from(supplierPayments)
    .leftJoin(purchases, eq(purchases.id, supplierPayments.purchaseId))
    .leftJoin(productionBatches, eq(productionBatches.id, supplierPayments.productionBatchId))
    .where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: aggregate?.totalCount ?? 0 });

  const payments = await db
    .select({
      id: supplierPayments.id,
      paymentNo: supplierPayments.paymentNo,
      paidAt: supplierPayments.paidAt,
      amount: supplierPayments.amount,
      method: supplierPayments.method,
      targetType: supplierPayments.targetType,
      purchaseId: supplierPayments.purchaseId,
      productionBatchId: supplierPayments.productionBatchId,
      supplierId: supplierPayments.supplierId,
      supplierName: supplierPayments.supplierName,
      purchaseNo: purchases.purchaseNo,
      batchNo: productionBatches.batchNo,
    })
    .from(supplierPayments)
    .leftJoin(purchases, eq(purchases.id, supplierPayments.purchaseId))
    .leftJoin(productionBatches, eq(productionBatches.id, supplierPayments.productionBatchId))
    .where(where)
    .orderBy(desc(supplierPayments.paidAt), desc(supplierPayments.createdAt), desc(supplierPayments.paymentNo))
    .limit(pagination.limit)
    .offset(pagination.offset);

  const purchaseIds = [...new Set(payments.flatMap((row) => (row.purchaseId ? [row.purchaseId] : [])))];
  const batchIds = [...new Set(payments.flatMap((row) => (row.productionBatchId ? [row.productionBatchId] : [])))];
  const details = await loadTargetDetails(purchaseIds, batchIds, db);

  const rows = payments.map((row): ProductionOutflowRow => {
    const target = targetOf(row);
    const ordinal = details.ordinals.get(row.id);
    // Every listed row is non-voided, so it always has a number.
    if (ordinal === undefined) throw new Error(`no ordinal for payment ${row.paymentNo}`);
    const common = {
      id: row.id,
      paymentNo: row.paymentNo,
      paidAt: row.paidAt,
      amount: row.amount,
      method: row.method,
      sourceHref: outflowSourceHref(target, permissionKeys),
      categoryLabel: PRODUCTION_OUTFLOW_CATEGORY_LABEL,
      payeeName: row.supplierName ?? NO_PAYEE_LABEL,
      ordinal,
    };
    if (target.type === "purchase") {
      return {
        ...common,
        source: "purchase",
        sourceNo: row.purchaseNo ?? "-",
        itemLabel: PURCHASE_OUTFLOW_ITEM_LABEL,
        itemDetail: purchaseItemDetail(details.purchaseItemTypes.get(target.purchaseId) ?? []),
        status: purchaseOutflowStatus(details.purchaseTagihan.get(target.purchaseId) ?? 0, details.paid.get(outflowTargetKey(target)) ?? 0),
      };
    }
    const batch = details.batches.get(target.productionBatchId);
    const lines = batch?.lines ?? [];
    return {
      ...common,
      source: "production",
      sourceNo: row.batchNo ?? "-",
      itemLabel: batchItemLabel(lines.filter((line) => line.supplierId === target.supplierId).map((line) => line.componentName)),
      itemDetail: null,
      status: batch ? batchPayeeOutflowStatus(batch.status, lines, target.supplierId, details.paid.get(outflowTargetKey(target)) ?? 0) : "no_bill",
    };
  });

  return { rows, pagination, total: toAmount(aggregate?.total) };
}

interface TargetDetails {
  ordinals: Map<string, number>;
  /** Σ non-voided payments, ALL dates (the bill's current state), per outflowTargetKey (a purchase as a whole, a batch per payee). */
  paid: Map<string, number>;
  purchaseItemTypes: Map<string, PurchaseItemType[]>;
  purchaseTagihan: Map<string, number>;
  batches: Map<string, { status: "draft" | "posted"; lines: { supplierId: string | null; supplierName: string | null; componentName: string; total: number }[] }>;
}

/** Four batched reads for the page's targets: their payments (every date, voided included so the
 * numbering can skip them), the purchases' line types and tagihan, and the batches' status and
 * cost lines. */
async function loadTargetDetails(purchaseIds: readonly string[], batchIds: readonly string[], db: Database): Promise<TargetDetails> {
  const targetFilter: SQL[] = [];
  if (purchaseIds.length > 0) targetFilter.push(inArray(supplierPayments.purchaseId, [...purchaseIds]));
  if (batchIds.length > 0) targetFilter.push(inArray(supplierPayments.productionBatchId, [...batchIds]));
  if (targetFilter.length === 0) {
    return { ordinals: new Map(), paid: new Map(), purchaseItemTypes: new Map(), purchaseTagihan: new Map(), batches: new Map() };
  }

  const [allPayments, purchaseLines, batchRows, costLines] = await Promise.all([
    db
      .select({
        id: supplierPayments.id,
        targetType: supplierPayments.targetType,
        purchaseId: supplierPayments.purchaseId,
        productionBatchId: supplierPayments.productionBatchId,
        supplierId: supplierPayments.supplierId,
        paidAt: supplierPayments.paidAt,
        createdAt: supplierPayments.createdAt,
        paymentNo: supplierPayments.paymentNo,
        amount: supplierPayments.amount,
        voidedAt: supplierPayments.voidedAt,
      })
      .from(supplierPayments)
      .where(or(...targetFilter)),
    purchaseIds.length > 0
      ? db
          .select({
            purchaseId: purchaseItems.purchaseId,
            itemType: purchaseItems.itemType,
            // The PO page's tagihan, per line (purchase-payments.test.ts pins it to purchaseTagihan).
            tagihan: sql<string>`(${purchaseLineTagihanSql()})::bigint::text`,
          })
          .from(purchaseItems)
          .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
          .where(inArray(purchaseItems.purchaseId, [...purchaseIds]))
      : Promise.resolve([]),
    batchIds.length > 0
      ? db.select({ id: productionBatches.id, status: productionBatches.status }).from(productionBatches).where(inArray(productionBatches.id, [...batchIds]))
      : Promise.resolve([]),
    batchIds.length > 0
      ? db
          .select({
            productionBatchId: productionBatchCosts.productionBatchId,
            supplierId: productionBatchCosts.supplierId,
            supplierName: productionBatchCosts.supplierName,
            componentName: productionBatchCosts.componentName,
            total: productionBatchCosts.total,
          })
          .from(productionBatchCosts)
          .where(inArray(productionBatchCosts.productionBatchId, [...batchIds]))
          // The batch page's line order.
          .orderBy(asc(productionBatchCosts.createdAt), asc(productionBatchCosts.id))
      : Promise.resolve([]),
  ]);

  const ordinals = paymentOrdinals(
    allPayments.map((row) => ({ id: row.id, target: targetOf(row), paidAt: row.paidAt, createdAt: row.createdAt, paymentNo: row.paymentNo, voided: row.voidedAt !== null })),
  );
  const paid = new Map<string, number>();
  for (const row of allPayments) {
    if (row.voidedAt !== null) continue;
    const key = outflowTargetKey(targetOf(row));
    paid.set(key, toAmount((paid.get(key) ?? 0) + row.amount));
  }

  const purchaseItemTypes = new Map<string, PurchaseItemType[]>();
  const purchaseTagihan = new Map<string, number>();
  for (const line of purchaseLines) {
    purchaseItemTypes.set(line.purchaseId, [...(purchaseItemTypes.get(line.purchaseId) ?? []), line.itemType]);
    purchaseTagihan.set(line.purchaseId, toAmount((purchaseTagihan.get(line.purchaseId) ?? 0) + toAmount(line.tagihan)));
  }

  const batches: TargetDetails["batches"] = new Map(batchRows.map((row) => [row.id, { status: row.status, lines: [] }]));
  for (const line of costLines) {
    batches.get(line.productionBatchId)?.lines.push({ supplierId: line.supplierId, supplierName: line.supplierName, componentName: line.componentName, total: line.total });
  }

  return { ordinals, paid, purchaseItemTypes, purchaseTagihan, batches };
}

/** Σ non-voided supplier payments paid in the range: the "Pengeluaran produksi" tile of the cash
 * summary (cash-outflow.ts). */
export async function getProductionOutflowTotal(range: { from: string; to: string }, db: Database = defaultDb): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${supplierPayments.amount}), 0)::text` })
    .from(supplierPayments)
    .where(and(isNull(supplierPayments.voidedAt), gte(supplierPayments.paidAt, range.from), lte(supplierPayments.paidAt, range.to)));
  return toAmount(row?.total);
}
