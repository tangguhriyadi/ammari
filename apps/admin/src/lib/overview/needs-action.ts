import "server-only";
import { sql } from "drizzle-orm";
import {
  channels,
  customers,
  fabricColors,
  orders,
  productionBatchCosts,
  productionBatches,
  products,
  productVariants,
  stockMovements,
  supplierPayments,
} from "@ammari/db/schema";
import { addCalendarDays, jakartaDate, jakartaMidnight } from "@ammari/commerce/jakarta-day";
import { defaultDb, type Database } from "@/lib/db";
import { aliasedOrderBuyerNameSql } from "@/lib/orders/buyer-name";

// Ringkasan "Perlu tindakan" (docs/plans/dashboard-overview.md §5, D8, D10): what needs doing now,
// not tied to the selected period. Each block is a count plus its first few rows. The page checks
// each block's own module permission before calling these; the production amounts additionally
// need finance.view_profit and are not selected otherwise (D9).

/** Rows shown per block; "Lihat semua" links to the full filtered page. */
export const ACTION_LIST_LIMIT = 3;
/** Stok menipis lists a few more: they are short lines and the owner reorders from it. */
export const LOW_STOCK_LIST_LIMIT = 5;
/** D10: a Siap Kirim order is late MORE than this many Jakarta days after its order date. */
export const LATE_TO_SHIP_DAYS = 2;
/** D8: a manual order still unpaid this many hours after its order date. */
export const STALE_MANUAL_PAYMENT_HOURS = 24;
/** D8: a checkout order whose payment window closes within this many minutes. */
export const CHECKOUT_EXPIRY_SOON_MINUTES = 15;

const HOUR_MS = 60 * 60_000;

export interface ActionOrderRow {
  id: string;
  orderNo: string;
  channelName: string;
  buyerName: string | null;
  orderDate: Date;
}

const orderRowColumns = sql`o.id, o.order_no, ch.name as channel_name, ${aliasedOrderBuyerNameSql()} as buyer_name, o.order_date`;
const orderJoins = sql`join ${channels} ch on ch.id = o.channel_id
  left join ${customers} cu on cu.id = o.customer_id`;
const orderRowFrom = sql`from ${orders} o
  ${orderJoins}`;

type OrderSqlRow = { id: string; order_no: string; channel_name: string; buyer_name: string | null; order_date: string | Date };

function toOrderRow(row: OrderSqlRow): ActionOrderRow {
  return { id: row.id, orderNo: row.order_no, channelName: row.channel_name, buyerName: row.buyer_name, orderDate: new Date(row.order_date) };
}

// ---------- Orders ----------

export interface AttentionOrders {
  count: number;
  rows: ActionOrderRow[];
}

/** "Perlu dicek": every flagged order, newest first (the order list's own order). */
export async function getAttentionOrders(db: Database = defaultDb): Promise<AttentionOrders> {
  const rows = await db.execute<OrderSqlRow & { total: number }>(sql`
    select ${orderRowColumns}, count(*) over ()::int as total
    ${orderRowFrom}
    where cardinality(o.needs_attention) > 0
    order by o.created_at desc, o.id desc
    limit ${ACTION_LIST_LIMIT}
  `);
  return { count: rows[0]?.total ?? 0, rows: rows.map(toOrderRow) };
}

export interface ToShipOrders {
  count: number;
  /** Older than LATE_TO_SHIP_DAYS Jakarta days (D10). */
  lateCount: number;
  /** Oldest first, so the late ones lead. */
  rows: (ActionOrderRow & { isLate: boolean })[];
}

/** The instant before which a Siap Kirim order is late: 00:00 WIB, LATE_TO_SHIP_DAYS days ago. An
 * order placed on the 21st is late from the 24th (3 days), not on the 23rd (2 days). */
export function lateToShipCutoff(now: Date): Date {
  return jakartaMidnight(addCalendarDays(jakartaDate(now), -LATE_TO_SHIP_DAYS));
}

