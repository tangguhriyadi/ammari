import "server-only";
import { sql } from "drizzle-orm";
import { segmentStartOf, TIKTOK_PAYOUT_PAID_STATUS } from "@ammari/accounting";
import { defaultDb, type Database } from "@/lib/db";
import type { ReconciliationStatus } from "./reconciliation-rules";
import {
  pairAdsLines,
  reconcileSellerBalance,
  reconcileTikTokOrder,
  reconcileTotal,
  type AdsPair,
  type TikTokOrderReconciliation,
} from "./tiktok-reconciliation-rules";

// Rekonsiliasi "TikTok Shop" (docs/plans/tiktok-shop-integration.md §5.4, T8), read-only:
//   (a) per order: the order's 1-1303 Saldo Penjual TikTok lines (M1 − M2 − S4/S7) against the
//       settlement TikTok paid for it (Σ its ORDER/REFUND statement transactions = total − fees − refunds);
//   (b) per statement: Σ transactions = the statement's settlement (T7 holds a statement that does not);
//   (c) per payout: the payout amount = Σ the statements it paid, and whether M3 booked it;
//   (d) the 1-1303 balance against what TikTok still owes: unsettled estimates + statements settled but
//       not paid out;
//   plus the M4/M5 ads pair list (an ad paid from the balance booked by M5 AND recorded as a business
//   expense with channel tiktok: remove one of the pair).
// The ledger side is summed within the set of books of `asOf` (books.ts), like the other checks; the
// TikTok side is the stored finance data up to the end of `asOf` (Jakarta). An admin order is matched to
// its TikTok order by (tiktok, channel_order_no), the key the sync (T5) and a hand-typed order share.

export const TIKTOK_ROWS_LIMIT = 50;

const STATUS_ORDER: Record<ReconciliationStatus, number> = { mismatch: 0, review: 1, explained: 2, ok: 3 };
const num = (value: string | number | null | undefined) => Number(value ?? 0);
const numOrNull = (value: string | number | null | undefined) => (value === null || value === undefined ? null : Number(value));
const EFFECTIVE_DATE = sql.raw("coalesce(e.source_date, e.entry_date)");

/** The end of a Jakarta calendar day, as an instant bound (exclusive). */
function endOfJakartaDay(date: string) {
  return sql`((${date}::date + 1)::timestamp at time zone 'Asia/Jakarta')`;
}

export interface TikTokOrderRow extends TikTokOrderReconciliation {
  orderId: string;
  orderNo: string;
  tiktokOrderId: string;
}

export interface TikTokStatementRow {
  statementId: string;
  statementTime: Date;
  settlement: number | null;
  transactionsTotal: number | null;
  transactionCount: number;
  heldReason: string | null;
  paymentId: string | null;
  difference: number | null;
  status: ReconciliationStatus;
}

export interface TikTokPayoutRow {
  paymentId: string;
  paidTime: Date | null;
  status: string | null;
  amount: number | null;
  statementsTotal: number | null;
  statementCount: number;
  /** M3 has an active journal for it. */
  journaled: boolean;
  difference: number | null;
  rowStatus: ReconciliationStatus;
}

export interface TikTokSellerBalance {
  ledger: number;
  unsettled: number;
  settledNotPaidOut: number;
  /** Statements held as unreadable: in neither figure. */
  heldStatements: number;
  expected: number;
  difference: number;
  status: ReconciliationStatus;
}

export interface TikTokReconciliation {
  accountCode: string;
  accountName: string;
  orders: { rows: TikTokOrderRow[]; rowCount: number; mismatchCount: number; waitingCount: number };
  statements: { rows: TikTokStatementRow[]; rowCount: number; mismatchCount: number };
  payouts: { rows: TikTokPayoutRow[]; rowCount: number; mismatchCount: number };
  balance: TikTokSellerBalance;
  adsPairs: AdsPair[];
}

