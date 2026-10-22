import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import postgres from "postgres";

// Direct ammari_e2e access for orders.spec.ts (docs/plans/cart-checkout.md §9, session 15). Same
// fail-closed target guard as the other helpers: host localhost/127.0.0.1, database "ammari_e2e"
// only. Orders are written the way placeOrder and staff write them (every CHECK satisfied), view
// tokens the way the order emails mint them (only the sha256 stored). Tokens are random, built at
// runtime. Rows seeded here are not deleted: ammari_e2e is truncated at the start of every run.

function e2eDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  url.pathname = "/ammari_e2e";
  url.search = "";
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Refusing to touch the e2e database on non-local host "${url.hostname}".`);
  }
  return url.toString();
}

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(e2eDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** A valid order number in a far-future month, so it never meets a real one. */
export function e2eOrderNo(): string {
  return `ORD-209908-${randomInt(10_000_000, 99_999_999)}`;
}

export interface SeededOrder {
  id: string;
  orderNo: string;
}

export interface OrderLine {
  sku: string;
  qty: number;
  unitPrice: number;
}

/** A storefront checkout order. `state`: `pending` (inside the payment window), `cancelled` (the
 * payment expired), `paid` (paid, in Diproses, no resi yet), `shipped` (paid, courier and resi
 * entered). Ongkir: cost Rp95.000, buyer Rp75.000. */
export async function seedCheckoutOrder(params: {
  customerId: string | null;
  email: string;
  placedWithSession: boolean;
  lines: OrderLine[];
  state: "pending" | "cancelled" | "paid" | "shipped";
  paymentUrl?: string;
}): Promise<SeededOrder> {
  const orderNo = e2eOrderNo();
  const subtotal = params.lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
  const shipping = 75_000;
  const status = { pending: "awaiting_payment", cancelled: "cancelled", paid: "to_ship", shipped: "shipped" }[params.state];
  const paymentStatus = { pending: "pending", cancelled: "expired", paid: "paid", shipped: "paid" }[params.state];
  const paid = params.state === "paid" || params.state === "shipped";
  return withSql(async (sql) =>
    sql.begin(async (tx) => {
      const [order] = await tx<{ id: string }[]>`
        insert into orders (
          channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount, customer_id,
          payment_status, payment_expires_at, paid_at, cancelled_at, cancel_reason, shipped_at, courier, tracking_number,
          checkout_attempt_id, terms_accepted_at, promo_opt_in, placed_with_session,
          contact_email, contact_phone, recipient_name, shipping_address,
          shipping_cost_amount, shipping_subsidy_amount, shipping_courier_code, shipping_service_code, shipping_courier_label,
          shipping_weight_grams, shipping_destination_id, shipping_quoted_at)
        values (
          'web', ${orderNo}, now() - interval '2 hours', ${status}, ${subtotal}, ${shipping}, 0, ${subtotal + shipping}, ${params.customerId},
          ${paymentStatus},
          ${params.state === "pending" ? sql`now() + interval '50 minutes'` : sql`now() - interval '70 minutes'`},
          ${paid ? sql`now() - interval '100 minutes'` : null},
          ${params.state === "cancelled" ? sql`now() - interval '60 minutes'` : null},
          ${params.state === "cancelled" ? "payment_expired" : null},
          ${params.state === "shipped" ? sql`now() - interval '30 minutes'` : null},
          ${params.state === "shipped" ? "JNE" : null},
          ${params.state === "shipped" ? "JNE0001E2E" : null},
          ${randomUUID()}, now(), false, ${params.placedWithSession},
          ${params.email}, '+6281200000001', 'Penerima E2E', 'Penerima E2E, +6281200000001, Jl. Melati 2, Kecamatan E2E Murah, Kota E2E, Provinsi E2E 40111',
          95000, 20000, 'jne', 'reg', 'JNE Reguler', 800, 'IDNP-E2E-JAUH', now())
        returning id`;
      if (!order) throw new Error("failed to seed e2e order");
      for (const line of params.lines) {
        await tx`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${order.id}, ${line.sku}, ${line.qty}, ${line.unitPrice}, ${paid ? 111_111 : 0})`;
      }
      if (params.paymentUrl) {
        await tx`insert into payments (order_id, provider, provider_order_id, attempt, gross_amount, redirect_url, status)
          values (${order.id}, 'midtrans', ${`E2E-${orderNo}-1`}, 1, ${subtotal + shipping}, ${params.paymentUrl}, 'pending')`;
      }
      return { id: order.id, orderNo };
    }),
  );
}

/** A staff-entered marketplace order of the customer (no payment status, no totals shown). */
export async function seedMarketplaceOrder(customerId: string, line: OrderLine): Promise<SeededOrder> {
  const orderNo = e2eOrderNo();
  return withSql(async (sql) => {
    const [order] = await sql<{ id: string }[]>`
      insert into orders (channel_id, order_no, channel_order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount, customer_id)
      values ('shopee', ${orderNo}, ${`SHOPEE-${randomUUID()}`}, now() - interval '3 days', 'to_ship', ${line.qty * line.unitPrice}, 0, 0, ${line.qty * line.unitPrice}, ${customerId})
      returning id`;
    if (!order) throw new Error("failed to seed e2e order");
    await sql`insert into order_items (order_id, sku, qty, unit_price, unit_cost) values (${order.id}, ${line.sku}, ${line.qty}, ${line.unitPrice}, 0)`;
    return { id: order.id, orderNo };
  });
}

/** A "Lihat pesanan" token for the order (120 days, or already expired), as an order email mints
 * it; returns the raw token. */
export async function issueViewToken(orderId: string, options: { expired?: boolean } = {}): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withSql(
    (sql) => sql`
      insert into order_access_tokens (order_id, token_hash, created_at, expires_at)
      values (${orderId}, ${hash(token)}, now() - interval '121 days', ${options.expired ? sql`now() - interval '1 day'` : sql`now() + interval '120 days'`})`,
  );
  return token;
}

/** The SKUs and quantities in the customer's cart. */
export async function customerCartLines(customerId: string): Promise<Record<string, number>> {
  return withSql(async (sql) => {
    const rows = await sql<{ sku: string; qty: number }[]>`
      select ci.sku, ci.qty from cart_items ci join carts c on c.id = ci.cart_id where c.customer_id = ${customerId}`;
    return Object.fromEntries(rows.map((row) => [row.sku, row.qty]));
  });
}

/** Clears the e2e server's own order-view and cart-write rows for 127.0.0.1 (every e2e request
 * without its own CF-Connecting-IP comes from there). */
export async function clearOrderLimits(): Promise<void> {
  await withSql((sql) => sql`delete from claim_rate_limits where ip = '127.0.0.1' and action in ('order_view', 'cart_write', 'cart_create')`);
}

export interface SeededShipment {
  providerOrderId: string;
  awb: string;
}

/** A courier booking of the order as admin's "Pesan kurir" stores it with the fake courier (K2):
 * waiting for pickup, waybill issued. The web "advance shipment" test route adopts it into its own
 * fake courier (docs/plans/cart-checkout.md §15 Phase K, K3). */
export async function seedBookedShipment(order: SeededOrder): Promise<SeededShipment> {
  const providerOrderId = randomBytes(12).toString("hex");
  const awb = `E2E${randomInt(1_000_000_000, 9_999_999_999)}${randomInt(100, 999)}`;
  await withSql(
    (sql) => sql`
      insert into shipments (order_id, attempt, reference_id, provider, provider_order_id, courier, service, awb, cost_amount, status, provider_status, booked_at, last_event_at)
      values (${order.id}, 1, ${`E2E-${order.orderNo}-K1`}, 'biteship', ${providerOrderId}, 'jne', 'reg', ${awb}, 95000, 'pickup_requested', 'confirmed', now(), now())`,
  );
  return { providerOrderId, awb };
}

/** The order's status and attention flags, as stored. */
export async function orderState(orderId: string): Promise<{ status: string; needsAttention: string[]; trackingNumber: string | null }> {
  return withSql(async (sql) => {
    const [row] = await sql<{ status: string; needs_attention: string[]; tracking_number: string | null }[]>`
      select status, needs_attention, tracking_number from orders where id = ${orderId}`;
    if (!row) throw new Error("no such e2e order");
    return { status: row.status, needsAttention: row.needs_attention, trackingNumber: row.tracking_number };
  });
}

/** K4: the order's booking as a failed automatic read leaves it (`read:<reason>`), or cleared. */
export async function setShipmentReadError(orderId: string, lastError: string | null): Promise<void> {
  await withSql((sql) => sql`update shipments set last_error = ${lastError} where order_id = ${orderId} and status not in ('cancelled', 'failed')`);
}

/** K4: a resi on the order other than the booking's waybill (a mismatch staff have not fixed yet). */
export async function setOrderTrackingNumber(orderId: string, trackingNumber: string): Promise<void> {
  await withSql((sql) => sql`update orders set tracking_number = ${trackingNumber} where id = ${orderId}`);
}
