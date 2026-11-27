import "server-only";
import { sql } from "drizzle-orm";
import { batchWipAsOf, bookSegmentOf, jakartaDateOf, orderAccountMovements, segmentStartOf, type BookSegment } from "@ammari/accounting";
import { checkPostingCompleteness, loadOrderSnapshots, loadProductionBatchSnapshots, type PostingCompleteness } from "@ammari/accounting/runner";
import type { ChannelId } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";
import {
  biteshipDifference,
  reconcileMaterial,
  reconcileOrderAccount,
  reconcilePayable,
  reconcileStockAccount,
  reconcileWipBatch,
  type MaterialReconciliation,
  type OrderAccountReconciliation,
  type PayableReconciliation,
  type ReconciliationStatus,
  type StockAccountReconciliation,
  type WipBatchReconciliation,
} from "./reconciliation-rules";

// Rekonsiliasi (docs/plans/accounting.md §6.3, Sessions 7, 8 and 9): check 1 for inventory (1-1501
// kain, 1-1502 aksesoris vs the raw-material ledgers; 1-1503 barang dalam proses per batch; 1-1504
// barang jadi vs stock_movements; 1-1506 barang cacat vs defect_movements) and check 2 for supplier
// payables (utang per purchase document vs the app's tagihan); Session 9: check 1 for 1-1505 and checks 3
// (2-1201 Uang muka pelanggan), 3b (1-1603 Saldo Biteship vs the dashboard) and 3c (2-1203 Titipan
// ongkir pembeli), per order. Read-only. The ledger side is summed within one set of books
// (books.ts): from 1 Dec 2026 for the trial month, from the cut-over 1 Jan 2027 for the official
// books (the opening journal included), so the stock side uses the same window: in the official
// books everything before the cut-over is the opening balance; in the trial month nothing before
// 1 Dec 2026 is booked at all.
//
// The stock side dates a movement by its economic date, the same date its journal carries: a
// receipt's received_at (not when it was typed in), a production consumption its batch's posted_at
// (R1), a defect its occurred_at, created_at (Jakarta) otherwise.

export interface MaterialRow extends MaterialReconciliation {
  accountCode: string;
  accountName: string;
  material: "fabric" | "accessory";
}

export interface PayableRow extends PayableReconciliation {
  purchaseId: string;
  purchaseNo: string;
  supplierId: string;
  supplierName: string;
}

export type StockAccountKind = "wip" | "finished" | "defect";

export interface StockAccountRow extends StockAccountReconciliation {
  accountCode: string;
  accountName: string;
  kind: StockAccountKind;
}

export interface WipBatchRow extends WipBatchReconciliation {
  batchId: string;
  batchNo: string;
}

export type SalesCheckKind = "sold_not_shipped" | "deposit" | "buyer_shipping";

export interface SalesOrderRow extends OrderAccountReconciliation {
  orderId: string;
  orderNo: string;
  channelId: ChannelId;
  /** The order waits for data the records do not have yet (a marketplace ship time, a manual
   * payment record): its journal is a posting issue. */
  pending: boolean;
}

export interface SalesCheck {
  kind: SalesCheckKind;
  accountCode: string;
  accountName: string;
  /** The whole account in the window, as a balance on its normal side. */
  ledgerTotal: number;
  /** The part on no order's lines (manual and opening journals). */
  outsideOrders: number;
  /** Orders with a balance or a difference, mismatches first, at most SALES_ROWS_LIMIT. */
  rows: SalesOrderRow[];
  /** How many orders had a balance or a difference before the limit. */
  rowCount: number;
  mismatchCount: number;
}

export interface BiteshipCheck {
  accountCode: string;
  accountName: string;
  ledger: number;
  /** Bookings and their cancels (W9, W10). */
  bookings: number;
  /** Everything else: top-ups and corrections by manual journal, the opening balance. */
  otherJournals: number;
  typed: number | null;
  difference: number | null;
}

