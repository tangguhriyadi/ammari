// The admin side of the per-product discount (docs/plans/product-discount.md §3, §9): parsing,
// the linked "Harga setelah diskon" / "Diskon (%)" inputs, WIB datetime conversion, the rule
// checks with their Indonesian messages, and the status chip labels.
//
// Client-safe on purpose (no `server-only`, no schema import): the discount section validates
// while the owner types with exactly the same rules the server action runs again on save. The
// price math itself lives in @ammari/db/pricing; its helpers throw on bad input, so every call
// from here is guarded first and never throws on anything typed into a field.

import {
  DISCOUNT_PERCENT_MAX,
  DISCOUNT_PRICE_ROUNDING,
  DISCOUNT_PERCENT_MIN,
  discountPercentTenths,
  salePriceFromPercent,
  validateDiscountPrice,
  type DiscountPriceIssue,
  type DiscountStatus,
} from "@ammari/db/pricing";
import type { BadgeVariant } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { parseRupiah } from "./money";

export const DISCOUNT_PRICE_ISSUE_MESSAGES: Record<DiscountPriceIssue, string> = {
  not_positive: `Harga setelah diskon harus lebih dari ${formatRupiah(0)}.`,
  not_below_base: "Harga setelah diskon harus lebih kecil dari harga normal.",
  under_min_percent: "Diskon minimal 1%.",
};

export const DISCOUNT_PERCENT_RANGE_MESSAGE = "Diskon harus 1 sampai 99 persen.";
export const DISCOUNT_PERCENT_NOT_ROUNDABLE_MESSAGE = `Persentase ini tidak bisa dibulatkan ke ${formatRupiah(DISCOUNT_PRICE_ROUNDING)}. Isi harga setelah diskon langsung.`;
export const DISCOUNT_PRICE_REQUIRED_MESSAGE = "Isi harga setelah diskon dulu.";
export const DISCOUNT_WINDOW_MESSAGE = "Waktu selesai harus setelah waktu mulai.";
export const DISCOUNT_ENDED_MESSAGE = "Waktu selesai sudah lewat.";
export const DISCOUNT_PRICE_FORMAT_MESSAGE = "Format harga tidak valid.";
export const DISCOUNT_DATETIME_FORMAT_MESSAGE = "Format tanggal dan jam tidak valid.";

/** A base price edit that would break the stored discount (plan §3.2, last row), with the price
 * in the admin's own format ("Rp 279.000"). */
export function basePriceBreaksDiscountMessage(discountPriceAmount: number): string {
  return `Harga normal harus lebih besar dari harga diskon (${formatRupiah(discountPriceAmount)}) dan diskon minimal 1%. Ubah atau hapus diskon dulu.`;
}

/** The admin chip labels (plan §3.3). */
export const DISCOUNT_STATUS_LABELS: Record<DiscountStatus, string> = {
  active: "Aktif",
  scheduled: "Terjadwal",
  ended: "Berakhir",
  off: "Nonaktif",
};

export const DISCOUNT_STATUS_BADGE_VARIANTS: Record<DiscountStatus, BadgeVariant> = {
  active: "success",
  scheduled: "warning",
  ended: "neutral",
  off: "neutral",
};

/** A whole rupiah amount for an input field, grouped the id-ID way ("279.000"). */
export function formatRupiahInput(amount: number): string {
  return formatNumber(amount);
}

/** 202 tenths -> "20,2"; 200 -> "20". */
export function formatPercentTenths(tenths: number): string {
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return fraction === 0 ? String(whole) : `${whole},${fraction}`;
}

/** The typed "Diskon (%)": a whole number 1..99, or null. "20%" is accepted; "20,5" is not. */
export function parseDiscountPercent(input: string): number | null {
  const trimmed = input.trim().replace(/\s*%$/, "");
  if (!/^\d{1,2}$/.test(trimmed)) return null;
  const percent = Number.parseInt(trimmed, 10);
  return percent >= DISCOUNT_PERCENT_MIN && percent <= DISCOUNT_PERCENT_MAX ? percent : null;
}

