import "server-only";
import { getStoreSettings } from "@ammari/db/storefront";

interface StoreSettingsSnapshot {
  whatsappNumber: string | null;
  supportEmail: string | null;
  businessAddress: string | null;
  returnPolicySummary: string | null;
}

const EMPTY_SETTINGS: StoreSettingsSnapshot = {
  whatsappNumber: null,
  supportEmail: null,
  businessAddress: null,
  returnPolicySummary: null,
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
async function safeGetStoreSettings(): Promise<StoreSettingsSnapshot> {
  try {
    return await getStoreSettings();
  } catch (error) {
    console.error("store-settings: failed to read store_settings — rendering without store contact info", error);
    return EMPTY_SETTINGS;
  }
}

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
