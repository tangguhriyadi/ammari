import { formatDate, formatRupiah } from "@ammari/ui/lib";

/** A Jakarta calendar day ("2026-12-05") as "5 Des 2026". */
export function formatDay(date: string): string {
  return formatDate(new Date(`${date}T00:00:00+07:00`));
}

/** An amount cell: blank for 0 (a line has exactly one positive side). */
export function formatAmount(amount: number): string {
  return amount === 0 ? "" : formatRupiah(amount);
}

/** A balance; a negative one (against the account's normal side) keeps its minus sign. */
export function formatBalance(amount: number): string {
  return amount < 0 ? `-${formatRupiah(-amount)}` : formatRupiah(amount);
}
