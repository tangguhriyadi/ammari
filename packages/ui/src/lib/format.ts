const JAKARTA_TIME_ZONE = "Asia/Jakarta";

const numberFormatter = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: JAKARTA_TIME_ZONE,
});
const timeFormatter = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: JAKARTA_TIME_ZONE,
});

/** Whole-rupiah only — money is never fractional (CLAUDE.md). Built from a plain number format
 * plus a literal "Rp " rather than `style: "currency"`, because id-ID's own currency formatting
 * omits the space ("Rp249.000") that Indonesian convention and this app's UI expect. */
export function formatRupiah(amount: number): string {
  return `Rp ${numberFormatter.format(amount)}`;
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

/** e.g. "1 Okt 2026", always in Asia/Jakarta regardless of server/client timezone. */
export function formatDate(date: Date): string {
  return dateFormatter.format(date);
}

/** e.g. "1 Okt 2026, 20.14". Composed manually (date + ", " + time) rather than a single
 * combined Intl format, so the separator is guaranteed rather than left to locale defaults. */
export function formatDateTime(date: Date): string {
  return `${dateFormatter.format(date)}, ${timeFormatter.format(date)}`;
}
