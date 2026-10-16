const numberFormatter = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

/** Whole-rupiah only (CLAUDE.md — money is never fractional), formatted WITHOUT a space after
 * "Rp" — docs/design/storefront.md §6 gives the exact format ("Rp269.000"). Deliberately NOT
 * @ammari/ui's own `formatRupiah` (admin's convention inserts a space, "Rp 269.000") — kept local
 * since the two apps' designs disagree on this one detail. */
export function formatPriceIdr(amount: number): string {
  return `Rp${numberFormatter.format(amount)}`;
}
