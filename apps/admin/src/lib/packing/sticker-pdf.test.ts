import { PDFDocument } from "pdf-lib";
import QRCode from "qrcode";
import { describe, expect, test, vi } from "vitest";
import { buildStickerSheetPdf, stickerPdfFilename, type StickerPdfCard } from "./sticker-pdf";

const MM_TO_PT = 72 / 25.4;

function card(orderId: string, code: string): StickerPdfCard {
  return { orderId, code, claimUrl: `https://ammari.id/claim/${orderId}` };
}

describe("buildStickerSheetPdf", () => {
  test("9 cards fit on exactly 1 page", async () => {
    const cards = Array.from({ length: 9 }, (_, i) => card(`o${i}`, `CODE-${i}`));
    const bytes = await buildStickerSheetPdf(cards);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  test("10 cards need a second (partial) sheet -> 2 pages", async () => {
    const cards = Array.from({ length: 10 }, (_, i) => card(`o${i}`, `CODE-${i}`));
    const bytes = await buildStickerSheetPdf(cards);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  test("18 cards fill exactly 2 full pages", async () => {
    const cards = Array.from({ length: 18 }, (_, i) => card(`o${i}`, `CODE-${i}`));
    const bytes = await buildStickerSheetPdf(cards);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
  });

  test("every page is exactly 100mm x 120mm", async () => {
    const cards = Array.from({ length: 10 }, (_, i) => card(`o${i}`, `CODE-${i}`));
    const bytes = await buildStickerSheetPdf(cards);
    const doc = await PDFDocument.load(bytes);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      expect(width).toBeCloseTo(100 * MM_TO_PT, 1);
      expect(height).toBeCloseTo(120 * MM_TO_PT, 1);
    }
  });

  test("each QR is built from exactly the given card's claimUrl, in order, at error correction Q", async () => {
    const createSpy = vi.spyOn(QRCode, "create");
    const cards = [card("a", "AAA-1"), card("b", "BBB-2"), card("c", "CCC-3")];
    await buildStickerSheetPdf(cards);

    expect(createSpy).toHaveBeenCalledTimes(3);
    cards.forEach((c, i) => {
      expect(createSpy).toHaveBeenNthCalledWith(i + 1, c.claimUrl, { errorCorrectionLevel: "Q" });
    });
    createSpy.mockRestore();
  });

  test("a card's code text never appears for the wrong order's QR (sanity: distinct URLs per card)", async () => {
    const createSpy = vi.spyOn(QRCode, "create");
    const cards = [card("x", "XXX-1"), card("y", "YYY-2")];
    await buildStickerSheetPdf(cards);
    const calledUrls = createSpy.mock.calls.map((args) => args[0]);
    expect(calledUrls).toEqual([cards[0]!.claimUrl, cards[1]!.claimUrl]);
    createSpy.mockRestore();
  });
});

describe("stickerPdfFilename", () => {
  test("formats as ammari-stiker-YYYY-MM-DD-HHmm.pdf in Jakarta time", () => {
    // 2026-10-15T02:30:00Z -> 2026-10-15T09:30:00+07:00 (Jakarta).
    const name = stickerPdfFilename(new Date("2026-10-15T02:30:00.000Z"));
    expect(name).toBe("ammari-stiker-2026-10-15-0930.pdf");
  });

  test("midnight in Jakarta renders as 0000, not 2400", () => {
    // 2026-10-14T17:00:00Z -> 2026-10-15T00:00:00+07:00 (Jakarta).
    const name = stickerPdfFilename(new Date("2026-10-14T17:00:00.000Z"));
    expect(name).toBe("ammari-stiker-2026-10-15-0000.pdf");
  });
});
