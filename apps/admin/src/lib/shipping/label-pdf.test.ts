import { PDFDocument, StandardFonts } from "pdf-lib";
import { beforeAll, describe, expect, test } from "vitest";
import { CODE128_QUIET_ZONE_MODULES, encodeCode128 } from "./code128";
import {
  BARCODE_HEIGHT_MM,
  LABEL_HEIGHT_MM,
  LABEL_WIDTH_MM,
  LabelBarcodeError,
  PRINTER_DOT_MM,
  buildShippingLabelPdf,
  formatLabelWeight,
  labelText,
  layoutShippingLabel,
  planBarcode,
  shippingLabelPdfFilename,
  wrapText,
  type LabelFonts,
  type LabelOp,
  type ShippingLabelData,
} from "./label-pdf";

// docs/plans/cart-checkout.md §15 Phase K, decision 49: our own 120 x 100 mm label.

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

const texts = (ops: LabelOp[]) => ops.filter((op): op is Extract<LabelOp, { kind: "text" }> => op.kind === "text").map((op) => op.text);

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

  test("everything is drawn inside the page; text inside the 4 mm margins", () => {
    const width = LABEL_WIDTH_MM * MM_TO_PT;
    const height = LABEL_HEIGHT_MM * MM_TO_PT;
    const margin = 4 * MM_TO_PT - 1e-6;
    const long = label({
      recipient: { ...label().recipient, name: "Nama Penerima Yang Sangat Panjang Sekali Melebihi Lebar Kolom", address: "Jalan ".repeat(60) },
      sender: { ...label().sender, address: "Gang ".repeat(80) },
      note: "Catatan panjang ".repeat(20),
      courierLabel: "SiCepat Reguler Layanan Dengan Nama Yang Sangat Panjang",
      routingCode: "ROUTING-CODE-YANG-PANJANG-SEKALI-123456",
    });
    const layout = layoutShippingLabel(long, fonts);
    expect(layout.warnings).toEqual(expect.arrayContaining(["recipient_name_cut", "recipient_address_cut", "sender_cut", "note_cut"]));
    for (const op of layout.ops) {
      if (op.kind === "text") {
        const font = op.bold ? fonts.bold : fonts.regular;
        expect(op.x).toBeGreaterThanOrEqual(margin);
        expect(op.x + font.widthOfTextAtSize(op.text, op.size)).toBeLessThanOrEqual(width - margin + 1e-6);
        expect(op.y).toBeGreaterThan(0);
        expect(op.y + op.size).toBeLessThanOrEqual(height);
      } else if (op.kind === "bar") {
        expect(op.x).toBeGreaterThanOrEqual(0);
        expect(op.x + op.width).toBeLessThanOrEqual(width);
        expect(op.height).toBeCloseTo(BARCODE_HEIGHT_MM * MM_TO_PT, 6);
      }
    }
  });

  test("an address too long even at 7 pt: at most 5 lines, the last ends with ..., and a warning", () => {
    const layout = layoutShippingLabel(label({ recipient: { ...label().recipient, address: "Jalan Panjang Sekali ".repeat(30) } }), fonts);
    const addressLines = texts(layout.ops).filter((line) => line.startsWith("Jalan Panjang") || line.startsWith("Sekali") || line.startsWith("Panjang"));
    expect(addressLines.length).toBeLessThanOrEqual(5);
    expect(addressLines.at(-1)).toMatch(/\.\.\.$/);
    expect(layout.warnings).toContain("recipient_address_cut");
  });

  test("smart punctuation from phones prints as ASCII, invisible characters vanish, no warning", () => {
    const layout = layoutShippingLabel(label({ recipient: { ...label().recipient, name: "Ma\u2019ruf \u201cUmi\u201d\u200b" } }), fonts);
    expect(texts(layout.ops)).toContain(`Ma'ruf "Umi"`);
    expect(layout.warnings).toEqual([]);
  });

  test("a long address first drops to 7 pt in 5 lines before anything is cut", () => {
    const medium = "Jalan Contoh Nomor Dua Belas ".repeat(9).trim();
    const layout = layoutShippingLabel(label({ recipient: { ...label().recipient, address: medium } }), fonts);
    const addressOps = layout.ops.filter((op): op is Extract<LabelOp, { kind: "text" }> => op.kind === "text" && op.text.includes("Contoh Nomor"));
    expect(addressOps.length).toBeGreaterThan(4);
    expect(addressOps.every((op) => op.size === 7)).toBe(true);
    expect(layout.warnings).not.toContain("recipient_address_cut");
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

describe("buildShippingLabelPdf", () => {
  test("one 120 x 100 mm landscape page per label", async () => {
    const doc = await PDFDocument.load((await buildShippingLabelPdf([label(), label({ orderNo: "ORD-202612-0002" })])).pdf);
    expect(doc.getPageCount()).toBe(2);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      expect(width).toBeCloseTo(LABEL_WIDTH_MM * MM_TO_PT, 1);
      expect(height).toBeCloseTo(LABEL_HEIGHT_MM * MM_TO_PT, 1);
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
