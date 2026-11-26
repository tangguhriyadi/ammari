import "server-only";
import * as XLSX from "xlsx";
import { formatDateTime } from "@ammari/ui/lib";
import { neutralizeFormula } from "@/lib/csv";
import { TRIAL_BALANCE_TITLE, trialBalanceNotes, trialBalancePeriodLabel } from "./trial-balance-content";
import type { TrialBalance } from "./trial-balance";

// Neraca saldo as an Excel file (docs/plans/accounting.md §6, Session 4), same conventions as
// lib/expenses/report-xlsx.ts: typed cells only (text is never a formula, and is formula-neutralized
// for a later CSV save), money as whole-rupiah numbers with a thousands format.

type Cell = string | number | null;
const MONEY_FORMAT = "#,##0";
const MONEY_COLUMNS = [2, 3, 4, 5, 6, 7];

export function renderTrialBalanceXlsx(report: TrialBalance): Uint8Array {
  const rows: Cell[][] = [
    [`AMMARI ${TRIAL_BALANCE_TITLE}`],
    [`Periode: ${trialBalancePeriodLabel(report.range)}`],
    [`Dibuat ${formatDateTime(report.generatedAt)} WIB`],
    ...trialBalanceNotes(report.range).map((note): Cell[] => [note]),
    [],
    ["Kode", "Akun", "Saldo awal debit (Rp)", "Saldo awal kredit (Rp)", "Mutasi debit (Rp)", "Mutasi kredit (Rp)", "Saldo akhir debit (Rp)", "Saldo akhir kredit (Rp)"],
    ...report.rows.map((row): Cell[] => [
      row.code,
      row.isActive ? row.name : `${row.name} (nonaktif)`,
      row.openingDebit,
      row.openingCredit,
      row.debit,
      row.credit,
      row.closingDebit,
      row.closingCredit,
    ]),
    [],
    ["Total", null, report.totals.openingDebit, report.totals.openingCredit, report.totals.debit, report.totals.credit, report.totals.closingDebit, report.totals.closingCredit],
    [report.balanced ? "Seimbang" : "TIDAK SEIMBANG"],
  ];
  const ws: XLSX.WorkSheet = {};
  let maxColumn = 0;
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value === null) return;
      ws[XLSX.utils.encode_cell({ r, c })] =
        typeof value === "number" ? { t: "n", v: value, ...(MONEY_COLUMNS.includes(c) ? { z: MONEY_FORMAT } : {}) } : { t: "s", v: neutralizeFormula(value) };
      maxColumn = Math.max(maxColumn, c);
    });
  });
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: maxColumn } });
  ws["!cols"] = [10, 40, 18, 18, 18, 18, 18, 18].map((wch) => ({ wch }));
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: TRIAL_BALANCE_TITLE, Author: "Ammari", CreatedDate: report.generatedAt };
  XLSX.utils.book_append_sheet(workbook, ws, TRIAL_BALANCE_TITLE);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Uint8Array;
}
