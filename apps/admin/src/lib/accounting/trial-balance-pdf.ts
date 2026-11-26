import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import { formatDateTime, formatRupiah } from "@ammari/ui/lib";
import { labelText, wrapText } from "@/lib/shipping/label-pdf";
import { TRIAL_BALANCE_TITLE, trialBalanceNotes, trialBalancePeriodLabel } from "./trial-balance-content";
import type { TrialBalance } from "./trial-balance";

// Neraca saldo as a PDF (docs/plans/accounting.md §6, Session 4). Same approach as
// lib/expenses/report-pdf.ts: pdf-lib with the built-in Helvetica (every string through labelText,
// WinAnsi only), brand colours, pages added as needed. A4 landscape: eight columns.

const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN_X = 36;
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 52;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

const BRAND = rgb(0x69 / 255, 0x5a / 255, 0x5a / 255);
const BLACK = rgb(0, 0, 0);
const MUTED = rgb(0x52 / 255, 0x52 / 255, 0x52 / 255);
const RULE = rgb(0xd4 / 255, 0xd4 / 255, 0xd4 / 255);
const OLIVE = rgb(0x4b / 255, 0x57 / 255, 0x26 / 255);
const BRICK = rgb(0x8a / 255, 0x33 / 255, 0x24 / 255);

const AMOUNT_WIDTH = 92;
const COLUMNS = [
  { title: "Kode", width: 46, align: "left" as const },
  { title: "Akun", width: CONTENT_WIDTH - 46 - AMOUNT_WIDTH * 6, align: "left" as const },
  { title: "Awal debit", width: AMOUNT_WIDTH, align: "right" as const },
  { title: "Awal kredit", width: AMOUNT_WIDTH, align: "right" as const },
  { title: "Mutasi debit", width: AMOUNT_WIDTH, align: "right" as const },
  { title: "Mutasi kredit", width: AMOUNT_WIDTH, align: "right" as const },
  { title: "Akhir debit", width: AMOUNT_WIDTH, align: "right" as const },
  { title: "Akhir kredit", width: AMOUNT_WIDTH, align: "right" as const },
];

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

const money = (amount: number) => (amount === 0 ? "" : formatRupiah(amount));

export async function renderTrialBalancePdf(report: TrialBalance): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(TRIAL_BALANCE_TITLE);
  pdf.setAuthor("Ammari");
  pdf.setCreator("Ammari Admin");
  pdf.setProducer("Ammari Admin");
  pdf.setCreationDate(report.generatedAt);
  pdf.setModificationDate(report.generatedAt);
  const fonts: Fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const pages: PDFPage[] = [];
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);
  let y = PAGE_HEIGHT - MARGIN_TOP;

  const text = (value: string, x: number, options: { size: number; bold?: boolean; color?: RGB; align?: "left" | "right"; width?: number }) => {
    const font = options.bold ? fonts.bold : fonts.regular;
    let drawn = labelText(value);
    // Clip a long account name to its column.
    if (options.width && options.align !== "right") drawn = wrapText(font, drawn, options.size, options.width, 1)[0] ?? "";
    const drawX = options.align === "right" ? x + (options.width ?? 0) - font.widthOfTextAtSize(drawn, options.size) : x;
    page.drawText(drawn, { x: drawX, y, size: options.size, font, color: options.color ?? BLACK });
  };
  const rule = (color: RGB = RULE, thickness = 0.6) => page.drawLine({ start: { x: MARGIN_X, y }, end: { x: PAGE_WIDTH - MARGIN_X, y }, thickness, color });
  const row = (cells: string[], options: { bold?: boolean; size?: number; color?: RGB }) => {
    let x = MARGIN_X;
    COLUMNS.forEach((column, index) => {
      text(cells[index] ?? "", column.align === "left" ? x + 2 : x, { size: options.size ?? 8.5, bold: options.bold, color: options.color, align: column.align, width: column.width - 6 });
      x += column.width;
    });
  };
  const header = () => {
    row(
      COLUMNS.map((column) => column.title),
      { bold: true, size: 8, color: MUTED },
    );
    y -= 6;
    rule();
    y -= 12;
  };
  const ensure = (height: number) => {
    if (y - height >= MARGIN_BOTTOM) return;
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    y = PAGE_HEIGHT - MARGIN_TOP;
    header();
  };

  text("AMMARI", MARGIN_X, { size: 10, bold: true, color: BRAND });
  y -= 18;
  text(TRIAL_BALANCE_TITLE, MARGIN_X, { size: 16, bold: true });
  y -= 15;
  text(`Periode: ${trialBalancePeriodLabel(report.range)}`, MARGIN_X, { size: 9, color: MUTED });
  y -= 12;
  for (const note of trialBalanceNotes(report.range)) {
    text(note, MARGIN_X, { size: 8.5, color: MUTED });
    y -= 11;
  }
  y -= 2;
  rule(BRAND, 1.2);
  y -= 16;
  header();

  for (const line of report.rows) {
    ensure(14);
    row([line.code, line.isActive ? line.name : `${line.name} (nonaktif)`, money(line.openingDebit), money(line.openingCredit), money(line.debit), money(line.credit), money(line.closingDebit), money(line.closingCredit)], {});
    y -= 14;
  }
  ensure(34);
  y += 4;
  rule();
  y -= 12;
  const totals = report.totals;
  row(["", "Total", formatRupiah(totals.openingDebit), formatRupiah(totals.openingCredit), formatRupiah(totals.debit), formatRupiah(totals.credit), formatRupiah(totals.closingDebit), formatRupiah(totals.closingCredit)], { bold: true });
  y -= 16;
  text(report.balanced ? "Seimbang" : "TIDAK SEIMBANG", MARGIN_X + 2, { size: 9, bold: true, color: report.balanced ? OLIVE : BRICK });

  const generated = `Dibuat ${formatDateTime(report.generatedAt)} WIB`;
  pages.forEach((current, index) => {
    current.drawLine({ start: { x: MARGIN_X, y: 40 }, end: { x: PAGE_WIDTH - MARGIN_X, y: 40 }, thickness: 0.6, color: RULE });
    current.drawText(labelText(generated), { x: MARGIN_X, y: 28, size: 7.5, font: fonts.regular, color: MUTED });
    const label = `Halaman ${index + 1} dari ${pages.length}`;
    current.drawText(label, { x: PAGE_WIDTH - MARGIN_X - fonts.regular.widthOfTextAtSize(label, 7.5), y: 28, size: 7.5, font: fonts.regular, color: MUTED });
  });
  return pdf.save();
}
