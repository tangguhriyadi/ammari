import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { CODE128_QUIET_ZONE_MODULES, encodeCode128 } from "./code128";

// Our own shipping label (docs/plans/cart-checkout.md §15 Phase K, decision 49): Biteship has no
// label API (its docs: "Biteship does not provide a Shipping Label API") and its dashboard labels
// come only as A6, 4x6 inch or A4. One label per page, 120 mm wide x 100 mm tall: the same thermal
// roll as the 100 x 120 mm thank-you stickers (lib/packing/sticker-pdf.ts), used landscape.
// Contents follow Biteship's label requirements (https://biteship.com/id/docs/shipping_label):
// courier and service, routing code, the waybill as a barcode and as text, sender and recipient,
// weight; plus "NON COD" and our order number. Indonesian text, never the shipping provider's
// name. Built from draw operations (`layoutShippingLabel`) so the layout is testable without
// parsing a PDF.
//
// Barcode (Code 128, ./code128.ts): every module is a whole number of printer dots at 203 dpi
// (0.125 mm), as wide as fits (4, 3 or 2 dots: 0.5, 0.375 or 0.25 mm, all far above the 0.19 mm a
// phone camera needs at arm's length), with a quiet zone of at least 10 modules on both sides and
// 16 mm tall bars. Bar edges are placed on the dot grid measured from the page edge, so a driver
// printing at 100% (never "fit to page") renders every bar the same width.

const MM_TO_PT = 72 / 25.4;
const mm = (value: number) => value * MM_TO_PT;

export const LABEL_WIDTH_MM = 120;
export const LABEL_HEIGHT_MM = 100;
const MARGIN_MM = 4;
const PRINTER_DPI = 203;
export const PRINTER_DOT_MM = 25.4 / PRINTER_DPI;
/** Widest first: the widest module that still fits gives the easiest scan. */
const MODULE_DOT_CHOICES = [4, 3, 2] as const;
export const BARCODE_HEIGHT_MM = 16;
const BARCODE_TOP_MM = 20;

export interface ShippingLabelParty {
  name: string;
  /** E.164 `+62...`, printed as `08...`. */
  phone: string;
  /** Street line (recipient: jalan, nomor rumah, RT/RW, kelurahan). */
  address: string;
  /** Recipient only: "Kecamatan, Kota, Provinsi 12345". */
  areaLine?: string | null;
}

export interface ShippingLabelData {
  orderNo: string;
  /** The order's locked service label, e.g. "JNE Reguler". */
  courierLabel: string;
  waybill: string;
  /** Biteship `courier.routing_code` when the courier gives one. */
  routingCode: string | null;
  weightGrams: number;
  pieces: number;
  sender: ShippingLabelParty;
  recipient: ShippingLabelParty;
  /** The buyer's note for the courier. */
  note: string | null;
}

export type LabelOp =
  | { kind: "text"; text: string; x: number; y: number; size: number; bold: boolean }
  | { kind: "bar"; x: number; y: number; width: number; height: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; thickness: number };

export interface LabelFonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** Every reason the waybill cannot be printed as a barcode on our label: `invalid` (not 1 to 40
 * printable ASCII characters without spaces: the barcode must encode the waybill exactly, never a
 * cleaned-up copy) or `too_long` (even 2-dot modules do not fit 120 mm). Either way staff print
 * Biteship's own label from its dashboard instead. */
export class LabelBarcodeError extends Error {
  readonly reason: "invalid" | "too_long";
  constructor(reason: "invalid" | "too_long") {
    super(reason === "invalid" ? "waybill cannot be encoded exactly as a barcode" : "waybill too long for a scannable barcode on a 120 mm label");
    this.name = "LabelBarcodeError";
    this.reason = reason;
  }
}

/** What a waybill must be for our barcode: the resi rule's characters and more, never a space. */
const BARCODE_WAYBILL = /^[\x21-\x7e]{1,40}$/;

/** Something on the label is not exactly what the order says; the UI shows it before printing. */
export type LabelWarning =
  | "characters_replaced"
  | "recipient_name_cut"
  | "recipient_address_cut"
  | "recipient_area_cut"
  | "sender_cut"
  | "note_cut";

export interface BarcodePlan {
  moduleDots: number;
  /** In mm, quiet zones included. */
  totalWidthMm: number;
  /** Left edge of the first bar, mm from the page's left edge, on the dot grid. */
  firstBarMm: number;
  /** Each bar as [left, width] in mm, on the dot grid. */
  bars: Array<[number, number]>;
  quietZoneModules: number;
}

