import "server-only";
import { and, eq } from "drizzle-orm";
import { fabricColors, productVariants, products, storefrontHomepageSections, type HomepageSectionKey } from "@ammari/db/schema";
import { ActionError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { buildHeroOgImageKey } from "@ammari/db/storefront-settings";
import { cleanupOrphanedContentImages } from "./content-image-queries";
import { generateHeroOgImage, heroImageStorageKeyOf } from "./hero-og-image";
import { diffOrphanedContentImageKeys } from "./content-image-diff";
import type {
  FeatureBlockContent,
  HeroContent,
  HomepageProductRef,
  ProductGridContent,
  WhyAmmariContent,
} from "./homepage-schemas";
import { byCanonicalKey, type HomepageSectionRow } from "./homepage-types";

export {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_SECTION_ROUTES,
  homepageHasUnpublishedChanges,
  sectionHasUnpublishedChanges,
  type HomepageSectionRow,
} from "./homepage-types";

// ---------- Homepage content: Konten nav, section editors, draft/publish (session 4) ----------
//
// `storefront_homepage_sections` always has exactly 4 rows (seeded by migration 0019, one per
// HOMEPAGE_SECTION_KEYS) — every function below either reads/writes all 4 or one specific key,
// never creates/deletes a row. The storefront's own READ path (`@ammari/db/storefront`,
// `getPublishedHomepageContent`/`getDraftHomepageContent`) is untouched by this module; this is
// the admin-only WRITE side, gated by `content.manage` at the server-action layer (actions.ts).
//
// `HomepageSectionRow`/the label+route maps/`sectionHasUnpublishedChanges` live in
// ./homepage-types instead of here (re-exported above for every existing import site) — that
// module has no `server-only` guard and no DB import, so the /content overview's CLIENT
// component can use `sectionHasUnpublishedChanges` as a real function without pulling the
// Postgres driver into the browser bundle, which a value-import from THIS file would do.

const SECTION_COLUMNS = {
  id: storefrontHomepageSections.id,
  key: storefrontHomepageSections.key,
  draftIsVisible: storefrontHomepageSections.draftIsVisible,
  draftContent: storefrontHomepageSections.draftContent,
  draftUpdatedAt: storefrontHomepageSections.draftUpdatedAt,
  publishedIsVisible: storefrontHomepageSections.publishedIsVisible,
  publishedContent: storefrontHomepageSections.publishedContent,
  publishedAt: storefrontHomepageSections.publishedAt,
};

/** Always exactly 4 rows, in HOMEPAGE_SECTION_KEYS' own canonical order — never storage order. */
export async function listHomepageSections(db: Database = defaultDb): Promise<HomepageSectionRow[]> {
  const rows = await db.select(SECTION_COLUMNS).from(storefrontHomepageSections);
  return byCanonicalKey(rows as HomepageSectionRow[]);
}

export async function getHomepageSection(key: HomepageSectionKey, db: Database = defaultDb): Promise<HomepageSectionRow | null> {
  const [row] = await db.select(SECTION_COLUMNS).from(storefrontHomepageSections).where(eq(storefrontHomepageSections.key, key)).limit(1);
  return (row as HomepageSectionRow) ?? null;
}

// ---------- Product/color reference validation ----------
//
// A tile's/linked-product's `productId`/`fabricColorId` is NOT a real FK (docs/plans/
// storefront-cms.md's own "Homepage content" section explains why — JSONB, no child table) —
// this is the app-level check that stands in for one: the referenced product must currently be
// published on the storefront (and active), and the color (if pinned) must be one of its
// currently-active colors. Checked at SAVE time, not just render time, so the admin editor can
// surface a friendly error immediately rather than silently saving a tile the storefront would
// later have to skip.
async function assertProductRefIsPublishable(ref: HomepageProductRef, db: Database): Promise<void> {
  const [product] = await db
    .select({ isPublishedOnStorefront: products.isPublishedOnStorefront, isActive: products.isActive })
    .from(products)
    .where(eq(products.id, ref.productId))
    .limit(1);
  if (!product || !product.isPublishedOnStorefront || !product.isActive) {
    throw new ActionError("Salah satu produk yang dipilih sudah tidak tayang di toko online. Pilih produk lain.");
  }
  if (ref.fabricColorId) {
    const [variant] = await db
      .select({ sku: productVariants.sku })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.productId, ref.productId),
          eq(productVariants.fabricColorId, ref.fabricColorId),
          eq(productVariants.isActive, true),
        ),
      )
      .limit(1);
    if (!variant) throw new ActionError("Salah satu warna yang dipilih sudah tidak aktif untuk produk tersebut. Pilih warna lain.");
  }
}

