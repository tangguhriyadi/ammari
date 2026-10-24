import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { productionBatchCosts, productionBatches, purchaseItems, purchases, supplierPayments, type PurchaseStatus } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import { defaultDb, type Database } from "@/lib/db";
import { purchaseLineTagihanSql } from "./purchase-tagihan-sql";
import { summarizePayment, type PaymentSummary } from "./status";

// "Total utang" per supplier (docs/plans/purchase-payments.md P9, A3, §9, session S5): what we
// still owe a supplier over every document that bills them, i.e. their purchase documents (§3.1)
// plus their share, as a payee, of posted production batches' service lines (§3.2). Derived on
// every read, never stored (P3). Voided payments never count (P6).
//
// One overpaid document never settles another: a purchase cancelled under its DP is "Lebih bayar"
// on its own (A4, the refund is recorded later), so the balance keeps the two figures apart
// instead of netting them.

export type SupplierDocumentKind = "purchase" | "production_batch";

export interface SupplierDocumentAmounts {
  tagihan: number;
  paid: number;
}

export interface SupplierBalance {
  /** Σ remaining over the supplier's documents. */
  outstanding: number;
  /** Σ paid above the bill, over the documents that are overpaid. */
  overpaid: number;
  /** Documents with something left to pay. */
  openDocuments: number;
}

export const EMPTY_SUPPLIER_BALANCE: SupplierBalance = { outstanding: 0, overpaid: 0, openDocuments: 0 };

/** Pure: each document is summarized on its own (summarizePayment), then summed. */
export function supplierBalance(documents: readonly SupplierDocumentAmounts[]): SupplierBalance {
  let outstanding = 0;
  let overpaid = 0;
  let openDocuments = 0;
  for (const document of documents) {
    const summary = summarizePayment(document.tagihan, document.paid);
    outstanding += summary.remaining;
    overpaid += summary.overpaid;
    if (summary.remaining > 0) openDocuments += 1;
  }
  if (!Number.isSafeInteger(outstanding) || !Number.isSafeInteger(overpaid)) throw new Error("supplier balance overflow");
  return { outstanding, overpaid, openDocuments };
}

/** Every billing document per supplier, one row each, as a SQL union (§3.1 + §3.2):
 *
 * - purchases: tagihan per purchaseLineTagihanSql (a cancelled one is due 0, so it only ever
 *   shows up as "Lebih bayar" when it was paid), paid = Σ its non-voided payments.
 * - posted batches, one row per (batch, payee supplier): tagihan = Σ the service lines naming that
 *   supplier, paid = Σ the non-voided payments to that payee on that batch. Drafts have no
 *   tagihan; unattributed lines ("Tanpa pemasok") belong to no supplier.
 *
 * `supplierIds` narrows both halves (pushed into each WHERE, not filtered after the union). */
function supplierDocumentsSql(supplierIds?: readonly string[]): SQL {
  const purchaseId = qualifiedColumn(purchases, purchases.id);
  const purchaseSupplierId = qualifiedColumn(purchases, purchases.supplierId);
  const costSupplierId = qualifiedColumn(productionBatchCosts, productionBatchCosts.supplierId);
  const batchId = qualifiedColumn(productionBatches, productionBatches.id);
  const paymentAmount = qualifiedColumn(supplierPayments, supplierPayments.amount);
  const paymentVoidedAt = qualifiedColumn(supplierPayments, supplierPayments.voidedAt);
  const idList = supplierIds ? sql.join(supplierIds.map((id) => sql`${id}::uuid`), sql`, `) : undefined;

  return sql`
    select ${purchaseSupplierId} as supplier_id,
           'purchase' as kind,
           ${purchaseId} as document_id,
           ${qualifiedColumn(purchases, purchases.purchaseNo)} as document_no,
           ${qualifiedColumn(purchases, purchases.orderedAt)} as document_date,
           ${qualifiedColumn(purchases, purchases.createdAt)} as created_at,
           ${qualifiedColumn(purchases, purchases.status)} as purchase_status,
           coalesce((select sum(${purchaseLineTagihanSql()}) from ${purchaseItems}
             where ${qualifiedColumn(purchaseItems, purchaseItems.purchaseId)} = ${purchaseId}), 0)::bigint as tagihan,
           coalesce((select sum(${paymentAmount}) from ${supplierPayments}
             where ${qualifiedColumn(supplierPayments, supplierPayments.purchaseId)} = ${purchaseId}
               and ${paymentVoidedAt} is null), 0)::bigint as paid
    from ${purchases}
    ${idList ? sql`where ${purchaseSupplierId} in (${idList})` : sql``}
    union all
    select ${costSupplierId} as supplier_id,
           'production_batch' as kind,
           ${batchId} as document_id,
           ${qualifiedColumn(productionBatches, productionBatches.batchNo)} as document_no,
           ${qualifiedColumn(productionBatches, productionBatches.producedAt)} as document_date,
           ${qualifiedColumn(productionBatches, productionBatches.createdAt)} as created_at,
           null as purchase_status,
           sum(${qualifiedColumn(productionBatchCosts, productionBatchCosts.total)})::bigint as tagihan,
           coalesce((select sum(${paymentAmount}) from ${supplierPayments}
             where ${qualifiedColumn(supplierPayments, supplierPayments.productionBatchId)} = ${batchId}
               and ${qualifiedColumn(supplierPayments, supplierPayments.supplierId)} = ${costSupplierId}
               and ${paymentVoidedAt} is null), 0)::bigint as paid
    from ${productionBatchCosts}
    inner join ${productionBatches} on ${batchId} = ${qualifiedColumn(productionBatchCosts, productionBatchCosts.productionBatchId)}
    where ${qualifiedColumn(productionBatches, productionBatches.status)} = 'posted'
      and ${costSupplierId} is not null
      ${idList ? sql`and ${costSupplierId} in (${idList})` : sql``}
    group by ${costSupplierId}, ${batchId}
  `;
}

