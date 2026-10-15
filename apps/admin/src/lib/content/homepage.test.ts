import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant } from "@ammari/db/test-fixtures";
import { auditLog, productVariants, products } from "@ammari/db/schema";
import { ActionError } from "@/lib/errors";
import {
  discardHomepageDraft,
  getHomepageSection,
  homepageHasUnpublishedChanges,
  listPublishableProducts,
  publishHomepageSections,
  saveFeatureBlockDraft,
  saveHeroDraft,
  saveProductGridDraft,
  saveWhyAmmariDraft,
  sectionHasUnpublishedChanges,
  setHomepageSectionDraftVisibility,
  type HomepageSectionRow,
} from "./homepage";

const ACTOR_ID = null;

async function publishProduct(tx: TestDatabase, productId: string): Promise<void> {
  await tx.update(products).set({ isPublishedOnStorefront: true }).where(eq(products.id, productId));
}

describe("sectionHasUnpublishedChanges / homepageHasUnpublishedChanges (pure, no DB)", () => {
  function row(overrides: Partial<HomepageSectionRow> = {}): HomepageSectionRow {
    return {
      id: "row-1",
      key: "hero",
      draftIsVisible: true,
      draftContent: {},
      draftUpdatedAt: new Date(),
      publishedIsVisible: null,
      publishedContent: null,
      publishedAt: null,
      ...overrides,
    };
  }

  test("a never-published row with the seeded empty draft reports no changes", () => {
    expect(sectionHasUnpublishedChanges(row())).toBe(false);
  });

  test("a never-published row with real draft content reports changes", () => {
    expect(sectionHasUnpublishedChanges(row({ draftContent: { eyebrow: "Baru" } }))).toBe(true);
  });

  test("identical draft/published content and visibility reports no changes", () => {
    expect(
      sectionHasUnpublishedChanges(
        row({ draftContent: { eyebrow: "Sama" }, publishedContent: { eyebrow: "Sama" }, publishedIsVisible: true }),
      ),
    ).toBe(false);
  });

  test("a visibility-only difference still reports changes", () => {
    expect(
      sectionHasUnpublishedChanges(
        row({ draftIsVisible: false, draftContent: { eyebrow: "Sama" }, publishedContent: { eyebrow: "Sama" }, publishedIsVisible: true }),
      ),
    ).toBe(true);
  });

  test("homepageHasUnpublishedChanges is true if ANY row differs", () => {
    const clean = row({ draftContent: { eyebrow: "Sama" }, publishedContent: { eyebrow: "Sama" }, publishedIsVisible: true });
    const dirty = row({ key: "product_grid", draftContent: { title: "Baru" } });
    expect(homepageHasUnpublishedChanges([clean, dirty])).toBe(true);
    expect(homepageHasUnpublishedChanges([clean, clean])).toBe(false);
  });
});

describe("listPublishableProducts", () => {
  test("only returns products published on the storefront, with their active colors", async () => {
    await withRollback(async (tx) => {
      const { product, color } = await insertProductVariant(tx);
      const unpublished = await insertProductVariant(tx);

      await publishProduct(tx, product.id);
      // `unpublished.product` stays unpublished — default is_published_on_storefront = false.

      const options = await listPublishableProducts(tx);
      const ids = options.map((option) => option.id);
      expect(ids).toContain(product.id);
      expect(ids).not.toContain(unpublished.product.id);

      const published = options.find((option) => option.id === product.id);
      expect(published?.colors.map((c) => c.id)).toContain(color.id);
    });
  });

  test("still returns a published product with zero currently-active variants, just with an empty color list", async () => {
    await withRollback(async (tx) => {
      const { product, variant } = await insertProductVariant(tx);
      await publishProduct(tx, product.id);
      await tx.update(productVariants).set({ isActive: false }).where(eq(productVariants.sku, variant.sku));

      const options = await listPublishableProducts(tx);
      const published = options.find((option) => option.id === product.id);
      expect(published).toBeDefined();
      expect(published?.colors).toEqual([]);
    });
  });
});

