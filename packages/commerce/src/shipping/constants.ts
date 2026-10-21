// Shipping subsidy and parcel constants (docs/plans/cart-checkout.md §4.5, D11, decisions 17
// and 19). No server-only import and no DB, so checkout UI can read them too. Code constants on
// purpose, never CHECKs: changing one must never conflict with orders already placed.

/** Ammari covers at most this much of the courier cost per order; the buyer pays
 * `max(0, cost - SHIPPING_SUBSIDY_MAX_AMOUNT)` as "Ongkir" (owner decision 17). Whole rupiah. */
export const SHIPPING_SUBSIDY_MAX_AMOUNT = 20_000;

/** One outer mailer per order, added to `sum(qty x products.shipping_weight_grams)` for the
 * parcel weight (plan §4.5.3). A starting value: the owner confirms it by weighing one packed
 * order before launch (plan §14). */
export const SHIPPING_PACKAGING_GRAMS = 100;
