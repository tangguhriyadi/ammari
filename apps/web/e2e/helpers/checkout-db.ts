import { randomUUID } from "node:crypto";
import postgres from "postgres";

// Direct ammari_e2e access for checkout.spec.ts (docs/plans/cart-checkout.md session 10). Same
// fail-closed target guard as cart-db.ts: host localhost/127.0.0.1, database "ammari_e2e" only.
// Every helper touches only rows it creates itself, or the e2e server's own rate-limit rows for
// 127.0.0.1 (every e2e request comes from there, so the suite would otherwise trip its own
// per-IP limits). Clearing and filling those shared rows is safe only because playwright.config.ts
// runs one worker with fullyParallel off; parallel workers would make the limit tests flaky. Rows
// seeded here are not deleted: ammari_e2e is truncated at the start of every run.

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

/** The colour of every product seedCheckoutProduct makes (size M). */
export const CHECKOUT_COLOR_NAME = "Krem Checkout E2E";

export interface CheckoutProduct {
  name: string;
  slug: string;
  sku: string;
  price: number;
}

/** A fresh published product (CHECKOUT_COLOR_NAME, size M) with a shipping weight, a photo and `stock`
 * pieces, so each test owns its stock and never changes what other specs see. `weightGrams: null`
 * makes a product the quote refuses ("missing weight"). */
export async function seedCheckoutProduct(params: { label: string; stock?: number; price?: number; weightGrams?: number | null }): Promise<CheckoutProduct> {
  const suffix = randomUUID().slice(0, 8);
  const code = `CO${suffix.toUpperCase()}`;
  const name = `Gamis ${params.label} E2E`;
  const slug = `gamis-checkout-${suffix}`;
  const price = params.price ?? 250_000;
  const stock = params.stock ?? 20;
  const weight = params.weightGrams === undefined ? 700 : params.weightGrams;
  return withSql(async (sql) => {
    // Their own colour, so these products (which also show up as related tiles on other product
    // pages) never add a second "Beige E2E" to a page another spec checks.
    const [fabric] = await sql<{ id: string }[]>`select id from fabrics where name = 'Katun Rayon E2E' limit 1`;
    if (!fabric) throw new Error("e2e fabric Katun Rayon E2E is not seeded");
    const [existing] = await sql<{ id: string; fabricId: string }[]>`
      select id, fabric_id as "fabricId" from fabric_colors where fabric_id = ${fabric.id} and name = ${CHECKOUT_COLOR_NAME} limit 1`;
    const [inserted] = existing
      ? [existing]
      : await sql<{ id: string; fabricId: string }[]>`
          insert into fabric_colors (fabric_id, name, hex) values (${fabric.id}, ${CHECKOUT_COLOR_NAME}, '#E8DCC8') returning id, fabric_id as "fabricId"`;
    const color = inserted;
    if (!color) throw new Error("failed to seed the checkout e2e colour");
    const [chart] = await sql<{ id: string }[]>`select id from size_charts where name = 'Gamis Reguler E2E' limit 1`;
    const sku = `E2E-${code}-KRM-M`;
    await sql.begin(async (tx) => {
      const [product] = await tx<{ id: string }[]>`
        insert into products (name, code, slug, fabric_id, closure, size_mode, base_price, is_active, is_published_on_storefront, size_chart_id, shipping_weight_grams)
        values (${name}, ${code}, ${slug}, ${color.fabricId}, 'front_zip', 'sized', ${price}, true, true, ${chart?.id ?? null}, ${weight})
        returning id`;
      if (!product) throw new Error("failed to seed checkout product");
      await tx`
        insert into product_images (product_id, fabric_id, fabric_color_id, storage_key, alt_text, width, height, sort_order)
        values (${product.id}, ${color.fabricId}, ${color.id}, 'api/test/fixtures/beige', ${name}, 800, 1200, 0)`;
      await tx`
        insert into product_variants (sku, product_id, fabric_id, fabric_color_id, closure, size, is_active)
        values (${sku}, ${product.id}, ${color.fabricId}, ${color.id}, 'front_zip', 'M', true)`;
      if (stock > 0) {
        await tx`insert into stock_movements (sku, qty, value_amount, type, ref_type) values (${sku}, ${stock}, ${stock * 48_000}, 'production', 'manual')`;
      }
    });
    return { name, slug, sku, price };
  });
}