describe("save*Draft: product/color reference validation", () => {
  test("saveHeroDraft rejects a product CTA pointing at a product not published on the storefront", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      await expect(
        saveHeroDraft(
          {
            isVisible: true,
            content: {
              eyebrow: "",
              headline: "Headline",
              ctaLabel: "Lihat",
              ctaTarget: { type: "product", productId: product.id, fabricColorId: null },
              image: null,
            },
          },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toThrow(ActionError);
    });
  });

  test("saveHeroDraft accepts a product CTA once the product is published", async () => {
    await withRollback(async (tx) => {
      const { product, color } = await insertProductVariant(tx);
      await publishProduct(tx, product.id);

      await saveHeroDraft(
        {
          isVisible: true,
          content: {
            eyebrow: "",
            headline: "Headline",
            ctaLabel: "Lihat",
            ctaTarget: { type: "product", productId: product.id, fabricColorId: color.id },
            image: null,
          },
        },
        ACTOR_ID,
        tx,
      );

      const section = await getHomepageSection("hero", tx);
      expect(section?.draftContent).toMatchObject({ headline: "Headline" });
    });
  });

  test("saveProductGridDraft rejects a tile whose fabricColorId isn't an active color of that product", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const other = await insertProductVariant(tx);
      await publishProduct(tx, product.id);
      await publishProduct(tx, other.product.id);

      await expect(
        saveProductGridDraft(
          {
            isVisible: true,
            content: { title: "Grid", tiles: [{ productId: product.id, fabricColorId: other.color.id }] },
          },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toThrow(ActionError);
    });
  });

  test("saveProductGridDraft accepts multiple valid tiles and persists them in order", async () => {
    await withRollback(async (tx) => {
      const first = await insertProductVariant(tx);
      const second = await insertProductVariant(tx);
      await publishProduct(tx, first.product.id);
      await publishProduct(tx, second.product.id);

      await saveProductGridDraft(
        {
          isVisible: true,
          content: {
            title: "Grid",
            tiles: [
              { productId: first.product.id, fabricColorId: first.color.id },
              { productId: second.product.id, fabricColorId: null },
            ],
          },
        },
        ACTOR_ID,
        tx,
      );

      const section = await getHomepageSection("product_grid", tx);
      expect(section?.draftContent).toMatchObject({
        tiles: [
          { productId: first.product.id, fabricColorId: first.color.id },
          { productId: second.product.id, fabricColorId: null },
        ],
      });
    });
  });

  test("saveFeatureBlockDraft rejects an unpublished linked product", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      await expect(
        saveFeatureBlockDraft(
          {
            isVisible: true,
            content: {
              title: "Judul",
              subtitle: "Subjudul",
              ctaLabel: "Lihat",
              linkedProduct: { productId: product.id, fabricColorId: null },
              image: null,
            },
          },
          ACTOR_ID,
          tx,
        ),
      ).rejects.toThrow(ActionError);
    });
  });

  test("saveWhyAmmariDraft has no product reference to validate and always persists", async () => {
    await withRollback(async (tx) => {
      await saveWhyAmmariDraft(
        {
          isVisible: true,
          content: { eyebrow: "", heading: "Kenapa Pilih Kami", points: [{ icon: "syari_design", title: "Judul", text: "Teks" }] },
        },
        ACTOR_ID,
        tx,
      );
      const section = await getHomepageSection("why_ammari", tx);
      expect(section?.draftContent).toMatchObject({ heading: "Kenapa Pilih Kami" });
    });
  });
});

describe("setHomepageSectionDraftVisibility", () => {
  test("flips only draftIsVisible, leaving draftContent untouched", async () => {
    await withRollback(async (tx) => {
      await saveWhyAmmariDraft(
        { isVisible: true, content: { eyebrow: "", heading: "Judul", points: [] } },
        ACTOR_ID,
        tx,
      );
      await setHomepageSectionDraftVisibility("why_ammari", false, ACTOR_ID, tx);

      const section = await getHomepageSection("why_ammari", tx);
      expect(section?.draftIsVisible).toBe(false);
      expect(section?.draftContent).toMatchObject({ heading: "Judul" });
    });
  });
});

