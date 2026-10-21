import "server-only";
import { eq, sql } from "drizzle-orm";
import { shippingAreas } from "@ammari/db/schema";
import type { Database } from "../db";
import type { ShippingArea, ShippingRateProvider } from "./provider";
import { formatShippingAreaLabel, shippingAreaSearchText } from "./rules";

// Area search for the checkout combobox (docs/plans/cart-checkout.md §4.5.1, session 8): ask the
// provider, cache every returned area in shipping_areas, and hand the browser only our own row id
// and a display label. The browser never sees or sends a provider area id.

/** At most this many results reach the browser (plan §4.5.1). */
export const SHIPPING_AREA_RESULT_LIMIT = 10;
/** Upper bound on rows upserted per search, so an oversized provider answer stays one small
 * statement. */
const MAX_UPSERT_ROWS = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShippingAreaOption {
  /** `shipping_areas.id`, what the checkout form posts back as `shippingAreaId`. */
  id: string;
  /** "Kecamatan, Kota, Provinsi 12345". */
  label: string;
  /** False when the area has no kode pos, so the form shows the Kode pos input (plan §4.3). */
  hasPostalCode: boolean;
}

/** One shipping_areas row as the address validator and the quote need it. */
export interface ShippingAreaRecord {
  id: string;
  province: string;
  city: string;
  district: string;
  subdistrict: string | null;
  postalCode: string | null;
  label: string;
  providerAreaId: string | null;
}

/** Searches the provider and upserts every area it returned (first occurrence wins when the
 * provider repeats an id: one INSERT ... ON CONFLICT DO UPDATE cannot touch the same row twice),
 * refreshing names, label, kode pos and last_synced_at. Returns at most
 * SHIPPING_AREA_RESULT_LIMIT options in the provider's order. Provider errors propagate as
 * ShippingRateError for the caller to turn into a message. */
export async function searchShippingAreas(db: Database, provider: ShippingRateProvider, query: string): Promise<ShippingAreaOption[]> {
  const found = await provider.searchAreas(query);
  const unique: ShippingArea[] = [];
  const seen = new Set<string>();
  for (const area of found) {
    if (seen.has(area.providerAreaId)) continue;
    seen.add(area.providerAreaId);
    unique.push(area);
    if (unique.length === MAX_UPSERT_ROWS) break;
  }
  if (unique.length === 0) return [];

  // Sorted by provider id, so two concurrent searches with overlapping results lock the rows in the
  // same order (a multi-row ON CONFLICT DO UPDATE locks in VALUES order; mixed orders can deadlock).
  // The provider's order is kept in `unique` for the answer.
  const sorted = [...unique].sort((a, b) => (a.providerAreaId < b.providerAreaId ? -1 : a.providerAreaId > b.providerAreaId ? 1 : 0));
  const rows = await db
    .insert(shippingAreas)
    .values(
      sorted.map((area) => ({
        providerAreaId: area.providerAreaId,
        province: area.province,
        city: area.city,
        district: area.district,
        subdistrict: area.subdistrict,
        postalCode: area.postalCode,
        label: formatShippingAreaLabel(area),
        searchText: shippingAreaSearchText(area),
      })),
    )
    .onConflictDoUpdate({
      target: shippingAreas.providerAreaId,
      set: {
        province: sql`excluded.province`,
        city: sql`excluded.city`,
        district: sql`excluded.district`,
        subdistrict: sql`excluded.subdistrict`,
        postalCode: sql`excluded.postal_code`,
        label: sql`excluded.label`,
        searchText: sql`excluded.search_text`,
        lastSyncedAt: sql`now()`,
      },
    })
    .returning({ id: shippingAreas.id, providerAreaId: shippingAreas.providerAreaId, label: shippingAreas.label, postalCode: shippingAreas.postalCode });

  // RETURNING order is not guaranteed to follow VALUES, so map back by provider id.
  const byProviderId = new Map(rows.map((row) => [row.providerAreaId, row]));
  const options: ShippingAreaOption[] = [];
  for (const area of unique.slice(0, SHIPPING_AREA_RESULT_LIMIT)) {
    const row = byProviderId.get(area.providerAreaId);
    if (!row) {
      console.warn("[shipping] area upsert returned no row for a provider area; left out of the results");
      continue;
    }
    options.push({ id: row.id, label: row.label ?? formatShippingAreaLabel(area), hasPostalCode: row.postalCode !== null });
  }
  return options;
}

/** The area the browser picked, by our own id. Null for anything that is not one of our rows
 * (a malformed id included), which the caller treats as a validation error (plan §4.5.1). */
export async function loadShippingArea(db: Database, id: string): Promise<ShippingAreaRecord | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const [row] = await db
    .select({
      id: shippingAreas.id,
      province: shippingAreas.province,
      city: shippingAreas.city,
      district: shippingAreas.district,
      subdistrict: shippingAreas.subdistrict,
      postalCode: shippingAreas.postalCode,
      label: shippingAreas.label,
      providerAreaId: shippingAreas.providerAreaId,
    })
    .from(shippingAreas)
    .where(eq(shippingAreas.id, id));
  if (!row) return null;
  return { ...row, label: row.label ?? formatShippingAreaLabel(row) };
}
