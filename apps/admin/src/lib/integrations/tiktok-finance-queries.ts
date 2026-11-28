import "server-only";
import { sql } from "drizzle-orm";
import { getTikTokPayoutStatementLinks } from "@ammari/commerce/tiktok";
import type { TikTokFeeSource, TikTokFinanceHeldReason, TikTokOrderFeeHeldReason } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";

// Reads for Keuangan TikTok (docs/plans/tiktok-shop-integration.md §3.5, §5.3, T7). Read only: what the
// finance sync stored. No token, no payload, no bank account number (only its last four digits).

export const TIKTOK_FINANCE_LIST_LIMIT = 30;

export interface TikTokFinancePageData {
  cursors: { resource: "unsettled" | "statements" | "payments"; lastRunAt: Date | null; lastOkAt: Date | null; lastErrorCode: string | null }[];
  fees: { estimate: number; actual: number; held: number; waiting: number };
  heldOrders: { tiktokOrderId: string; orderId: string | null; orderNo: string | null; reason: TikTokOrderFeeHeldReason; unmappedTypes: string[]; appliedSource: TikTokFeeSource | null }[];
  statements: { statementId: string; statementTime: Date; settlementAmount: number | null; paymentStatus: string | null; paymentId: string | null; heldReason: TikTokFinanceHeldReason | null; complete: boolean; transactionCount: number }[];
  payouts: { paymentId: string; amount: number | null; status: string | null; paidTime: Date | null; createTime: Date | null; bankAccountLast4: string | null; heldReason: TikTokFinanceHeldReason | null; statementCount: number; statementsTotal: number | null; matches: boolean }[];
  /** Statement transaction types that are not an order's own money (mapped by the accountant in T8). */
  adjustmentTypes: { type: string; count: number; total: number | null }[];
}

const toNumber = (value: string | number | null): number | null => (value === null ? null : Number(value));
const toDate = (value: string | Date | null): Date | null => (value === null ? null : new Date(value));

export async function getTikTokFinancePageData(db: Database = defaultDb): Promise<TikTokFinancePageData> {
  const [cursorRows, [feeCounts], heldRows, statementRows, payoutRows, adjustmentRows] = await Promise.all([
    db.execute<{ resource: "unsettled" | "statements" | "payments"; last_run_at: string | Date | null; last_ok_at: string | Date | null; last_error_code: string | null }>(sql`
      select resource, last_run_at, last_ok_at, last_error_code from tiktok_sync_cursors where resource in ('unsettled', 'statements', 'payments') order by resource`),
    db.execute<{ estimate: number; actual: number; held: number; waiting: number }>(sql`
      select count(*) filter (where state = 'applied' and applied_source = 'estimate')::int as estimate,
        count(*) filter (where state = 'applied' and applied_source = 'actual')::int as actual,
        count(*) filter (where state = 'held')::int as held,
        count(*) filter (where state = 'waiting_order')::int as waiting
      from tiktok_order_fees`),
    db.execute<{ tiktok_order_id: string; order_id: string | null; order_no: string | null; held_reason: TikTokOrderFeeHeldReason; unmapped_types: string[]; applied_source: TikTokFeeSource | null }>(sql`
      select f.tiktok_order_id, f.order_id, o.order_no, f.held_reason, f.unmapped_types, f.applied_source
      from tiktok_order_fees f left join orders o on o.id = f.order_id
      where f.state = 'held' order by f.updated_at desc limit ${TIKTOK_FINANCE_LIST_LIMIT}`),
    db.execute<{ statement_id: string; statement_time: string | Date; settlement_amount: string | number | null; payment_status: string | null; payment_id: string | null; held_reason: TikTokFinanceHeldReason | null; complete: boolean; transaction_count: number }>(sql`
      select s.statement_id, s.statement_time, s.settlement_amount, s.payment_status, s.payment_id, s.held_reason,
        (s.transactions_complete_sha256 is not null and s.transactions_complete_sha256 = f.content_sha256) as complete,
        (select count(*)::int from tiktok_statement_transactions t where t.statement_id = s.statement_id) as transaction_count
      from tiktok_statements s join tiktok_finance_snapshots f on f.id = s.latest_snapshot_id
      order by s.statement_time desc limit ${TIKTOK_FINANCE_LIST_LIMIT}`),
    db.execute<{ payment_id: string; amount: string | number | null; status: string | null; paid_time: string | Date | null; create_time: string | Date | null; bank_account_last4: string | null; held_reason: TikTokFinanceHeldReason | null }>(sql`
      select payment_id, amount, status, paid_time, create_time, bank_account_last4, held_reason from tiktok_payouts
      order by coalesce(paid_time, create_time) desc nulls last limit ${TIKTOK_FINANCE_LIST_LIMIT}`),
    db.execute<{ type: string; count: number; total: string | number | null }>(sql`
      select type, count(*)::int as count, sum(settlement_amount) as total from tiktok_statement_transactions
      where kind = 'adjustment' group by type order by type`),
  ]);
  const links = new Map((await getTikTokPayoutStatementLinks(db, payoutRows.map((row) => row.payment_id))).map((link) => [link.paymentId, link]));
  return {
    cursors: cursorRows.map((row) => ({ resource: row.resource, lastRunAt: toDate(row.last_run_at), lastOkAt: toDate(row.last_ok_at), lastErrorCode: row.last_error_code })),
    fees: feeCounts ?? { estimate: 0, actual: 0, held: 0, waiting: 0 },
    heldOrders: heldRows.map((row) => ({ tiktokOrderId: row.tiktok_order_id, orderId: row.order_id, orderNo: row.order_no, reason: row.held_reason, unmappedTypes: row.unmapped_types, appliedSource: row.applied_source })),
    statements: statementRows.map((row) => ({
      statementId: row.statement_id,
      statementTime: new Date(row.statement_time),
      settlementAmount: toNumber(row.settlement_amount),
      paymentStatus: row.payment_status,
      paymentId: row.payment_id,
      heldReason: row.held_reason,
      complete: row.complete,
      transactionCount: row.transaction_count,
    })),
    payouts: payoutRows.map((row) => {
      const link = links.get(row.payment_id);
      return {
        paymentId: row.payment_id,
        amount: toNumber(row.amount),
        status: row.status,
        paidTime: toDate(row.paid_time),
        createTime: toDate(row.create_time),
        bankAccountLast4: row.bank_account_last4,
        heldReason: row.held_reason,
        statementCount: link?.statementCount ?? 0,
        statementsTotal: link?.statementsTotal ?? null,
        matches: link?.matches ?? false,
      };
    }),
    adjustmentTypes: adjustmentRows.map((row) => ({ type: row.type, count: row.count, total: toNumber(row.total) })),
  };
}
