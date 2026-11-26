import { OFFICIAL_BOOKS_START, type ReportRange } from "@ammari/accounting";
import { formatDay } from "./format";

// Text shared by the Neraca saldo page and its PDF/Excel exports (docs/plans/accounting.md §6,
// Session 4), so all three say the same thing about the trial month and the official books.

export const TRIAL_BALANCE_TITLE = "Neraca Saldo";

export function trialBalancePeriodLabel(range: Pick<ReportRange, "from" | "to">): string {
  return `${formatDay(range.from)} s.d. ${formatDay(range.to)}`;
}

/** Notes about which set of books the range belongs to (books.ts), or none. */
export function trialBalanceNotes(range: ReportRange): string[] {
  const notes: string[] = [];
  if (range.segment === "trial") notes.push("Desember 2026 adalah bulan uji coba: angka ini bukan bagian dari pembukuan resmi dan tidak terbawa ke 2027.");
  if (range.segment === "before") notes.push("Pembukuan dimulai 1 Desember 2026 (uji coba); sebelum tanggal itu tidak ada jurnal.");
  if (range.adjusted && range.from === OFFICIAL_BOOKS_START) notes.push("Periode dimulai 1 Jan 2027 karena pembukuan resmi dimulai pada tanggal itu; Desember 2026 dilaporkan terpisah.");
  else if (range.adjusted) notes.push("Periode dimulai 1 Des 2026, awal bulan uji coba.");
  if (range.segment === "official") notes.push("Saldo awal pembukuan resmi berasal dari jurnal saldo awal 1 Jan 2027.");
  return notes;
}

export function trialBalanceFileName(range: Pick<ReportRange, "from" | "to">, format: "pdf" | "xlsx"): string {
  return `neraca-saldo-${range.from}-${range.to}.${format}`;
}
