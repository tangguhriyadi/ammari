// Formatting for order emails (docs/plans/cart-checkout.md §8). Same output as apps/web's
// lib/format.ts (the storefront's "Rp269.000" without a space, times in WIB), repeated here because
// this package cannot import from apps/*. Times and escaping are the shared email package's.

export { escapeHtml, formatWib } from "@ammari/email";

const NUMBER = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

/** "Rp269.000" (whole rupiah, dots as thousands separators). */
export function formatRupiah(amount: number): string {
  return `Rp${NUMBER.format(amount)}`;
}
