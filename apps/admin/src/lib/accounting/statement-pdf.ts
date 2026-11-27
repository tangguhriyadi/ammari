import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { formatDateTime, formatNumber } from "@ammari/ui/lib";
import { labelText, wrapText } from "@/lib/shipping/label-pdf";
import { STATEMENT_TITLES, statementBalanced, statementNotes, statementPeriodLabel } from "./statement-content";
import type { StatementRow } from "./statement-layout";
import type { StatementReport } from "./statements";

// Neraca, Laba rugi and Arus kas as a PDF (docs/plans/accounting.md §6, Session 10), the same
// approach as trial-balance-pdf.ts: pdf-lib with the built-in Helvetica (every string through
// labelText, WinAnsi only), brand colours, pages added as needed. A4 portrait for one or two amount
// columns, landscape for the per-month / per-channel Laba rugi. Amounts in whole rupiah, negatives in
// brackets (accounting style), so a wide statement still fits.

const MARGIN_X = 36;
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 52;
const INDENT = 10;

const BRAND = rgb(0x69 / 255, 0x5a / 255, 0x5a / 255);
const BLACK = rgb(0, 0, 0);
const MUTED = rgb(0x52 / 255, 0x52 / 255, 0x52 / 255);
const RULE = rgb(0xd4 / 255, 0xd4 / 255, 0xd4 / 255);
const OLIVE = rgb(0x4b / 255, 0x57 / 255, 0x26 / 255);
const BRICK = rgb(0x8a / 255, 0x33 / 255, 0x24 / 255);

/** 1.234.000 / (1.234.000) / "" for no figure. */
export function pdfAmount(value: number | null): string {
  if (value === null) return "";
  if (value === 0) return "-";
  return value < 0 ? `(${formatNumber(-value)})` : formatNumber(value);
}

