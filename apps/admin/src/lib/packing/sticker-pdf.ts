import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";

const MM_TO_PT = 72 / 25.4;
const mm = (value: number) => value * MM_TO_PT;

// OKAY D100 thermal sheet (docs/plans/thermal-stickers.md): 100x120mm, 3 cols x 3 rows, cut by
// hand — exactly 3 * 33.33mm = 100mm and 3 * 40mm = 120mm, no sheet margin at all (stickers tile
// edge to edge; the crop marks below are what a cutter actually follows).
const PAGE_WIDTH_MM = 100;
const PAGE_HEIGHT_MM = 120;
const COLS = 3;
const ROWS = 3;
const PER_SHEET = COLS * ROWS;
const CELL_WIDTH_MM = PAGE_WIDTH_MM / COLS;
const CELL_HEIGHT_MM = PAGE_HEIGHT_MM / ROWS;

const QR_SIZE_MM = 29;
// Standard QR quiet zone is 4 modules — baked INTO the 29mm box (not left to incidental cell
// padding) so the code scans reliably regardless of how close a hand cut lands to the sticker.
const QUIET_ZONE_MODULES = 4;
// A hairline overlap between adjacent module rectangles papers over floating-point rounding that
// would otherwise show as faint white seams between modules in some PDF renderers.
const MODULE_OVERLAP_PT = 0.05;

const CROP_MARK_LENGTH_MM = 2;
const CROP_MARK_THICKNESS_PT = 0.4;

const CODE_MAX_FONT_SIZE_PT = 10;
const CODE_MIN_FONT_SIZE_PT = 5;
const CODE_SIDE_PADDING_MM = 1.5;

export interface StickerPdfCard {
  orderId: string;
  code: string;
  claimUrl: string;
}

/** Draws one sticker's QR (vector rectangles, not an embedded image) inside a `sizePt` square
 * whose bottom-left corner is `(x, y)` in PDF coordinates (origin bottom-left, y up). */
function drawQr(page: PDFPage, claimUrl: string, x: number, y: number, sizePt: number): void {
  const { modules } = QRCode.create(claimUrl, { errorCorrectionLevel: "Q" });
  const moduleCount = modules.size;
  const totalUnits = moduleCount + QUIET_ZONE_MODULES * 2;
  const unitPt = sizePt / totalUnits;

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (!modules.get(row, col)) continue;
      const rectX = x + (QUIET_ZONE_MODULES + col) * unitPt;
      // QR row 0 is the TOP row; PDF y grows upward, so row 0 sits at the top of the box.
      const rectY = y + sizePt - (QUIET_ZONE_MODULES + row + 1) * unitPt;
      page.drawRectangle({
        x: rectX,
        y: rectY,
        width: unitPt + MODULE_OVERLAP_PT,
        height: unitPt + MODULE_OVERLAP_PT,
        color: rgb(0, 0, 0),
      });
    }
  }
}

/** Shrinks `fontSize` until `text` fits `maxWidthPt` on one line (never wraps), down to a hard
 * floor — the owner's "shrink font to fit if needed" rule for the sticker code line. */
function fitFontSize(font: PDFFont, text: string, maxWidthPt: number): number {
  let size = CODE_MAX_FONT_SIZE_PT;
  while (size > CODE_MIN_FONT_SIZE_PT && font.widthOfTextAtSize(text, size) > maxWidthPt) {
    size -= 0.5;
  }
  return size;
}

/** Two short outward... no, INWARD line segments per corner (safely inside the cell's own box,
 * never overlapping a neighboring cell's ink or running off the page edge for an outer cell) —
 * "small corner crop marks per cell for cutting (no full grid lines)." */
function drawCropMarks(page: PDFPage, cellX: number, cellY: number, cellWidthPt: number, cellHeightPt: number): void {
  const len = mm(CROP_MARK_LENGTH_MM);
  const corners = [
    { x: cellX, y: cellY, dx: 1, dy: 1 }, // bottom-left
    { x: cellX + cellWidthPt, y: cellY, dx: -1, dy: 1 }, // bottom-right
    { x: cellX, y: cellY + cellHeightPt, dx: 1, dy: -1 }, // top-left
    { x: cellX + cellWidthPt, y: cellY + cellHeightPt, dx: -1, dy: -1 }, // top-right
  ];
  for (const { x, y, dx, dy } of corners) {
    page.drawLine({ start: { x, y }, end: { x: x + dx * len, y }, thickness: CROP_MARK_THICKNESS_PT, color: rgb(0, 0, 0) });
    page.drawLine({ start: { x, y }, end: { x, y: y + dy * len }, thickness: CROP_MARK_THICKNESS_PT, color: rgb(0, 0, 0) });
  }
}

function drawSticker(page: PDFPage, font: PDFFont, card: StickerPdfCard, indexOnSheet: number): void {
  const col = indexOnSheet % COLS;
  const row = Math.floor(indexOnSheet / COLS);
  const cellWidthPt = mm(CELL_WIDTH_MM);
  const cellHeightPt = mm(CELL_HEIGHT_MM);
  const cellX = col * cellWidthPt;
  // Row 0 is the TOP row of the sheet; PDF y grows upward from the bottom.
  const cellY = mm(PAGE_HEIGHT_MM) - (row + 1) * cellHeightPt;

  drawCropMarks(page, cellX, cellY, cellWidthPt, cellHeightPt);

  const qrSizePt = mm(QR_SIZE_MM);
  const qrX = cellX + (cellWidthPt - qrSizePt) / 2;
  const qrTopMarginPt = mm(1.5);
  const qrY = cellY + cellHeightPt - qrTopMarginPt - qrSizePt;
  drawQr(page, card.claimUrl, qrX, qrY, qrSizePt);

  const maxTextWidthPt = cellWidthPt - mm(CODE_SIDE_PADDING_MM) * 2;
  const fontSize = fitFontSize(font, card.code, maxTextWidthPt);
  const textWidth = font.widthOfTextAtSize(card.code, fontSize);
  const textX = cellX + (cellWidthPt - textWidth) / 2;
  const textY = qrY - mm(5);
  page.drawText(card.code, { x: textX, y: textY, size: fontSize, font, color: rgb(0, 0, 0) });
}

/** Builds the full sheet PDF: one page per 9 cards, left-to-right/top-to-bottom, in the exact
 * order `cards` is given — callers are responsible for that order already matching the
 * selection order on `/packing` (docs/plans/thermal-stickers.md). The last sheet's unused cells
 * are simply left blank (no placeholder marks of any kind). */
export async function buildStickerSheetPdf(cards: StickerPdfCard[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (let sheetStart = 0; sheetStart < cards.length; sheetStart += PER_SHEET) {
    const page = pdf.addPage([mm(PAGE_WIDTH_MM), mm(PAGE_HEIGHT_MM)]);
    const sheetCards = cards.slice(sheetStart, sheetStart + PER_SHEET);
    sheetCards.forEach((card, indexOnSheet) => drawSticker(page, font, card, indexOnSheet));
  }

  return pdf.save();
}

const JAKARTA_PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  // Explicit, not just `hour12: false` — some ICU implementations map that to "h24" (midnight
  // prints as "24:00"), which `hourCycle: "h23"` rules out directly (midnight is always "00").
  hourCycle: "h23",
});

/** "ammari-stiker-2026-10-15-0930.pdf" — Jakarta time (docs/plans/thermal-stickers.md). */
export function stickerPdfFilename(now: Date): string {
  const parts = JAKARTA_PARTS_FORMATTER.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `ammari-stiker-${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}.pdf`;
}