export const SALES_ROWS_LIMIT = 50;

export interface Reconciliation {
  asOf: string;
  segment: BookSegment;
  segmentStart: string;
  materials: MaterialRow[];
  /** 1-1503, 1-1504 and 1-1506 (Session 8). */
  stockAccounts: StockAccountRow[];
  /** Work in progress per production batch, the ones with anything to show. */
  wipBatches: WipBatchRow[];
  payables: PayableRow[];
  /** Σ 2-1101 on the ledger and the part no purchase document explains (manual and opening
   * journals). */
  payableLedgerTotal: number;
  payableOutsideDocuments: number;
  /** Session 9: 1-1505, 2-1201, 2-1203 per order. */
  salesChecks: SalesCheck[];
  biteship: BiteshipCheck;
}

const STATUS_ORDER: Record<ReconciliationStatus, number> = { mismatch: 0, review: 1, explained: 2, ok: 3 };

const num = (value: string | number | null | undefined) => Number(value ?? 0);

/** The account a system key or mapping points at (null when the chart lost it). */
async function accountByKey(db: Database): Promise<Map<string, { code: string; name: string }>> {
  const rows = (await db.execute(sql`
    select a.system_key as key, a.code, a.name::text as name from accounts a where a.system_key is not null
    union all
    select m.mapping_key as key, a.code, a.name::text as name from account_mappings m join accounts a on a.code = m.account_code
  `)) as unknown as { key: string; code: string; name: string }[];
  return new Map(rows.map((row) => [row.key, { code: row.code, name: row.name }]));
}

/** A journal counts on its source's own date: a correction booked in the first open month because
 * its month was closed (D-23) keeps `source_date`, the date the stock and app side use too, so it
 * never shows as a mismatch for the month it really belongs to. Manual and opening journals have
 * no source date and count on their entry date. */
const EFFECTIVE_DATE = sql.raw("coalesce(e.source_date, e.entry_date)");

async function ledgerBalance(db: Database, accountCode: string, from: string, to: string): Promise<number> {
  const [row] = (await db.execute(sql`
    select coalesce(sum(l.debit - l.credit), 0)::bigint as net
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.account_code = ${accountCode} and ${EFFECTIVE_DATE} >= ${from} and ${EFFECTIVE_DATE} <= ${to}
  `)) as unknown as { net: string }[];
  return num(row?.net);
}

/** Check 1 for one raw-material stock ledger. Table names are fixed literals, never input. */
async function materialFigures(db: Database, table: "fabric_stock_movements" | "accessory_movements", from: string, to: string, official: boolean) {
  const movements = sql.identifier(table);
  const [row] = (await db.execute(sql`
    with m as (
      select m.type, m.ref_type, m.value_amount,
        case
          when m.ref_type = 'goods_receipt' then gr.received_at
          when m.ref_type = 'production_batch' and pb.posted_at is not null then (pb.posted_at at time zone 'Asia/Jakarta')::date
          else (m.created_at at time zone 'Asia/Jakarta')::date
        end as d,
        ogr.received_at as original_d
      from ${movements} m
      left join goods_receipt_items gri on m.ref_type = 'goods_receipt' and gri.id::text = m.ref_id
      left join goods_receipts gr on gr.id = gri.goods_receipt_id
      left join goods_receipts ogr on ogr.id = gr.reverses_receipt_id
      left join production_batches pb on m.ref_type = 'production_batch' and pb.id::text = m.ref_id
    )
    select
      coalesce(sum(value_amount) filter (where ${official}::boolean and d < ${from}), 0)::bigint as before_books,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to} and ref_type = 'goods_receipt' and type = 'purchase'), 0)::bigint as receipts,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to} and ref_type = 'goods_receipt' and type = 'purchase_void' and original_d >= ${from}), 0)::bigint as receipt_reversals,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to} and ref_type = 'goods_receipt' and type = 'purchase_void' and original_d < ${from}), 0)::bigint as voids_before_books,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to} and type = 'adjustment'), 0)::bigint as adjustments,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to} and type = 'production'), 0)::bigint as production,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to} and ref_type = 'manual' and type in ('purchase', 'purchase_void')), 0)::bigint as legacy
    from m
  `)) as unknown as Record<string, string>[];
  return {
    beforeBooks: num(row?.before_books),
    receipts: num(row?.receipts),
    receiptReversals: num(row?.receipt_reversals),
    voidsBeforeBooks: num(row?.voids_before_books),
    adjustments: num(row?.adjustments),
    production: num(row?.production),
    legacy: num(row?.legacy),
  };
}