/** What TikTok still owes at the end of `asOf`: estimates of transactions no statement up to then holds,
 * plus statements up to then not paid out by a PAID payout up to then; `heldStatements` counts statements
 * held as unreadable (in neither figure, so a balance difference can point at them). Also the opening
 * 1-1303 proposal (§5.4: at 31 Dec 2026, confirmed by hand in Saldo awal).
 *
 * An estimate counts only while it is still owed: TikTok still listed it in its latest unsettled read
 * (T7 keeps a row after TikTok stops listing it, e.g. a cancelled order, so `last_seen_at` stops moving),
 * it was seen by `asOf`, and no statement up to `asOf` holds the same transaction or, since T0 has not
 * confirmed that unsettled and statement ids are equal, a transaction of the same order and type. */
export async function tiktokAmountsOwed(db: Database, asOf: string): Promise<{ unsettled: number; settledNotPaidOut: number; heldStatements: number }> {
  const end = endOfJakartaDay(asOf);
  const [row] = (await db.execute(sql`
    select
      (select coalesce(sum(u.est_settlement_amount), 0) from tiktok_unsettled_transactions u
        where u.held_reason is null and u.first_seen_at < ${end}
          -- Still listed by the latest read (one finance run spans minutes; a day of margin).
          and u.last_seen_at >= (select max(last_seen_at) from tiktok_unsettled_transactions) - interval '1 day'
          and not exists (
            select 1 from tiktok_statement_transactions t join tiktok_statements s on s.statement_id = t.statement_id
            where s.statement_time < ${end}
              and (t.transaction_id = u.transaction_id or (u.tiktok_order_id is not null and t.tiktok_order_id = u.tiktok_order_id and t.type = u.type))
          ))::bigint as unsettled,
      (select count(*) from tiktok_statements s where s.held_reason is not null and s.statement_time < ${end})::int as held_statements,
      (select coalesce(sum(s.settlement_amount), 0) from tiktok_statements s
        where s.held_reason is null and s.statement_time < ${end}
          and not exists (
            select 1 from tiktok_payouts p
            where p.payment_id = s.payment_id and p.status = ${TIKTOK_PAYOUT_PAID_STATUS} and p.paid_time < ${end}
          ))::bigint as settled_not_paid_out
  `)) as unknown as { unsettled: string; settled_not_paid_out: string; held_statements: number }[];
  return { unsettled: num(row?.unsettled), settledNotPaidOut: num(row?.settled_not_paid_out), heldStatements: row?.held_statements ?? 0 };
}

async function sellerBalanceAccount(db: Database): Promise<{ code: string; name: string }> {
  const [row] = (await db.execute(sql`select code, name::text as name from accounts where system_key = 'seller_balance.tiktok'`)) as unknown as { code: string; name: string }[];
  if (!row) throw new Error("the chart of accounts lost the system account seller_balance.tiktok");
  return row;
}

async function orderRows(db: Database, accountCode: string, from: string, asOf: string): Promise<TikTokOrderRow[]> {
  const end = endOfJakartaDay(asOf);
  const rows = (await db.execute(sql`
    with ledger as (
      select l.order_id, sum(l.debit - l.credit)::bigint as net
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where l.account_code = ${accountCode} and l.order_id is not null and ${EFFECTIVE_DATE} >= ${from} and ${EFFECTIVE_DATE} <= ${asOf}
      group by l.order_id
    ),
    settled as (
      select t.tiktok_order_id, sum(t.settlement_amount)::bigint as settlement, count(*) filter (where t.held_reason is not null)::int as held
      from tiktok_statement_transactions t join tiktok_statements s on s.statement_id = t.statement_id
      where t.kind = 'order' and t.tiktok_order_id is not null and s.statement_time < ${end}
      group by t.tiktok_order_id
    )
    select o.id::text as order_id, o.order_no, o.channel_order_no as tiktok_order_id,
      coalesce(lg.net, 0)::bigint as ledger,
      case when st.tiktok_order_id is null or st.held > 0 then null else st.settlement end as settlement,
      coalesce((o.marketplace_shipped_at at time zone 'Asia/Jakarta')::date < ${from}::date, false) as starts_before
    from orders o
    left join ledger lg on lg.order_id = o.id
    left join settled st on st.tiktok_order_id = o.channel_order_no
    where o.channel_id = 'tiktok' and o.channel_order_no is not null and (lg.order_id is not null or st.tiktok_order_id is not null)
  `)) as unknown as { order_id: string; order_no: string; tiktok_order_id: string; ledger: string; settlement: string | null; starts_before: boolean }[];
  return rows
    .map((row) => ({
      orderId: row.order_id,
      orderNo: row.order_no,
      tiktokOrderId: row.tiktok_order_id,
      ...reconcileTikTokOrder({ ledger: num(row.ledger), settlement: numOrNull(row.settlement), startsBeforeBooks: row.starts_before }),
    }))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.orderNo.localeCompare(b.orderNo));
}

