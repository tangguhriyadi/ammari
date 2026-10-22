import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, test } from "vitest";
import { decodeCode128, scanlineToWidths } from "../../../test/code128-decode";
import { CODE128_QUIET_ZONE_MODULES, encodeCode128 } from "./code128";
import {
  BARCODE_HEIGHT_MM,
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  LabelBarcodeError,
  PAGE_HEIGHT_MM,
  PAGE_WIDTH_MM,
  PRINTER_DOT_MM,
  SAFE_MARGIN_MM,
  buildShippingLabelPdf,
  formatLabelWeight,
  labelText,
  layoutShippingLabel,
  planBarcode,
  shippingLabelPdfFilename,
  toPageOp,
  wrapText,
  type LabelFonts,
  type LabelOp,
  type PageOp,
  type ShippingLabelData,
} from "./label-pdf";

// docs/plans/cart-checkout.md §15 Phase K, decision 49: our own 120 x 100 mm label, printed on a
// portrait 100 x 120 mm page (the sticker roll) with the label turned 90 degrees inside it.

const MM_TO_PT = 72 / 25.4;

let fonts: LabelFonts;
beforeAll(async () => {
  const doc = await PDFDocument.create();
  fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
});

function label(overrides: Partial<ShippingLabelData> = {}): ShippingLabelData {
  return {
    orderNo: "ORD-202612-0001",
    courierLabel: "JNE Reguler",
    waybill: "0123082100003094",
    routingCode: "BDO-JKT 12250",
    weightGrams: 1_400,
    pieces: 2,
    sender: { name: "Ammari", phone: "+6281200000001", address: "Jalan Contoh No. 1, Kelurahan Contoh, Bandung" },
    recipient: {
      name: "Rina Contoh",
      phone: "+6281200000002",
      address: "Jalan Contoh No. 2, RT 01/RW 02, Kelurahan Contoh",
      areaLine: "Pesanggrahan, Jakarta Selatan, DKI Jakarta 12250",
    },
    note: "Pagar hitam, titip ke satpam",
    ...overrides,
  };
}

/** Space-separated numbered words (`Jalan0 Jalan1 ...`), as many as fit in `maxChars`. */
function words(prefix: string, maxChars: number): string {
  let value = `${prefix}0`;
  for (let index = 1; `${value} ${prefix}${index}`.length <= maxChars; index += 1) value += ` ${prefix}${index}`;
  return value;
}

/** The recipient at the order form's limits (packages/commerce/src/address.ts: name 100, address
 * 500 characters), the longest phone, a long area line and a waybill that needs 2-dot modules. */
function longest(): ShippingLabelData {
  return label({
    waybill: "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF",
    recipient: {
      name: words("Nama", 100),
      phone: "+628123456789012",
      address: words("Jalan", 500),
      areaLine: "Kecamatan Pesanggrahan Selatan, Kota Administrasi Jakarta Selatan, Daerah Khusus Ibukota Jakarta 12250",
    },
  });
}

/** `longest()` plus every other field far too long, so everything that can be cut is. */
function overflowing(): ShippingLabelData {
  return {
    ...longest(),
    sender: { ...label().sender, name: "Nama Pengirim ".repeat(10).trim(), address: "Gang ".repeat(80).trim() },
    note: "Catatan panjang ".repeat(20).trim(),
    courierLabel: "SiCepat Reguler Layanan Dengan Nama Yang Sangat Panjang",
    routingCode: "ROUTING-CODE-YANG-PANJANG-SEKALI-123456",
  };
}

type TextOp = Extract<LabelOp, { kind: "text" }>;
const textOps = (ops: LabelOp[]) => ops.filter((op): op is TextOp => op.kind === "text");
const texts = (ops: LabelOp[]) => textOps(ops).map((op) => op.text);
/** The recipient column's lines in order: name, phone, street address, area. */
function recipientLines(ops: LabelOp[]): string[] {
  const all = texts(ops);
  return all.slice(all.indexOf("PENERIMA") + 1, all.indexOf("PENGIRIM"));
}

const LABEL_W = LABEL_WIDTH_MM * MM_TO_PT;
const LABEL_H = LABEL_HEIGHT_MM * MM_TO_PT;
const PAGE_W = PAGE_WIDTH_MM * MM_TO_PT;
const PAGE_H = PAGE_HEIGHT_MM * MM_TO_PT;
const SAFE = SAFE_MARGIN_MM * MM_TO_PT - 1e-6;

