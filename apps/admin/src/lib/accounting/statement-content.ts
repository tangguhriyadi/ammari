import { OFFICIAL_BOOKS_START, TRIAL_BOOKS_START } from "@ammari/accounting";
import { formatDay } from "./format";
import type { Statement } from "./statement-layout";
import type { IncomeStatementView, StatementFormat, StatementReport } from "./statements";
import { trialBalanceNotes, trialBalancePeriodLabel } from "./trial-balance-content";

// Text shared by the Neraca, Laba rugi and Arus kas pages and their PDF/Excel exports
// (docs/plans/accounting.md §6, Session 10), so screen and files say the same thing.

export const STATEMENT_TITLES: Record<StatementReport["kind"], string> = {
  balance_sheet: "Neraca",
  income_statement: "Laba Rugi",
  cash_flow: "Arus Kas",
};

export const INCOME_STATEMENT_VIEW_LABELS: Record<IncomeStatementView, string> = {
  total: "Jumlah saja",
  month: "Per bulan",
  channel: "Per saluran",
};

export function statementPeriodLabel(report: StatementReport): string {
  if (report.kind === "balance_sheet") return `Per ${formatDay(report.asOf)}`;
  return trialBalancePeriodLabel(report.range);
}

export function statementNotes(report: StatementReport): string[] {
  if (report.kind === "balance_sheet") {
    const notes: string[] = [];
    if (report.segment === "trial") notes.push("Desember 2026 adalah bulan uji coba: angka ini bukan bagian dari pembukuan resmi dan tidak terbawa ke 2027. Bulan uji coba tidak punya pembanding.");
    if (report.segment === "before") notes.push(`Pembukuan dimulai ${formatDay(TRIAL_BOOKS_START)} (uji coba); sebelum tanggal itu tidak ada jurnal.`);
    if (report.segment === "official") notes.push(`Dihitung sejak ${formatDay(OFFICIAL_BOOKS_START)}, termasuk jurnal saldo awal.`);
    if (report.comparison.kind === "opening") notes.push("Pembanding bulan pertama adalah saldo awal pembukuan resmi, bukan Desember 2026 (bulan uji coba).");
    if (report.statement.rows.some((row) => row.key === "equity:current_earnings")) notes.push("Laba (rugi) berjalan adalah hasil laba rugi yang belum ditutup ke saldo laba (tutup buku akhir tahun).");
    return notes;
  }
  const notes = trialBalanceNotes(report.range).filter((note) => !note.startsWith("Saldo awal pembukuan resmi"));
  if (report.kind === "income_statement" && report.range.segment === "official") notes.push("Jurnal saldo awal 1 Jan 2027 tidak termasuk laba rugi.");
  if (report.kind === "income_statement" && report.monthsClamped) notes.push("Per bulan menampilkan paling banyak 12 bulan terakhir dari periode yang dipilih.");
  if (report.kind === "income_statement" && report.view === "channel") notes.push("Per saluran mengikuti saluran pada baris jurnal; beban tanpa saluran (gaji, sewa, jurnal manual) ada di kolom Tanpa saluran.");
  if (report.kind === "cash_flow") {
    notes.push("Metode langsung: setiap mutasi akun kas, bank, Piutang Midtrans dan Saldo Penjual dikelompokkan menurut akun lawannya.");
    if (report.range.segment === "official") notes.push("Kas awal pembukuan resmi berasal dari jurnal saldo awal 1 Jan 2027.");
  }
  return notes;
}

/** "Seimbang" when every check of the statement holds. */
export function statementBalanced(statement: Statement): boolean {
  return statement.checks.every((check) => check.ok);
}

export function statementFileName(report: StatementReport, format: StatementFormat): string {
  switch (report.kind) {
    case "balance_sheet":
      return `neraca-${report.asOf}.${format}`;
    case "income_statement":
      return `laba-rugi-${report.range.from}-${report.range.to}${report.view === "total" ? "" : `-${report.view === "month" ? "per-bulan" : "per-saluran"}`}.${format}`;
    case "cash_flow":
      return `arus-kas-${report.range.from}-${report.range.to}.${format}`;
  }
}
