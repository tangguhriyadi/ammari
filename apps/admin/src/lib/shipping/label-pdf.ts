import "server-only";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont } from "pdf-lib";
import { CODE128_QUIET_ZONE_MODULES, encodeCode128 } from "./code128";

// Our own shipping label (docs/plans/cart-checkout.md §15 Phase K, decision 49): Biteship has no
// label API (its docs: "Biteship does not provide a Shipping Label API") and its dashboard labels
// come only as A6, 4x6 inch or A4. One label per page: a 120 mm wide x 100 mm tall landscape label
// on the same thermal roll as the 100 x 120 mm thank-you stickers (lib/packing/sticker-pdf.ts).
// Contents follow Biteship's label requirements (https://biteship.com/id/docs/shipping_label):
// courier and service, routing code, the waybill as a barcode and as text, sender and recipient,
// weight; plus "NON COD" and our order number. Indonesian text, never the shipping provider's
// name. Built from draw operations (`layoutShippingLabel`) so the layout is testable without
// parsing a PDF.
//
// Page: portrait 100 x 120 mm, exactly the sticker PDF's page (and the roll's own size), with the
// landscape label drawn turned 90 degrees clockwise inside it (`toPageOp`): the label's left edge
// runs along the page's top edge, its top along the page's right edge. A landscape page made the
// printer driver turn and shift it onto the portrait roll (first real print: ~2-3 mm cut off the
// label's left edge and the print running over the gap into the next sticker); a portrait page
// with no /Rotate leaves the driver nothing to turn. Everything (text with its ascenders and
// descenders, lines, the barcode with its quiet zones) stays at least `SAFE_MARGIN_MM` from every
// edge of the sticker.
//
// Barcode (Code 128, ./code128.ts): every module is a whole number of printer dots at 203 dpi
// (0.125 mm), as wide as fits (4, 3 or 2 dots: 0.5, 0.375 or 0.25 mm, all far above the 0.19 mm a
// phone camera needs at arm's length), with a quiet zone of at least 10 modules on both sides and
// 16 mm tall bars. The bars run across the page, so their widths lie along the paper feed; bar
// edges are placed on the dot grid measured from the label's left edge, which is the page's top
// edge (where the printer's first dot row is), so a driver printing at 100% (never "fit to page")
// renders every bar the same width.

const MM_TO_PT = 72 / 25.4;
const mm = (value: number) => value * MM_TO_PT;

/** The label as read: landscape. Layout coordinates (`LabelOp`) are in this frame. */
export const LABEL_WIDTH_MM = 120;
export const LABEL_HEIGHT_MM = 100;
/** The PDF page: portrait, the sticker roll's own 100 x 120 mm (lib/packing/sticker-pdf.ts). */
export const PAGE_WIDTH_MM = LABEL_HEIGHT_MM;
export const PAGE_HEIGHT_MM = LABEL_WIDTH_MM;
/** Text and lines start this far in from the label's edges... */
const MARGIN_MM = 4;
/** ...so that no ink at all (ascenders, descenders, quiet zones included) is closer than this. */
export const SAFE_MARGIN_MM = 3;
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

/** In PDF points in the label's own landscape frame (origin bottom-left of the label as read). */
export type LabelOp =
  | { kind: "text"; text: string; x: number; y: number; size: number; bold: boolean }
  | { kind: "bar"; x: number; y: number; width: number; height: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; thickness: number };

/** A `LabelOp` on the portrait page (PDF points, origin bottom-left of the page). Text is drawn
 * rotated 90 degrees clockwise about its baseline start (x, y), so it runs down the page. */
export type PageOp =
  | { kind: "text"; text: string; x: number; y: number; size: number; bold: boolean; rotateDegrees: -90 }
  | { kind: "bar"; x: number; y: number; width: number; height: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; thickness: number };

/** Turns the landscape label 90 degrees clockwise onto the portrait page: label (x, y) is page
 * (y, pageHeight - x). The label's left edge becomes the page's top edge, its bottom the page's
 * left edge; a bar's width (along the label) becomes a height (along the paper feed). */
export function toPageOp(op: LabelOp): PageOp {
  const pageHeight = mm(PAGE_HEIGHT_MM);
  if (op.kind === "text") return { ...op, x: op.y, y: pageHeight - op.x, rotateDegrees: -90 };
  if (op.kind === "bar") return { kind: "bar", x: op.y, y: pageHeight - op.x - op.width, width: op.height, height: op.width };
  return { kind: "line", x1: op.y1, y1: pageHeight - op.x1, x2: op.y2, y2: pageHeight - op.x2, thickness: op.thickness };
}

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
  /** Left edge of the first bar, mm from the label's left edge (the page's top edge), on the dot
   * grid. */
  firstBarMm: number;
  /** Each bar as [left, width] in mm from the label's left edge, on the dot grid. */
  bars: Array<[number, number]>;
  quietZoneModules: number;
}