export async function getToShipOrders(now: Date = new Date(), db: Database = defaultDb): Promise<ToShipOrders> {
  const cutoff = lateToShipCutoff(now).toISOString();
  const rows = await db.execute<OrderSqlRow & { total: number; late_total: number }>(sql`
    select ${orderRowColumns},
           count(*) over ()::int as total,
           count(*) filter (where o.order_date < ${cutoff}::timestamptz) over ()::int as late_total
    ${orderRowFrom}
    where o.status = 'to_ship'
    order by o.order_date, o.id
    limit ${ACTION_LIST_LIMIT}
  `);
  return {
    count: rows[0]?.total ?? 0,
    lateCount: rows[0]?.late_total ?? 0,
    rows: rows.map((row) => ({ ...toOrderRow(row), isLate: new Date(row.order_date).getTime() < new Date(cutoff).getTime() })),
  };
}

export interface AwaitingPaymentOrders {
  /** Manual orders (no payment_status) unpaid more than STALE_MANUAL_PAYMENT_HOURS. */
  staleManualCount: number;
  /** Checkout orders whose payment window closes within CHECKOUT_EXPIRY_SOON_MINUTES. */
  expiringCheckoutCount: number;
  /** Expiring checkout orders first (soonest first), then the oldest stale manual orders. */
  rows: (ActionOrderRow & { kind: "expiring_checkout" | "stale_manual"; paymentExpiresAt: Date | null })[];
}

/** "Menunggu Bayar", both halves (D8). A checkout order already past its window is not listed:
 * the expiry sweeper cancels it. */
export async function getAwaitingPaymentOrders(now: Date = new Date(), db: Database = defaultDb): Promise<AwaitingPaymentOrders> {
  const staleBefore = new Date(now.getTime() - STALE_MANUAL_PAYMENT_HOURS * HOUR_MS).toISOString();
  const nowIso = now.toISOString();
  const expiringBy = new Date(now.getTime() + CHECKOUT_EXPIRY_SOON_MINUTES * 60_000).toISOString();
  // Each half spelled like its index: orders_checkout_awaiting_payment_idx for checkout,
  // orders_status_idx for manual.
  const rows = await db.execute<
    OrderSqlRow & { kind: "expiring_checkout" | "stale_manual"; payment_expires_at: string | Date | null; stale_total: number; expiring_total: number }
  >(sql`
    with matched as (
      select o.id,
             case when o.payment_status is null then 'stale_manual' else 'expiring_checkout' end as kind
      from ${orders} o
      where o.status = 'awaiting_payment'
        and (
          (o.payment_status is null and o.order_date < ${staleBefore}::timestamptz)
          or (o.payment_status is not null and o.payment_expires_at > ${nowIso}::timestamptz and o.payment_expires_at <= ${expiringBy}::timestamptz)
        )
    )
    select ${orderRowColumns}, matched.kind, o.payment_expires_at,
           count(*) filter (where matched.kind = 'stale_manual') over ()::int as stale_total,
           count(*) filter (where matched.kind = 'expiring_checkout') over ()::int as expiring_total
    from matched
    join ${orders} o on o.id = matched.id
    ${orderJoins}
    order by matched.kind = 'stale_manual', o.payment_expires_at, o.order_date, o.id
    limit ${ACTION_LIST_LIMIT}
  `);
  return {
    staleManualCount: rows[0]?.stale_total ?? 0,
    expiringCheckoutCount: rows[0]?.expiring_total ?? 0,
    rows: rows.map((row) => ({
      ...toOrderRow(row),
      kind: row.kind,
      paymentExpiresAt: row.payment_expires_at === null ? null : new Date(row.payment_expires_at),
    })),
  };
}

// ---------- Stock ----------

export interface LowStockRow {
  sku: string;
  productName: string;
  colorName: string;
  size: string;
  currentStock: number;
  minStockQty: number;
}

export interface LowStock {
  /** At 0 or below. */
  outCount: number;
  /** Above 0, at or below the minimum. */
  lowCount: number;
  /** Lowest stock against its minimum first (out of stock leads). */
  rows: LowStockRow[];
}

type LowStockSqlRow = {
  sku: string;
  product_name: string;
  color_name: string;
  size: string;
  current_stock: number;
  min_stock_qty: number;
  out_total: number;
  low_total: number;
};

/** "Stok menipis": active variants with a minimum set and stock at or below it, the same rule as
 * stockStatus and /stock?low=1. A variant without a minimum (0) is never listed, even at 0. */