/** The day before a calendar date: "2027-01-01" -> "2026-12-31". */
function dayBefore(date: string): string {
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) - 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Check 1 for 1-1504 against stock_movements. A production receipt counts on its received_at (R2),
 * everything else on created_at (Jakarta). */
async function finishedFigures(db: Database, from: string, to: string, official: boolean) {
  const [row] = (await db.execute(sql`
    with m as (
      select m.type, m.ref_type, m.value_amount,
        case when m.ref_type = 'goods_receipt_item' then gr.received_at else (m.created_at at time zone 'Asia/Jakarta')::date end as d,
        ogr.received_at as original_d,
        -- A return held behind its sale (S2 waits while the order's recognition is blocked by
        -- marketplace_ship_date_missing, rules/sales.ts): no active S2 journal, the issue open.
        (m.type = 'return'
          and not exists (select 1 from journal_entries je where je.source_type = 'stock_movement' and je.source_id = m.id::text and je.source_event = 'return'
            and je.kind = 'system' and je.reversed_by_entry_id is null)
          and exists (select 1 from posting_issues pi where pi.source_type = 'order' and pi.source_id = oi.order_id::text and pi.source_event = 'recognised'
            and pi.issue_code = 'marketplace_ship_date_missing' and pi.resolved_at is null)) as held_return
      from stock_movements m
      left join order_items oi on m.ref_type = 'order_item' and oi.id::text = m.ref_id
      left join goods_receipt_items gri on m.ref_type = 'goods_receipt_item' and gri.id::text = m.ref_id
      left join goods_receipts gr on gr.id = gri.goods_receipt_id
      left join goods_receipts ogr on ogr.id = gr.reverses_receipt_id
    )
    select
      coalesce(sum(value_amount) filter (where ${official}::boolean and d < ${from}), 0)::bigint as before_books,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to}), 0)::bigint as in_window,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to} and ref_type = 'goods_receipt_item' and original_d < ${from}), 0)::bigint as voids_before_books,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to} and held_return), 0)::bigint as held_returns,
      coalesce(sum(value_amount) filter (where d >= ${from} and d <= ${to} and ref_type = 'production_batch_item'), 0)::bigint as legacy
    from m
  `)) as unknown as Record<string, string>[];
  return {
    stockValue: num(row?.before_books) + num(row?.in_window),
    notJournaled: [
      { label: "Retur pesanan marketplace yang penjualannya menunggu tanggal kirim asli", value: num(row?.held_returns) },
      { label: "Stok produksi cara lama (ditambah saat posting batch)", value: num(row?.legacy) },
      { label: "Pembatalan penerimaan dari sebelum pembukuan", value: num(row?.voids_before_books) },
    ],
  };
}