type Box = { left: number; right: number; bottom: number; top: number };

/** Helvetica's and Helvetica-Bold's font boxes (AFM FontBBox, the larger of the two): no glyph,
 * accented capitals included, reaches higher or lower. */
const GLYPH_TOP = 0.962;
const GLYPH_BOTTOM = 0.228;

function textExtent(op: { text: string; size: number; bold: boolean }) {
  return { width: (op.bold ? fonts.bold : fonts.regular).widthOfTextAtSize(op.text, op.size), ascent: op.size * GLYPH_TOP, descent: op.size * GLYPH_BOTTOM };
}

function strokeBox(op: Extract<LabelOp, { kind: "line" }>): Box {
  const half = op.thickness / 2;
  return { left: Math.min(op.x1, op.x2) - half, right: Math.max(op.x1, op.x2) + half, bottom: Math.min(op.y1, op.y2) - half, top: Math.max(op.y1, op.y2) + half };
}

/** Ink box of an op in the label's own frame. */
function labelBox(op: LabelOp): Box {
  if (op.kind === "text") {
    const { width, ascent, descent } = textExtent(op);
    return { left: op.x, right: op.x + width, bottom: op.y - descent, top: op.y + ascent };
  }
  if (op.kind === "bar") return { left: op.x, right: op.x + op.width, bottom: op.y, top: op.y + op.height };
  return strokeBox(op);
}

/** Ink box of an op on the page, worked out from the page op alone: text turned 90 degrees
 * clockwise runs down the page from (x, y) with the tops of its glyphs towards the right. */
function pageBox(op: PageOp): Box {
  if (op.kind === "text") {
    expect(op.rotateDegrees).toBe(-90);
    const { width, ascent, descent } = textExtent(op);
    return { left: op.x - descent, right: op.x + ascent, bottom: op.y - width, top: op.y };
  }
  if (op.kind === "bar") return { left: op.x, right: op.x + op.width, bottom: op.y, top: op.y + op.height };
  return strokeBox(op);
}

function expectInside(box: Box, width: number, height: number) {
  expect(box.left).toBeGreaterThanOrEqual(SAFE);
  expect(box.bottom).toBeGreaterThanOrEqual(SAFE);
  expect(width - box.right).toBeGreaterThanOrEqual(SAFE);
  expect(height - box.top).toBeGreaterThanOrEqual(SAFE);
}

/** 4-dot, 3-dot and 2-dot modules. */
const WAYBILLS = ["0123082100003094", "JP1234567890", "ABCDEFGHIJKLMNOPQRSTUV", "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF"];

/** The barcode's bars as drawn on the page. */
function barOps(waybill: string): Array<Extract<PageOp, { kind: "bar" }>> {
  return layoutShippingLabel(label({ waybill }), fonts)
    .ops.map(toPageOp)
    .filter((op): op is Extract<PageOp, { kind: "bar" }> => op.kind === "bar");
}

const HAS_PDFTOPPM = spawnSync("pdftoppm", ["-v"]).error === undefined;

/** A binary greyscale PGM (P5, 8-bit) as pdftoppm writes it. */
function readPgm(file: Buffer): { width: number; height: number; pixels: Buffer } {
  const header = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(file.subarray(0, 64).toString("latin1"));
  if (!header) throw new Error("not an 8-bit P5 PGM");
  const [width, height] = [Number(header[1]), Number(header[2])];
  return { width, height, pixels: file.subarray(header[0].length, header[0].length + width * height) };
}

/** Whole printer dots, allowing for floating point. */
function isWholeDots(valueMm: number): boolean {
  const dots = valueMm / PRINTER_DOT_MM;
  return Math.abs(dots - Math.round(dots)) < 1e-6;
}