export async function getLowStock(db: Database = defaultDb, limit: number = LOW_STOCK_LIST_LIMIT): Promise<LowStock> {
  const rows = await db.execute<LowStockSqlRow>(sql`
    with stock as (
      select v.sku, v.product_id, v.fabric_color_id, v.size, v.min_stock_qty,
             coalesce((select sum(m.qty) from ${stockMovements} m where m.sku = v.sku), 0)::int as current_stock
      from ${productVariants} v
      where v.is_active and v.min_stock_qty > 0
    )
    select stock.sku, p.name as product_name, c.name as color_name, stock.size, stock.current_stock, stock.min_stock_qty,
           count(*) filter (where stock.current_stock <= 0) over ()::int as out_total,
           count(*) filter (where stock.current_stock > 0) over ()::int as low_total
    from stock
    join ${products} p on p.id = stock.product_id
    join ${fabricColors} c on c.id = stock.fabric_color_id
    where stock.current_stock <= stock.min_stock_qty
    order by greatest(stock.current_stock, 0)::numeric / stock.min_stock_qty, stock.current_stock, p.name, stock.sku
    limit ${limit}
  `);
  return {
    outCount: rows[0]?.out_total ?? 0,
    lowCount: rows[0]?.low_total ?? 0,
    rows: rows.map((row) => ({
      sku: row.sku,
      productName: row.product_name,
      colorName: row.color_name,
      size: row.size,
      currentStock: row.current_stock,
      minStockQty: row.min_stock_qty,
    })),
  };
}

// ---------- Production ----------

export interface UnpaidBatchRow {
  id: string;
  batchNo: string;
  /** "YYYY-MM-DD". */
  producedAt: string;
  status: "unpaid" | "partial";
  /** tagihan - paid; null without finance.view_profit. */
  remaining: number | null;
}

export interface UnpaidProduction {
  unpaidCount: number;
  partialCount: number;
  /** Σ remaining; null without finance.view_profit. */
  remainingTotal: number | null;
  /** Oldest first. */
  rows: UnpaidBatchRow[];
}

type UnpaidBatchSqlRow = {
  id: string;
  batch_no: string;
  produced_at: string;
  status: "unpaid" | "partial";
  remaining?: string;
  unpaid_total: number;
  partial_total: number;
  remaining_total?: string;
};

function toAmount(value: string | undefined): number {
  const amount = Number(value ?? 0);
  if (!Number.isSafeInteger(amount)) throw new Error("overview amount overflow");
  return amount;
}

/** "Produksi belum lunas": posted batches whose service lines are not fully paid. The same
 * tagihan / paid arithmetic as listBatches' "Belum bayar" and "DP" filters (queries.test.ts
 * asserts they agree): tagihan = Σ service lines, paid = Σ non-voided payments on the batch. */
export async function getUnpaidProduction({ canViewProfit }: { canViewProfit: boolean }, db: Database = defaultDb): Promise<UnpaidProduction> {
  const rows = await db.execute<UnpaidBatchSqlRow>(sql`
    with totals as (
      select b.id, b.batch_no, b.produced_at,
             coalesce((select sum(cost.total) from ${productionBatchCosts} cost where cost.production_batch_id = b.id), 0)::bigint as tagihan,
             coalesce((select sum(pay.amount) from ${supplierPayments} pay
               where pay.production_batch_id = b.id and pay.voided_at is null), 0)::bigint as paid
      from ${productionBatches} b
      where b.status = 'posted'
    ),
    open as (
      select totals.*, case when paid = 0 then 'unpaid' else 'partial' end as status
      from totals
      where tagihan > 0 and paid < tagihan
    )
    select id, batch_no, produced_at::text as produced_at, status,
           ${canViewProfit ? sql`(tagihan - paid)::text as remaining, sum(tagihan - paid) over ()::text as remaining_total,` : sql``}
           count(*) filter (where status = 'unpaid') over ()::int as unpaid_total,
           count(*) filter (where status = 'partial') over ()::int as partial_total
    from open
    order by open.produced_at, open.batch_no
    limit ${ACTION_LIST_LIMIT}
  `);
  return {
    unpaidCount: rows[0]?.unpaid_total ?? 0,
    partialCount: rows[0]?.partial_total ?? 0,
    remainingTotal: canViewProfit ? toAmount(rows[0]?.remaining_total) : null,
    rows: rows.map((row) => ({
      id: row.id,
      batchNo: row.batch_no,
      producedAt: row.produced_at,
      status: row.status,
      remaining: canViewProfit ? toAmount(row.remaining) : null,
    })),
  };
}