/** Check 1 for 1-1506 against defect_movements, each row on its occurred_at. */
async function defectFigures(db: Database, from: string, to: string, official: boolean) {
  const [row] = (await db.execute(sql`
    select
      coalesce(sum(d.value_amount) filter (where ${official}::boolean and d.occurred_at < ${from}), 0)::bigint as before_books,
      coalesce(sum(d.value_amount) filter (where d.occurred_at >= ${from} and d.occurred_at <= ${to}), 0)::bigint as in_window,
      coalesce(sum(d.value_amount) filter (where d.occurred_at >= ${from} and d.occurred_at <= ${to} and o.occurred_at < ${from}), 0)::bigint as voids_before_books
    from defect_movements d
    left join defect_movements o on o.id = d.reverses_movement_id
  `)) as unknown as Record<string, string>[];
  return {
    stockValue: num(row?.before_books) + num(row?.in_window),
    notJournaled: [{ label: "Pembatalan dari sebelum pembukuan", value: num(row?.voids_before_books) }],
  };
}

/** The 1-1503 lines of every production batch's own journals (R1, R2, R3, R5) in the window, by batch. */
async function wipLedgerByBatch(db: Database, wipAccount: string, from: string, to: string): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    select batch_id, sum(net)::bigint as net from (
      select l.debit - l.credit as net,
        case e.source_type
          when 'production_batch' then e.source_id::uuid
          when 'goods_receipt_item' then (select gr.production_batch_id from goods_receipt_items gri join goods_receipts gr on gr.id = gri.goods_receipt_id where gri.id = e.source_id::uuid)
          when 'defect_movement' then (select pbi.production_batch_id from defect_movements d join production_batch_items pbi on pbi.id = d.production_batch_item_id where d.id = e.source_id::uuid)
        end as batch_id
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where l.account_code = ${wipAccount} and ${EFFECTIVE_DATE} >= ${from} and ${EFFECTIVE_DATE} <= ${to}
        and e.source_type in ('production_batch', 'goods_receipt_item', 'defect_movement')
    ) x where batch_id is not null group by batch_id
  `)) as unknown as { batch_id: string; net: string }[];
  return new Map(rows.map((row) => [row.batch_id, num(row.net)]));
}

/** Check 1 for 1-1503: per batch (its own records vs its own journals) and in total. */
async function wipReconciliation(db: Database, wipAccount: string, from: string, to: string, official: boolean) {
  const [batches, ledgerByBatch, ledgerTotal] = await Promise.all([loadProductionBatchSnapshots(db), wipLedgerByBatch(db, wipAccount, from, to), ledgerBalance(db, wipAccount, from, to)]);
  const lastDayBefore = dayBefore(from);
  const rows: WipBatchRow[] = [];
  let stockValue = 0;
  let beforeBooksTotal = 0;
  for (const batch of batches) {
    if (batch.status !== "posted" || !batch.postedAt || batch.hasLegacyStock) continue;
    const startsBeforeBooks = jakartaDateOf(batch.postedAt) < from;
    const appWip = batchWipAsOf(batch, to);
    const before = startsBeforeBooks ? batchWipAsOf(batch, lastDayBefore) : 0;
    const row: WipBatchRow = {
      batchId: batch.id,
      batchNo: batch.batchNo,
      ...reconcileWipBatch({
        appWip: appWip ?? 0,
        beforeBooks: before ?? 0,
        ledger: ledgerByBatch.get(batch.id) ?? 0,
        startsBeforeBooks,
        valueMissing: appWip === null || before === null,
      }),
    };
    stockValue += row.appWip;
    beforeBooksTotal += row.beforeBooks;
    if (row.appWip !== 0 || row.ledger !== 0 || row.difference !== 0 || row.status === "mismatch") rows.push(row);
  }
  rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.batchNo.localeCompare(b.batchNo));
  // Official books: the opening journal (in the ledger total) carries what was in process at the
  // cut-over. Trial month: no opening, so a batch's pre-December part is in no journal.
  const notJournaled = official ? [] : [{ label: "Sisa batch dari sebelum pembukuan (bulan uji coba tanpa saldo awal)", value: beforeBooksTotal }];
  return { rows, account: reconcileStockAccount({ ledger: ledgerTotal, stockValue, notJournaled }) };
}

interface PayableQueryRow {
  purchase_id: string;
  purchase_no: string;
  supplier_id: string;
  supplier_name: string;
  tagihan: string;
  paid: string;
  net_received: string;
  ledger_payable: string;
  ledger_advance: string;
  ledger_claim: string;
  starts_before: boolean;
}

/** Check 2, one row per purchase document with anything to show. The tagihan mirrors
 * purchaseLineTagihanSql (lib/supplier-payments/purchase-tagihan-sql.ts) and follows the
 * document's CURRENT status; payments, receipts and journals are counted up to `to`. */
async function payableRows(db: Database, keys: { payable: string; advance: string; claim: string }, from: string, to: string): Promise<PayableQueryRow[]> {
  return (await db.execute(sql`
    with doc_journal as (
      select l.account_code, l.debit - l.credit as net,
        case e.source_type
          when 'goods_receipt_item' then (select gr.purchase_id from goods_receipt_items gri join goods_receipts gr on gr.id = gri.goods_receipt_id where gri.id = e.source_id::uuid)
          when 'supplier_payment' then (select sp.purchase_id from supplier_payments sp where sp.id = e.source_id::uuid)
          when 'purchase' then (select p.id from purchases p where p.id = e.source_id::uuid)
          when 'defect_movement' then (select pi.purchase_id from defect_movements d join purchase_items pi on pi.id = d.purchase_item_id where d.id = e.source_id::uuid)
        end as purchase_id
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where ${EFFECTIVE_DATE} >= ${from} and ${EFFECTIVE_DATE} <= ${to}
        and l.account_code in (${keys.payable}, ${keys.advance}, ${keys.claim})
        and e.source_type in ('goods_receipt_item', 'supplier_payment', 'purchase', 'defect_movement')
    ),
    ledger as (
      select purchase_id,
        coalesce(-sum(net) filter (where account_code = ${keys.payable}), 0) as payable,
        coalesce(sum(net) filter (where account_code = ${keys.advance}), 0) as advance,
        coalesce(sum(net) filter (where account_code = ${keys.claim}), 0) as claim
      from doc_journal where purchase_id is not null group by purchase_id
    ),
    tagihan as (
      select p.id as purchase_id, coalesce(sum(case
        when p.status = 'cancelled' then 0
        when p.status = 'closed' then floor((2 * pi.total_amount::numeric * round(settled.qty * 100) + round(pi.qty_ordered * 100)) / (2 * round(pi.qty_ordered * 100)))
        else pi.total_amount end), 0) as tagihan
      from purchases p
      join purchase_items pi on pi.purchase_id = p.id
      cross join lateral (
        select coalesce((select sum(gri.qty_accepted) from goods_receipt_items gri where gri.purchase_item_id = pi.id), 0)
             + coalesce((select sum(d.qty) from defect_movements d where d.purchase_item_id = pi.id and d.disposal_type is null), 0) as qty
      ) settled
      group by p.id
    ),
    paid as (
      select sp.purchase_id, sum(sp.amount) as paid
      from supplier_payments sp
      where sp.target_type = 'purchase' and sp.paid_at <= ${to}
        and (sp.voided_at is null or (sp.voided_at at time zone 'Asia/Jakarta')::date > ${to})
      group by sp.purchase_id
    ),
    received as (
      select gr.purchase_id,
        coalesce(sum((select coalesce(sum(m.value_amount), 0) from fabric_stock_movements m where m.ref_type = 'goods_receipt' and m.ref_id = gri.id::text)
          + (select coalesce(sum(m.value_amount), 0) from accessory_movements m where m.ref_type = 'goods_receipt' and m.ref_id = gri.id::text)
          + (select coalesce(sum(d.value_amount), 0) from defect_movements d where d.goods_receipt_item_id = gri.id)), 0) as value
      from goods_receipt_items gri join goods_receipts gr on gr.id = gri.goods_receipt_id
      where gr.source_type = 'purchase' and gr.received_at <= ${to}
      group by gr.purchase_id
    ),
    returned as (
      select pi.purchase_id, sum(d.value_amount) as value
      from defect_movements d
      join purchase_items pi on pi.id = d.purchase_item_id
      left join defect_movements o on o.id = d.reverses_movement_id
      where d.occurred_at <= ${to} and (d.type = 'return_out' or (d.type = 'reversal' and o.type = 'return_out'))
      group by pi.purchase_id
    ),
    first_event as (
      select purchase_id, min(d) as first_d from (
        select gr.purchase_id, gr.received_at as d from goods_receipts gr where gr.source_type = 'purchase'
        union all select sp.purchase_id, sp.paid_at from supplier_payments sp where sp.target_type = 'purchase'
        union all select pi.purchase_id, d.occurred_at from defect_movements d join purchase_items pi on pi.id = d.purchase_item_id
      ) events group by purchase_id
    )
    select p.id as purchase_id, p.purchase_no, s.id as supplier_id, s.name::text as supplier_name,
      coalesce(t.tagihan, 0)::bigint as tagihan,
      coalesce(pd.paid, 0)::bigint as paid,
      (coalesce(r.value, 0) + coalesce(rt.value, 0))::bigint as net_received,
      coalesce(l.payable, 0)::bigint as ledger_payable,
      coalesce(l.advance, 0)::bigint as ledger_advance,
      coalesce(l.claim, 0)::bigint as ledger_claim,
      coalesce(fe.first_d < ${from}, false) as starts_before
    from purchases p
    join suppliers s on s.id = p.supplier_id
    left join tagihan t on t.purchase_id = p.id
    left join paid pd on pd.purchase_id = p.id
    left join received r on r.purchase_id = p.id
    left join returned rt on rt.purchase_id = p.id
    left join ledger l on l.purchase_id = p.id
    left join first_event fe on fe.purchase_id = p.id
    order by s.name, p.purchase_no
  `)) as unknown as PayableQueryRow[];
}

const SALES_ACCOUNT_KEYS: Record<SalesCheckKind, { key: string; credit: boolean }> = {
  sold_not_shipped: { key: "inventory.sold_not_shipped", credit: false },
  deposit: { key: "liability.customer_deposit", credit: true },
  buyer_shipping: { key: "liability.buyer_shipping", credit: true },
};

/** Σ (debit − credit) per (order, account) on lines that carry an order id, within the window. */
async function ledgerByOrder(db: Database, accountCodes: string[], from: string, to: string): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    select l.order_id::text as order_id, l.account_code, sum(l.debit - l.credit)::bigint as net
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.order_id is not null and l.account_code in (${sql.join(accountCodes.map((code) => sql`${code}`), sql`, `)}) and ${EFFECTIVE_DATE} >= ${from} and ${EFFECTIVE_DATE} <= ${to}
    group by l.order_id, l.account_code
  `)) as unknown as { order_id: string; account_code: string; net: string }[];
  return new Map(rows.map((row) => [`${row.order_id}|${row.account_code}`, num(row.net)]));
}

