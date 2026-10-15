import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "./client";
import { products } from "./schema";

// Same Tx/Database union every other query layer in this codebase uses (apps/admin's own
// lib/db.ts) — accepting a transaction too, not just the top-level client, is what lets tests
// call this inside `withRollback`.
type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
type Database = typeof defaultDb | Tx;

/** Minimal product read for the future storefront PDP (apps/web) — not consumed anywhere yet
 * (no storefront product page exists), added now so every product column, including
 * `highlights`, is reachable the moment that page is built, without apps/web having to depend
 * on apps/admin's own query layer (which is shaped for admin screens — joins, admin-specific
 * fields a PDP shouldn't just inherit). Deliberately thin: a plain active-only, by-slug, full-
 * row read — no variant/image/pricing shaping, no pagination. That shaping is the storefront
 * page's own future work. */
export async function getActiveProductBySlug(slug: string, db: Database = defaultDb) {
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.slug, slug), eq(products.isActive, true)))
    .limit(1);
  return product ?? null;
}
