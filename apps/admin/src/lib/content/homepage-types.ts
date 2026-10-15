import { HOMEPAGE_SECTION_KEYS, type HomepageSectionKey } from "@ammari/db/schema";

// ---------- Pure types/helpers shared by server code AND client components ----------
//
// Deliberately NOT in homepage.ts (which has `import "server-only"` and pulls in the real DB
// client transitively) — a CLIENT component (homepage-overview.tsx) needs
// `sectionHasUnpublishedChanges`/the label+route maps as real runtime values, not just types,
// and importing those from homepage.ts would drag the Postgres driver into the browser bundle
// (Next.js has no way to tree-shake a VALUE import out of a "server-only"-guarded module, unlike
// a `import type` which every other client component here already uses instead).

export interface HomepageSectionRow {
  id: string;
  key: HomepageSectionKey;
  draftIsVisible: boolean;
  draftContent: unknown;
  draftUpdatedAt: Date;
  publishedIsVisible: boolean | null;
  publishedContent: unknown | null;
  publishedAt: Date | null;
}

export function byCanonicalKey(rows: HomepageSectionRow[]): HomepageSectionRow[] {
  return [...rows].sort(
    (a, b) => HOMEPAGE_SECTION_KEYS.indexOf(a.key) - HOMEPAGE_SECTION_KEYS.indexOf(b.key),
  );
}

/** Indonesian display labels for each fixed section key — same key↔label split `@ammari/db/
 * why-ammari`'s WHY_AMMARI_ICON_LABELS already uses, shared by the /content overview list and
 * homepage.ts's own publish-time error messages. */
export const HOMEPAGE_SECTION_LABELS: Record<HomepageSectionKey, string> = {
  hero: "Hero",
  product_grid: "Grid Produk",
  feature_block: "Feature Block",
  why_ammari: "Kenapa Ammari",
};

/** Each section key's editor route under /content, per docs/plans/storefront-cms.md's "Admin
 * UX" ("/content/hero, /content/product-grid, /content/feature-block, /content/why-ammari"). */
export const HOMEPAGE_SECTION_ROUTES: Record<HomepageSectionKey, string> = {
  hero: "/content/hero",
  product_grid: "/content/product-grid",
  feature_block: "/content/feature-block",
  why_ammari: "/content/why-ammari",
};

/** True when a section's DRAFT differs from what's currently live — the "Ada perubahan belum
 * diterbitkan" banner's per-row check (docs/plans/storefront-cms.md). A section that has NEVER
 * been published (`publishedContent === null`) is compared against the seeded defaults
 * (`{}`/visible) rather than always reporting `true` — a freshly-seeded, never-touched row (the
 * common case right after migration 0019) must not show the banner before the owner has typed
 * anything. Content equality is a plain JSON comparison: `published_content` is always written
 * as a literal column-to-column copy of `draft_content` at publish time (never re-serialized in
 * JS), so the two stay byte-identical until the draft is edited again. */
export function sectionHasUnpublishedChanges(
  row: Pick<HomepageSectionRow, "draftIsVisible" | "draftContent" | "publishedIsVisible" | "publishedContent">,
): boolean {
  const publishedVisible = row.publishedIsVisible ?? true;
  const publishedContent = row.publishedContent ?? {};
  return row.draftIsVisible !== publishedVisible || JSON.stringify(row.draftContent) !== JSON.stringify(publishedContent);
}

export function homepageHasUnpublishedChanges(rows: HomepageSectionRow[]): boolean {
  return rows.some(sectionHasUnpublishedChanges);
}