export interface PublishableProductOption {
  id: string;
  name: string;
  colors: { id: string; name: string; hex: string | null }[];
}

/** Products the tile/linked-product picker may offer — every product published on the
 * storefront (the real gate), each with whatever active colors it currently has. LEFT JOINed
 * (not INNER), on purpose: `is_published_on_storefront` is a PRODUCT-level flag, independent of
 * whether any one variant happens to be active right now (a variant can be deactivated for
 * reasons unrelated to publishing, e.g. a discontinued color) — an
 * INNER JOIN would silently drop a published product with zero currently-active variants from
 * the picker entirely, instead of just offering it with no specific color to pin (only "Semua
 * warna", which ProductColorPicker already handles when `colors` is empty). Colors come from
 * DISTINCT active `product_variants` (same source `getProductDetail`, apps/admin's own product
 * page, already uses for a product's colors), not from every color the product's fabric happens
 * to have. */
export async function listPublishableProducts(db: Database = defaultDb): Promise<PublishableProductOption[]> {
  const rows = await db
    .select({
      productId: products.id,
      productName: products.name,
      colorId: fabricColors.id,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
    })
    .from(products)
    .leftJoin(productVariants, and(eq(productVariants.productId, products.id), eq(productVariants.isActive, true)))
    .leftJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(and(eq(products.isPublishedOnStorefront, true), eq(products.isActive, true)))
    .orderBy(products.name, fabricColors.name);

  const byProduct = new Map<string, PublishableProductOption>();
  for (const row of rows) {
    let product = byProduct.get(row.productId);
    if (!product) {
      product = { id: row.productId, name: row.productName, colors: [] };
      byProduct.set(row.productId, product);
    }
    if (row.colorId && !product.colors.some((color) => color.id === row.colorId)) {
      product.colors.push({ id: row.colorId, name: row.colorName!, hex: row.colorHex });
    }
  }
  return Array.from(byProduct.values());
}

// ---------- Draft saves (one per section key) ----------

/** Returns the storage keys (if any) now orphaned by this save — a content image that was in
 * the OLD draft but is in neither the NEW draft nor the currently-published content. Per
 * docs/plans/storefront-cms.md's "Image uploads": replacing/removing an image in the draft must
 * never delete a file still referenced by the published version — excluding
 * `before.publishedContent` from "still referenced" is exactly that guard. The caller deletes
 * these AFTER this function's transaction commits, never from inside it (CLAUDE.md-adjacent
 * "database state first, storage cleanup second" rule apps/admin/src/lib/products/
 * image-queries.ts's deleteProductImage already follows). */
async function writeSectionDraft(
  key: HomepageSectionKey,
  input: { isVisible: boolean; content: unknown },
  actorStaffUserId: string | null,
  tx: Database,
): Promise<string[]> {
  const [before] = await tx.select(SECTION_COLUMNS).from(storefrontHomepageSections).where(eq(storefrontHomepageSections.key, key)).limit(1);
  if (!before) throw new ActionError("Bagian ini tidak ditemukan.");

  const [after] = await tx
    .update(storefrontHomepageSections)
    .set({ draftContent: input.content, draftIsVisible: input.isVisible, draftUpdatedAt: new Date() })
    .where(eq(storefrontHomepageSections.key, key))
    .returning();
  if (!after) throw new Error("failed to update homepage section draft");

  await writeAuditLog(tx, {
    actorStaffUserId,
    action: "save_draft",
    entityType: "storefront_homepage_section",
    entityId: before.id,
    before: { isVisible: before.draftIsVisible, content: before.draftContent },
    after: { isVisible: after.draftIsVisible, content: after.draftContent },
  });

  return diffOrphanedContentImageKeys(before.draftContent, input.content, before.publishedContent ?? {});
}

