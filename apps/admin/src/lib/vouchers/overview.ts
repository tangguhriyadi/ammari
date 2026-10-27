import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { customers, orders, thankYouCards, vouchers, type VoucherStatus } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { defaultDb, type Database } from "@/lib/db";
import type { VoucherFilter } from "@/lib/customers/search-params";
import type { TimeRange } from "@/lib/overview/period";
import { effectiveVoucherStatusSql, voucherExpiringSoonSql, voucherFilterSql, voucherUsableSql } from "./status-sql";

// The "Voucher" tab of Pelanggan & Voucher and the Ringkasan voucher card (docs/plans/growth.md
// §9.2, owner answers A6, A12; session S5). Every status is the effective one (status-sql.ts),
// judged by the database clock like checkout. Needs customers.view (checked by the page); the
// value of active vouchers is a liability figure, read only for finance.view_profit.

function rangeSql(column: SQL, range: TimeRange): SQL {
  return sql`${column} >= ${range.start.toISOString()}::timestamptz and ${column} < ${range.end.toISOString()}::timestamptz`;
}

export interface VoucherStatusCounts {
  active: number;
  expiringSoon: number;
  used: number;
  expired: number;
  void: number;
  /** "Nilai voucher aktif": only when asked for (finance.view_profit), never read otherwise. */
  activeValue: number | null;
}

export async function getVoucherStatusCounts({ canViewProfit }: { canViewProfit: boolean }, db: Database = defaultDb): Promise<VoucherStatusCounts> {
  const status = effectiveVoucherStatusSql();
  const [row] = await db.execute<{ active: number; expiring_soon: number; used: number; expired: number; void: number; active_value: string | null }>(sql`
    select count(*) filter (where ${status} = 'active')::int as active,
           count(*) filter (where ${voucherExpiringSoonSql()})::int as expiring_soon,
           count(*) filter (where ${status} = 'used')::int as used,
           count(*) filter (where ${status} = 'expired')::int as expired,
           count(*) filter (where ${status} = 'void')::int as void
           ${canViewProfit ? sql`, coalesce(sum(v.amount) filter (where ${voucherUsableSql()}), 0)::text as active_value` : sql``}
    from ${vouchers} v`);
  return {
    active: row?.active ?? 0,
    expiringSoon: row?.expiring_soon ?? 0,
    used: row?.used ?? 0,
    expired: row?.expired ?? 0,
    void: row?.void ?? 0,
    activeValue: canViewProfit ? Number(row?.active_value ?? 0) : null,
  };
}

export interface RateParts {
  part: number;
  whole: number;
}

export interface VoucherPeriodStats {
  /** Orders whose first thank-you card was printed in the period (a reprint is the same card). */
  cardsPrinted: number;
  /** Cards claimed in the period. */
  cardsClaimed: number;
  /** Vouchers redeemed at checkout in the period. */
  vouchersUsed: number;
  /** "Tingkat klaim": of the orders printed in the period whose claim deadline has passed, how
   * many were claimed. A card still claimable is not yet a "no"; an order whose every card was
   * voided (cancelled before any claim) never had the chance and is left out. */
  claimRate: RateParts;
  /** "Tingkat pemakaian": of the vouchers issued in the period that are used or expired, how many
   * were used. Still-active vouchers are not yet a "no"; voided ones are left out. */
  redemptionRate: RateParts;
}

