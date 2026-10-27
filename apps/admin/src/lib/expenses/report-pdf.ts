import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { formatDateTime, formatNumber, formatRupiah } from "@ammari/ui/lib";
import { labelText, wrapText } from "@/lib/shipping/label-pdf";
import {
  REPORT_DISCLAIMER,
  breakEvenText,
  channelReportRows,
  formatSignedRupiah,
  profitAndLossLines,
  reportNotes,
  reportPeriodLabel,
  reportTitle,
} from "./report-content";
import type { MonthlyReport } from "./report";

// The monthly report as a PDF (docs/plans/growth.md session S6, owner addition A). Drawn with
// pdf-lib (already the admin's PDF library for shipping labels and stickers) and the built-in
// Helvetica: no headless browser and no font file in the Docker image. Helvetica draws WinAnsi
// only, so every string goes through labelText (accents stripped, anything else "?"); every figure
// and label here is ASCII Indonesian anyway. A4 portrait; pages are added as the content needs.

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 48;
const MARGIN_TOP = 48;
/** Room kept free at the bottom for the footer. */
const MARGIN_BOTTOM = 64;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

// Brand (CLAUDE.md "Visual identity") and the muted status tones of the admin theme.
const BRAND = rgb(0x69 / 255, 0x5a / 255, 0x5a / 255);
const BLACK = rgb(0, 0, 0);
const MUTED = rgb(0x52 / 255, 0x52 / 255, 0x52 / 255);
const RULE = rgb(0xd4 / 255, 0xd4 / 255, 0xd4 / 255);
const BAND = rgb(0xf5 / 255, 0xf3 / 255, 0xf3 / 255);
const OLIVE = rgb(0x4b / 255, 0x57 / 255, 0x26 / 255);
const BRICK = rgb(0x8a / 255, 0x33 / 255, 0x24 / 255);

/** The brand mark next to the title. Reads apps/admin/public (the Docker image copies it next to
 * server.js, whose working directory is the app folder). */
export const REPORT_LOGO_PATH = path.join("public", "logos", "ammari-mark-512.png");

/** Null (and a warning) when the file cannot be read: the report is still drawn, with the name
 * only, rather than refusing a finance download over a missing picture. */
