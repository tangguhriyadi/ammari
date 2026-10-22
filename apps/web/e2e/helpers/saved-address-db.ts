import { randomUUID } from "node:crypto";
import postgres from "postgres";

// Direct ammari_e2e access for saved-address.spec.ts ("Alamat tersimpan" on /account). Same
// fail-closed target guard as the other helpers: host localhost/127.0.0.1, database "ammari_e2e"
// only. Rows seeded here are not deleted: ammari_e2e is truncated at the start of every run.

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

/** A saved default address for the customer, as placeOrder writes one, on a fresh area of its own
 * (the flag-off case cannot place an order). */
export async function seedSavedAddress(customerId: string, recipientName: string): Promise<void> {
  await withSql((sql) =>
    sql.begin(async (tx) => {
      const [area] = await tx<{ id: string }[]>`
        insert into shipping_areas (province, city, district, postal_code, search_text, provider_area_id)
        values ('Jawa Barat', 'Kota E2E', 'Kecamatan E2E Alamat', '40111', 'kecamatan e2e alamat', ${`E2E-ADDR-${randomUUID()}`})
        returning id`;
      await tx`
        insert into customer_addresses (customer_id, recipient_name, phone, address_line, shipping_area_id, province, city, district, postal_code, is_default)
        values (${customerId}, ${recipientName}, '+6281234567890', 'Jl. Kenanga No. 9', ${area!.id}, 'Jawa Barat', 'Kota E2E', 'Kecamatan E2E Alamat', '40111', true)`;
    }),
  );
}

export async function savedAddressCount(customerId: string): Promise<number> {
  return withSql(async (sql) => {
    const [row] = await sql<{ count: string }[]>`select count(*) from customer_addresses where customer_id = ${customerId}`;
    return Number(row?.count ?? 0);
  });
}

/** The order rows' own address snapshots, which a deletion must never touch. */
export async function orderAddressesOf(email: string): Promise<{ recipientName: string | null; addressLine: string | null }[]> {
  return withSql((sql) => sql<{ recipientName: string | null; addressLine: string | null }[]>`
    select recipient_name as "recipientName", shipping_address_snapshot->>'addressLine' as "addressLine"
    from orders where contact_email = ${email} order by created_at`);
}
