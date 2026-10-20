// Shared, pure constants for the storefront-facing store settings (announcement bar, homepage
// meta) and the Hero-derived Open Graph image. Imported by apps/admin (validation, form counters,
// OG generation) AND apps/web (rendering, fallbacks), so the two apps can never disagree on a
// default or a limit. No DB access here, safe to import from a client component.

/** Shown when the owner never edited the bar (migration 0029 seeds this same string as the
 * column default, keep the two identical). */
export const ANNOUNCEMENT_BAR_DEFAULT_TEXT = "Gratis Ongkir Ke Seluruh Indonesia";

/** The longest text that still fits ONE line of the bar at a 360px-wide phone (the narrowest
 * common Android width) in the bar's mobile type (11px, uppercase, 0.12em tracking): measured,
 * see apps/web/e2e/announcement-bar.spec.ts. Backed by a CHECK in migration 0029. */
export const ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH = 40;

/** Used for "/" when `store_settings.homepage_meta_title`/`_description` are null. */
export const HOMEPAGE_META_TITLE_DEFAULT = "Ammari | Graceful in every thread";
// Never name a city or shipping origin here (docs/design/storefront.md §2 "Hard rules"): this text
// is the homepage's search snippet and social preview. The only place a city may appear on the
// storefront is the owner's own business address (contact/legal blocks, from store settings).
export const HOMEPAGE_META_DESCRIPTION_DEFAULT =
  "Gamis syar'i Ammari. Desain syar'i yang anggun, bahan premium, dan nyaman dipakai seharian. Gratis ongkir ke seluruh Indonesia.";

/** Search-result guidance shown next to the admin counters (Google truncates around here). */
export const HOMEPAGE_META_TITLE_RECOMMENDED_LENGTH = 60;
export const HOMEPAGE_META_DESCRIPTION_RECOMMENDED_LENGTH = 160;

/** Hard caps, enforced by Zod and by a CHECK in migration 0029. Generous on purpose: going past
 * the recommended length only gets truncated in search results, it is not an error. */
export const HOMEPAGE_META_TITLE_MAX_LENGTH = 80;
export const HOMEPAGE_META_DESCRIPTION_MAX_LENGTH = 200;

/** The social preview size every major platform (Facebook, WhatsApp, X, LinkedIn) renders
 * without its own crop. */
export const HERO_OG_IMAGE_WIDTH = 1200;
export const HERO_OG_IMAGE_HEIGHT = 630;

/** The object key of the Hero's generated OG JPEG, next to the Hero image's own WebP sizes
 * (`<storageKey>/<size>.webp`). One per Hero image: a new Hero image is a new storageKey, so the
 * URL changes with it and the immutable cache header (packages/storage) stays correct. */
export function buildHeroOgImageKey(heroStorageKey: string): string {
  return `${heroStorageKey}/og.jpg`;
}
