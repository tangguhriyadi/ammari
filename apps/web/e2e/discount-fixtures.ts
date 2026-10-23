// Product discount fixtures (docs/plans/product-discount.md, session 3) for product-discount.spec.ts,
// seeded by global-setup.ts. Their own fabric, so on each other's PDP "Lengkapi koleksimu" shows
// only these (same fabric first), and `created_at` far in the past, so they never take a slot in
// any other product's related list (newest first after same fabric) and never change what the
// other specs see. Not on the homepage grid, for the same reason.
//
// Related order on a discount PDP = the others below, newest `createdAt` first:
//   ACTIVE (2001) > SOLD_OUT (2000-06) > SCHEDULED (2000-03) > ENDED (2000-02) > FLIP (2000-01)

export const E2E_DISCOUNT_ACTIVE_SLUG = "gamis-diskon-aktif-e2e";
export const E2E_DISCOUNT_ACTIVE_NAME = "Gamis Diskon Aktif E2E";
export const E2E_DISCOUNT_SOLD_OUT_SLUG = "gamis-diskon-habis-e2e";
export const E2E_DISCOUNT_SOLD_OUT_NAME = "Gamis Diskon Habis E2E";
export const E2E_DISCOUNT_SCHEDULED_SLUG = "gamis-diskon-terjadwal-e2e";
export const E2E_DISCOUNT_SCHEDULED_NAME = "Gamis Diskon Terjadwal E2E";
export const E2E_DISCOUNT_ENDED_SLUG = "gamis-diskon-berakhir-e2e";
export const E2E_DISCOUNT_ENDED_NAME = "Gamis Diskon Berakhir E2E";
/** The spec sets this one's window a few seconds ahead itself, to watch it start and end. */
export const E2E_DISCOUNT_FLIP_SLUG = "gamis-diskon-berganti-e2e";

/** The plan's worked example: 350.000 -> 279.000 shows `20% OFF`. */
export const E2E_DISCOUNT_BASE_PRICE = 350_000;
export const E2E_DISCOUNT_SALE_PRICE = 279_000;
/** An active discount's end, far ahead: JSON-LD priceValidUntil is its Jakarta date, 2099-12-31. */
export const E2E_DISCOUNT_ACTIVE_ENDS_AT = new Date("2099-12-31T05:00:00Z");

export async function seedDiscountFixtures(): Promise<void> {
  const { db } = await import("@ammari/db");
  const { fabricColors, fabrics, products, productVariants, stockMovements } = await import("@ammari/db/schema");

  const [fabric] = await db.insert(fabrics).values({ name: "Voal Diskon E2E", careInstructions: "Cuci dengan air dingin" }).returning();
  if (!fabric) throw new Error("failed to seed the discount e2e fabric");
  const [color] = await db.insert(fabricColors).values({ fabricId: fabric.id, name: "Rose E2E", hex: "#C9A3A0" }).returning();
  if (!color) throw new Error("failed to seed the discount e2e colour");

  const sale = { basePrice: E2E_DISCOUNT_BASE_PRICE, discountPriceAmount: E2E_DISCOUNT_SALE_PRICE, discountEnabled: true };
  const defs = [
    { slug: E2E_DISCOUNT_ACTIVE_SLUG, name: E2E_DISCOUNT_ACTIVE_NAME, code: "E2EDSKAKT", createdAt: "2001-01-01", stock: 5, ...sale, discountStartsAt: new Date("2020-01-01T00:00:00Z"), discountEndsAt: E2E_DISCOUNT_ACTIVE_ENDS_AT },
    { slug: E2E_DISCOUNT_SOLD_OUT_SLUG, name: E2E_DISCOUNT_SOLD_OUT_NAME, code: "E2EDSKHBS", createdAt: "2000-06-01", stock: 0, ...sale, discountStartsAt: null, discountEndsAt: null },
    { slug: E2E_DISCOUNT_SCHEDULED_SLUG, name: E2E_DISCOUNT_SCHEDULED_NAME, code: "E2EDSKJDW", createdAt: "2000-03-01", stock: 5, ...sale, discountStartsAt: new Date("2099-01-01T00:00:00Z"), discountEndsAt: null },
    { slug: E2E_DISCOUNT_ENDED_SLUG, name: E2E_DISCOUNT_ENDED_NAME, code: "E2EDSKBRK", createdAt: "2000-02-01", stock: 5, ...sale, discountStartsAt: new Date("2020-01-01T00:00:00Z"), discountEndsAt: new Date("2020-02-01T00:00:00Z") },
    { slug: E2E_DISCOUNT_FLIP_SLUG, name: "Gamis Diskon Berganti E2E", code: "E2EDSKBGT", createdAt: "2000-01-01", stock: 5, ...sale, discountEnabled: false, discountStartsAt: null, discountEndsAt: null },
  ];

  for (const { createdAt, stock, ...def } of defs) {
    const [product] = await db
      .insert(products)
      .values({ ...def, fabricId: fabric.id, closure: "front_zip", sizeMode: "all_size", isActive: true, isPublishedOnStorefront: true, createdAt: new Date(`${createdAt}T00:00:00Z`) })
      .returning();
    if (!product) throw new Error(`failed to seed ${def.slug}`);
    const sku = `E2E-${def.code}-ROSE-ALL`;
    await db.insert(productVariants).values({ sku, productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: "front_zip", size: "ALLSIZE", isActive: true });
    if (stock > 0) await db.insert(stockMovements).values({ sku, qty: stock, valueAmount: stock * 48_000, type: "production", refType: "manual" });
  }
}