export interface SaveSectionInput<T> {
  isVisible: boolean;
  content: T;
}

/** Flips ONE section's draft visibility without touching its content — the /content overview
 * list's own per-row switch (docs/plans/storefront-cms.md: "each showing its own visibility
 * toggle"), distinct from a full section-editor save. */
export async function setHomepageSectionDraftVisibility(
  key: HomepageSectionKey,
  isVisible: boolean,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select(SECTION_COLUMNS).from(storefrontHomepageSections).where(eq(storefrontHomepageSections.key, key)).limit(1);
    if (!before) throw new ActionError("Bagian ini tidak ditemukan.");
    // Content is unchanged (only isVisible flips), so writeSectionDraft's own diff is always
    // empty here — nothing to clean up.
    await writeSectionDraft(key, { isVisible, content: before.draftContent }, actorStaffUserId, tx);
  });
}

// Every save* function below takes ALREADY-Zod-validated content (actions.ts's
// <section>ContentSchema.safeParse — same split `createSizeChartAction`/`createSizeChart`
// already uses: the action layer turns a bad shape into a friendly field error, this layer only
// does the business-rule checks a Zod schema can't express, i.e. "does this product/color
// reference still resolve to something publishable").

export async function saveHeroDraft(
  input: SaveSectionInput<HeroContent>,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  const orphanedKeys = await db.transaction(async (tx) => {
    if (input.content.ctaTarget.type === "product") {
      await assertProductRefIsPublishable(
        { productId: input.content.ctaTarget.productId, fabricColorId: input.content.ctaTarget.fabricColorId },
        tx,
      );
    }
    return writeSectionDraft("hero", input, actorStaffUserId, tx);
  });
  await cleanupOrphanedContentImages(orphanedKeys);
}

export async function saveProductGridDraft(
  input: SaveSectionInput<ProductGridContent>,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const tile of input.content.tiles) {
      await assertProductRefIsPublishable(tile, tx);
    }
    await writeSectionDraft("product_grid", input, actorStaffUserId, tx);
  });
}

export async function saveFeatureBlockDraft(
  input: SaveSectionInput<FeatureBlockContent>,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  const orphanedKeys = await db.transaction(async (tx) => {
    await assertProductRefIsPublishable(input.content.linkedProduct, tx);
    return writeSectionDraft("feature_block", input, actorStaffUserId, tx);
  });
  await cleanupOrphanedContentImages(orphanedKeys);
}

export async function saveWhyAmmariDraft(
  input: SaveSectionInput<WhyAmmariContent>,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    await writeSectionDraft("why_ammari", input, actorStaffUserId, tx);
  });
}

// ---------- Publish (atomic, all 4 sections) + discard ----------

/** Promotes every section's draft -> published in ONE transaction (CLAUDE.md: concurrent-shaped
 * writes must be atomic) — publishing section-by-section would let a published page show, e.g.,
 * a new Hero next to a not-yet-published old grid, exactly what draft/publish exists to prevent
 * (docs/plans/storefront-cms.md). Each section's draft was already validated against its own Zod
 * schema when it was SAVED (the save* functions above) — publishing never re-validates shape, so
 * an owner can freely publish after finishing only SOME sections (the rest keep whatever they
 * last validly saved, including the untouched `{}`/visible seeded default, which simply renders
 * nothing — see getPublishedHomepageContent's own doc comment) without a cross-section "finish
 * everything before you can publish anything" wall that nothing in the plan asks for. */
