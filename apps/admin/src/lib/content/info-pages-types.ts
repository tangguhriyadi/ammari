import { INFO_PAGE_SLUGS, type InfoPageSlug } from "@ammari/db/schema";

// ---------- Pure types/helpers shared by server code AND client components ----------
//
// Same split homepage-types.ts already establishes: deliberately NOT in info-pages.ts (which has
// `import "server-only"` and pulls in the real DB client transitively) — the /content/pages list
// (a CLIENT component) needs `infoPageHasUnpublishedChanges`/the label map as real runtime
// values, not just types.

export interface InfoPageRow {
  id: string;
  slug: InfoPageSlug;
  title: string;
  draftBody: string;
  draftUpdatedAt: Date;
  publishedBody: string | null;
  publishedAt: Date | null;
}

export function byCanonicalInfoPageSlug(rows: InfoPageRow[]): InfoPageRow[] {
  return [...rows].sort((a, b) => INFO_PAGE_SLUGS.indexOf(a.slug) - INFO_PAGE_SLUGS.indexOf(b.slug));
}

/** Indonesian display labels for each fixed slug — same key↔label split HOMEPAGE_SECTION_LABELS
 * already uses. Matches each page's current title at seed time (migration 0020); the admin can
 * still edit a page's own `title` independently of this display label used for the /content/pages
 * list and nav. */
export const INFO_PAGE_LABELS: Record<InfoPageSlug, string> = {
  "privacy-policy": "Kebijakan Privasi",
  "terms-of-service": "Syarat & Ketentuan",
  "returns-exchange": "Pengembalian & Penukaran",
  "how-to-order": "Cara Pemesanan",
  shipping: "Pengiriman",
};

/** Each slug's editor route under /content/pages. */
export const INFO_PAGE_ROUTES: Record<InfoPageSlug, string> = {
  "privacy-policy": "/content/pages/privacy-policy",
  "terms-of-service": "/content/pages/terms-of-service",
  "returns-exchange": "/content/pages/returns-exchange",
  "how-to-order": "/content/pages/how-to-order",
  shipping: "/content/pages/shipping",
};

/** True when a page's DRAFT differs from what's currently live — same "Ada perubahan belum
 * diterbitkan" idea as sectionHasUnpublishedChanges, but per-page (each info page publishes
 * independently, unlike the homepage's one atomic "Terbitkan"). A page that has NEVER been
 * published (`publishedBody === null`) compares against `null`/empty, not against the seeded
 * draft — so privacy-policy/terms-of-service (seeded already-published, draft === published)
 * correctly start with no pending changes, while a brand-new unpublished page with any non-empty
 * draft correctly shows one. */
export function infoPageHasUnpublishedChanges(row: Pick<InfoPageRow, "draftBody" | "publishedBody">): boolean {
  return row.draftBody !== (row.publishedBody ?? "");
}
