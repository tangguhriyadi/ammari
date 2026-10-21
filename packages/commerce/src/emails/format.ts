// Formatting for order emails (docs/plans/cart-checkout.md §8). Same output as apps/web's
// lib/format.ts (the storefront's "Rp269.000" without a space, times in WIB), repeated here because
// this package cannot import from apps/*.

const NUMBER = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
const JAKARTA_DATE = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long", year: "numeric" });
const JAKARTA_TIME = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "Rp269.000" (whole rupiah, dots as thousands separators). */
export function formatRupiah(amount: number): string {
  return `Rp${NUMBER.format(amount)}`;
}

/** "21 Oktober 2026, 14.30 WIB". */
export function formatWib(date: Date): string {
  return `${JAKARTA_DATE.format(date)}, ${JAKARTA_TIME.format(date)} WIB`;
}

/** Escapes text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