describe("publishHomepageSections", () => {
  test("promotes every section's draft to published and writes one audit log row per section", async () => {
    await withRollback(async (tx) => {
      await saveWhyAmmariDraft(
        { isVisible: true, content: { eyebrow: "", heading: "Kenapa Pilih Kami", points: [] } },
        ACTOR_ID,
        tx,
      );

      await publishHomepageSections(ACTOR_ID, tx);

      const section = await getHomepageSection("why_ammari", tx);
      expect(section?.publishedContent).toMatchObject({ heading: "Kenapa Pilih Kami" });
      expect(section?.publishedIsVisible).toBe(true);
      expect(section?.publishedAt).not.toBeNull();

      const entries = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityType, "storefront_homepage_section"));
      const publishEntries = entries.filter((entry) => entry.action === "publish");
      expect(publishEntries.length).toBe(4);
    });
  });

  test("a failure partway through rolls back EVERY section's update, including ones already issued — proving one transaction, not 4 independent writes", async () => {
    await withRollback(async (tx) => {
      await saveHeroDraft(
        {
          isVisible: true,
          content: { eyebrow: "", headline: "Headline", ctaLabel: "Lihat", ctaTarget: { type: "anchor" }, image: null },
        },
        ACTOR_ID,
        tx,
      );
      await saveProductGridDraft({ isVisible: true, content: { title: "Grid", tiles: [] } }, ACTOR_ID, tx);

      // A staff id that doesn't exist in staff_users — audit_log.actor_staff_user_id's own FK
      // (ON DELETE RESTRICT, not deferrable) rejects the FIRST section's audit-log INSERT with a
      // real 23503 violation. By then "hero" (processed first, in canonical order) has already
      // had its own UPDATE issued within this same transaction — a real, not synthetic, forced
      // failure partway through the loop.
      const nonExistentStaffId = "00000000-0000-4000-8000-000000000000";
      await expect(publishHomepageSections(nonExistentStaffId, tx)).rejects.toThrow();

      const hero = await getHomepageSection("hero", tx);
      const productGrid = await getHomepageSection("product_grid", tx);
      expect(hero?.publishedContent).toBeNull();
      expect(productGrid?.publishedContent).toBeNull();
    });
  });
});

describe("discardHomepageDraft", () => {
  test("resets every section's draft back to its published content", async () => {
    await withRollback(async (tx) => {
      await saveWhyAmmariDraft(
        { isVisible: true, content: { eyebrow: "", heading: "Published", points: [] } },
        ACTOR_ID,
        tx,
      );
      await publishHomepageSections(ACTOR_ID, tx);

      await saveWhyAmmariDraft(
        { isVisible: false, content: { eyebrow: "", heading: "Unsaved Draft", points: [] } },
        ACTOR_ID,
        tx,
      );
      let section = await getHomepageSection("why_ammari", tx);
      expect(section?.draftContent).toMatchObject({ heading: "Unsaved Draft" });

      await discardHomepageDraft(ACTOR_ID, tx);

      section = await getHomepageSection("why_ammari", tx);
      expect(section?.draftContent).toMatchObject({ heading: "Published" });
      expect(section?.draftIsVisible).toBe(true);
    });
  });

  test("a section never published resets its draft back to the seeded {}/visible defaults", async () => {
    await withRollback(async (tx) => {
      await saveWhyAmmariDraft(
        { isVisible: false, content: { eyebrow: "", heading: "Belum Diterbitkan", points: [] } },
        ACTOR_ID,
        tx,
      );
      await discardHomepageDraft(ACTOR_ID, tx);

      const section = await getHomepageSection("why_ammari", tx);
      expect(section?.draftContent).toEqual({});
      expect(section?.draftIsVisible).toBe(true);
    });
  });
});