/** Checks 1 (1-1505), 3 (2-1201) and 3c (2-1203): per order, the records against the order's lines. */
async function salesChecks(db: Database, keys: Map<string, { code: string; name: string }>, from: string, to: string): Promise<SalesCheck[]> {
  const accountsByKind = Object.fromEntries(
    (Object.keys(SALES_ACCOUNT_KEYS) as SalesCheckKind[]).map((kind) => {
      const account = keys.get(SALES_ACCOUNT_KEYS[kind].key);
      if (!account) throw new Error(`the chart of accounts lost the system account ${SALES_ACCOUNT_KEYS[kind].key}`);
      return [kind, account];
    }),
  ) as Record<SalesCheckKind, { code: string; name: string }>;
  const [orders, byOrder] = await Promise.all([loadOrderSnapshots(db), ledgerByOrder(db, Object.values(accountsByKind).map((account) => account.code), from, to)]);
  const appByOrder = new Map(orders.map((order) => [order.id, { order, movements: orderAccountMovements(order, from, to) }]));

  const checks: SalesCheck[] = [];
  for (const kind of Object.keys(SALES_ACCOUNT_KEYS) as SalesCheckKind[]) {
    const account = accountsByKind[kind];
    const sign = SALES_ACCOUNT_KEYS[kind].credit ? -1 : 1;
    const ledgerTotal = sign * (await ledgerBalance(db, account.code, from, to)) || 0;
    const rows: SalesOrderRow[] = [];
    let ordersLedger = 0;
    for (const [orderId, { order, movements }] of appByOrder) {
      const ledger = sign * (byOrder.get(`${orderId}|${account.code}`) ?? 0) || 0;
      ordersLedger += ledger;
      const app = kind === "sold_not_shipped" ? movements.soldNotShipped : kind === "deposit" ? movements.deposit : movements.buyerShipping;
      if (app === 0 && ledger === 0) continue;
      rows.push({ orderId, orderNo: order.orderNo, channelId: order.channelId, pending: movements.pending, ...reconcileOrderAccount({ app, ledger, startsBeforeBooks: movements.startsBeforeBooks }) });
    }
    // Lines of an order the loader does not return (nothing to book any more) still count as orders'.
    for (const [mapKey, net] of byOrder) {
      const [orderId, code] = mapKey.split("|");
      if (code === account.code && orderId && !appByOrder.has(orderId)) ordersLedger += sign * net;
    }
    rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.orderNo.localeCompare(b.orderNo));
    checks.push({
      kind,
      accountCode: account.code,
      accountName: account.name,
      ledgerTotal,
      outsideOrders: ledgerTotal - ordersLedger,
      rows: rows.slice(0, SALES_ROWS_LIMIT),
      rowCount: rows.length,
      mismatchCount: rows.filter((row) => row.status === "mismatch").length,
    });
  }
  return checks;
}

