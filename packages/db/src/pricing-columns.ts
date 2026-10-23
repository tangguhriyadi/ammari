import { products } from "./schema";

/** The `products` columns resolveUnitPrice (./pricing.ts) needs, as one select fragment, so no
 * price-reading query can forget one: `db.select({ ...productPricingColumns, ... })`. Kept apart
 * from pricing.ts so that module stays free of the schema (the admin's client-side discount inputs
 * import it). */
export const productPricingColumns = {
  basePrice: products.basePrice,
  discountPriceAmount: products.discountPriceAmount,
  discountEnabled: products.discountEnabled,
  discountStartsAt: products.discountStartsAt,
  discountEndsAt: products.discountEndsAt,
};
