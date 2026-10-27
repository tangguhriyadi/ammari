import "server-only";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { auditLog, channels, customerAuthAccounts, customerAuthUsers, customers, orders, staffUsers, thankYouCards, voucherAdjustments, vouchers, type OrderPaymentStatus, type OrderStatus, type VoucherAdjustmentKind, type VoucherStatus } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { defaultDb, type Database } from "@/lib/db";
import { channelDisplayNameSql } from "@/lib/orders/channel-label";
import { countedOrderSql, orderOmzetSql } from "@/lib/overview/revenue-sql";
import { effectiveVoucherStatusSql, voucherUsableSql } from "@/lib/vouchers/status-sql";
import { maskEmail, maskPhone, phoneSearchPrefix } from "./mask";
import type { CustomerListParams } from "./search-params";

// Pelanggan list and detail reads (docs/plans/growth.md §8, session S4). Both need customers.view
// (checked by the page). Read-only for identity (A10). What leaves the server is only what the
// viewer may see: the list carries masked contacts (A5); the detail carries the full email and
// phone but never an order's contact snapshot, shipping address or saved addresses (§8.1), which
// is what the 90-day anonymisation will blank.

export type CustomerOrigin = "account" | "guest" | "staff";

export interface CustomerListRow {
  id: string;
  name: string;
  maskedEmail: string | null;
  maskedPhone: string | null;
  origin: CustomerOrigin;
  pdpConsentAt: Date | null;
  promoConsentAt: Date | null;
  createdAt: Date;
  lastOrderAt: Date | null;
  orderCount: number;
  totalSpend: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** One row per customer with its counted-order aggregate (the Ringkasan definition: countedOrderSql
 * and orderOmzetSql, never a second one) and whether it has an account or a checkout order. Every
 * condition and sort reads the `b` row. */
function customerBaseSql(): SQL {
  return sql`
    with agg as (
      select o.customer_id,
             count(*)::int as order_count,
             max(o.order_date) as last_order_at,
             sum(${orderOmzetSql()})::bigint as total
      from ${orders} o
      where o.customer_id is not null and ${countedOrderSql()}
      group by o.customer_id
    ),
    b as (
      select c.id, c.name, c.email, c.phone, c.pdp_consent_at, c.promo_consent_at, c.created_at,
             exists (select 1 from ${customerAuthUsers} u where u.customer_id = c.id) as has_account,
             exists (select 1 from ${orders} x where x.customer_id = c.id and x.checkout_attempt_id is not null) as has_checkout,
             coalesce(a.order_count, 0) as order_count,
             a.last_order_at,
             coalesce(a.total, 0) as total
      from ${customers} c
      left join agg a on a.customer_id = c.id
    )`;
}

function listConditions(params: CustomerListParams): SQL {
  const conditions: SQL[] = [];
  // Owner answer A13: no counted order and no account is hidden unless asked for.
  if (!params.includeNonBuyers) conditions.push(sql`(b.has_account or b.order_count > 0)`);
  switch (params.filter) {
    case "account":
      conditions.push(sql`b.has_account`);
      break;
    case "buyer":
      conditions.push(sql`b.order_count > 0`);
      break;
    case "promo":
      conditions.push(sql`b.promo_consent_at is not null`);
      break;
    case "voucher":
      conditions.push(sql`exists (select 1 from ${vouchers} v where v.customer_id = b.id and ${voucherUsableSql()})`);
      break;
  }
  if (params.q) {
    // Matches the full values server-side; only the masked form is ever sent back.
    const pattern = `%${escapeLike(params.q)}%`;
    const phone = phoneSearchPrefix(params.q);
    conditions.push(
      sql`(b.name ilike ${pattern} or b.email ilike ${pattern}${phone ? sql` or b.phone like ${`${escapeLike(phone)}%`}` : sql``})`,
    );
  }
  return conditions.length > 0 ? sql.join(conditions, sql` and `) : sql`true`;
}

const ORDER_BY: Record<CustomerListParams["sort"], SQL> = {
  newest: sql`b.created_at desc, b.id`,
  spend: sql`b.total desc, b.created_at desc, b.id`,
  last_order: sql`b.last_order_at desc nulls last, b.created_at desc, b.id`,
};

interface ListSqlRow extends Record<string, unknown> {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  pdp_consent_at: string | Date | null;
  promo_consent_at: string | Date | null;
  created_at: string | Date;
  has_account: boolean;
  has_checkout: boolean;
  order_count: number;
  last_order_at: string | Date | null;
  total: string;
}

function toDate(value: string | Date): Date;
function toDate(value: string | Date | null): Date | null;
function toDate(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

export async function listCustomers(
  params: CustomerListParams,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: CustomerListRow[]; pagination: Pagination }> {
  const where = listConditions(params);
  const [countRow] = await db.execute<{ total_count: number }>(sql`${customerBaseSql()} select count(*)::int as total_count from b where ${where}`);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: countRow?.total_count ?? 0 });
  const rows = await db.execute<ListSqlRow>(sql`
    ${customerBaseSql()}
    select * from b where ${where}
    order by ${ORDER_BY[params.sort]}
    limit ${pagination.limit} offset ${pagination.offset}`);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      name: row.name,
      maskedEmail: row.email ? maskEmail(row.email) : null,
      maskedPhone: row.phone ? maskPhone(row.phone) : null,
      origin: row.has_account ? "account" : row.has_checkout ? "guest" : "staff",
      pdpConsentAt: toDate(row.pdp_consent_at),
      promoConsentAt: toDate(row.promo_consent_at),
      createdAt: toDate(row.created_at),
      lastOrderAt: toDate(row.last_order_at),
      orderCount: Number(row.order_count),
      totalSpend: Number(row.total),
    })),
    pagination,
  };
}

