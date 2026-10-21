const numberFormatter = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });

/** Whole-rupiah only (CLAUDE.md — money is never fractional), formatted WITHOUT a space after
 * "Rp" — docs/design/storefront.md §6 gives the exact format ("Rp269.000"). Deliberately NOT
 * @ammari/ui's own `formatRupiah` (admin's convention inserts a space, "Rp 269.000") — kept local
 * since the two apps' designs disagree on this one detail. */
export function formatPriceIdr(amount: number): string {
  return `Rp${numberFormatter.format(amount)}`;
}

const JAKARTA_DATE = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "long", year: "numeric" });
const JAKARTA_TIME = new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "21 Oktober 2026", the calendar date in Asia/Jakarta (CLAUDE.md: dates show in WIB). */
export function formatJakartaDate(date: Date): string {
  return JAKARTA_DATE.format(date);
}

/** "21 Oktober 2026, 14.30 WIB" (plan §4.4: the payment deadline in WIB). */
export function formatJakartaDateTime(date: Date): string {
  return `${JAKARTA_DATE.format(date)}, ${JAKARTA_TIME.format(date)} WIB`;
}