export async function loadReportLogo(): Promise<Uint8Array | null> {
  try {
    return await readFile(path.join(process.cwd(), REPORT_LOGO_PATH));
  } catch (error) {
    console.warn("[expense-report] logo not readable; drawing the report without it", { path: REPORT_LOGO_PATH, code: (error as { code?: unknown }).code });
    return null;
  }
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

class Cursor {
  page: PDFPage;
  y: number;
  readonly pages: PDFPage[] = [];

  constructor(
    private readonly pdf: PDFDocument,
    readonly fonts: Fonts,
  ) {
    this.page = this.addPage();
    this.y = PAGE_HEIGHT - MARGIN_TOP;
  }

  private addPage(): PDFPage {
    const page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(page);
    return page;
  }

  /** Starts a new page when `height` no longer fits above the footer. */
  ensure(height: number): void {
    if (this.y - height >= MARGIN_BOTTOM) return;
    this.page = this.addPage();
    this.y = PAGE_HEIGHT - MARGIN_TOP;
  }

  text(value: string, x: number, options: { size: number; bold?: boolean; color?: RGB; align?: "left" | "right"; width?: number }): void {
    const font = options.bold ? this.fonts.bold : this.fonts.regular;
    const text = labelText(value);
    const drawX = options.align === "right" ? x + (options.width ?? 0) - font.widthOfTextAtSize(text, options.size) : x;
    this.page.drawText(text, { x: drawX, y: this.y, size: options.size, font, color: options.color ?? BLACK });
  }

  rule(color: RGB = RULE, thickness = 0.6): void {
    this.page.drawLine({ start: { x: MARGIN_X, y: this.y }, end: { x: PAGE_WIDTH - MARGIN_X, y: this.y }, thickness, color });
  }
}

function sectionHeading(cursor: Cursor, title: string): void {
  cursor.ensure(40);
  cursor.y -= 22;
  cursor.text(title, MARGIN_X, { size: 12, bold: true, color: BRAND });
  cursor.y -= 6;
  cursor.rule(BRAND, 0.8);
  cursor.y -= 14;
}

function drawHeader(cursor: Cursor, report: MonthlyReport, logo: PDFImage | null, today: string): void {
  const logoSize = 44;
  const textX = logo ? MARGIN_X + logoSize + 12 : MARGIN_X;
  if (logo) cursor.page.drawImage(logo, { x: MARGIN_X, y: cursor.y - logoSize + 10, width: logoSize, height: logoSize });
  cursor.text("AMMARI", textX, { size: 10, bold: true, color: BRAND });
  cursor.y -= 18;
  cursor.text(reportTitle(report.params, today), textX, { size: 16, bold: true });
  cursor.y -= 16;
  cursor.text(`Periode: ${reportPeriodLabel(report.params, today)}`, textX, { size: 9, color: MUTED });
  cursor.y -= 14;
  cursor.rule(BRAND, 1.2);
}

function drawProfitAndLoss(cursor: Cursor, report: MonthlyReport): void {
  sectionHeading(cursor, "Laba rugi (manajemen)");
  const amountWidth = 160;
  const amountX = PAGE_WIDTH - MARGIN_X - amountWidth;
  for (const line of profitAndLossLines(report.summary)) {
    const rowHeight = line.kind === "result" ? 20 : 16;
    cursor.ensure(rowHeight);
    if (line.kind === "result") {
      cursor.page.drawRectangle({ x: MARGIN_X, y: cursor.y - 5, width: CONTENT_WIDTH, height: 17, color: BAND });
    }
    const isNet = line.label === "Laba bersih";
    const color = isNet ? (line.amount >= 0 ? OLIVE : BRICK) : line.kind === "detail" ? MUTED : BLACK;
    const size = line.kind === "detail" ? 9 : 10;
    cursor.text(line.label, line.kind === "detail" ? MARGIN_X + 16 : MARGIN_X + 4, { size, bold: line.kind === "result", color: line.kind === "detail" ? MUTED : BLACK });
    cursor.text(formatSignedRupiah(line.amount), amountX, { size, bold: line.kind === "result", color, align: "right", width: amountWidth - 4 });
    cursor.y -= rowHeight;
  }
  cursor.ensure(16);
  cursor.text(`Pesanan dihitung: ${formatNumber(report.summary.totals.orders)}. Titik impas ROAS: ${breakEvenText(report.summary.breakEven)}.`, MARGIN_X + 4, { size: 8.5, color: MUTED });
  cursor.y -= 4;
}

function drawChannels(cursor: Cursor, report: MonthlyReport): void {
  sectionHeading(cursor, "Per kanal");
  // Kanal | Omzet | Pesanan | Biaya iklan | ROAS | Status
  const columns = [
    { title: "Kanal", width: 92, align: "left" as const },
    { title: "Omzet", width: 96, align: "right" as const },
    { title: "Pesanan", width: 50, align: "right" as const },
    { title: "Biaya iklan", width: 88, align: "right" as const },
    { title: "ROAS", width: 72, align: "right" as const },
    { title: "Status", width: CONTENT_WIDTH - 92 - 96 - 50 - 88 - 72, align: "left" as const },
  ];
  const drawRow = (cells: string[], options: { bold?: boolean; size?: number; colors?: (RGB | undefined)[] }) => {
    let x = MARGIN_X;
    columns.forEach((column, index) => {
      cursor.text(cells[index] ?? "", column.align === "left" ? x + 4 : x, { size: options.size ?? 9, bold: options.bold, color: options.colors?.[index], align: column.align, width: column.width - 6 });
      x += column.width;
    });
  };
  cursor.ensure(18);
  drawRow(columns.map((column) => column.title), { bold: true, size: 8.5, colors: columns.map(() => MUTED) });
  cursor.y -= 6;
  cursor.rule();
  cursor.y -= 12;
  for (const row of channelReportRows(report.summary)) {
    cursor.ensure(16);
    const isTotal = row.key === "total";
    if (isTotal) {
      cursor.y += 4;
      cursor.rule();
      cursor.y -= 12;
    }
    const statusColor = row.status.startsWith("Di atas") ? OLIVE : row.status.startsWith("Di bawah") ? BRICK : MUTED;
    drawRow(
      [row.label, row.omzet === null ? "-" : formatRupiah(row.omzet), row.orders === null ? "-" : formatNumber(row.orders), formatRupiah(row.adSpend), row.roas, row.status],
      { bold: isTotal, colors: [undefined, undefined, undefined, undefined, undefined, statusColor] },
    );
    cursor.y -= 15;
  }
}

function drawNotes(cursor: Cursor, report: MonthlyReport): void {
  sectionHeading(cursor, "Catatan");
  const size = 8.5;
  const lineHeight = 11.5;
  for (const note of reportNotes(report.summary)) {
    const lines = wrapText(cursor.fonts.regular, labelText(note), size, CONTENT_WIDTH - 12, 12);
    cursor.ensure(lines.length * lineHeight + 4);
    lines.forEach((line, index) => {
      if (index === 0) cursor.text("-", MARGIN_X, { size, color: MUTED });
      cursor.text(line, MARGIN_X + 10, { size, color: MUTED });
      cursor.y -= lineHeight;
    });
    cursor.y -= 3;
  }
}

function drawFooters(cursor: Cursor, report: MonthlyReport): void {
  const generated = `Dibuat ${formatDateTime(report.generatedAt)} WIB`;
  cursor.pages.forEach((page, index) => {
    const y = 34;
    page.drawLine({ start: { x: MARGIN_X, y: y + 12 }, end: { x: PAGE_WIDTH - MARGIN_X, y: y + 12 }, thickness: 0.6, color: RULE });
    page.drawText(labelText(`${REPORT_DISCLAIMER} ${generated}.`), { x: MARGIN_X, y, size: 7.5, font: cursor.fonts.regular, color: MUTED });
    const pageLabel = `Halaman ${index + 1} dari ${cursor.pages.length}`;
    page.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN_X - cursor.fonts.regular.widthOfTextAtSize(pageLabel, 7.5), y, size: 7.5, font: cursor.fonts.regular, color: MUTED });
  });
}

/** `today` is the Jakarta date of `report.generatedAt` (for "s.d. <today>" on this month). */
export async function renderMonthlyReportPdf(report: MonthlyReport, today: string, logoPng: Uint8Array | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const title = reportTitle(report.params, today);
  pdf.setTitle(labelText(title));
  pdf.setAuthor("Ammari");
  pdf.setCreator("Ammari Admin");
  pdf.setProducer("Ammari Admin");
  pdf.setCreationDate(report.generatedAt);
  pdf.setModificationDate(report.generatedAt);
  const fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  const logo = logoPng ? await pdf.embedPng(logoPng) : null;
  const cursor = new Cursor(pdf, fonts);
  drawHeader(cursor, report, logo, today);
  drawProfitAndLoss(cursor, report);
  drawChannels(cursor, report);
  drawNotes(cursor, report);
  drawFooters(cursor, report);
  return pdf.save();
}