describe("planBarcode", () => {
  test("a 16-digit waybill: the widest module that fits (4 dots = 0.5 mm), quiet zones of 10 modules", () => {
    const plan = planBarcode("0123082100003094");
    expect(plan.moduleDots).toBe(4);
    expect(plan.quietZoneModules).toBe(CODE128_QUIET_ZONE_MODULES);
    expect(plan.totalWidthMm).toBeLessThanOrEqual(LABEL_WIDTH_MM - 8);
  });

  test("bars sit on the 203 dpi dot grid, are whole multiples of the module and leave the quiet zones empty", () => {
    for (const waybill of ["0123082100003094", "JP1234567890", "TKP01-AB-12345678", "ID12345678901234567890X"]) {
      const plan = planBarcode(waybill);
      const moduleMm = plan.moduleDots * PRINTER_DOT_MM;
      const code = encodeCode128(waybill);
      expect(plan.bars).toHaveLength((code.widths.length + 1) / 2);
      for (const [leftMm, widthMm] of plan.bars) {
        expect(isWholeDots(leftMm)).toBe(true);
        expect(isWholeDots(widthMm)).toBe(true);
        const modules = widthMm / moduleMm;
        expect(Math.abs(modules - Math.round(modules))).toBeLessThan(1e-6);
      }
      const first = plan.bars[0]![0];
      const [lastLeft, lastWidth] = plan.bars.at(-1)!;
      const quietMm = CODE128_QUIET_ZONE_MODULES * moduleMm;
      // Quiet zones inside the page's 4 mm margins on both sides.
      expect(first - quietMm).toBeGreaterThanOrEqual(4 - 1e-9);
      expect(lastLeft + lastWidth + quietMm).toBeLessThanOrEqual(LABEL_WIDTH_MM - 4 + 1e-9);
      // The bars span exactly the code's modules.
      expect(lastLeft + lastWidth - first).toBeCloseTo(code.modules * moduleMm, 6);
    }
  });

  test("longer waybills step down to 3 and then 2 dots; past that the label refuses", () => {
    expect(planBarcode("ABCDEFGHIJKLMNOPQRSTUV").moduleDots).toBe(3);
    expect(planBarcode("ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF").moduleDots).toBe(2);
    expect(() => planBarcode("ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMN")).toThrow(expect.objectContaining({ name: "LabelBarcodeError", reason: "too_long" }));
  });

  test.each(["", "AB CD", "AB\u200bCD", "RÉSI123", "A".repeat(41), "AB\nCD"])("a waybill it cannot encode exactly (%j) is refused, never cleaned up", (waybill) => {
    expect(() => planBarcode(waybill)).toThrow(expect.objectContaining({ name: "LabelBarcodeError", reason: "invalid" }));
  });
});

