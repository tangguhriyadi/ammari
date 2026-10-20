import "server-only";
import { cache } from "react";
import { getStoreSettings, type StorefrontSettings } from "@ammari/db/storefront";
import { HOMEPAGE_META_DESCRIPTION_DEFAULT, HOMEPAGE_META_TITLE_DEFAULT } from "@ammari/db/storefront-settings";

type StoreSettingsSnapshot = StorefrontSettings;

// A failed read hides the announcement bar too (enabled: false), same "null = hide" contract as
// the contact fields: an outage must never render a stale or default promise to shoppers.
const EMPTY_SETTINGS: StoreSettingsSnapshot = {
  whatsappNumber: null,
  supportEmail: null,
  businessAddress: null,
  returnPolicySummary: null,
  announcementBarEnabled: false,
  announcementBarText: null,
  homepageMetaTitle: null,
  homepageMetaDescription: null,
};

/** Read via the ROOT layout, which wraps every route including ones Next still probes for
 * static-vs-dynamic status at `next build` time even when they end up dynamic at runtime (a
 * session-gated page's `cookies()` call only bails to dynamic AFTER its component tree,
 * including this layout read, finishes running once during that probe — confirmed empirically:
 * building against an unreachable DATABASE_URL throws from exactly this call, for `/account`,
 * not just a plain static page). A thrown connection error here must never crash that probe (or,
 * at runtime, a real page render) — logged loudly, same "never silently drop, but never crash
 * the render either" posture lib/revalidate.ts already takes on apps/admin, falling back to
 * "nothing set" (every caller already treats null as "hide this").
 *
 * Deliberately NOT wrapped in `unstable_cache` (tried, then reverted — see this session's own
 * implementation report): `unstable_cache`'s Data Cache did not reliably reflect writes made
 * directly via `db.update(storeSettings)` outside a publish/revalidate action (e2e fixtures,
 * and in principle a direct DB edit) within the SAME dev-server/build lifetime, serving a stale
 * cached result instead — a correctness bug worse than the extra query it was meant to save. A
 * `SELECT ... LIMIT 1` by primary key on a 1-row table is cheap enough per request that this
 * table doesn't need caching at all. */
//
// React `cache()` (per-request memoization, not a cross-request cache, so the reasoning above
// still holds): the root layout, the homepage's generateMetadata and a product page all read
// these settings while rendering one request, and that is now one query instead of several.
const safeGetStoreSettings = cache(async (): Promise<StoreSettingsSnapshot> => {
  try {
    return await getStoreSettings();
  } catch (error) {
    console.error("store-settings: failed to read store_settings — rendering without store contact info", error);
    return EMPTY_SETTINGS;
  }
});

/** `STORE_WHATSAPP_NUMBER` is now a FALLBACK, used only when `store_settings.whatsapp_number`
 * is empty (docs/plans/storefront-cms.md Phase 2, session 8) — kept rather than removed: it's
 * already wired into apps/web/playwright.config.ts's `webServer.env` for deterministic e2e
 * assertions, and dropping it would mean re-plumbing e2e to seed `store_settings` instead for no
 * real behavioral gain. `null` when both are unset, which every caller already treats as "hide
 * the button," never a broken `wa.me` link with no number. */
export async function getWhatsappNumber(): Promise<string | null> {
  const settings = await safeGetStoreSettings();
  if (settings.whatsappNumber) return settings.whatsappNumber;
  const raw = process.env.STORE_WHATSAPP_NUMBER;
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

export interface StoreContact {
  supportEmail: string | null;
  businessAddress: string | null;
  returnPolicySummary: string | null;
}

/** The footer's contact block and the PDP trust row's 3rd item (docs/design/storefront.md §4/§6)
 * — both read straight from `store_settings`, no env-var fallback (unlike the WhatsApp number,
 * nothing pre-existing depended on an env var for these). `null` fields mean "hide this," same
 * contract as everywhere else store settings are read. */
export async function getStoreContact(): Promise<StoreContact> {
  const settings = await safeGetStoreSettings();
  return {
    supportEmail: settings.supportEmail,
    businessAddress: settings.businessAddress,
    returnPolicySummary: settings.returnPolicySummary,
  };
}

/** The announcement bar's text, or null when the bar must not render at all (switched off, or
 * the text is empty). The admin form already collapses whitespace on save; trimmed again here so
 * a direct DB edit with stray spaces can't render an empty-looking bar. */
export async function getAnnouncementBarText(): Promise<string | null> {
  const settings = await safeGetStoreSettings();
  if (!settings.announcementBarEnabled) return null;
  const text = settings.announcementBarText?.trim();
  return text ? text : null;
}

export interface HomepageMeta {
  title: string;
  description: string;
}

/** "/"'s <title>, meta description, og:title and og:description: the owner's text from
 * Pengaturan Toko, or the shared default when a field is empty. */
export async function getHomepageMeta(): Promise<HomepageMeta> {
  const settings = await safeGetStoreSettings();
  return {
    title: settings.homepageMetaTitle?.trim() || HOMEPAGE_META_TITLE_DEFAULT,
    description: settings.homepageMetaDescription?.trim() || HOMEPAGE_META_DESCRIPTION_DEFAULT,
  };
}
