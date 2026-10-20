import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import type { BrowserContext } from "@playwright/test";

// Seeds guest carts straight into ammari_e2e for cart.spec.ts, so a spec can start from line
// states the UI cannot reach on its own (a sold-out or unpublished line, more pieces than are in
// stock) without spending the per-IP cart write limits. Same token shape as
// @ammari/commerce/cart's token.ts (32 random bytes, base64url; only the sha256 hex stored), same
// fail-closed target guard as store-settings-db.ts: host localhost/127.0.0.1, database
// "ammari_e2e" only.

const CART_COOKIE_NAME = "ammari_cart";

function e2eDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  url.pathname = "/ammari_e2e";
  // postgres.js also reads a host from the query string; none is allowed to redirect it.
  url.search = "";
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Refusing to seed an e2e cart on non-local host "${url.hostname}".`);
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

/** The SKU of a seeded variant, looked up by product slug, colour name and size. */
export async function findSku(productSlug: string, colorName: string, size: string): Promise<string> {
  return withSql(async (sql) => {
    const [row] = await sql<{ sku: string }[]>`
      select v.sku from product_variants v
      join products p on p.id = v.product_id
      join fabric_colors c on c.id = v.fabric_color_id
      where p.slug = ${productSlug} and c.name = ${colorName} and v.size = ${size}`;
    if (!row) throw new Error(`no e2e variant ${productSlug} ${colorName} ${size}`);
    return row.sku;
  });
}

/** Creates a guest cart holding `lines` (in this order) and puts its cookie into `context`. */
export async function seedGuestCart(context: BrowserContext, baseURL: string, lines: { sku: string; qty: number }[]): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await withSql(async (sql) => {
    await sql.begin(async (tx) => {
      const [cart] = await tx<{ id: string }[]>`insert into carts (token_hash) values (${tokenHash}) returning id`;
      if (!cart) throw new Error("failed to seed e2e cart");
      for (const [index, line] of lines.entries()) {
        // Distinct added_at values keep the page's line order equal to `lines`.
        await tx`insert into cart_items (cart_id, sku, qty, added_at) values (${cart.id}, ${line.sku}, ${line.qty}, now() + make_interval(secs => ${index}))`;
      }
    });
  });
  await context.addCookies([{ name: CART_COOKIE_NAME, value: token, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}