describe("layoutShippingLabel", () => {
  test("carries what the courier needs, in Indonesian, without the shipping provider's name", () => {
    const all = texts(layoutShippingLabel(label(), fonts).ops);
    expect(all).toEqual(
      expect.arrayContaining([
        "JNE Reguler",
        "BDO-JKT 12250",
        "No. pesanan ORD-202612-0001",
        "NON COD",
        "0123082100003094",
        "PENERIMA",
        "Rina Contoh",
        "081200000002",
        "PENGIRIM",
        "Ammari",
        "081200000001",
        "Berat 1,4 kg   Isi: Pakaian x 2",
        "Catatan: Pagar hitam, titip ke satpam",
      ]),
    );
    expect(all.join(" ")).toContain("Pesanggrahan, Jakarta Selatan, DKI Jakarta 12250");
    expect(all.join(" ").toLowerCase()).not.toContain("biteship");
    expect(all.join(" ")).not.toContain("—");
  });

  test.each([
    ["a typical label", label()],
    ["the recipient at its longest", longest()],
    ["every field overflowing", overflowing()],
  ])("%s: all ink at least 3 mm inside the label's edges", (_, data) => {
    for (const op of layoutShippingLabel(data, fonts).ops) expectInside(labelBox(op), LABEL_W, LABEL_H);
  });

  test("fields that may be cut (sender, note, courier) are cut with a warning; the recipient never is", () => {
    expect(layoutShippingLabel(overflowing(), fonts).warnings.sort()).toEqual(["note_cut", "sender_cut"]);
  });

  test("past the order form's limits (a 300-character name) the name is cut to 2 lines with a warning; address and area still print in full", () => {
    const data = longest();
    const layout = layoutShippingLabel({ ...data, recipient: { ...data.recipient, name: "Nama Sangat Panjang ".repeat(15).trim() } }, fonts);
    expect(layout.warnings).toEqual(["recipient_name_cut"]);
    const lines = recipientLines(layout.ops);
    expect(lines[1]).toMatch(/\.\.\.$/);
    expect(lines.join(" ")).toContain(`${data.recipient.address} ${data.recipient.areaLine}`);
    for (const op of layout.ops) expectInside(labelBox(op), LABEL_W, LABEL_H);
  });

  test("smart punctuation from phones prints as ASCII, invisible characters vanish, no warning", () => {
    const layout = layoutShippingLabel(label({ recipient: { ...label().recipient, name: "Ma\u2019ruf \u201cUmi\u201d\u200b" } }), fonts);
    expect(texts(layout.ops)).toContain(`Ma'ruf "Umi"`);
    expect(layout.warnings).toEqual([]);
  });

  test("a typical recipient prints at the largest sizes", () => {
    const sizes = new Map(textOps(layoutShippingLabel(label(), fonts).ops).map((op) => [op.text, op.size]));
    expect(sizes.get("Rina Contoh")).toBe(11);
    expect(sizes.get("081200000002")).toBe(9);
    expect(sizes.get("Jalan Contoh No. 2, RT 01/RW 02, Kelurahan Contoh")).toBe(8);
  });

  test("the recipient is never cut: a 100-character name and a 500-character address (the order form's limits) print in full, smaller", () => {
    const data = longest();
    const layout = layoutShippingLabel(data, fonts);
    expect(layout.warnings).toEqual([]);
    const { name, phone, address, areaLine } = data.recipient;
    expect(recipientLines(layout.ops).join(" ")).toBe(`${name} 0${phone.slice(3)} ${address} ${areaLine}`);
    const addressOp = textOps(layout.ops).find((op) => op.text.startsWith("Jalan0 "))!;
    expect(addressOp.size).toBeLessThan(8);
    expect(addressOp.size).toBeGreaterThanOrEqual(5);
  });

  test("a medium address shrinks before anything else would happen, and never ends with ...", () => {
    const medium = "Jalan Contoh Nomor Dua Belas ".repeat(9).trim();
    const layout = layoutShippingLabel(label({ recipient: { ...label().recipient, address: medium } }), fonts);
    const lines = recipientLines(layout.ops);
    expect(lines.join(" ")).toContain(medium);
    expect(lines.some((line) => line.endsWith("..."))).toBe(false);
    expect(layout.warnings).toEqual([]);
  });

  test("the barcode encodes the waybill exactly and the text under it is the same string, shrunk to fit", () => {
    const wide = "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW";
    const layout = layoutShippingLabel(label({ waybill: wide }), fonts);
    const waybillOp = layout.ops.find((op): op is Extract<LabelOp, { kind: "text" }> => op.kind === "text" && op.text === wide)!;
    expect(waybillOp.size).toBeLessThan(13);
    expect(fonts.bold.widthOfTextAtSize(wide, waybillOp.size)).toBeLessThanOrEqual((LABEL_WIDTH_MM - 8) * MM_TO_PT);
  });

  test("bad numbers are refused, never printed as something else", () => {
    expect(() => layoutShippingLabel(label({ weightGrams: 0 }), fonts)).toThrow(RangeError);
    expect(() => layoutShippingLabel(label({ weightGrams: Number.NaN }), fonts)).toThrow(RangeError);
    expect(() => layoutShippingLabel(label({ pieces: 0 }), fonts)).toThrow(RangeError);
    expect(() => layoutShippingLabel(label({ waybill: "RESI 123" }), fonts)).toThrow(LabelBarcodeError);
  });

  test("no routing code and no note: nothing printed for them", () => {
    const layout = layoutShippingLabel(label({ routingCode: null, note: null }), fonts);
    expect(layout.warnings).toEqual([]);
    const all = texts(layout.ops);
    expect(all.some((line) => line.startsWith("Catatan"))).toBe(false);
    expect(all).not.toContain("BDO-JKT 12250");
  });

  test("text the PDF font cannot draw is replaced, never thrown", async () => {
    const odd = label({ recipient: { ...label().recipient, name: "Siti 😊 Ñañá ٱلله" } });
    const layout = layoutShippingLabel(odd, fonts);
    expect(texts(layout.ops)).toContain("Siti ? Ñañá ????");
    expect(layout.warnings).toEqual(["characters_replaced"]);
    const built = await buildShippingLabelPdf([odd, label()]);
    expect(built.pdf).toBeInstanceOf(Uint8Array);
    expect(built.warnings).toEqual([["characters_replaced"], []]);
  });
});

