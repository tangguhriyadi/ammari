import "server-only";

// Strict whole-rupiah parsing (docs/plans/tiktok-shop-integration.md §8.3, decided Q6). TikTok
// sends amounts as strings; anything that is not a plain whole number is refused, never rounded.
// The caller turns the error into the held reason `money_format`.

export class TikTokMoneyFormatError extends Error {
  /** Which field failed; never the value itself (it may sit next to buyer data in a payload). */
  readonly field: string | undefined;

  constructor(field: string | undefined) {
    super(field ? `money_format: ${field} is not a whole-rupiah amount` : "money_format: not a whole-rupiah amount");
    this.name = "TikTokMoneyFormatError";
    this.field = field;
  }
}

export interface ParseRupiahOptions {
  /** A negative amount is refused unless the field can legitimately be negative (an adjustment). */
  allowNegative?: boolean;
  /** Named in the error, for the held reason. */
  field?: string;
}

// No sign but an optional leading "-", no leading zeros, no whitespace, no decimal point, no
// exponent, no thousands separator.
const WHOLE_NUMBER = /^-?(?:0|[1-9][0-9]*)$/;

/** Whole rupiah as a safe integer. Accepts only a string in canonical integer form: a JSON number
 * has already lost its spelling (`1e5` and `125000.00` both parse to integers), so it is refused,
 * and money fields in response schemas must be `z.string()`. Refuses `"125000.50"`, `"125000.00"`, `"1e5"`, `""`, `" 1"`, `"+1"`,
 * `"01"`, `"-0"`, `"1,000"`, every non-string, and anything beyond `Number.MAX_SAFE_INTEGER`. */
export function parseRupiah(value: unknown, options: ParseRupiahOptions = {}): number {
  if (typeof value !== "string" || !WHOLE_NUMBER.test(value) || value === "-0") throw new TikTokMoneyFormatError(options.field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TikTokMoneyFormatError(options.field);
  if (parsed < 0 && !options.allowNegative) throw new TikTokMoneyFormatError(options.field);
  return parsed;
}
