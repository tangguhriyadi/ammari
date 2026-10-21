import "server-only";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { shippingRateCache } from "@ammari/db/schema";
import type { Database } from "../db";
import { SHIPPING_SERVICE_ALLOWLIST, type AllowlistedService, type RatedService } from "./rules";

// shipping_rate_cache (docs/plans/cart-checkout.md §4.5.4, §11): one row per (origin,
// destination, parcel weight, allowlist), holding only the allowlisted services and their prices,
// never a raw provider response. A row is used while younger than SHIPPING_QUOTE_CACHE_MINUTES;
// an empty list ("no service") is cached the same way.

export const DEFAULT_SHIPPING_QUOTE_CACHE_MINUTES = 360;

export interface RateCacheKey {
  originId: string;
  destinationId: string;
  weightGrams: number;
  servicesKey: string;
}

/** sha256 of the allowlist's codes, so changing the allowlist never serves an old row. */
export function allowlistServicesKey(allowlist: readonly AllowlistedService[] = SHIPPING_SERVICE_ALLOWLIST): string {
  const pairs = allowlist.map((entry) => [entry.courierCode, entry.serviceCode]);
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}

const cachedResult = z.object({
  services: z.array(
    z.object({
      courierCode: z.string().min(1),
      serviceCode: z.string().min(1),
      cost: z.number().int().positive(),
    }),
  ),
});

export interface CachedRates {
  services: RatedService[];
  fetchedAt: Date;
}

/** A fresh row, judged by the database clock. A row whose JSON no longer parses counts as a miss
 * (it is overwritten by the next write). */
export async function readCachedRates(db: Database, key: RateCacheKey, maxAgeMinutes: number): Promise<CachedRates | null> {
  const [row] = await db
    .select({ result: shippingRateCache.result, fetchedAt: shippingRateCache.fetchedAt })
    .from(shippingRateCache)
    .where(
      and(
        eq(shippingRateCache.originId, key.originId),
        eq(shippingRateCache.destinationId, key.destinationId),
        eq(shippingRateCache.weightGrams, key.weightGrams),
        eq(shippingRateCache.servicesKey, key.servicesKey),
        sql`${shippingRateCache.fetchedAt} > now() - make_interval(mins => ${maxAgeMinutes})`,
      ),
    );
  if (!row) return null;
  const parsed = cachedResult.safeParse(row.result);
  if (!parsed.success) {
    // Overwritten by the next write; logged so a shape drift does not hide as paid cache misses.
    console.warn("[shipping] rate cache row unparseable; treated as a miss", {
      destinationId: key.destinationId,
      issues: parsed.error.issues.map((issue) => issue.code),
    });
    return null;
  }
  return { services: parsed.data.services, fetchedAt: row.fetchedAt };
}

/** Upserts the row (ON CONFLICT on the lookup UNIQUE) and returns its fetched_at. */
export async function writeCachedRates(db: Database, key: RateCacheKey, services: readonly RatedService[]): Promise<Date> {
  const result = { services: services.map(({ courierCode, serviceCode, cost }) => ({ courierCode, serviceCode, cost })) };
  const [row] = await db
    .insert(shippingRateCache)
    .values({ ...key, result })
    .onConflictDoUpdate({
      target: [shippingRateCache.originId, shippingRateCache.destinationId, shippingRateCache.weightGrams, shippingRateCache.servicesKey],
      set: { result: sql`excluded.result`, fetchedAt: sql`now()` },
    })
    .returning({ fetchedAt: shippingRateCache.fetchedAt });
  if (!row) throw new Error("shipping_rate_cache upsert returned no row");
  return row.fetchedAt;
}
