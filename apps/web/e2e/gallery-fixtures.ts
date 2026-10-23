// PDP gallery fixture (docs/plans/pdp-gallery.md §10) for pdp-gallery.spec.ts, seeded by
// global-setup.ts: 2 general photos, then 2 colour groups of 2, plus a colour without any photo.
// Its own fabric and a `created_at` far in the past (like discount-fixtures.ts), so it never takes
// a slot in another product's related list. It also carries an active product discount, so the
// spec can check that browsing the gallery never touches the price block.

export const E2E_GALLERY_SLUG = "gamis-galeri-e2e";
export const E2E_GALLERY_NAME = "Gamis Galeri E2E";

/** Swatch order = colour creation order (storefront read layer). */
export const E2E_GALLERY_COLORS = { sage: "Sage Galeri E2E", navy: "Navy Galeri E2E", noPhoto: "Hitam Galeri E2E" } as const;

/** The gallery's expected order: general first, then each colour's photos in swatch order. */
export const E2E_GALLERY_PHOTOS = [
  { alt: "Galeri umum 1", fixture: "general" },
  { alt: "Galeri umum 2", fixture: "dusty-pink" },
  { alt: "Galeri sage 1", fixture: "sage" },
  { alt: "Galeri sage 2", fixture: "beige" },
  { alt: "Galeri navy 1", fixture: "navy" },
  { alt: "Galeri navy 2", fixture: "taupe" },
] as const;

export const E2E_GALLERY_BASE_PRICE = 350_000;
export const E2E_GALLERY_SALE_PRICE = 279_000;

export async function seedGalleryFixtures(): Promise<void> {
  const { db } = await import("@ammari/db");
  const { fabricColors, fabrics, productImages, products, productVariants, stockMovements } = await import("@ammari/db/schema");

  const [fabric] = await db.insert(fabrics).values({ name: "Ceruti Galeri E2E", careInstructions: "Cuci dengan air dingin" }).returning();
  if (!fabric) throw new Error("failed to seed the gallery e2e fabric");

  // Explicit, increasing created_at: the storefront orders swatches (and the gallery's colour
  // groups) by it.
  const colorDefs = [
    { name: E2E_GALLERY_COLORS.sage, hex: "#9CAF88", createdAt: "2000-01-01" },
    { name: E2E_GALLERY_COLORS.navy, hex: "#1B2436", createdAt: "2000-01-02" },
    { name: E2E_GALLERY_COLORS.noPhoto, hex: "#1E1A1A", createdAt: "2000-01-03" },
  ];
  const colors = [];
  for (const def of colorDefs) {
    const [color] = await db
      .insert(fabricColors)
      .values({ fabricId: fabric.id, name: def.name, hex: def.hex, createdAt: new Date(`${def.createdAt}T00:00:00Z`) })
      .returning();
    if (!color) throw new Error(`failed to seed the gallery e2e colour ${def.name}`);
    colors.push(color);
  }
  const [sage, navy, noPhoto] = colors;
  if (!sage || !navy || !noPhoto) throw new Error("expected 3 gallery e2e colours");

  const [product] = await db
    .insert(products)
    .values({
      name: E2E_GALLERY_NAME,
      code: "E2EGALERI",
      slug: E2E_GALLERY_SLUG,
      fabricId: fabric.id,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: E2E_GALLERY_BASE_PRICE,
      discountPriceAmount: E2E_GALLERY_SALE_PRICE,
      discountEnabled: true,
      discountStartsAt: new Date("2020-01-01T00:00:00Z"),
      discountEndsAt: null,
      isActive: true,
      isPublishedOnStorefront: true,
      createdAt: new Date("1999-01-01T00:00:00Z"),
    })
    .returning();
  if (!product) throw new Error("failed to seed the gallery e2e product");

  const colorOf = [null, null, sage.id, sage.id, navy.id, navy.id];
  await db.insert(productImages).values(
    E2E_GALLERY_PHOTOS.map((photo, index) => ({
      productId: product.id,
      fabricId: fabric.id,
      fabricColorId: colorOf[index] ?? null,
      storageKey: `api/test/fixtures/${photo.fixture}`,
      altText: photo.alt,
      width: 800,
      height: 1200,
      // Within each group, the photo listed first comes first.
      sortOrder: index % 2,
    })),
  );

  for (const color of [sage, navy, noPhoto]) {
    for (const size of ["M", "L"] as const) {
      const sku = `E2E-GALERI-${color.name.slice(0, 3).toUpperCase()}-${size}`;
      await db.insert(productVariants).values({ sku, productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: "front_zip", size, isActive: true });
      await db.insert(stockMovements).values({ sku, qty: 5, valueAmount: 5 * 48_000, type: "production", refType: "manual" });
    }
  }
}