describe("toPageOp", () => {
  test("turns the label 90 degrees clockwise onto the portrait page: label left edge = page top, label top = page right", () => {
    const mm = (value: number) => value * MM_TO_PT;
    // A bar in the label's bottom-left corner lands in the page's top-left corner, turned.
    const bar = toPageOp({ kind: "bar", x: 0, y: 0, width: mm(10), height: mm(20) });
    expect(bar).toMatchObject({ kind: "bar", x: 0, width: mm(20) });
    if (bar.kind !== "bar") throw new Error("expected a bar");
    expect(bar.y).toBeCloseTo(PAGE_H - mm(10), 9);
    expect(bar.height).toBeCloseTo(mm(10), 9);
    // The label's first header text (4 mm from its left, baseline 10 mm below its top) starts 4 mm
    // below the page's top and 10 mm in from the page's right, running down the page.
    const text = toPageOp({ kind: "text", text: "J&T", x: mm(4), y: LABEL_H - mm(10), size: 15, bold: true });
    if (text.kind !== "text") throw new Error("expected text");
    expect(text.rotateDegrees).toBe(-90);
    expect(text.x).toBeCloseTo(PAGE_W - mm(10), 9);
    expect(text.y).toBeCloseTo(PAGE_H - mm(4), 9);
    const line = toPageOp({ kind: "line", x1: mm(4), y1: mm(50), x2: mm(116), y2: mm(50), thickness: 0.8 });
    expect(line).toMatchObject({ x1: mm(50), x2: mm(50), thickness: 0.8 });
    if (line.kind !== "line") throw new Error("expected a line");
    expect(line.y1).toBeCloseTo(PAGE_H - mm(4), 9);
    expect(line.y2).toBeCloseTo(PAGE_H - mm(116), 9);
  });

  test.each([
    ["a typical label", label()],
    ["the recipient at its longest", longest()],
    ["every field overflowing", overflowing()],
  ])("%s: on the page too, all ink at least 3 mm inside the sticker's edges", (_, data) => {
    for (const op of layoutShippingLabel(data, fonts).ops.map(toPageOp)) expectInside(pageBox(op), PAGE_W, PAGE_H);
  });

  test.each(WAYBILLS)("%s: bar edges on the 203 dpi dot grid counted from the page's top edge (the printer's first dot row), quiet zones inside the margin", (waybill) => {
    const plan = planBarcode(waybill);
    const bars = barOps(waybill);
    for (const bar of bars) {
      // Bars run across the page: their 16 mm length is the page op's width.
      expect(bar.width).toBeCloseTo(BARCODE_HEIGHT_MM * MM_TO_PT, 6);
      expect(isWholeDots((PAGE_H - bar.y - bar.height) / MM_TO_PT)).toBe(true);
      expect(isWholeDots(bar.height / MM_TO_PT)).toBe(true);
    }
    const quietPt = plan.quietZoneModules * plan.moduleDots * PRINTER_DOT_MM * MM_TO_PT;
    const top = Math.max(...bars.map((bar) => bar.y + bar.height));
    const bottom = Math.min(...bars.map((bar) => bar.y));
    expect(PAGE_H - top - quietPt).toBeGreaterThanOrEqual(SAFE);
    expect(bottom - quietPt).toBeGreaterThanOrEqual(SAFE);
  });

  test.each(WAYBILLS)("%s: rasterised at 203 dpi, a scan down the page across the bars decodes to the waybill", (waybill) => {
    const plan = planBarcode(waybill);
    const bars = barOps(waybill);
    const columnX = bars[0]!.x + bars[0]!.width / 2;
    const rows = Math.ceil(PAGE_HEIGHT_MM / PRINTER_DOT_MM);
    // Each printer dot is black when its centre is inside a bar: the dots counted from the top edge.
    const scanline = Array.from({ length: rows }, (_, row) => {
      const y = PAGE_H - (row + 0.5) * PRINTER_DOT_MM * MM_TO_PT;
      return bars.some((bar) => columnX >= bar.x && columnX <= bar.x + bar.width && y >= bar.y && y <= bar.y + bar.height);
    });
    expect(decodeCode128(scanlineToWidths(scanline, plan.moduleDots)).text).toBe(waybill);
    // Quiet zone and the 3 mm margin above the first bar and below the last are blank.
    const blank = plan.quietZoneModules * plan.moduleDots + Math.floor(SAFE_MARGIN_MM / PRINTER_DOT_MM);
    expect(scanline.indexOf(true)).toBeGreaterThanOrEqual(blank);
    expect(rows - 1 - scanline.lastIndexOf(true)).toBeGreaterThanOrEqual(blank);
  });
});

