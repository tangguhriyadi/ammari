import "server-only";
import type { ShippingAreaOption } from "@ammari/commerce/shipping";

// Per-process memory of recent area search answers (security review, session 8): buyers type the
// same kecamatan names over and over, and every provider Maps call spends the shared daily budget
// (and, past the monthly quota, money). A repeat of the same normalized query within the TTL is
// answered from here without a provider call. Holds only our own shipping_areas ids and public
// labels, never anything about the visitor. Lost on restart, which only costs a few calls.

export const AREA_SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const AREA_SEARCH_CACHE_MAX_ENTRIES = 2_000;

const entries = new Map<string, { options: ShippingAreaOption[]; expiresAt: number }>();

/** Lowercase, single-spaced: "Coblong" and " coblong " are one entry. */
export function areaSearchCacheKey(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

export function readAreaSearchCache(query: string, now = Date.now()): ShippingAreaOption[] | null {
  const key = areaSearchCacheKey(query);
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    entries.delete(key);
    return null;
  }
  return entry.options;
}

/** Oldest entry first out when full (Map keeps insertion order). Empty answers are kept too: a
 * nonsense query repeated by a bot must not reach the provider each time. */
export function writeAreaSearchCache(query: string, options: ShippingAreaOption[], now = Date.now()): void {
  const key = areaSearchCacheKey(query);
  entries.delete(key);
  entries.set(key, { options, expiresAt: now + AREA_SEARCH_CACHE_TTL_MS });
  while (entries.size > AREA_SEARCH_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Tests only. */
export function clearAreaSearchCache(): void {
  entries.clear();
}
