import "server-only";
import { eq } from "drizzle-orm";
import { infoPages, type InfoPageSlug } from "@ammari/db/schema";
import { ContentTooLargeError, sanitizeInfoPageHtml } from "@ammari/content-sanitize";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import type { SaveInfoPageDraftInput } from "./info-pages-schemas";
import { byCanonicalInfoPageSlug, type InfoPageRow } from "./info-pages-types";

export {
  INFO_PAGE_LABELS,
  INFO_PAGE_ROUTES,
  infoPageHasUnpublishedChanges,
  type InfoPageRow,
} from "./info-pages-types";

// ---------- Info pages: /content/pages editors, independent draft/publish (session 8) ----------
//
// `info_pages` always has exactly 5 rows (seeded by migration 0020, one per INFO_PAGE_SLUGS) —
// every function below reads/writes one specific slug, never creates/deletes a row. The
// storefront's own READ path (`@ammari/db/storefront`'s getPublishedInfoPage) is untouched by
// this module; this is the admin-only WRITE side, gated by `content.manage` at the server-action
// layer (actions.ts).
//
// Unlike the homepage's 4 sections (one atomic "Terbitkan" across all of them), each info page
// publishes INDEPENDENTLY — there is no cross-page consistency requirement to protect (publishing
// a new Cara Pemesanan has nothing to do with Kebijakan Privasi), so publishHomepageSections'
// "promote every row in one transaction" shape would be the wrong model here.
//
// `title` is a single, un-versioned column (no draft/published pair) — editing it takes effect
// immediately, the same "no half-finished composition risk" reasoning store_settings' save=live
// gets: a page's display title is a short factual label, not multi-field content that can be
// left half-edited the way a page's full body can.

const PAGE_COLUMNS = {
  id: infoPages.id,
  slug: infoPages.slug,
  title: infoPages.title,
  draftBody: infoPages.draftBody,
  draftUpdatedAt: infoPages.draftUpdatedAt,
  publishedBody: infoPages.publishedBody,
  publishedAt: infoPages.publishedAt,
};

/** Always exactly 5 rows, in INFO_PAGE_SLUGS' own canonical order — never storage order. */
export async function listInfoPages(db: Database = defaultDb): Promise<InfoPageRow[]> {
  const rows = await db.select(PAGE_COLUMNS).from(infoPages);
  return byCanonicalInfoPageSlug(rows as InfoPageRow[]);
}

export async function getInfoPage(slug: InfoPageSlug, db: Database = defaultDb): Promise<InfoPageRow | null> {
  const [row] = await db.select(PAGE_COLUMNS).from(infoPages).where(eq(infoPages.slug, slug)).limit(1);
  return (row as InfoPageRow) ?? null;
}

/** Sanitizes server-side, unconditionally (never trusts the editor's own claim that its output is
 * already clean — same posture products/storefront.ts's updateProductStorefront already takes),
 * then writes the draft columns only. Never touches published_body/published_at. */
export async function saveInfoPageDraft(
  slug: InfoPageSlug,
  input: SaveInfoPageDraftInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  let sanitizedBody: string;
  try {
    sanitizedBody = sanitizeInfoPageHtml(input.bodyHtml);
  } catch (error) {
    if (error instanceof ContentTooLargeError) throw new FieldError("bodyHtml", "Konten terlalu panjang.");
    throw error;
  }

  await db.transaction(async (tx) => {
    const [before] = await tx.select(PAGE_COLUMNS).from(infoPages).where(eq(infoPages.slug, slug)).limit(1);
    if (!before) throw new ActionError("Halaman ini tidak ditemukan.");

    const [after] = await tx
      .update(infoPages)
      .set({ title: input.title, draftBody: sanitizedBody, draftUpdatedAt: new Date() })
      .where(eq(infoPages.slug, slug))
      .returning();
    if (!after) throw new Error("failed to update info page draft");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "save_draft",
      entityType: "info_page",
      entityId: before.id,
      before: { title: before.title, body: before.draftBody },
      after: { title: after.title, body: after.draftBody },
    });
  });
}

/** Promotes THIS page's draft -> published — independent of every other info page (see this
 * module's own doc comment for why that's correct here, unlike the homepage). The draft was
 * already sanitized when it was SAVED (saveInfoPageDraft above); publishing never re-sanitizes. */
export async function publishInfoPage(slug: InfoPageSlug, actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select(PAGE_COLUMNS).from(infoPages).where(eq(infoPages.slug, slug)).limit(1);
    if (!before) throw new ActionError("Halaman ini tidak ditemukan.");

    const [after] = await tx
      .update(infoPages)
      .set({ publishedBody: before.draftBody, publishedAt: new Date(), publishedByStaffUserId: actorStaffUserId })
      .where(eq(infoPages.id, before.id))
      .returning();
    if (!after) throw new Error("failed to publish info page");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "publish",
      entityType: "info_page",
      entityId: before.id,
      before: { body: before.publishedBody },
      after: { body: after.publishedBody },
    });
  });
}

/** Resets this page's draft back to what's currently published (or to empty, for a page never
 * published at all) — the editor's "Batalkan perubahan" action, same idea
 * discardHomepageDraft gives the homepage. Returns the reset body: unlike the homepage overview
 * (which already tracks every section's content in its own client state and just copies
 * `publishedContent` into `draftContent` locally), this page's own TipTap editor only applies its
 * `content` prop ONCE at mount — a plain `router.refresh()` changes this component's SERVER
 * props but never the already-mounted editor's internal document, so the caller needs the reset
 * value back to force a remount (see InfoPageForm's own comment on its `editorKey`). */
export async function discardInfoPageDraft(
  slug: InfoPageSlug,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<{ bodyHtml: string }> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select(PAGE_COLUMNS).from(infoPages).where(eq(infoPages.slug, slug)).limit(1);
    if (!before) throw new ActionError("Halaman ini tidak ditemukan.");

    const resetBody = before.publishedBody ?? "";
    const [after] = await tx
      .update(infoPages)
      .set({ draftBody: resetBody, draftUpdatedAt: new Date() })
      .where(eq(infoPages.id, before.id))
      .returning();
    if (!after) throw new Error("failed to discard info page draft");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "discard_draft",
      entityType: "info_page",
      entityId: before.id,
      before: { body: before.draftBody },
      after: { body: after.draftBody },
    });

    return { bodyHtml: resetBody };
  });
}
