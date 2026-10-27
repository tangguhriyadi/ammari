import "server-only";
import * as XLSX from "xlsx";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { formatDateTime } from "@ammari/ui/lib";
import { neutralizeFormula } from "@/lib/csv";
import { EXPENSE_CATEGORY_LABELS, EXPENSE_METHOD_LABELS, MARKETING_CHANNEL_LABELS, MARKETING_CHANNEL_OPTIONS, type MarketingChannelId } from "./labels";
import { REPORT_ORDER_ROW_CAP, type MonthlyReport } from "./report";
import { REPORT_DISCLAIMER, breakEvenText, channelReportRows, profitAndLossLines, reportNotes, reportTitle } from "./report-content";

// The monthly report as an Excel file (docs/plans/growth.md session S6, owner addition A), with the
// vendored SheetJS (apps/admin/vendor/README.md). Sheets: Ringkasan, Per kanal, Biaya (one row
// per non-voided expense; never the proof file), Pesanan (one row per counted order).
//
// Formula injection: every cell is written as a typed cell, so text is a string cell ("s") and
// never a formula; text that came from a person (notes, campaigns, names, order numbers) also goes
// through neutralizeFormula, the CSV rule (lib/csv.ts), so it stays inert if the sheet is later
// saved as CSV. Money is a number cell in whole rupiah with a thousands format.

type Cell = string | number | null;
const MONEY_FORMAT = "#,##0";

/** A sheet from rows of plain values: strings as text cells (formula-neutralized), numbers as
 * number cells with `moneyColumns` formatted as rupiah. */
function sheet(rows: readonly (readonly Cell[])[], options: { widths: number[]; moneyColumns?: readonly number[] }): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  let maxColumn = 0;
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value === null) return;
      const address = XLSX.utils.encode_cell({ r, c });
      ws[address] =
        typeof value === "number"
          ? { t: "n", v: value, ...(options.moneyColumns?.includes(c) ? { z: MONEY_FORMAT } : {}) }
          : { t: "s", v: neutralizeFormula(value) };
      maxColumn = Math.max(maxColumn, c);
    });
  });
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: maxColumn } });
  ws["!cols"] = options.widths.map((wch) => ({ wch }));
  return ws;
}

function channelLabel(channelId: string | null): string {
  if (channelId === null) return "";
  return (MARKETING_CHANNEL_OPTIONS as readonly string[]).includes(channelId) ? MARKETING_CHANNEL_LABELS[channelId as MarketingChannelId] : channelId;
}

function summarySheet(report: MonthlyReport, today: string): XLSX.WorkSheet {
  const rows: Cell[][] = [
    [reportTitle(report.params, today)],
    [`Dibuat ${formatDateTime(report.generatedAt)} WIB`],
    [REPORT_DISCLAIMER],
    [],
    ["Pos", "Jumlah (Rp)"],
    ...profitAndLossLines(report.summary).map((line): Cell[] => [line.kind === "detail" ? `   ${line.label}` : line.label, line.amount]),
    [],
    ["Pesanan dihitung", report.summary.totals.orders],
    ["Titik impas ROAS", breakEvenText(report.summary.breakEven)],
    [],
    ["Catatan"],
    ...reportNotes(report.summary).map((note): Cell[] => [note]),
  ];
  return sheet(rows, { widths: [34, 18], moneyColumns: [1] });
}

function channelSheet(report: MonthlyReport): XLSX.WorkSheet {
  const rows: Cell[][] = [
    ["Kanal", "Omzet (Rp)", "Pesanan", "Biaya iklan (Rp)", "ROAS", "Status"],
    ...channelReportRows(report.summary).map((row): Cell[] => [row.label, row.omzet, row.orders, row.adSpend, row.roas === "-" ? null : row.roas, row.status]),
    [],
    ["Titik impas ROAS", breakEvenText(report.summary.breakEven)],
  ];
  return sheet(rows, { widths: [16, 16, 10, 18, 16, 24], moneyColumns: [1, 3] });
}

function expenseSheet(report: MonthlyReport): XLSX.WorkSheet {
  const total = report.expenseRows.reduce((sum, row) => sum + row.amount, 0);
  const rows: Cell[][] = [
    ["Tanggal bayar", "No. biaya", "Kategori", "Kanal", "Kampanye", "Jumlah (Rp)", "Metode", "Catatan", "Dicatat oleh"],
    ...report.expenseRows.map((row): Cell[] => [
      row.expenseDate,
      row.expenseNo,
      EXPENSE_CATEGORY_LABELS[row.category],
      channelLabel(row.channelId),
      row.campaign,
      row.amount,
      EXPENSE_METHOD_LABELS[row.method],
      row.note,
      row.recordedByName,
    ]),
    [],
    ["Total", null, null, null, null, total],
  ];
  return sheet(rows, { widths: [14, 18, 14, 12, 20, 16, 14, 40, 20], moneyColumns: [5] });
}

function orderSheet(report: MonthlyReport): XLSX.WorkSheet {
  const totals = report.orderRows.reduce(
    (sum, row) => ({ omzet: sum.omzet + row.omzet, hpp: sum.hpp + row.hpp, fee: sum.fee + row.platformFee, subsidy: sum.subsidy + row.webShippingSubsidy }),
    { omzet: 0, hpp: 0, fee: 0, subsidy: 0 },
  );
  const note = (row: MonthlyReport["orderRows"][number]): string | null => {
    const parts = [row.linesWithoutCost > 0 ? "HPP belum lengkap" : null, row.feeMissing ? "Biaya platform belum ada" : null].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  };
  const rows: Cell[][] = [
    ["Tanggal pesanan (WIB)", "No. pesanan", "Kanal", "Omzet (Rp)", "HPP (Rp)", "Biaya platform (Rp)", "Subsidi ongkir (Rp)", "Catatan"],
    ...report.orderRows.map((row): Cell[] => [jakartaDate(row.orderDate), row.orderNo, row.channelName, row.omzet, row.hpp, row.platformFee, row.webShippingSubsidy, note(row)]),
    [],
    // A cut sheet adds up only its own rows, so its total says so (Ringkasan has the full figures).
    [report.ordersTruncated ? "Total (sebagian)" : "Total", null, null, totals.omzet, totals.hpp, totals.fee, totals.subsidy],
  ];
  if (report.ordersTruncated) rows.push([`Dipotong: hanya ${REPORT_ORDER_ROW_CAP} pesanan pertama. Pilih rentang bulan yang lebih pendek untuk sisanya.`]);
  return sheet(rows, { widths: [20, 24, 14, 16, 16, 18, 18, 36], moneyColumns: [3, 4, 5, 6] });
}

export function renderMonthlyReportXlsx(report: MonthlyReport, today: string): Uint8Array {
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: reportTitle(report.params, today), Author: "Ammari", CreatedDate: report.generatedAt };
  XLSX.utils.book_append_sheet(workbook, summarySheet(report, today), "Ringkasan");
  XLSX.utils.book_append_sheet(workbook, channelSheet(report), "Per kanal");
  XLSX.utils.book_append_sheet(workbook, expenseSheet(report), "Biaya");
  XLSX.utils.book_append_sheet(workbook, orderSheet(report), "Pesanan");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Uint8Array;
}
