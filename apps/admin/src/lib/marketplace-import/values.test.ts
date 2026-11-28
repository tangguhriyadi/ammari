import { describe, expect, test } from "vitest";
import { MAX_RUPIAH_CELL, parseChannelOrderNo, parseCountText, parseSkuText, parseJakartaDateTime, parseJakartaMinuteText, parseMoney, parseQty, parseQtyText, parseRupiahText, parseSku } from "./values";

describe("parseMoney", () => {
  test.each([
    [249000, 249000],
    [0, 0],
    ["249000", 249000],
    ["Rp 249.000", 249000],
    ["Rp249.000", 249000],
    ["rp 1.249.000", 1249000],
    ["249.000,00", 249000],
    ["249.000,0", 249000],
    ["  12.500  ", 12500],
    ["Rp\u00a0249.000", 249000],
  ])("%j is %d rupiah", (input, expected) => {
    expect(parseMoney(input)).toEqual({ ok: true, value: expected });
  });

  test.each([["249,5"], [-1], [1.5], ["abc"], ["-5.000"], ["249.00"], ["2.49.000"], ["1e5"], [Number.NaN], [Number.POSITIVE_INFINITY], [true], ["249.000,50"], ["9007199254740993"]])(
    "%j is refused",
    (input) => {
      const result = parseMoney(input);
      expect(result.ok).toBe(false);
    },
  );

  test("a blank cell is blank, not zero", () => {
    expect(parseMoney(null)).toEqual({ ok: true, value: null });
    expect(parseMoney("   ")).toEqual({ ok: true, value: null });
    expect(parseMoney("-")).toEqual({ ok: true, value: null });
  });
});

describe("parseQty", () => {
  test("whole pieces from 1 to 1000", () => {
    expect(parseQty(1)).toEqual({ ok: true, value: 1 });
    expect(parseQty("3")).toEqual({ ok: true, value: 3 });
    expect(parseQty(1000)).toEqual({ ok: true, value: 1000 });
  });

  test.each([[0], [-1], [1.5], ["2,0"], ["dua"], [1001], [null], [""]])("%j is refused", (input) => {
    expect(parseQty(input).ok).toBe(false);
  });
});

describe("parseChannelOrderNo", () => {
  test("trimmed and uppercased", () => {
    expect(parseChannelOrderNo(" 241022abcdef12 ")).toEqual({ ok: true, value: "241022ABCDEF12" });
  });

  test("a whole number cell of up to 15 digits is kept digit for digit", () => {
    expect(parseChannelOrderNo(24102212345)).toEqual({ ok: true, value: "24102212345" });
    expect(parseChannelOrderNo(999999999999999)).toEqual({ ok: true, value: "999999999999999" });
  });

  test.each([["=HYPERLINK(\"http://x\")"], ["=cmd|' /C calc'!A0"], ["+62812"], ["ABC"], ["2410 22AB"], ["A".repeat(33)], [1.5], [2 ** 60], [1234567890123450], [null], [""]])(
    "%j is refused",
    (input) => {
      expect(parseChannelOrderNo(input).ok).toBe(false);
    },
  );
});

describe("parseSku", () => {
  test("trimmed and uppercased, never otherwise rewritten", () => {
    expect(parseSku(" poka-fz-sage-m ")).toEqual({ ok: true, value: "POKA-FZ-SAGE-M" });
    expect(parseSku("POKA FZ SAGE M")).toEqual({ ok: true, value: "POKA FZ SAGE M" });
  });

  test("blank is blank (an unknown SKU later, not a row error)", () => {
    expect(parseSku(null)).toEqual({ ok: true, value: null });
    expect(parseSku("  ")).toEqual({ ok: true, value: null });
  });

  test("too long or with control characters is refused", () => {
    expect(parseSku("A".repeat(65)).ok).toBe(false);
    expect(parseSku("POKA\u0000M").ok).toBe(false);
    expect(parseSku("POKA\nM").ok).toBe(false);
  });
});

describe("parseJakartaDateTime", () => {
  test("text is Asia/Jakarta wall time", () => {
    expect(parseJakartaDateTime("2026-10-23 14:05", false)).toEqual({ ok: true, value: new Date("2026-10-23T07:05:00.000Z") });
    expect(parseJakartaDateTime("2026-10-23 14:05:09", false)).toEqual({ ok: true, value: new Date("2026-10-23T07:05:09.000Z") });
    expect(parseJakartaDateTime("2026-10-23T14:05", false)).toEqual({ ok: true, value: new Date("2026-10-23T07:05:00.000Z") });
  });

  test("near midnight: 23:30 WIB is 16:30 UTC the same day, 00:30 WIB is 17:30 UTC the day before", () => {
    expect(parseJakartaDateTime("2026-11-01 23:30", false)).toEqual({ ok: true, value: new Date("2026-11-01T16:30:00.000Z") });
    expect(parseJakartaDateTime("2026-11-01 00:30", false)).toEqual({ ok: true, value: new Date("2026-10-31T17:30:00.000Z") });
  });

  test("an Excel date serial is the same wall time", () => {
    // 2026-10-23 is serial 46318; 14:05 is 14/24 + 5/1440 of a day.
    const serial = 46318 + (14 * 60 + 5) / 1440;
    expect(parseJakartaDateTime(serial, false)).toEqual({ ok: true, value: new Date("2026-10-23T07:05:00.000Z") });
  });

  test("a 1904-system workbook serial is shifted by 1462 days", () => {
    const serial = 46318 - 1462 + 0.5;
    expect(parseJakartaDateTime(serial, true)).toEqual({ ok: true, value: new Date("2026-10-23T05:00:00.000Z") });
  });

  test.each([["2026-02-30 10:00"], ["23-10-2026 14:05"], ["10/23/2026 14:05"], ["2026-10-23"], ["2026-10-23 24:00"], ["kemarin"], [12], [null], [""]])(
    "%j is refused",
    (input) => {
      expect(parseJakartaDateTime(input, false).ok).toBe(false);
    },
  );
});