/** What the "Diskon (%)" field shows while the owner types a Rp price: the real percent floored
 * to one decimal ("20,2"), or "" while the price is empty, unparseable or not below the base. */
export function percentTextForPrice(basePrice: number, priceText: string): string {
  const price = parseRupiah(priceText);
  if (price === null || !Number.isSafeInteger(basePrice) || basePrice <= 0 || price >= basePrice) return "";
  return formatPercentTenths(discountPercentTenths(basePrice, price));
}

export type PriceFromPercent =
  | { ok: true; priceText: string }
  | { ok: false; message: string };

/** What the "Harga setelah diskon" field gets while the owner types a percent: the price rounded
 * DOWN to Rp1.000 (plan §3.1), or a message when the percent is out of range or cannot be rounded
 * without the badge showing more than the typed percent. An empty field is not an error. */
export function priceForPercentText(basePrice: number, percentText: string): PriceFromPercent | null {
  if (percentText.trim() === "") return null;
  const percent = parseDiscountPercent(percentText);
  if (percent === null) return { ok: false, message: DISCOUNT_PERCENT_RANGE_MESSAGE };
  if (!Number.isSafeInteger(basePrice) || basePrice <= 0) return { ok: false, message: DISCOUNT_PERCENT_NOT_ROUNDABLE_MESSAGE };
  const price = salePriceFromPercent(basePrice, percent);
  if (price === null) return { ok: false, message: DISCOUNT_PERCENT_NOT_ROUNDABLE_MESSAGE };
  return { ok: true, priceText: formatRupiahInput(price) };
}

// ---------- WIB datetimes ----------
//
// `<input type="datetime-local">` gives "YYYY-MM-DDTHH:mm" with no zone; the owner means
// Asia/Jakarta, which is UTC+7 all year (no DST), so the conversion is a fixed offset.

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const DATETIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/;

/** "2026-11-01T00:00" (WIB) -> 2026-10-31T17:00:00Z. Seconds are dropped (minute precision).
 * Null for anything that is not a real calendar date and time. */
export function jakartaLocalToUtc(value: string): Date | null {
  const match = DATETIME_LOCAL_PATTERN.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  // Rejects day overflow such as 2026-02-30 (Date.UTC would roll it into March).
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(asUtc - JAKARTA_OFFSET_MS);
}

/** A stored instant back into the datetime-local value, in WIB ("2026-11-01T00:00"). */
export function utcToJakartaLocal(date: Date): string {
  const shifted = new Date(date.getTime() + JAKARTA_OFFSET_MS);
  return shifted.toISOString().slice(0, 16);
}

// ---------- Rules (plan §3.2) ----------

export interface DiscountRuleInput {
  basePrice: number;
  /** null when the "Harga setelah diskon" field is empty. */
  discountPriceAmount: number | null;
  discountEnabled: boolean;
  discountStartsAt: Date | null;
  discountEndsAt: Date | null;
}

export type DiscountField = "discountPriceAmount" | "discountStartsAt" | "discountEndsAt";

/** The first rule a discount save breaks, as the field to blame and its message, or null. The
 * same check runs in the browser while typing and on the server against the locked row. */
export function checkDiscountRules(input: DiscountRuleInput, now: Date): { field: DiscountField; message: string } | null {
  if (input.discountPriceAmount !== null) {
    const issue = validateDiscountPrice(input.basePrice, input.discountPriceAmount);
    if (issue) return { field: "discountPriceAmount", message: DISCOUNT_PRICE_ISSUE_MESSAGES[issue] };
  } else if (input.discountEnabled) {
    return { field: "discountPriceAmount", message: DISCOUNT_PRICE_REQUIRED_MESSAGE };
  }
  if (input.discountStartsAt && input.discountEndsAt && input.discountEndsAt.getTime() <= input.discountStartsAt.getTime()) {
    return { field: "discountEndsAt", message: DISCOUNT_WINDOW_MESSAGE };
  }
  if (input.discountEnabled && input.discountEndsAt && input.discountEndsAt.getTime() <= now.getTime()) {
    return { field: "discountEndsAt", message: DISCOUNT_ENDED_MESSAGE };
  }
  return null;
}
