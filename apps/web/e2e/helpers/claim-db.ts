import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

// Direct ammari_e2e access for claim.spec.ts. Same fail-closed target guard as checkout-db.ts:
// host localhost/127.0.0.1, database "ammari_e2e" only. A card is written the way apps/admin's
// packing flow mints one (the sha256 of the normalized token, never the token itself), for a
// marketplace order of its own. Tokens are random, built at runtime. Rows seeded here are not
// deleted: ammari_e2e is truncated at the start of every run.

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

/** A printed, unclaimed thank-you card; returns its raw (already normalized) token. */
export async function seedClaimableCard(): Promise<string> {
  const token = randomBytes(16).toString("hex").toUpperCase();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await withSql((sql) =>
    sql.begin(async (tx) => {
      const [role] = await tx<{ id: string }[]>`select id from roles where key = 'owner'`;
      if (!role) throw new Error("owner role is not seeded");
      const [staff] = await tx<{ id: string }[]>`
        insert into staff_users (name, email, role_id) values ('E2E Staff', ${`staff-${randomUUID()}@e2e.ammari.test`}, ${role.id}) returning id`;
      if (!staff) throw new Error("failed to seed e2e staff user");
      const [order] = await tx<{ id: string }[]>`
        insert into orders (channel_id, order_no, channel_order_no, order_date, subtotal_amount, shipping_amount, discount_amount, total_amount)
        values ('shopee', ${`ORD-E2E-${randomUUID()}`}, ${`SHP-${randomUUID()}`}, now(), 250000, 0, 0, 250000) returning id`;
      if (!order) throw new Error("failed to seed e2e marketplace order");
      await tx`
        insert into thank_you_cards (order_id, token_hash, claim_deadline, printed_by_staff_user_id)
        values (${order.id}, ${tokenHash}, now() + interval '30 days', ${staff.id})`;
    }),
  );
  return token;
}

/** The customer's active vouchers' expiry dates (the claim itself sets them). */
export async function activeVoucherExpiries(customerId: string): Promise<Date[]> {
  return withSql(async (sql) => {
    const rows = await sql<{ expires_at: Date }[]>`select expires_at from vouchers where customer_id = ${customerId} and status = 'active'`;
    return rows.map((row) => row.expires_at);
  });
}