export async function publishHomepageSections(actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  const preparedOg = await prepareHeroOgImage(db);

  const orphanedKeys = await db.transaction(async (tx) => {
    const rows = await tx.select(SECTION_COLUMNS).from(storefrontHomepageSections);
    const orphaned: string[] = [];

    for (const row of byCanonicalKey(rows as HomepageSectionRow[])) {
      const [after] = await tx
        .update(storefrontHomepageSections)
        .set({
          publishedContent: row.draftContent,
          publishedIsVisible: row.draftIsVisible,
          publishedAt: new Date(),
          publishedByStaffUserId: actorStaffUserId,
          ...(row.key === "hero" ? { publishedOgImageKey: heroOgImageKeyFor(row.draftContent, preparedOg) } : {}),
        })
        .where(eq(storefrontHomepageSections.id, row.id))
        .returning();
      if (!after) throw new Error("failed to publish homepage section");

      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "publish",
        entityType: "storefront_homepage_section",
        entityId: row.id,
        before: { isVisible: row.publishedIsVisible, content: row.publishedContent },
        after: { isVisible: after.publishedIsVisible, content: after.publishedContent },
      });

      // The OLD published image, if any, is replaced by whatever the (now-published) draft had
      // — nothing can still reference the old one once this commits, since draft === published
      // from this point on. Collected here, deleted only after the whole transaction commits.
      orphaned.push(...diffOrphanedContentImageKeys(row.publishedContent ?? {}, row.draftContent));
    }
    return orphaned;
  });
  await cleanupOrphanedContentImages(orphanedKeys);
}

interface PreparedHeroOgImage {
  /** The Hero image the OG JPEG was cut from. */
  heroStorageKey: string;
  /** Null when generation failed (already logged by generateHeroOgImage). */
  ogKey: string | null;
}

/** Runs BEFORE the publish transaction, never inside it: it does object-storage I/O and an image
 * encode, which must not hold row locks open. Skips the work when the Hero being published
 * already has its OG image (re-publishing an unchanged Hero after editing another section). */
async function prepareHeroOgImage(db: Database): Promise<PreparedHeroOgImage | null> {
  const [hero] = await db
    .select({ draftContent: storefrontHomepageSections.draftContent, publishedOgImageKey: storefrontHomepageSections.publishedOgImageKey })
    .from(storefrontHomepageSections)
    .where(eq(storefrontHomepageSections.key, "hero"))
    .limit(1);
  const heroStorageKey = heroImageStorageKeyOf(hero?.draftContent);
  if (!heroStorageKey) return null;
  if (hero?.publishedOgImageKey === buildHeroOgImageKey(heroStorageKey)) return { heroStorageKey, ogKey: hero.publishedOgImageKey };
  return { heroStorageKey, ogKey: await generateHeroOgImage(heroStorageKey) };
}

/** The OG key to publish for the hero draft read INSIDE the transaction. Only used when it was
 * cut from that exact image: a draft save that swapped the image between prepareHeroOgImage and
 * the transaction publishes null (placeholder) instead of a preview of the wrong image. */
function heroOgImageKeyFor(draftContent: unknown, prepared: PreparedHeroOgImage | null): string | null {
  const heroStorageKey = heroImageStorageKeyOf(draftContent);
  if (!heroStorageKey || !prepared || prepared.heroStorageKey !== heroStorageKey) return null;
  return prepared.ogKey;
}

/** Resets every section's DRAFT back to what's currently published (or to the seeded
 * defaults — `{}`/visible — for a section never published at all), discarding unsaved edits.
 * The admin's "Batalkan perubahan" action — see docs/plans/storefront-cms.md's "allow discarding
 * the draft back to the published version". */
export async function discardHomepageDraft(actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  const orphanedKeys = await db.transaction(async (tx) => {
    const rows = await tx.select(SECTION_COLUMNS).from(storefrontHomepageSections);
    const orphaned: string[] = [];

    for (const row of rows as HomepageSectionRow[]) {
      const resetContent = row.publishedContent ?? {};
      const resetVisible = row.publishedIsVisible ?? true;

      const [after] = await tx
        .update(storefrontHomepageSections)
        .set({ draftContent: resetContent, draftIsVisible: resetVisible, draftUpdatedAt: new Date() })
        .where(eq(storefrontHomepageSections.id, row.id))
        .returning();
      if (!after) throw new Error("failed to discard homepage section draft");

      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "discard_draft",
        entityType: "storefront_homepage_section",
        entityId: row.id,
        before: { isVisible: row.draftIsVisible, content: row.draftContent },
        after: { isVisible: after.draftIsVisible, content: after.draftContent },
      });

      // The discarded draft's own image, if different from what it was just reset to, is now
      // unreferenced by anything (the new draft equals published, exactly what resetContent is).
      orphaned.push(...diffOrphanedContentImageKeys(row.draftContent, resetContent));
    }
    return orphaned;
  });
  await cleanupOrphanedContentImages(orphanedKeys);
}