/** Fits the waybill's Code 128 into `availableMm` (quiet zones included), centred on the page, on
 * the printer's dot grid. */
export function planBarcode(text: string, availableMm = LABEL_WIDTH_MM - MARGIN_MM * 2): BarcodePlan {
  if (!BARCODE_WAYBILL.test(text)) throw new LabelBarcodeError("invalid");
  const code = encodeCode128(text);
  const totalModules = code.modules + CODE128_QUIET_ZONE_MODULES * 2;
  const availableDots = Math.floor(availableMm / PRINTER_DOT_MM);
  const moduleDots = MODULE_DOT_CHOICES.find((dots) => totalModules * dots <= availableDots);
  if (moduleDots === undefined) throw new LabelBarcodeError("too_long");

  const pageDots = Math.floor(LABEL_WIDTH_MM / PRINTER_DOT_MM);
  const startDot = Math.floor((pageDots - totalModules * moduleDots) / 2);
  const bars: Array<[number, number]> = [];
  let dot = startDot + CODE128_QUIET_ZONE_MODULES * moduleDots;
  code.widths.forEach((width, index) => {
    const widthDots = width * moduleDots;
    if (index % 2 === 0) bars.push([dot * PRINTER_DOT_MM, widthDots * PRINTER_DOT_MM]);
    dot += widthDots;
  });
  return {
    moduleDots,
    totalWidthMm: totalModules * moduleDots * PRINTER_DOT_MM,
    firstBarMm: bars[0]![0],
    bars,
    quietZoneModules: CODE128_QUIET_ZONE_MODULES,
  };
}

/** Typographic punctuation phones insert (iOS smart quotes in "Ma\u2019ruf") as plain ASCII. */
const PUNCTUATION: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201b": "'",
  "\u02bc": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u201e": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u2026": "...",
};

const LABEL_TEXT_MAX = 500;

/** Text the standard PDF fonts can draw (WinAnsi) on one line, capped: Latin-1 kept, typographic
 * punctuation as ASCII, invisible characters dropped, accents stripped where that leaves ASCII,
 * anything else (emoji, other scripts) "?" with `replaced` set so the UI can warn. */
export function labelTextInfo(value: string): { text: string; replaced: boolean } {
  let replaced = false;
  const text = [...value.normalize("NFC").replace(/[\p{Cf}]/gu, "").replace(/[\p{Cc}\s]+/gu, " ").trim()]
    .map((char) => {
      const code = char.codePointAt(0)!;
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return char;
      if (PUNCTUATION[char]) return PUNCTUATION[char];
      const stripped = char.normalize("NFKD").replace(/\p{M}/gu, "");
      if (stripped.length > 0 && [...stripped].every((c) => c.codePointAt(0)! >= 0x20 && c.codePointAt(0)! <= 0x7e)) return stripped;
      replaced = true;
      return "?";
    })
    .join("");
  return { text: text.length > LABEL_TEXT_MAX ? text.slice(0, LABEL_TEXT_MAX) : text, replaced };
}

export function labelText(value: string): string {
  return labelTextInfo(value).text;
}

/** Up to `maxLines` lines no wider than `widthPt`; the last line ends with "..." when cut. Words
 * longer than a line are split. */
export function wrapText(font: PDFFont, text: string, size: number, widthPt: number, maxLines: number): string[] {
  if (!(widthPt > 0) || maxLines < 1) throw new RangeError("wrapText needs a positive width and at least one line");
  const fits = (line: string) => font.widthOfTextAtSize(line, size) <= widthPt;
  const lines: string[] = [];
  let current = "";
  const words = text.split(" ").filter((word) => word.length > 0);
  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    let word = words[wordIndex]!;
    const candidate = current ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    while (!fits(word)) {
      let cut = word.length - 1;
      while (cut > 1 && !fits(word.slice(0, cut))) cut -= 1;
      // At least one character per line, even in a column too narrow for it: never loops forever.
      cut = Math.max(cut, 1);
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    current = word;
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1]!;
  while (last.length > 0 && !fits(`${last}...`)) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = `${last}...`;
  return kept;
}

function localPhone(e164: string): string {
  return /^\+62[0-9]{8,13}$/.test(e164) ? `0${e164.slice(3)}` : labelText(e164);
}