describe("buildShippingLabelPdf", () => {
  test("one portrait 100 x 120 mm page per label (the sticker PDF's page), never a /Rotate for the driver to act on", async () => {
    const doc = await PDFDocument.load((await buildShippingLabelPdf([label(), label({ orderNo: "ORD-202612-0002" })])).pdf);
    expect(doc.getPageCount()).toBe(2);
    expect([PAGE_WIDTH_MM, PAGE_HEIGHT_MM]).toEqual([100, 120]);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      expect(width).toBeCloseTo(PAGE_WIDTH_MM * MM_TO_PT, 1);
      expect(height).toBeCloseTo(PAGE_HEIGHT_MM * MM_TO_PT, 1);
      expect(page.getRotation().angle).toBe(0);
    }
  });

  // The real PDF through a real rasteriser (poppler's pdftoppm, without anti-aliasing like a thermal
  // head) at 203 dpi. Skipped where poppler is not installed (no new package for it).
  test.skipIf(!HAS_PDFTOPPM).each([
    ["a typical label", label()],
    ["every field overflowing", overflowing()],
  ])("%s: rasterised at 203 dpi by pdftoppm: portrait, ink 3 mm clear of every edge, the barcode decodes", async (_, data) => {
    const dir = await mkdtemp(join(tmpdir(), "ammari-label-"));
    try {
      await writeFile(join(dir, "label.pdf"), (await buildShippingLabelPdf([data])).pdf);
      execFileSync("pdftoppm", ["-r", "203", "-gray", "-aa", "no", "-aaVector", "no", "-singlefile", join(dir, "label.pdf"), join(dir, "label")]);
      const image = readPgm(await readFile(join(dir, "label.pgm")));
      expect(image.width).toBeCloseTo(PAGE_WIDTH_MM / PRINTER_DOT_MM, -0.5);
      expect(image.height).toBeCloseTo(PAGE_HEIGHT_MM / PRINTER_DOT_MM, -0.5);

      const black = (x: number, y: number) => image.pixels[y * image.width + x]! < 128;
      let [minX, minY, maxX, maxY] = [image.width, image.height, -1, -1];
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          if (!black(x, y)) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      const marginDots = Math.floor(SAFE_MARGIN_MM / PRINTER_DOT_MM);
      expect(minX).toBeGreaterThanOrEqual(marginDots);
      expect(minY).toBeGreaterThanOrEqual(marginDots);
      expect(image.width - 1 - maxX).toBeGreaterThanOrEqual(marginDots);
      expect(image.height - 1 - maxY).toBeGreaterThanOrEqual(marginDots);

      // A scan down the page through the middle of the bars: nothing else is drawn along it.
      const bar = barOps(data.waybill)[0]!;
      const column = Math.floor((bar.x + bar.width / 2) / MM_TO_PT / PRINTER_DOT_MM);
      const scanline = Array.from({ length: image.height }, (_, y) => black(column, y));
      expect(decodeCode128(scanlineToWidths(scanline, planBarcode(data.waybill).moduleDots)).text).toBe(data.waybill);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  test("labelText keeps Latin-1, strips other marks, replaces the rest, one line", () => {
    expect(labelText("  Jl. Merdeka\nNo. 5\t ")).toBe("Jl. Merdeka No. 5");
    expect(labelText("Nguyễn")).toBe("Nguyen");
    expect(labelText("Ł")).toBe("?");
    expect(labelText("x".repeat(600))).toHaveLength(500);
    expect(labelText("Café")).toBe("Café");
    expect(labelText("中")).toBe("?");
  });

  test("wrapText never loops on a column narrower than one character, and refuses no width", () => {
    expect(wrapText(fonts.regular, "WWW", 8, 1, 5)).toEqual(["W", "W", "W"]);
    expect(() => wrapText(fonts.regular, "abc", 8, 0, 1)).toThrow(RangeError);
  });

  test("wrapText splits words longer than a line", () => {
    const lines = wrapText(fonts.regular, "A".repeat(200), 8, 50, 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(fonts.regular.widthOfTextAtSize(line, 8)).toBeLessThanOrEqual(50);
  });

  test("weights in Indonesian kilograms", () => {
    expect(formatLabelWeight(1_400)).toBe("1,4 kg");
    expect(formatLabelWeight(900)).toBe("0,9 kg");
    expect(formatLabelWeight(2_000)).toBe("2 kg");
    expect(() => formatLabelWeight(-1)).toThrow(RangeError);
  });

  test("filename in Jakarta time", () => {
    expect(shippingLabelPdfFilename(new Date("2026-12-02T02:30:00.000Z"))).toBe("ammari-label-2026-12-02-0930.pdf");
  });
});