export async function renderStatementPdf(report: StatementReport): Promise<Uint8Array> {
  const { statement } = report;
  const title = STATEMENT_TITLES[report.kind];
  const amountColumns = statement.columns.length;
  const landscape = amountColumns > 2;
  const [pageWidth, pageHeight] = landscape ? [841.89, 595.28] : [595.28, 841.89];
  const contentWidth = pageWidth - MARGIN_X * 2;
  const labelWidth = landscape ? Math.max(170, contentWidth - amountColumns * 90) : contentWidth - amountColumns * 110;
  const amountWidth = (contentWidth - labelWidth) / amountColumns;
  const size = amountColumns <= 4 ? 8.5 : amountColumns <= 8 ? 7.5 : 6.5;

  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor("Ammari");
  pdf.setCreator("Ammari Admin");
  pdf.setProducer("Ammari Admin");
  pdf.setCreationDate(report.generatedAt);
  pdf.setModificationDate(report.generatedAt);
  const fonts: { regular: PDFFont; bold: PDFFont } = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const pages: PDFPage[] = [];
  let page = pdf.addPage([pageWidth, pageHeight]);
  pages.push(page);
  let y = pageHeight - MARGIN_TOP;

  const text = (value: string, x: number, options: { size: number; bold?: boolean; color?: RGB; align?: "left" | "right"; width?: number }) => {
    const font = options.bold ? fonts.bold : fonts.regular;
    let drawn = labelText(value);
    let drawSize = options.size;
    if (options.width && options.align !== "right") drawn = wrapText(font, drawn, options.size, options.width, 1)[0] ?? "";
    // A wide amount in a narrow column (per-month Laba rugi) shrinks to fit, never spills into its neighbour.
    if (options.width && options.align === "right") {
      const width = font.widthOfTextAtSize(drawn, drawSize);
      if (width > options.width) drawSize = Math.max(4, (drawSize * options.width) / width);
    }
    const drawX = options.align === "right" ? x + (options.width ?? 0) - font.widthOfTextAtSize(drawn, drawSize) : x;
    page.drawText(drawn, { x: drawX, y, size: drawSize, font, color: options.color ?? BLACK });
  };
  const rule = (color: RGB = RULE, thickness = 0.6) => page.drawLine({ start: { x: MARGIN_X, y }, end: { x: pageWidth - MARGIN_X, y }, thickness, color });
  const header = () => {
    text("Dalam rupiah", MARGIN_X, { size: size - 0.5, color: MUTED });
    statement.columns.forEach((column, index) => {
      text(column.label, MARGIN_X + labelWidth + amountWidth * index, { size: size - 0.5, bold: true, color: MUTED, align: "right", width: amountWidth - 4 });
    });
    y -= 6;
    rule();
    y -= 12;
  };
  const ensure = (height: number) => {
    if (y - height >= MARGIN_BOTTOM) return;
    page = pdf.addPage([pageWidth, pageHeight]);
    pages.push(page);
    y = pageHeight - MARGIN_TOP;
    header();
  };
  const drawRow = (row: StatementRow) => {
    const bold = row.style !== "account";
    const before = row.style === "section" ? 6 : row.style === "total" ? 3 : 0;
    ensure(13 + before);
    y -= before;
    if (row.style === "total") {
      y += 9;
      rule();
      y -= 9;
    }
    const indent = MARGIN_X + 2 + row.depth * INDENT;
    text(row.accountCode ? `${row.accountCode}  ${row.label}` : row.label, indent, { size, bold, color: row.style === "section" ? BRAND : BLACK, width: labelWidth - (indent - MARGIN_X) - 4 });
    row.amounts.forEach((amount, index) => {
      text(pdfAmount(amount), MARGIN_X + labelWidth + amountWidth * index, { size, bold: row.style === "total" || row.style === "subtotal", align: "right", width: amountWidth - 4 });
    });
    y -= 13;
  };

  text("AMMARI", MARGIN_X, { size: 10, bold: true, color: BRAND });
  y -= 18;
  text(title, MARGIN_X, { size: 16, bold: true });
  y -= 15;
  text(statementPeriodLabel(report), MARGIN_X, { size: 9, color: MUTED });
  y -= 12;
  for (const note of statementNotes(report)) {
    for (const line of wrapText(fonts.regular, labelText(note), 8.5, contentWidth, 3)) {
      text(line, MARGIN_X, { size: 8.5, color: MUTED });
      y -= 11;
    }
  }
  y -= 2;
  rule(BRAND, 1.2);
  y -= 16;
  header();
  for (const row of statement.rows) drawRow(row);

  ensure(16 + statement.checks.length * 11);
  y -= 6;
  const balanced = statementBalanced(statement);
  text(balanced ? "Seimbang" : "TIDAK SEIMBANG", MARGIN_X + 2, { size: 9, bold: true, color: balanced ? OLIVE : BRICK });
  y -= 12;
  for (const check of statement.checks) {
    text(`${check.ok ? "Cocok" : "Tidak cocok"}: ${check.label}`, MARGIN_X + 2, { size: 7.5, color: check.ok ? MUTED : BRICK, width: contentWidth - 4 });
    y -= 11;
  }

  const generated = `Dibuat ${formatDateTime(report.generatedAt)} WIB`;
  pages.forEach((current, index) => {
    current.drawLine({ start: { x: MARGIN_X, y: 40 }, end: { x: pageWidth - MARGIN_X, y: 40 }, thickness: 0.6, color: RULE });
    current.drawText(labelText(generated), { x: MARGIN_X, y: 28, size: 7.5, font: fonts.regular, color: MUTED });
    const label = `Halaman ${index + 1} dari ${pages.length}`;
    current.drawText(label, { x: pageWidth - MARGIN_X - fonts.regular.widthOfTextAtSize(label, 7.5), y: 28, size: 7.5, font: fonts.regular, color: MUTED });
  });
  return pdf.save();
}
