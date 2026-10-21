import { z } from "zod";
import { PRODUCT_SHIPPING_WEIGHT_MAX_GRAMS, PRODUCT_SHIPPING_WEIGHT_MIN_GRAMS } from "@ammari/db/schema";

// Product shipping weight ("Berat kirim", docs/plans/cart-checkout.md §4.5.3): the field's
// validation and the messages shared by the server guards (queries.ts, storefront.ts) and the
// product page. A plain module (not server-only) so client components can import the messages.

export const PUBLISH_REQUIRES_SHIPPING_WEIGHT_MESSAGE =
  "Isi berat kirim di data produk sebelum menayangkannya di toko online.";
export const SHIPPING_WEIGHT_REQUIRED_WHILE_PUBLISHED_MESSAGE =
  "Berat kirim tidak bisa dikosongkan selagi produk tayang di toko online.";
export const SHIPPING_WEIGHT_RANGE_MESSAGE = `Berat kirim harus ${PRODUCT_SHIPPING_WEIGHT_MIN_GRAMS} sampai ${PRODUCT_SHIPPING_WEIGHT_MAX_GRAMS.toLocaleString("id-ID")} gram.`;
const SHIPPING_WEIGHT_FORMAT_MESSAGE = "Isi berat kirim dalam gram, angka bulat saja (mis. 850).";

/** The "Berat kirim (gram)" text input: empty is `null` (not filled in yet), otherwise whole
 * grams. Dots are accepted as thousands separators ("1.200"), as typed in Indonesian. */
export const shippingWeightString = z.string().transform((value, ctx) => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(trimmed)) {
    ctx.addIssue({ code: "custom", message: SHIPPING_WEIGHT_FORMAT_MESSAGE });
    return z.NEVER;
  }
  const grams = Number(trimmed.replaceAll(".", ""));
  if (grams < PRODUCT_SHIPPING_WEIGHT_MIN_GRAMS || grams > PRODUCT_SHIPPING_WEIGHT_MAX_GRAMS) {
    ctx.addIssue({ code: "custom", message: SHIPPING_WEIGHT_RANGE_MESSAGE });
    return z.NEVER;
  }
  return grams;
});