const WEIGHT_FORMAT = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: 1 });

export function formatLabelWeight(grams: number): string {
  if (!Number.isSafeInteger(grams) || grams <= 0) throw new RangeError("label weight must be a positive whole number of grams");
  return `${WEIGHT_FORMAT.format(grams / 1000)} kg`;
}

export interface LabelLayout {
  ops: LabelOp[];
  /** Empty when the label shows every field exactly. */
  warnings: LabelWarning[];
}

/** Every draw operation of one label, in PDF points (origin bottom-left), and what had to be cut or
 * replaced to fit. Throws `LabelBarcodeError` for a waybill we cannot encode exactly, a RangeError
 * for a weight or piece count that is not a positive whole number. */
export function layoutShippingLabel(data: ShippingLabelData, fonts: LabelFonts): LabelLayout {
  if (!Number.isSafeInteger(data.pieces) || data.pieces <= 0) throw new RangeError("label pieces must be a positive whole number");
  const weight = formatLabelWeight(data.weightGrams);
  const plan = planBarcode(data.waybill);
  const ops: LabelOp[] = [];
  const warnings = new Set<LabelWarning>();
  const pageWidth = mm(LABEL_WIDTH_MM);
  const pageHeight = mm(LABEL_HEIGHT_MM);
  /** Baseline `fromTopMm` below the top edge. */
  const y = (fromTopMm: number) => pageHeight - mm(fromTopMm);
  const left = mm(MARGIN_MM);
  const right = pageWidth - mm(MARGIN_MM);

  const clean = (value: string) => {
    const info = labelTextInfo(value);
    if (info.replaced) warnings.add("characters_replaced");
    return info.text;
  };
  const text = (value: string, x: number, fromTopMm: number, size: number, bold = false) => {
    ops.push({ kind: "text", text: value, x, y: y(fromTopMm), size, bold });
  };
  const rightText = (value: string, fromTopMm: number, size: number, bold = false) => {
    const font = bold ? fonts.bold : fonts.regular;
    text(value, right - font.widthOfTextAtSize(value, size), fromTopMm, size, bold);
  };
  /** One line of `value`, cut with "..." when it does not fit (then `cut` is recorded). */
  const fitted = (value: string, font: PDFFont, size: number, widthPt: number, cut?: LabelWarning) => {
    const lines = wrapText(font, value, size, widthPt, 1);
    if (cut && wrapText(font, value, size, widthPt, 2).length > 1) warnings.add(cut);
    return lines[0] ?? "";
  };
  /** Lines of `value` at the first size that fits within its line limit, else the last size cut. */
  const block = (value: string, font: PDFFont, sizes: Array<[number, number, number]>, widthPt: number, cut: LabelWarning) => {
    for (const [size, maxLines, step] of sizes) {
      const lines = wrapText(font, value, size, widthPt, maxLines + 1);
      if (lines.length <= maxLines) return { lines, size, step };
    }
    const [size, maxLines, step] = sizes.at(-1)!;
    warnings.add(cut);
    return { lines: wrapText(font, value, size, widthPt, maxLines), size, step };
  };
  const hLine = (fromTopMm: number) => ops.push({ kind: "line", x1: left, y1: y(fromTopMm), x2: right, y2: y(fromTopMm), thickness: 0.8 });

  // Header: courier and service, routing code, order number, NON COD.
  const routing = data.routingCode ? clean(data.routingCode) : "";
  const routingWidth = routing ? Math.min(fonts.bold.widthOfTextAtSize(routing, 14), mm(50)) + mm(4) : 0;
  text(fitted(clean(data.courierLabel), fonts.bold, 15, right - left - routingWidth), left, 10, 15, true);
  if (routing) rightText(fitted(routing, fonts.bold, 14, mm(50)), 10, 14, true);
  text(`No. pesanan ${clean(data.orderNo)}`, left, 15, 8);
  rightText("NON COD", 15, 9, true);
  hLine(17.5);

  // Barcode and the waybill in text (exactly what the barcode encodes).
  const barBottom = y(BARCODE_TOP_MM + BARCODE_HEIGHT_MM);
  for (const [barLeftMm, barWidthMm] of plan.bars) {
    ops.push({ kind: "bar", x: mm(barLeftMm), y: barBottom, width: mm(barWidthMm), height: mm(BARCODE_HEIGHT_MM) });
  }
  let waybillSize = 13;
  while (waybillSize > 7 && fonts.bold.widthOfTextAtSize(data.waybill, waybillSize) > right - left) waybillSize -= 0.5;
  text(data.waybill, (pageWidth - fonts.bold.widthOfTextAtSize(data.waybill, waybillSize)) / 2, BARCODE_TOP_MM + BARCODE_HEIGHT_MM + 5, waybillSize, true);
  hLine(44);

  // Recipient (left, wide) and sender (right, narrow).
  const columnSplit = mm(80);
  ops.push({ kind: "line", x1: columnSplit, y1: y(44), x2: columnSplit, y2: y(87), thickness: 0.8 });
  const recipientWidth = columnSplit - left - mm(2);
  text("PENERIMA", left, 48.5, 7, true);
  text(fitted(clean(data.recipient.name), fonts.bold, 11, recipientWidth, "recipient_name_cut"), left, 53.5, 11, true);
  text(localPhone(data.recipient.phone), left, 58, 9);
  let line = 62.5;
  // 8 pt in up to 4 lines, else 7 pt in up to 5, before anything is cut.
  const address = block(clean(data.recipient.address), fonts.regular, [[8, 4, 3.6], [7, 5, 3.1]], recipientWidth, "recipient_address_cut");
  for (const part of address.lines) {
    text(part, left, line, address.size);
    line += address.step;
  }
  if (data.recipient.areaLine) {
    const area = block(clean(data.recipient.areaLine), fonts.bold, [[8, 2, 3.6], [7, 2, 3.1]], recipientWidth, "recipient_area_cut");
    for (const part of area.lines) {
      text(part, left, line, area.size, true);
      line += area.step;
    }
  }

  const senderLeft = columnSplit + mm(2);
  const senderWidth = right - senderLeft;
  text("PENGIRIM", senderLeft, 48.5, 7, true);
  text(fitted(clean(data.sender.name), fonts.bold, 9, senderWidth, "sender_cut"), senderLeft, 53, 9, true);
  text(localPhone(data.sender.phone), senderLeft, 57.5, 8);
  let senderLine = 61.5;
  const sender = block(clean(data.sender.address), fonts.regular, [[7, 7, 3.2]], senderWidth, "sender_cut");
  for (const part of sender.lines) {
    text(part, senderLeft, senderLine, 7);
    senderLine += 3.2;
  }
  hLine(87);

  // Footer: weight and contents, the courier note.
  text(`Berat ${weight}   Isi: Pakaian x ${data.pieces}`, left, 91.5, 8, true);
  if (data.note) text(fitted(`Catatan: ${clean(data.note)}`, fonts.regular, 7.5, right - left, "note_cut"), left, 96, 7.5);
  return { ops, warnings: [...warnings] };
}

