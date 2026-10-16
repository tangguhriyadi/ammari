// Seeds realistic, PUBLISHED storefront data for the `/` and `/products/[slug]` e2e specs
// (home.spec.ts, product-page.spec.ts) — separate from global-setup.ts's own draft-only hero
// seeding (used only by preview-home.spec.ts), called from the SAME globalSetup run. Image
// `storageKey`s are "api/test/fixtures/<name>", resolved against STORAGE_PUBLIC_BASE_URL (which
// playwright.config.ts's webServer.env points at this very e2e server's own origin,
// http://localhost:3100) into a real, fetchable URL served by
// app/api/test/fixtures/[...path]/route.ts — an e2e-only backdoor reading the committed,
// tiny solid-colour WebP files under apps/web/e2e/fixtures/*. Deliberately NOT under
// apps/web/public/*: that directory ships verbatim into the production Docker image
// (Dockerfile COPYs it directly), and these are test-only fixtures, not real product assets.

export const E2E_PRODUCT_SLUG = "gamis-flowy-straight-e2e";
export const E2E_RELATED_PRODUCT_SLUG = "outer-dress-tali-depan-e2e";
export const E2E_UNPUBLISHED_PRODUCT_SLUG = "gamis-belum-terbit-e2e";
export const E2E_PRODUCT_NAME = "Gamis Flowy Straight E2E";
export const E2E_HOMEPAGE_TITLE = "Koleksi perdana E2E";
export const E2E_WHY_AMMARI_HEADING = "Nyaman dipakai seharian, tetap syar'i E2E";
export const E2E_FEATURE_BLOCK_TITLE = "Outer Dress Tali Depan E2E";