export async function getVoucherPeriodStats(range: TimeRange, db: Database = defaultDb): Promise<VoucherPeriodStats> {
  const status = effectiveVoucherStatusSql();
  const [row] = await db.execute<{
    cards_printed: number;
    claim_closed: number;
    claim_closed_claimed: number;
    cards_claimed: number;
    vouchers_used: number;
    issued_settled: number;
    issued_used: number;
  }>(sql`
    with per_order as (
      select card.order_id,
             min(card.created_at) as first_printed_at,
             max(card.claim_deadline) as deadline,
             bool_or(card.status = 'claimed') as claimed,
             bool_and(card.status = 'void') as all_void
      from ${thankYouCards} card
      group by card.order_id
    ),
    printed as (select * from per_order p where ${rangeSql(sql`p.first_printed_at`, range)}),
    issued as (
      select ${status} as status from ${vouchers} v where ${rangeSql(sql`v.issued_at`, range)}
    )
    select (select count(*) from printed)::int as cards_printed,
           (select count(*) from printed where deadline <= now() and not all_void)::int as claim_closed,
           (select count(*) from printed where deadline <= now() and claimed)::int as claim_closed_claimed,
           (select count(*) from ${thankYouCards} c where ${rangeSql(sql`c.claimed_at`, range)})::int as cards_claimed,
           (select count(*) from ${vouchers} u where ${rangeSql(sql`u.used_at`, range)})::int as vouchers_used,
           (select count(*) from issued where status in ('used', 'expired'))::int as issued_settled,
           (select count(*) from issued where status = 'used')::int as issued_used`);
  return {
    cardsPrinted: row?.cards_printed ?? 0,
    cardsClaimed: row?.cards_claimed ?? 0,
    vouchersUsed: row?.vouchers_used ?? 0,
    claimRate: { part: row?.claim_closed_claimed ?? 0, whole: row?.claim_closed ?? 0 },
    redemptionRate: { part: row?.issued_used ?? 0, whole: row?.issued_settled ?? 0 },
  };
}

/** Whole percent, or null when there is nothing to divide yet. */
export function ratePercent({ part, whole }: RateParts): number | null {
  return whole === 0 ? null : Math.round((part * 100) / whole);
}

export interface VoucherListRow {
  id: string;
  customerId: string;
  customerName: string;
  amount: number;
  status: VoucherStatus;
  expiringSoon: boolean;
  issuedAt: Date;
  expiresAt: Date;
  usedOrder: { id: string; orderNo: string } | null;
}

interface VoucherSqlRow extends Record<string, unknown> {
  id: string;
  customer_id: string;
  customer_name: string;
  amount: string;
  status: VoucherStatus;
  expiring_soon: boolean;
  issued_at: string | Date;
  expires_at: string | Date;
  used_order_id: string | null;
  used_order_no: string | null;
}

function toRow(row: VoucherSqlRow): VoucherListRow {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    amount: Number(row.amount),
    status: row.status,
    expiringSoon: row.expiring_soon,
    issuedAt: new Date(row.issued_at),
    expiresAt: new Date(row.expires_at),
    usedOrder: row.used_order_id && row.used_order_no ? { id: row.used_order_id, orderNo: row.used_order_no } : null,
  };
}

// Customer name only: the voucher lists carry no contact data (the detail page has it).
function voucherSelectSql(): SQL {
  return sql`
    select v.id, v.customer_id, c.name as customer_name, v.amount::text as amount, ${effectiveVoucherStatusSql()} as status,
           ${voucherExpiringSoonSql()} as expiring_soon, v.issued_at, v.expires_at, v.used_order_id, uo.order_no as used_order_no
    from ${vouchers} v
    join ${customers} c on c.id = v.customer_id
    left join ${orders} uo on uo.id = v.used_order_id`;
}

/** "Segera berakhir" (A12): usable vouchers expiring within 14 days, soonest first. Read-only; the
 * admin sends nothing. */
export async function listExpiringSoonVouchers(limit = 50, db: Database = defaultDb): Promise<VoucherListRow[]> {
  const rows = await db.execute<VoucherSqlRow>(sql`${voucherSelectSql()} where ${voucherExpiringSoonSql()} order by v.expires_at, v.id limit ${limit}`);
  return rows.map(toRow);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Every voucher, newest issued first, by effective status and customer name/email. */
export async function listVouchers(
  filters: { status?: VoucherFilter; q?: string },
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: VoucherListRow[]; pagination: Pagination }> {
  const conditions: SQL[] = [];
  if (filters.status) conditions.push(voucherFilterSql(filters.status));
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    conditions.push(sql`(c.name ilike ${pattern} or c.email ilike ${pattern})`);
  }
  const where = conditions.length > 0 ? sql.join(conditions, sql` and `) : sql`true`;
  const [countRow] = await db.execute<{ total_count: number }>(sql`
    select count(*)::int as total_count from ${vouchers} v join ${customers} c on c.id = v.customer_id where ${where}`);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: countRow?.total_count ?? 0 });
  const rows = await db.execute<VoucherSqlRow>(sql`
    ${voucherSelectSql()} where ${where}
    order by v.issued_at desc, v.id
    limit ${pagination.limit} offset ${pagination.offset}`);
  return { rows: rows.map(toRow), pagination };
}