/** Check 3b: 1-1603 Saldo Biteship, split into bookings and everything else. */
async function biteshipCheck(db: Database, account: { code: string; name: string }, from: string, to: string, typed: number | null): Promise<BiteshipCheck> {
  const [row] = (await db.execute(sql`
    select
      coalesce(sum(l.debit - l.credit), 0)::bigint as ledger,
      coalesce(sum(l.debit - l.credit) filter (where e.source_type = 'shipment'), 0)::bigint as bookings
    from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.account_code = ${account.code} and ${EFFECTIVE_DATE} >= ${from} and ${EFFECTIVE_DATE} <= ${to}
  `)) as unknown as { ledger: string; bookings: string }[];
  const ledger = num(row?.ledger);
  const bookings = num(row?.bookings);
  return { accountCode: account.code, accountName: account.name, ledger, bookings, otherJournals: ledger - bookings, typed, difference: biteshipDifference(ledger, typed) };
}

/** `biteshipDashboard`: the Saldo Biteship typed from the dashboard for check 3b (not stored). */
export async function getReconciliation(asOf: string, db: Database = defaultDb, biteshipDashboard: number | null = null): Promise<Reconciliation> {
  const segment = bookSegmentOf(asOf);
  const segmentStart = segmentStartOf(asOf);
  const official = segment === "official";
  const keys = await accountByKey(db);
  const fabricAccount = keys.get("inventory.fabric");
  const accessoryAccount = keys.get("inventory.accessory");
  const payable = keys.get("supplier_payable.kind.material");
  const advance = keys.get("prepaid.purchase_advance");
  const claim = keys.get("receivable.supplier_claim");
  if (!fabricAccount || !accessoryAccount || !payable || !advance || !claim) throw new Error("the chart of accounts lost a purchase-side system account or mapping");

  const materials: MaterialRow[] = [];
  for (const [material, account, table] of [
    ["fabric", fabricAccount, "fabric_stock_movements"],
    ["accessory", accessoryAccount, "accessory_movements"],
  ] as const) {
    const figures = await materialFigures(db, table, segmentStart, asOf, official);
    const ledger = await ledgerBalance(db, account.code, segmentStart, asOf);
    materials.push({
      ...reconcileMaterial({ ...figures, ledger }),
      accountCode: account.code,
      accountName: account.name,
      material,
    });
  }

  const wipAccount = keys.get("inventory.wip");
  const finishedAccount = keys.get("inventory.finished_goods");
  const defectAccount = keys.get("inventory.defect");
  if (!wipAccount || !finishedAccount || !defectAccount) throw new Error("the chart of accounts lost a production-side system account");
  const wip = await wipReconciliation(db, wipAccount.code, segmentStart, asOf, official);
  const finished = await finishedFigures(db, segmentStart, asOf, official);
  const defect = await defectFigures(db, segmentStart, asOf, official);
  const stockAccounts: StockAccountRow[] = [
    { ...wip.account, accountCode: wipAccount.code, accountName: wipAccount.name, kind: "wip" },
    { ...reconcileStockAccount({ ...finished, ledger: await ledgerBalance(db, finishedAccount.code, segmentStart, asOf) }), accountCode: finishedAccount.code, accountName: finishedAccount.name, kind: "finished" },
    { ...reconcileStockAccount({ ...defect, ledger: await ledgerBalance(db, defectAccount.code, segmentStart, asOf) }), accountCode: defectAccount.code, accountName: defectAccount.name, kind: "defect" },
  ];

  const rows = await payableRows(db, { payable: payable.code, advance: advance.code, claim: claim.code }, segmentStart, asOf);
  const allPayables: PayableRow[] = rows.map((row) => ({
      purchaseId: row.purchase_id,
      purchaseNo: row.purchase_no,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      ...reconcilePayable({
        tagihan: num(row.tagihan),
        paid: num(row.paid),
        netReceived: num(row.net_received),
        ledgerPayable: num(row.ledger_payable),
        ledgerAdvance: num(row.ledger_advance),
        ledgerClaim: num(row.ledger_claim),
        startsBeforeBooks: row.starts_before,
      }),
  }));
  // Mismatches first, then those to review; otherwise by supplier and document number (the query's order, kept by the
  // stable sort). Documents with nothing to show are left out.
  const payables = allPayables
    .filter((row) => row.appBalance !== 0 || row.ledgerPayable !== 0 || row.ledgerAdvance !== 0 || row.ledgerClaim !== 0 || row.notReceived !== 0 || row.difference !== 0)
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  const payableLedgerTotal = -(await ledgerBalance(db, payable.code, segmentStart, asOf));
  const biteshipAccount = keys.get("prepaid.biteship");
  if (!biteshipAccount) throw new Error("the chart of accounts lost the system account prepaid.biteship");
  const documentsPayable = allPayables.reduce((sum, row) => sum + row.ledgerPayable, 0);
  return {
    asOf,
    segment,
    segmentStart,
    materials,
    stockAccounts,
    wipBatches: wip.rows,
    payables,
    payableLedgerTotal,
    payableOutsideDocuments: payableLedgerTotal - documentsPayable,
    salesChecks: await salesChecks(db, keys, segmentStart, asOf),
    biteship: await biteshipCheck(db, biteshipAccount, segmentStart, asOf, biteshipDashboard),
  };
}

/** Check 5 (Session 10): every source event dated in the set of books of `asOf`, up to `asOf`, has
 * its active journal or an open posting issue. A read-only dry run of the posting runner. */
export async function getPostingCompleteness(asOf: string, db: Database = defaultDb): Promise<PostingCompleteness> {
  return checkPostingCompleteness(db, { from: segmentStartOf(asOf), to: asOf });
}