// ---------- Detail ----------

export type SignInMethod = "google" | "email_code";

export interface CustomerOrderRow {
  id: string;
  orderNo: string;
  orderDate: Date;
  channelName: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus | null;
  totalAmount: number;
  counted: boolean;
}

export interface VoucherAdjustmentRow {
  id: string;
  kind: VoucherAdjustmentKind;
  previousStatus: VoucherStatus;
  previousExpiresAt: Date;
  newExpiresAt: Date | null;
  reason: string;
  staffName: string | null;
  createdAt: Date;
}

export interface CustomerVoucherRow {
  id: string;
  amount: number;
  /** Effective status (plan §9.1), decided by the database clock like checkout. */
  status: VoucherStatus;
  issuedAt: Date;
  expiresAt: Date;
  cardOrderNo: string;
  usedOrder: { id: string; orderNo: string } | null;
  usedAt: Date | null;
  adjustments: VoucherAdjustmentRow[];
}

export interface ClaimedCardRow {
  id: string;
  orderId: string;
  orderNo: string;
  claimedAt: Date | null;
  claimDeadline: Date;
  status: string;
}

export interface CustomerDetail {
  id: string;
  name: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  phone: string | null;
  phoneVerifiedAt: Date | null;
  type: string;
  createdAt: Date;
  pdpConsentAt: Date | null;
  promoConsentAt: Date | null;
  /** When the promo consent was last withdrawn, recorded by staff (§8.3) or by the customer on
   * /account (A11, session S6), shown as "Ditarik pada ..." while the consent is not set again.
   * Only the date and who withdrew leave the audit log, nothing else of it. */
  promoWithdrawnAt: Date | null;
  promoWithdrawnBy: "staff" | "customer" | null;
  account: { createdAt: Date; methods: SignInMethod[] } | null;
  orderCount: number;
  totalSpend: number;
  orders: CustomerOrderRow[];
  /** More orders exist than the newest DETAIL_ORDER_LIMIT shown. */
  ordersTruncated: boolean;
  vouchers: CustomerVoucherRow[];
  claimedCards: ClaimedCardRow[];
}

export const DETAIL_ORDER_LIMIT = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Better Auth's provider ids for the customer instance: "google", and the email-code sign-in
 * (anything else). An account with no provider row signed up by email code. */
function signInMethods(providerIds: string[]): SignInMethod[] {
  const methods = new Set<SignInMethod>(providerIds.map((id) => (id === "google" ? "google" : "email_code")));
  if (methods.size === 0) methods.add("email_code");
  return [...methods].sort();
}

