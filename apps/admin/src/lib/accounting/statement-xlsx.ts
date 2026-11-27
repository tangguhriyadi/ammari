import "server-only";
import * as XLSX from "xlsx";
import { formatDateTime } from "@ammari/ui/lib";
import { neutralizeFormula } from "@/lib/csv";
import { STATEMENT_TITLES, statementBalanced, statementNotes, statementPeriodLabel } from "./statement-content";
import type { StatementReport } from "./statements";

// Neraca, Laba rugi and Arus kas as an Excel file (docs/plans/accounting.md §6, Session 10), the
// conventions of trial-balance-xlsx.ts: typed cells only (text never a formula, and formula-
// neutralized for a later CSV save), money as whole-rupiah numbers with a thousands format. Columns:
// Kode, Uraian (indented by level), one amount column per statement column.

type Cell = string | number | null;
const MONEY_FORMAT = "#,##0;(#,##0);-";
const FIRST_AMOUNT_COLUMN = 2;

export function renderStatementXlsx(report: StatementReport): Uint8Array {
  const { statement } = report;
  const title = STATEMENT_TITLES[report.kind];
  const rows: Cell[][] = [
    [`AMMARI ${title}`],
    [statementPeriodLabel(report)],
    [`Dibuat ${formatDateTime(report.generatedAt)} WIB`],
    ...statementNotes(report).map((note): Cell[] => [note]),
    [],
    ["Kode", "Uraian", ...statement.columns.map((column) => `${column.label} (Rp)`)],
    ...statement.rows.map((row): Cell[] => [row.accountCode ?? null, `${"  ".repeat(row.depth)}${row.label}`, ...row.amounts]),
    [],
    [statementBalanced(statement) ? "Seimbang" : "TIDAK SEIMBANG"],
    ...statement.checks.map((check): Cell[] => [`${check.ok ? "Cocok" : "Tidak cocok"}: ${check.label}`]),
  ];
  const ws: XLSX.WorkSheet = {};
  let maxColumn = 0;
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value === null) return;
      ws[XLSX.utils.encode_cell({ r, c })] =
        typeof value === "number" ? { t: "n", v: value, ...(c >= FIRST_AMOUNT_COLUMN ? { z: MONEY_FORMAT } : {}) } : { t: "s", v: neutralizeFormula(value) };
      maxColumn = Math.max(maxColumn, c);
    });
  });
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: maxColumn } });
  ws["!cols"] = [10, 48, ...statement.columns.map(() => 18)].map((wch) => ({ wch }));
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: title, Author: "Ammari", CreatedDate: report.generatedAt };
  XLSX.utils.book_append_sheet(workbook, ws, title);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Uint8Array;
}