async function statementRows(db: Database, from: string, asOf: string): Promise<TikTokStatementRow[]> {
  const rows = (await db.execute(sql`
    select s.statement_id, s.statement_time, s.settlement_amount, s.held_reason, s.payment_id,
      count(t.transaction_id)::int as transaction_count,
      case when count(t.transaction_id) = 0 or count(*) filter (where t.transaction_id is not null and t.settlement_amount is null) > 0 then null
        else sum(t.settlement_amount) end as transactions_total
    from tiktok_statements s left join tiktok_statement_transactions t on t.statement_id = s.statement_id
    where s.statement_time >= (${from}::date::timestamp at time zone 'Asia/Jakarta') and s.statement_time < ${endOfJakartaDay(asOf)}
    group by s.statement_id
    order by s.statement_time, s.statement_id
  `)) as unknown as { statement_id: string; statement_time: Date | string; settlement_amount: string | null; held_reason: string | null; payment_id: string | null; transaction_count: number; transactions_total: string | null }[];
  return rows
    .map((row) => {
      const settlement = numOrNull(row.settlement_amount);
      const transactionsTotal = numOrNull(row.transactions_total);
      const check = row.held_reason ? { difference: null, status: "mismatch" as const } : reconcileTotal(settlement, transactionsTotal);
      return {
        statementId: row.statement_id,
        statementTime: new Date(row.statement_time),
        settlement,
        transactionsTotal,
        transactionCount: row.transaction_count,
        heldReason: row.held_reason,
        paymentId: row.payment_id,
        ...check,
      };
    })
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

async function payoutRows(db: Database, from: string, asOf: string): Promise<TikTokPayoutRow[]> {
  const rows = (await db.execute(sql`
    select p.payment_id, p.paid_time, p.status, p.amount,
      count(s.statement_id)::int as statement_count,
      case when count(*) filter (where s.statement_id is not null and (s.settlement_amount is null or s.held_reason is not null)) > 0 or count(s.statement_id) = 0 then null
        else sum(s.settlement_amount) end as statements_total,
      exists (
        select 1 from journal_entries e
        where e.source_type = 'tiktok_payout' and e.source_id = p.payment_id and e.reversed_by_entry_id is null and e.kind = 'system'
      ) as journaled
    from tiktok_payouts p left join tiktok_statements s on s.payment_id = p.payment_id
    where coalesce(p.paid_time, p.create_time) >= (${from}::date::timestamp at time zone 'Asia/Jakarta') and coalesce(p.paid_time, p.create_time) < ${endOfJakartaDay(asOf)}
    group by p.payment_id
    order by coalesce(p.paid_time, p.create_time), p.payment_id
  `)) as unknown as { payment_id: string; paid_time: Date | string | null; status: string | null; amount: string | null; statement_count: number; statements_total: string | null; journaled: boolean }[];
  return rows
    .map((row) => {
      const amount = numOrNull(row.amount);
      const statementsTotal = numOrNull(row.statements_total);
      const check = reconcileTotal(amount, statementsTotal);
      // A PAID payout that matches its statements but has no M3 journal (unmapped, or not posted yet)
      // needs a look too; one that is not PAID yet is not booked on purpose.
      const paid = row.status === TIKTOK_PAYOUT_PAID_STATUS;
      const rowStatus: ReconciliationStatus = check.status !== "ok" ? check.status : paid && !row.journaled ? "review" : paid ? "ok" : "explained";
      return {
        paymentId: row.payment_id,
        paidTime: row.paid_time === null ? null : new Date(row.paid_time),
        status: row.status,
        amount,
        statementsTotal,
        statementCount: row.statement_count,
        journaled: row.journaled,
        difference: check.difference,
        rowStatus,
      };
    })
    .sort((a, b) => STATUS_ORDER[a.rowStatus] - STATUS_ORDER[b.rowStatus]);
}

async function adsPairs(db: Database, from: string, asOf: string): Promise<AdsPair[]> {
  const [adjustments, expenses] = await Promise.all([
    db.execute(sql`
      select e.id::text as id, to_char(${EFFECTIVE_DATE}, 'YYYY-MM') as month, sum(l.debit - l.credit)::bigint as amount, e.description as label
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      join accounts a on a.code = l.account_code
      where e.source_type = 'tiktok_statement_transaction' and e.kind = 'system' and e.reversed_by_entry_id is null
        and a.type = 'expense' and ${EFFECTIVE_DATE} >= ${from} and ${EFFECTIVE_DATE} <= ${asOf}
      group by e.id
      having sum(l.debit - l.credit) > 0
    `) as unknown as Promise<{ id: string; month: string; amount: string; label: string }[]>,
    db.execute(sql`
      select x.id::text as id, to_char(x.expense_date, 'YYYY-MM') as month, x.amount, x.expense_no as label
      from business_expenses x
      where x.voided_at is null and x.channel_id = 'tiktok' and x.method = 'platform_balance' and x.expense_date >= ${from} and x.expense_date <= ${asOf}
    `) as unknown as Promise<{ id: string; month: string; amount: string; label: string }[]>,
  ]);
  const line = (row: { id: string; month: string; amount: string; label: string }) => ({ id: row.id, month: row.month, amount: num(row.amount), label: row.label });
  return pairAdsLines(adjustments.map(line), expenses.map(line));
}

/** Rekonsiliasi "TikTok Shop" for the set of books of `asOf`, up to `asOf`. */
export async function getTikTokReconciliation(asOf: string, db: Database = defaultDb): Promise<TikTokReconciliation> {
  const from = segmentStartOf(asOf);
  const account = await sellerBalanceAccount(db);
  const [orders, statements, payouts, owed, pairs, [ledgerRow]] = await Promise.all([
    orderRows(db, account.code, from, asOf),
    statementRows(db, from, asOf),
    payoutRows(db, from, asOf),
    tiktokAmountsOwed(db, asOf),
    adsPairs(db, from, asOf),
    db.execute(sql`
      select coalesce(sum(l.debit - l.credit), 0)::bigint as net
      from journal_lines l join journal_entries e on e.id = l.entry_id
      where l.account_code = ${account.code} and ${EFFECTIVE_DATE} >= ${from} and ${EFFECTIVE_DATE} <= ${asOf}
    `) as unknown as Promise<{ net: string }[]>,
  ]);
  const ledger = num(ledgerRow?.net);
  const visibleOrders = orders.filter((row) => row.status !== "ok" || row.ledger !== 0);
  return {
    accountCode: account.code,
    accountName: account.name,
    orders: {
      rows: visibleOrders.slice(0, TIKTOK_ROWS_LIMIT),
      rowCount: visibleOrders.length,
      mismatchCount: orders.filter((row) => row.status === "mismatch").length,
      waitingCount: orders.filter((row) => row.status === "explained").length,
    },
    statements: { rows: statements.slice(0, TIKTOK_ROWS_LIMIT), rowCount: statements.length, mismatchCount: statements.filter((row) => row.status === "mismatch").length },
    payouts: { rows: payouts.slice(0, TIKTOK_ROWS_LIMIT), rowCount: payouts.length, mismatchCount: payouts.filter((row) => row.rowStatus === "mismatch").length },
    balance: { ledger, ...owed, ...reconcileSellerBalance(ledger, owed.unsettled, owed.settledNotPaidOut) },
    adsPairs: pairs,
  };
}
