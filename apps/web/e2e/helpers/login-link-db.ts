import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import postgres from "postgres";

// Direct ammari_e2e access for login-link.spec.ts (docs/plans/cart-checkout.md §9.3, session 14).
// Same fail-closed target guard as cart-db.ts and checkout-db.ts: host localhost/127.0.0.1,
// database "ammari_e2e" only. Links are written the way @ammari/auth's issueOrReuseCustomerLoginLink
// writes them (supersede the live one, insert the sha256 of a fresh token in one transaction); the
// issuance code itself is covered by packages/auth's and apps/web's own tests. Tokens are random,
// built at runtime. Rows seeded here are not deleted: ammari_e2e is truncated at the start of every run.

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

export interface LinkCustomer {
  id: string;
  email: string;
}

/** A customer as a guest checkout leaves it: email and name only (no phone), with PDP consent
 * already given unless `consented: false`. */
export async function seedLinkCustomer(label: string, options: { consented?: boolean } = {}): Promise<LinkCustomer> {
  const email = `${label}-${randomUUID().slice(0, 8)}@e2e.ammari.test`;
  return withSql(async (sql) => {
    const consent = options.consented === false ? null : new Date();
    const [row] = await sql<{ id: string }[]>`insert into customers (email, name, pdp_consent_at) values (${email}, 'Pembeli Link E2E', ${consent}) returning id`;
    if (!row) throw new Error("failed to seed e2e customer");
    return { id: row.id, email };
  });
}

/** Issues a new link for the customer (superseding the live one) and returns its raw token. */
export async function issueLoginLink(customer: LinkCustomer): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withSql((sql) =>
    sql.begin(async (tx) => {
      await tx`update customer_login_links set superseded_at = now() where customer_id = ${customer.id} and consumed_at is null and superseded_at is null`;
      await tx`insert into customer_login_links (customer_id, email, token_hash, expires_at) values (${customer.id}, ${customer.email}, ${hash(token)}, now() + interval '24 hours')`;
    }),
  );
  return token;
}

/** Moves the link 25 hours into the past (expired an hour ago). */
export async function expireLoginLink(token: string): Promise<void> {
  await withSql((sql) => sql`update customer_login_links set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where token_hash = ${hash(token)}`);
}

export async function loginLinkState(token: string): Promise<{ consumed: boolean; superseded: boolean }> {
  return withSql(async (sql) => {
    const [row] = await sql<{ consumed: boolean; superseded: boolean }[]>`
      select consumed_at is not null as consumed, superseded_at is not null as superseded from customer_login_links where token_hash = ${hash(token)}`;
    if (!row) throw new Error("no such e2e login link");
    return row;
  });
}

/** Better Auth sessions of the customer (0 until a login happened). */
export async function sessionCountFor(customer: LinkCustomer): Promise<number> {
  return withSql(async (sql) => {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from customer_auth_sessions s join customer_auth_users u on u.id = s.user_id where u.customer_id = ${customer.id}`;
    return row?.n ?? 0;
  });
}

/** A guest checkout order of the customer, with the WhatsApp number and promo choice typed at
 * checkout (only on the order, never on the account: plan §5 step 4). */
export async function seedGuestOrder(customer: LinkCustomer, values: { phone: string; promoOptIn: boolean }): Promise<string> {
  const orderNo = `ORD-E2E-${randomInt(10_000_000, 99_999_999)}`;
  await withSql(
    (sql) => sql`
      insert into orders (
        channel_id, order_no, order_date, status, subtotal_amount, shipping_amount, discount_amount, total_amount, customer_id,
        payment_status, payment_expires_at, checkout_attempt_id, terms_accepted_at, promo_opt_in, placed_with_session,
        contact_email, contact_phone, recipient_name,
        shipping_cost_amount, shipping_subsidy_amount, shipping_courier_code, shipping_service_code, shipping_courier_label,
        shipping_weight_grams, shipping_destination_id, shipping_quoted_at)
      values (
        'web', ${orderNo}, now(), 'awaiting_payment', 250000, 0, 0, 250000, ${customer.id},
        'pending', now() + interval '60 minutes', ${randomUUID()}, now(), ${values.promoOptIn}, false,
        ${customer.email}, ${values.phone}, 'Pembeli Link E2E',
        12000, 12000, 'jne', 'reg', 'JNE Reguler', 800, 'IDNP-E2E-MURAH', now())`,
  );
  return orderNo;
}

/** A WhatsApp number no other e2e customer has. */
export function uniquePhone(): string {
  return `+628${String(randomInt(1_000_000_000, 9_999_999_999))}`;
}

export async function customerContact(customer: LinkCustomer): Promise<{ phone: string | null; promo: boolean }> {
  return withSql(async (sql) => {
    const [row] = await sql<{ phone: string | null; promo: boolean }[]>`select phone, promo_consent_at is not null as promo from customers where id = ${customer.id}`;
    if (!row) throw new Error("no such e2e customer");
    return row;
  });
}
