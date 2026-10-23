import postgres from "postgres";
import type { APIRequestContext } from "@playwright/test";
import { E2E_REVALIDATE_SECRET } from "./revalidate-secret";

// Sets one e2e product's discount window directly in ammari_e2e, then refreshes its cached data
// through /api/revalidate with the tags an admin discount save sends (apps/admin lib/revalidate.ts
// revalidateProductSlug). After that, nothing else is called: the spec watches the discount start
// and end on reload alone (docs/plans/product-discount.md §7). Same fail-closed target guard as
// store-settings-db.ts: only host localhost/127.0.0.1, database "ammari_e2e".

function e2eDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set");
  const url = new URL(raw);
  url.pathname = "/ammari_e2e";
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Refusing to write e2e product discounts to non-local host "${url.hostname}".`);
  }
  return url.toString();
}

export async function saveDiscountWindow(
  request: APIRequestContext,
  slug: string,
  window: { enabled: boolean; startsAt: Date | null; endsAt: Date | null },
): Promise<void> {
  const sql = postgres(e2eDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`
      update products set
        discount_enabled = ${window.enabled},
        discount_starts_at = ${window.startsAt},
        discount_ends_at = ${window.endsAt}
      where slug = ${slug}
      returning id`;
    if (rows.length !== 1) throw new Error(`no e2e product with slug ${slug}`);
  } finally {
    await sql.end();
  }

  const response = await request.post("/api/revalidate", {
    headers: { "x-revalidate-secret": E2E_REVALIDATE_SECRET },
    data: { paths: [`/products/${slug}`], tags: [`storefront:product:${slug}`, "storefront:products", "storefront:homepage"] },
  });
  if (!response.ok()) throw new Error(`/api/revalidate answered ${response.status()}`);
}