/** Takes every remaining physical piece of `sku` out of stock (an append-only adjustment row,
 * like a staff recount), e.g. a marketplace sale while the buyer is on the checkout page. */
export async function sellOut(sku: string): Promise<void> {
  await withSql(async (sql) => {
    const [row] = await sql<{ qty: number }[]>`select coalesce(sum(qty), 0)::int as qty from stock_movements where sku = ${sku}`;
    const qty = row?.qty ?? 0;
    if (qty > 0) {
      await sql`insert into stock_movements (sku, qty, value_amount, type, ref_type, reason) values (${sku}, ${-qty}, ${-qty * 48_000}, 'adjustment', 'manual', 'recount')`;
    }
  });
}

const E2E_IP = "127.0.0.1";

/** Forgets the e2e server's own checkout-related rate-limit rows (per IP and per cart), so each
 * test starts below every limit. */
export async function clearCheckoutRateLimits(): Promise<void> {
  await withSql(async (sql) => {
    await sql`
      delete from claim_rate_limits
      where (ip = ${E2E_IP}::inet and action in ('checkout_submit', 'shipping_quote', 'area_search', 'cart_write', 'cart_create'))
         or (ip = '0.0.0.0'::inet and action like 'shipping_quote_cart:%')`;
  });
}

/** Puts `count` recent rows for `action` from 127.0.0.1, so the next request is over the limit. */
export async function fillRateLimit(action: "checkout_submit" | "shipping_quote", count: number): Promise<void> {
  await withSql(async (sql) => {
    await sql`insert into claim_rate_limits (ip, action) select ${E2E_IP}::inet, ${action} from generate_series(1, ${count})`;
  });
}

/** An active Rp`amount` voucher for the customer with this email (created by their login). A
 * voucher belongs to a thank-you card printed for a marketplace order, so those rows come too. */
export async function seedVoucherFor(email: string, amount = 20_000): Promise<void> {
  await withSql(async (sql) => {
    await sql.begin(async (tx) => {
      const [customer] = await tx<{ id: string }[]>`select id from customers where email = ${email}`;
      if (!customer) throw new Error(`no e2e customer ${email}`);
      const [role] = await tx<{ id: string }[]>`select id from roles where key = 'owner'`;
      if (!role) throw new Error("owner role is not seeded");
      const [staff] = await tx<{ id: string }[]>`
        insert into staff_users (name, email, role_id) values ('E2E Staff', ${`staff-${randomUUID()}@e2e.ammari.test`}, ${role.id}) returning id`;
      if (!staff) throw new Error("failed to seed e2e staff user");
      const [order] = await tx<{ id: string }[]>`
        insert into orders (channel_id, order_no, channel_order_no, order_date, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('shopee', ${`ORD-E2E-${randomUUID()}`}, ${`SHP-${randomUUID()}`}, now(), 250000, 0, 0, 250000) returning id`;
      if (!order) throw new Error("failed to seed e2e marketplace order");
      const [card] = await tx<{ id: string }[]>`
        insert into thank_you_cards (order_id, token_hash, claim_deadline, printed_by_staff_user_id)
        values (${order.id}, ${`hash-${randomUUID()}`}, now() + interval '30 days', ${staff.id}) returning id`;
      if (!card) throw new Error("failed to seed e2e thank-you card");
      await tx`
        insert into vouchers (card_id, customer_id, amount, status, expires_at)
        values (${card.id}, ${customer.id}, ${amount}, 'active', now() + interval '90 days')`;
    });
  });
}

/** The newest checkout order for a contact email, for checks the page does not show. */
export async function latestOrderFor(email: string): Promise<{ orderNo: string; shippingAmount: number; discountAmount: number; totalAmount: number } | null> {
  return withSql(async (sql) => {
    const [row] = await sql<{ orderNo: string; shippingAmount: number; discountAmount: number; totalAmount: number }[]>`
      select order_no as "orderNo", shipping_amount::int as "shippingAmount", discount_amount::int as "discountAmount", total_amount::int as "totalAmount"
      from orders where contact_email = ${email} and payment_status is not null order by created_at desc limit 1`;
    return row ?? null;
  });
}

/** How many checkout orders exist for a contact email. */
export async function countOrdersFor(email: string): Promise<number> {
  return withSql(async (sql) => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from orders where contact_email = ${email}`;
    return row?.n ?? 0;
  });
}