/** Fits the waybill's Code 128 into `availableMm` (quiet zones included), centred along the
 * label's width, on the printer's dot grid. */
export function planBarcode(text: string, availableMm = LABEL_WIDTH_MM - MARGIN_MM * 2): BarcodePlan {
  if (!BARCODE_WAYBILL.test(text)) throw new LabelBarcodeError("invalid");
  const code = encodeCode128(text);
  const totalModules = code.modules + CODE128_QUIET_ZONE_MODULES * 2;
  const availableDots = Math.floor(availableMm / PRINTER_DOT_MM);
  const moduleDots = MODULE_DOT_CHOICES.find((dots) => totalModules * dots <= availableDots);
  if (moduleDots === undefined) throw new LabelBarcodeError("too_long");

  const labelDots = Math.floor(LABEL_WIDTH_MM / PRINTER_DOT_MM);
  const startDot = Math.floor((labelDots - totalModules * moduleDots) / 2);
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

interface PlacedLine {
  text: string;
  /** Baseline, mm below the label's top edge. */
  baselineMm: number;
  size: number;
  bold: boolean;
}

/** Point sizes for the recipient's name, phone and address (street and area), largest first. The
 * whole recipient always prints: a long name or address shrinks the block (down to 5 pt for a
 * 500-character address, the order form's limit) instead of being cut. */
const RECIPIENT_STYLES: ReadonlyArray<{ name: number; phone: number; address: number }> = [
  { name: 11, phone: 9, address: 8 },
  { name: 11, phone: 9, address: 7.5 },
  { name: 10, phone: 9, address: 7 },
  { name: 10, phone: 8, address: 6.5 },
  { name: 9, phone: 8, address: 6 },
  { name: 9, phone: 8, address: 5.5 },
  { name: 8, phone: 7, address: 5 },
];
/** Baseline of "PENERIMA"; the recipient's lines follow it. */
const RECIPIENT_TOP_MM = 48.5;
/** No ink below this (the footer line is at 87 mm). */
const RECIPIENT_BOTTOM_MM = 86;
const LINE_ADVANCE = 1.3;
const GROUP_GAP_MM = 0.5;

const ptToMm = (value: number) => value / MM_TO_PT;

/** The recipient column's lines: name, phone, street address, area, at the largest sizes where all
 * of it fits. Only text longer than the order form allows can still be cut (then `cuts` says so). */
function layoutRecipient(
  fields: { name: string; phone: string; address: string; area: string },
  fonts: LabelFonts,
  widthPt: number,
): { lines: PlacedLine[]; cuts: LabelWarning[] } {
  type Group = { lines: string[]; size: number; bold: boolean };
  const all = Number.MAX_SAFE_INTEGER;
  const place = (groups: Group[]) => {
    const placed: PlacedLine[] = [];
    let baseline = RECIPIENT_TOP_MM;
    groups.forEach((group, groupIndex) => {
      group.lines.forEach((line, lineIndex) => {
        // A little air before the phone and before the street address; the area follows the street.
        const gap = lineIndex === 0 && (groupIndex === 1 || groupIndex === 2) ? GROUP_GAP_MM : 0;
        baseline += ptToMm(group.size * LINE_ADVANCE) + gap;
        placed.push({ text: line, baselineMm: baseline, size: group.size, bold: group.bold });
      });
    });
    return placed;
  };
  const fits = (placed: PlacedLine[]) => {
    const last = placed.at(-1);
    if (!last) return true;
    const font = last.bold ? fonts.bold : fonts.regular;
    const descent = font.heightAtSize(last.size) - font.heightAtSize(last.size, { descender: false });
    return last.baselineMm + ptToMm(descent) <= RECIPIENT_BOTTOM_MM;
  };
  const groups = (style: (typeof RECIPIENT_STYLES)[number], name: string[], address: string[], area: string[]): Group[] => [
    { lines: name, size: style.name, bold: true },
    { lines: [fields.phone], size: style.phone, bold: false },
    { lines: address, size: style.address, bold: false },
    { lines: area, size: style.address, bold: true },
  ];
  const wrap = (value: string, font: PDFFont, size: number, maxLines = all) => (value ? wrapText(font, value, size, widthPt, maxLines) : []);

  for (const style of RECIPIENT_STYLES) {
    const placed = place(
      groups(style, wrap(fields.name, fonts.bold, style.name), wrap(fields.address, fonts.regular, style.address), wrap(fields.area, fonts.bold, style.address)),
    );
    if (fits(placed)) return { lines: placed, cuts: [] };
  }

  // Past the order form's limits only: the smallest sizes, name and area in at most 2 lines each,
  // the street address in as many lines as still fit.
  const style = RECIPIENT_STYLES.at(-1)!;
  const cuts: LabelWarning[] = [];
  const name = wrap(fields.name, fonts.bold, style.name, 2);
  if (wrap(fields.name, fonts.bold, style.name, 3).length > 2) cuts.push("recipient_name_cut");
  const area = wrap(fields.area, fonts.bold, style.address, 2);
  if (wrap(fields.area, fonts.bold, style.address, 3).length > 2) cuts.push("recipient_area_cut");
  const addressLines = wrap(fields.address, fonts.regular, style.address).length;
  for (let keep = addressLines; keep > 1; keep -= 1) {
    const placed = place(groups(style, name, wrap(fields.address, fonts.regular, style.address, keep), area));
    if (fits(placed)) return { lines: placed, cuts: keep < addressLines ? [...cuts, "recipient_address_cut"] : cuts };
  }
  const lines = place(groups(style, name, wrap(fields.address, fonts.regular, style.address, 1), area));
  return { lines, cuts: addressLines > 1 ? [...cuts, "recipient_address_cut"] : cuts };
}

export interface LabelLayout {
  ops: LabelOp[];
  /** Empty when the label shows every field exactly. */
  warnings: LabelWarning[];
}

/** Every draw operation of one label, in PDF points in the label's landscape frame (origin
 * bottom-left; `toPageOp` puts them on the page), and what had to be cut or replaced to fit. Throws `LabelBarcodeError` for a waybill we cannot encode exactly, a RangeError
 * for a weight or piece count that is not a positive whole number. */
export function layoutShippingLabel(data: ShippingLabelData, fonts: LabelFonts): LabelLayout {
  if (!Number.isSafeInteger(data.pieces) || data.pieces <= 0) throw new RangeError("label pieces must be a positive whole number");
  const weight = formatLabelWeight(data.weightGrams);
  const plan = planBarcode(data.waybill);
  const ops: LabelOp[] = [];
  const warnings = new Set<LabelWarning>();
  const labelWidth = mm(LABEL_WIDTH_MM);
  const labelHeight = mm(LABEL_HEIGHT_MM);
  /** Baseline `fromTopMm` below the label's top edge. */
  const y = (fromTopMm: number) => labelHeight - mm(fromTopMm);
  const left = mm(MARGIN_MM);
  const right = labelWidth - mm(MARGIN_MM);

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
  text(data.waybill, (labelWidth - fonts.bold.widthOfTextAtSize(data.waybill, waybillSize)) / 2, BARCODE_TOP_MM + BARCODE_HEIGHT_MM + 5, waybillSize, true);
  hLine(44);

  // Recipient (left, wide) and sender (right, narrow).
  const columnSplit = mm(80);
  ops.push({ kind: "line", x1: columnSplit, y1: y(44), x2: columnSplit, y2: y(87), thickness: 0.8 });
  const recipientWidth = columnSplit - left - mm(2);
  text("PENERIMA", left, 48.5, 7, true);
  const recipient = layoutRecipient(
    {
      name: clean(data.recipient.name),
      phone: localPhone(data.recipient.phone),
      address: clean(data.recipient.address),
      area: data.recipient.areaLine ? clean(data.recipient.areaLine) : "",
    },
    fonts,
    recipientWidth,
  );
  for (const line of recipient.lines) text(line.text, left, line.baselineMm, line.size, line.bold);
  for (const cut of recipient.cuts) warnings.add(cut);

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

/** One portrait 100 x 120 mm page per label (the label turned onto it), in the order given. */
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
    const page = pdf.addPage([mm(PAGE_WIDTH_MM), mm(PAGE_HEIGHT_MM)]);
    for (const op of layout.ops.map(toPageOp)) {
      if (op.kind === "text") {
        page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: op.bold ? fonts.bold : fonts.regular, color: rgb(0, 0, 0), rotate: degrees(op.rotateDegrees) });
      }
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