describe("text-only parsers (the real Shopee export, plan §19.1)", () => {
  test.each([
    ["0", 0],
    ["8.000", 8_000],
    ["229.000", 229_000],
    ["999", 999],
    ["1.250.000", 1_250_000],
    [" 229.000 ", 229_000],
  ])("rupiah %j -> %j", (cell, value) => {
    expect(parseRupiahText(cell, "Harga Awal")).toEqual({ ok: true, value });
  });

  test("blank is null", () => {
    expect(parseRupiahText("", "Harga Awal")).toEqual({ ok: true, value: null });
    expect(parseRupiahText(null, "Harga Awal")).toEqual({ ok: true, value: null });
  });

  test.each(["229.000,00", "229,000", "1,5", "229.00", "22.9000", "1000", "0229", "00", "Rp229.000", "Rp 229.000", "-5.000", "229.000-", "2 29.000", "abc", "-", "."])(
    "rupiah %j is refused",
    (cell) => {
      expect(parseRupiahText(cell, "Harga Awal")).toEqual({ ok: false, message: `"${cell}" bukan angka rupiah dengan format 229.000.` });
    },
  );

  test("a number cell is refused: the real file is text", () => {
    expect(parseRupiahText(229000, "Harga Awal")).toEqual({ ok: false, message: "Harga Awal harus berupa teks seperti di export Shopee." });
    expect(parseRupiahText(true, "Harga Awal").ok).toBe(false);
  });

  test("a value above the cell cap is refused, so no sum of a file can lose precision", () => {
    expect(MAX_RUPIAH_CELL).toBe(10_000_000_000);
    expect(parseRupiahText("10.000.000.000", "Harga Awal")).toEqual({ ok: true, value: 10_000_000_000 });
    expect(parseRupiahText("10.000.000.001", "Harga Awal")).toEqual({ ok: false, message: "Angka uang terlalu besar." });
    expect(parseRupiahText("9.007.199.254.740.993", "Harga Awal")).toEqual({ ok: false, message: "Angka uang terlalu besar." });
  });

  test("sku: text only (a number cell may already have lost leading zeros)", () => {
    expect(parseSkuText(" poka-m ")).toEqual({ ok: true, value: "POKA-M" });
    expect(parseSkuText("")).toEqual({ ok: true, value: null });
    expect(parseSkuText(123)).toEqual({ ok: false, message: "Nomor Referensi SKU harus berupa teks seperti di export Shopee." });
  });

  test("count: whole number text >= 0, blank null", () => {
    expect(parseCountText("0", "Returned quantity")).toEqual({ ok: true, value: 0 });
    expect(parseCountText("2", "Returned quantity")).toEqual({ ok: true, value: 2 });
    expect(parseCountText("", "Returned quantity")).toEqual({ ok: true, value: null });
    for (const bad of ["-1", "1.5", "1,0", "satu", "1001"]) expect(parseCountText(bad, "Returned quantity").ok, bad).toBe(false);
    expect(parseCountText(1, "Returned quantity")).toEqual({ ok: false, message: "Returned quantity harus berupa teks seperti di export Shopee." });
  });

  test("qty: text only", () => {
    expect(parseQtyText("2")).toEqual({ ok: true, value: 2 });
    expect(parseQtyText(2)).toEqual({ ok: false, message: "Jumlah harus berupa teks seperti di export Shopee." });
    expect(parseQtyText("0").ok).toBe(false);
  });

  test("time: YYYY-MM-DD HH:MM Jakarta only", () => {
    expect(parseJakartaMinuteText("2026-11-27 23:30", "Waktu Pesanan Dibuat")).toEqual({ ok: true, value: new Date("2026-11-27T16:30:00.000Z") });
    expect(parseJakartaMinuteText("2026-11-28 00:05", "Waktu Pesanan Dibuat")).toEqual({ ok: true, value: new Date("2026-11-27T17:05:00.000Z") });
    for (const bad of ["2026-11-27 23:30:00", "2026-11-27T23:30", "27/11/2026 23:30", "2026-11-27"]) {
      expect(parseJakartaMinuteText(bad, "Waktu Pesanan Dibuat").ok, bad).toBe(false);
    }
    expect(parseJakartaMinuteText("2026-02-30 10:00", "Waktu Pesanan Dibuat")).toEqual({ ok: false, message: "Tanggal pesanan tidak ada di kalender." });
    expect(parseJakartaMinuteText(46318.5, "Waktu Pesanan Dibuat")).toEqual({ ok: false, message: "Waktu Pesanan Dibuat harus berupa teks seperti di export Shopee." });
  });
});
