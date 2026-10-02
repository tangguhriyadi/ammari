import { z } from "zod";
import { parseRupiah } from "./money";

/** A zod schema piece for an Indonesian-formatted money text input ("269.000", "Rp 269.000") —
 * transforms to a whole-rupiah integer, or fails validation if it can't be parsed. */
export const moneyString = z.string().transform((value, ctx) => {
  const parsed = parseRupiah(value);
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: "Format harga tidak valid." });
    return z.NEVER;
  }
  return parsed;
});

/** Same as `moneyString`, but an empty string is also valid and resolves to `null` (a cleared/
 * optional price field). */
export const optionalMoneyString = z.union([moneyString, z.literal("")]).transform((value) => (value === "" ? null : value));
