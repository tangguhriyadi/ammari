import { z } from "zod";

/** Parses a decimal quantity input ("12.5", "12,5" rejected, "12" -> 12) with at most 2 decimal
 * places — yards and cost-line quantities, never money (money has its own parseRupiah, which
 * treats "." as a THOUSANDS separator; this is the opposite convention, "." as the decimal
 * point, since these are physical quantities, not rupiah amounts). Returns `null` for anything
 * that isn't a valid positive number with at most 2 decimal places. */
export function parseDecimalQuantity(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** A zod schema piece for a required positive decimal-quantity text input. */
export const decimalQuantityString = z.string().transform((value, ctx) => {
  const parsed = parseDecimalQuantity(value);
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: "Jumlah tidak valid." });
    return z.NEVER;
  }
  return parsed;
});

/** Same as decimalQuantityString, but an empty string is also valid and resolves to `null` (a
 * cleared/not-yet-entered quantity — e.g. fabric_yards while the batch is still a draft). */
export const optionalDecimalQuantityString = z
  .union([decimalQuantityString, z.literal("")])
  .transform((value) => (value === "" ? null : value));