export async function seedStorefrontFixtures(): Promise<void> {
  const { eq } = await import("drizzle-orm");
  const { db } = await import("@ammari/db");
  const {
    fabricColors,
    fabrics,
    productImages,
    products,
    productVariants,
    sizeCharts,
    sizeChartRows,
    stockMovements,
    storefrontHomepageSections,
  } = await import("@ammari/db/schema");

  const [fabric] = await db
    .insert(fabrics)
    .values({ name: "Katun Rayon E2E", careInstructions: "Cuci dengan air dingin, jangan diperas" })
    .returning();
  if (!fabric) throw new Error("failed to seed e2e fabric");

  const colorDefs = [
    { name: "Beige E2E", hex: "#D9C9B8", fixture: "beige" },
    { name: "Navy E2E", hex: "#1B2436", fixture: "navy" },
    { name: "Taupe E2E", hex: "#8C7B6B", fixture: "taupe" },
  ];
  const colors = [];
  for (const def of colorDefs) {
    const [color] = await db.insert(fabricColors).values({ fabricId: fabric.id, name: def.name, hex: def.hex }).returning();
    if (!color) throw new Error(`failed to seed e2e colour ${def.name}`);
    colors.push({ ...color, fixture: def.fixture });
  }
  const [beige, navy, taupe] = colors;
  if (!beige || !navy || !taupe) throw new Error("expected 3 e2e colours");

  const [sizeChart] = await db.insert(sizeCharts).values({ name: "Gamis Reguler E2E" }).returning();
  if (!sizeChart) throw new Error("failed to seed e2e size chart");
  await db.insert(sizeChartRows).values([
    { sizeChartId: sizeChart.id, size: "S", bustCm: 96, lengthCm: 138, sleeveLengthCm: 54, heightRecommendationMinCm: 150, heightRecommendationMaxCm: 160 },
    { sizeChartId: sizeChart.id, size: "M", bustCm: 100, lengthCm: 140, sleeveLengthCm: 55, heightRecommendationMinCm: 155, heightRecommendationMaxCm: 165 },
    { sizeChartId: sizeChart.id, size: "L", bustCm: 104, lengthCm: 142, sleeveLengthCm: 56, heightRecommendationMinCm: 160, heightRecommendationMaxCm: 170 },
  ]);

  const [productA] = await db
    .insert(products)
    .values({
      name: E2E_PRODUCT_NAME,
      code: "E2EFLOWY",
      slug: E2E_PRODUCT_SLUG,
      fabricId: fabric.id,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 269_000,
      isActive: true,
      isPublishedOnStorefront: true,
      storefrontDescription: "<p>Potongan lurus yang tetap jatuh flowy.</p><ul><li>Resleting depan tertutup kain</li><li>Saku tersembunyi</li></ul>",
      highlights: ["breathable", "flowy", "not_see_through"],
      sizeChartId: sizeChart.id,
    })
    .returning();
  if (!productA) throw new Error("failed to seed e2e product A");

  // General (no colour) + one image per colour, for the gallery-grouping / colour-switch specs.
  await db.insert(productImages).values([
    { productId: productA.id, fabricId: fabric.id, fabricColorId: null, storageKey: "api/test/fixtures/general", altText: "Gamis Flowy Straight", width: 800, height: 1200, sortOrder: 0 },
    { productId: productA.id, fabricId: fabric.id, fabricColorId: beige.id, storageKey: "api/test/fixtures/beige", altText: "Gamis Flowy Straight Beige", width: 800, height: 1200, sortOrder: 0 },
    { productId: productA.id, fabricId: fabric.id, fabricColorId: navy.id, storageKey: "api/test/fixtures/navy", altText: "Gamis Flowy Straight Navy", width: 800, height: 1200, sortOrder: 0 },
  ]);

  // Beige: S available, M available, L OUT OF STOCK (net zero) — exercises the struck-through
  // "habis" state. Navy: only M exists at all (S/L have no variant row for this colour).
  const variantDefs: { color: typeof beige; size: "S" | "M" | "L"; qty: number }[] = [
    { color: beige, size: "S", qty: 5 },
    { color: beige, size: "M", qty: 5 },
    { color: beige, size: "L", qty: 0 },
    { color: navy, size: "M", qty: 3 },
  ];
  for (const def of variantDefs) {
    const sku = `E2E-${productA.code ?? "FLOWY"}-${def.color.name.slice(0, 3).toUpperCase()}-${def.size}-${def.color.id.slice(0, 4)}`.toUpperCase();
    const [variant] = await db
      .insert(productVariants)
      .values({
        sku,
        productId: productA.id,
        fabricId: fabric.id,
        fabricColorId: def.color.id,
        closure: "front_zip",
        size: def.size,
        isActive: true,
      })
      .returning();
    if (!variant) throw new Error(`failed to seed e2e variant ${sku}`);
    if (def.qty > 0) {
      await db.insert(stockMovements).values({ sku: variant.sku, qty: def.qty, valueAmount: def.qty * 48_000, type: "production", refType: "manual" });
    }
  }

  const [productB] = await db
    .insert(products)
    .values({
      name: E2E_FEATURE_BLOCK_TITLE,
      code: "E2EOUTER",
      slug: E2E_RELATED_PRODUCT_SLUG,
      fabricId: fabric.id,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 229_000,
      isActive: true,
      isPublishedOnStorefront: true,
      storefrontDescription: "<p>Dalam dan luar satu warna.</p>",
      highlights: ["falls_perfectly"],
      sizeChartId: sizeChart.id,
    })
    .returning();
  if (!productB) throw new Error("failed to seed e2e product B");

  await db.insert(productImages).values({
    productId: productB.id,
    fabricId: fabric.id,
    fabricColorId: taupe.id,
    storageKey: "api/test/fixtures/taupe",
    altText: "Outer Dress Tali Depan Taupe",
    width: 800,
    height: 1200,
    sortOrder: 0,
  });
  const [variantB] = await db
    .insert(productVariants)
    .values({ sku: "E2E-OUTER-TAUPE-M", productId: productB.id, fabricId: fabric.id, fabricColorId: taupe.id, closure: "front_zip", size: "M", isActive: true })
    .returning();
  if (!variantB) throw new Error("failed to seed e2e variant B");
  await db.insert(stockMovements).values({ sku: variantB.sku, qty: 4, valueAmount: 192_000, type: "production", refType: "manual" });

  // An active-but-UNPUBLISHED product — getStorefrontProductBySlug (and so the page itself) must
  // treat its slug exactly like one that doesn't exist at all: a 404.
  await db.insert(products).values({
    name: "Gamis Belum Terbit E2E",
    code: "E2EDRAFT",
    slug: E2E_UNPUBLISHED_PRODUCT_SLUG,
    fabricId: fabric.id,
    closure: "front_zip",
    sizeMode: "sized",
    basePrice: 199_000,
    isActive: true,
    isPublishedOnStorefront: false,
  });

  // --- Homepage: PUBLISHED content (home.spec.ts) — the draft columns above (global-setup.ts)
  // stay separately seeded for preview-home.spec.ts; this only ever touches published_*. ---
  await db
    .update(storefrontHomepageSections)
    .set({
      publishedIsVisible: true,
      publishedContent: {
        eyebrow: "KOLEKSI PERDANA",
        headline: "Graceful in every\nthread",
        ctaLabel: "LIHAT KOLEKSI",
        ctaTarget: { type: "anchor" },
        image: {
          storageKey: "api/test/fixtures/hero",
          altText: "Hero Ammari E2E",
          width: 1600,
          height: 2400,
          mobileStorageKey: "api/test/fixtures/hero-mobile",
          mobileWidth: 750,
          mobileHeight: 1000,
        },
      },
      publishedAt: new Date(),
    })
    .where(eq(storefrontHomepageSections.key, "hero"));

  await db
    .update(storefrontHomepageSections)
    .set({
      publishedIsVisible: true,
      publishedContent: {
        title: E2E_HOMEPAGE_TITLE,
        tiles: [
          { productId: productA.id, fabricColorId: null },
          { productId: productA.id, fabricColorId: navy.id },
          { productId: productB.id, fabricColorId: null },
        ],
      },
      publishedAt: new Date(),
    })
    .where(eq(storefrontHomepageSections.key, "product_grid"));

  await db
    .update(storefrontHomepageSections)
    .set({
      publishedIsVisible: true,
      publishedContent: {
        eyebrow: "KENAPA AMMARI",
        heading: E2E_WHY_AMMARI_HEADING,
        points: [
          { icon: "not_see_through", title: "Tidak menerawang", text: "Bahan cukup tebal untuk dipakai tanpa lapisan dalam." },
          { icon: "all_day_comfort", title: "Adem, tidak panas", text: "Serat rayon menyerap keringat dan jatuh ringan." },
          { icon: "nursing_friendly", title: "Busui friendly", text: "Resleting depan tertutup kain." },
          { icon: "easy_care", title: "Mudah dirawat", text: "Cukup dicuci dengan air dingin." },
        ],
      },
      publishedAt: new Date(),
    })
    .where(eq(storefrontHomepageSections.key, "why_ammari"));

  await db
    .update(storefrontHomepageSections)
    .set({
      publishedIsVisible: true,
      publishedContent: {
        title: E2E_FEATURE_BLOCK_TITLE,
        subtitle: "Dalam dan luar satu warna",
        ctaLabel: "LIHAT",
        linkedProduct: { productId: productB.id, fabricColorId: null },
        image: { storageKey: "api/test/fixtures/feature", altText: "Outer Dress Tali Depan E2E", width: 1600, height: 1600, mobileStorageKey: null, mobileWidth: null, mobileHeight: null },
      },
      publishedAt: new Date(),
    })
    .where(eq(storefrontHomepageSections.key, "feature_block"));
}