/** The supplier ids with something left to pay, as a subquery for listSuppliers' "Ada utang"
 * filter (`suppliers.id in (...)`). */
export function owedSupplierIdsSql(): SQL {
  return sql`select docs.supplier_id from (${supplierDocumentsSql()}) docs
    group by docs.supplier_id having sum(greatest(docs.tagihan - docs.paid, 0)) > 0`;
}

type BalanceRow = { supplier_id: string; outstanding: string; overpaid: string; open_documents: string };

/** Balances of the given suppliers (a list page's rows). A supplier with no billing document gets
 * EMPTY_SUPPLIER_BALANCE. Amounts are cost data: call only for a viewer with finance.view_profit. */
export async function getSupplierBalances(supplierIds: readonly string[], db: Database = defaultDb): Promise<Map<string, SupplierBalance>> {
  const balances = new Map<string, SupplierBalance>(supplierIds.map((id) => [id, EMPTY_SUPPLIER_BALANCE]));
  if (supplierIds.length === 0) return balances;
  // Same arithmetic as supplierBalance (remaining and overpaid per document, then summed);
  // supplier-balance.test.ts asserts the two agree.
  const rows = await db.execute<BalanceRow>(sql`
    select docs.supplier_id,
           sum(greatest(docs.tagihan - docs.paid, 0))::bigint as outstanding,
           sum(greatest(docs.paid - docs.tagihan, 0))::bigint as overpaid,
           count(*) filter (where docs.tagihan > docs.paid)::int as open_documents
    from (${supplierDocumentsSql(supplierIds)}) docs
    group by docs.supplier_id
  `);
  for (const row of rows) {
    const balance = { outstanding: Number(row.outstanding), overpaid: Number(row.overpaid), openDocuments: Number(row.open_documents) };
    if (!Number.isSafeInteger(balance.outstanding) || !Number.isSafeInteger(balance.overpaid)) throw new Error("supplier balance overflow");
    balances.set(row.supplier_id, balance);
  }
  return balances;
}

export interface SupplierPayableDocument {
  kind: SupplierDocumentKind;
  id: string;
  documentNo: string;
  /** ordered_at for a purchase, produced_at for a batch (YYYY-MM-DD). */
  documentDate: string;
  /** Only for a purchase. */
  purchaseStatus: PurchaseStatus | null;
  payment: PaymentSummary;
}

type DocumentRow = {
  kind: SupplierDocumentKind;
  document_id: string;
  document_no: string;
  document_date: string;
  purchase_status: PurchaseStatus | null;
  tagihan: string;
  paid: string;
};

/** The supplier detail breakdown (§9): their documents still unpaid, on a DP, or overpaid,
 * newest first, plus the balance over them. A settled ("Lunas") or bill-less document is left out:
 * it neither adds to nor explains the balance. Cost data: finance.view_profit only. */
export async function getSupplierPayables(
  supplierId: string,
  db: Database = defaultDb,
): Promise<{ documents: SupplierPayableDocument[]; balance: SupplierBalance }> {
  const rows = await db.execute<DocumentRow>(sql`
    select docs.kind, docs.document_id, docs.document_no, docs.document_date::text as document_date, docs.purchase_status, docs.tagihan, docs.paid
    from (${supplierDocumentsSql([supplierId])}) docs
    where docs.tagihan <> docs.paid
    order by docs.document_date desc, docs.created_at desc, docs.document_id desc
  `);
  const documents = rows.map((row) => ({
    kind: row.kind,
    id: row.document_id,
    documentNo: row.document_no,
    documentDate: row.document_date,
    purchaseStatus: row.purchase_status,
    payment: summarizePayment(Number(row.tagihan), Number(row.paid)),
  }));
  return { documents, balance: supplierBalance(documents.map((document) => document.payment)) };
}