export async function getCustomerDetail(customerId: string, db: Database = defaultDb): Promise<CustomerDetail | null> {
  if (!UUID_PATTERN.test(customerId)) return null;
  const [customer] = await db
    .select({
      id: customers.id,
      name: customers.name,
      email: customers.email,
      emailVerifiedAt: customers.emailVerifiedAt,
      phone: customers.phone,
      phoneVerifiedAt: customers.phoneVerifiedAt,
      type: customers.type,
      createdAt: customers.createdAt,
      pdpConsentAt: customers.pdpConsentAt,
      promoConsentAt: customers.promoConsentAt,
    })
    .from(customers)
    .where(eq(customers.id, customerId));
  if (!customer) return null;

  const [authRows, summaryRows, orderRows, voucherRows, adjustmentRows, cardRows, withdrawalRows] = await Promise.all([
    db
      .select({ createdAt: customerAuthUsers.createdAt, providerId: customerAuthAccounts.providerId })
      .from(customerAuthUsers)
      .leftJoin(customerAuthAccounts, eq(customerAuthAccounts.userId, customerAuthUsers.id))
      .where(eq(customerAuthUsers.customerId, customerId)),
    db.execute<{ order_count: number; total: string }>(sql`
      select count(*)::int as order_count, coalesce(sum(${orderOmzetSql()}), 0)::text as total
      from ${orders} o
      where o.customer_id = ${customerId} and ${countedOrderSql()}`),
    // Only these columns: never contact_email, contact_phone, shipping_address (§8.1).
    db.execute<{ id: string; order_no: string; order_date: string | Date; channel_name: string; status: OrderStatus; payment_status: OrderPaymentStatus | null; total_amount: string; counted: boolean }>(sql`
      select o.id, o.order_no, o.order_date, ${channelDisplayNameSql(sql`ch.id`, sql`ch.name`)} as channel_name,
             o.status, o.payment_status, o.total_amount::text as total_amount, (${countedOrderSql()}) as counted
      from ${orders} o
      join ${channels} ch on ch.id = o.channel_id
      where o.customer_id = ${customerId}
      order by o.order_date desc, o.order_no desc
      limit ${DETAIL_ORDER_LIMIT + 1}`),
    db.execute<{ id: string; amount: string; status: VoucherStatus; issued_at: string | Date; expires_at: string | Date; card_order_no: string; used_order_id: string | null; used_order_no: string | null; used_at: string | Date | null }>(sql`
      select v.id, v.amount::text as amount, ${effectiveVoucherStatusSql()} as status, v.issued_at, v.expires_at,
             co.order_no as card_order_no, v.used_order_id, uo.order_no as used_order_no, v.used_at
      from ${vouchers} v
      join ${thankYouCards} card on card.id = v.card_id
      join ${orders} co on co.id = card.order_id
      left join ${orders} uo on uo.id = v.used_order_id
      where v.customer_id = ${customerId}
      order by v.issued_at desc, v.id`),
    db
      .select({
        id: voucherAdjustments.id,
        voucherId: voucherAdjustments.voucherId,
        kind: voucherAdjustments.kind,
        previousStatus: voucherAdjustments.previousStatus,
        previousExpiresAt: voucherAdjustments.previousExpiresAt,
        newExpiresAt: voucherAdjustments.newExpiresAt,
        reason: voucherAdjustments.reason,
        staffName: staffUsers.name,
        createdAt: voucherAdjustments.createdAt,
      })
      .from(voucherAdjustments)
      .innerJoin(vouchers, eq(vouchers.id, voucherAdjustments.voucherId))
      .leftJoin(staffUsers, eq(staffUsers.id, voucherAdjustments.staffUserId))
      .where(eq(vouchers.customerId, customerId))
      .orderBy(asc(voucherAdjustments.createdAt), asc(voucherAdjustments.id)),
    db
      .select({
        id: thankYouCards.id,
        orderId: orders.id,
        orderNo: orders.orderNo,
        claimedAt: thankYouCards.claimedAt,
        claimDeadline: thankYouCards.claimDeadline,
        status: thankYouCards.status,
      })
      .from(thankYouCards)
      .innerJoin(orders, eq(orders.id, thankYouCards.orderId))
      .where(eq(thankYouCards.claimedByCustomerId, customerId))
      .orderBy(sql`${thankYouCards.claimedAt} desc nulls last`),
    customer.promoConsentAt === null
      ? db
          .select({ createdAt: auditLog.createdAt, action: auditLog.action })
          .from(auditLog)
          .where(and(eq(auditLog.entityType, "customer"), eq(auditLog.entityId, customerId), inArray(auditLog.action, ["promo_consent_withdraw", "promo_consent_withdraw_self"])))
          .orderBy(desc(auditLog.createdAt))
          .limit(1)
      : Promise.resolve([]),
  ]);

  const adjustmentsByVoucher = new Map<string, VoucherAdjustmentRow[]>();
  for (const { voucherId, ...adjustment } of adjustmentRows) {
    adjustmentsByVoucher.set(voucherId, [...(adjustmentsByVoucher.get(voucherId) ?? []), adjustment]);
  }
  const summary = summaryRows[0];

  return {
    ...customer,
    promoWithdrawnAt: withdrawalRows[0]?.createdAt ?? null,
    promoWithdrawnBy: withdrawalRows[0] ? (withdrawalRows[0].action === "promo_consent_withdraw_self" ? "customer" : "staff") : null,
    account: authRows.length > 0 ? { createdAt: authRows[0]!.createdAt, methods: signInMethods(authRows.flatMap((row) => (row.providerId ? [row.providerId] : []))) } : null,
    orderCount: Number(summary?.order_count ?? 0),
    totalSpend: Number(summary?.total ?? 0),
    orders: orderRows.slice(0, DETAIL_ORDER_LIMIT).map((row) => ({
      id: row.id,
      orderNo: row.order_no,
      orderDate: toDate(row.order_date),
      channelName: row.channel_name,
      status: row.status,
      paymentStatus: row.payment_status,
      totalAmount: Number(row.total_amount),
      counted: row.counted,
    })),
    ordersTruncated: orderRows.length > DETAIL_ORDER_LIMIT,
    vouchers: voucherRows.map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      status: row.status,
      issuedAt: toDate(row.issued_at),
      expiresAt: toDate(row.expires_at),
      cardOrderNo: row.card_order_no,
      usedOrder: row.used_order_id && row.used_order_no ? { id: row.used_order_id, orderNo: row.used_order_no } : null,
      usedAt: toDate(row.used_at),
      adjustments: adjustmentsByVoucher.get(row.id) ?? [],
    })),
    claimedCards: cardRows,
  };
}