export interface ShippingLabelPdf {
  pdf: Uint8Array;
  /** Per label (same order as given), what is not shown exactly; empty arrays when all is exact. */
  warnings: LabelWarning[][];
}

/** One page per label, in the order given. */
export async function buildShippingLabelPdf(labels: ShippingLabelData[]): Promise<ShippingLabelPdf> {
  const pdf = await PDFDocument.create();
  const fonts: LabelFonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const warnings: LabelWarning[][] = [];
  for (const label of labels) {
    const layout = layoutShippingLabel(label, fonts);
    warnings.push(layout.warnings);
    const page = pdf.addPage([mm(LABEL_WIDTH_MM), mm(LABEL_HEIGHT_MM)]);
    for (const op of layout.ops) {
      if (op.kind === "text") page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: op.bold ? fonts.bold : fonts.regular, color: rgb(0, 0, 0) });
      else if (op.kind === "bar") page.drawRectangle({ x: op.x, y: op.y, width: op.width, height: op.height, color: rgb(0, 0, 0) });
      else page.drawLine({ start: { x: op.x1, y: op.y1 }, end: { x: op.x2, y: op.y2 }, thickness: op.thickness, color: rgb(0, 0, 0) });
    }
  }
  return { pdf: await pdf.save(), warnings };
}

const JAKARTA_PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "ammari-label-2026-12-02-0930.pdf" (Jakarta time), like the sticker sheets. */
export function shippingLabelPdfFilename(now: Date): string {
  const parts = JAKARTA_PARTS_FORMATTER.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `ammari-label-${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}.pdf`;
}
