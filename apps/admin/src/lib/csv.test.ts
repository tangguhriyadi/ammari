import { describe, expect, test } from "vitest";
import { buildCsv, buildTsv, neutralizeFormula } from "./csv";

describe("neutralizeFormula", () => {
  test.each([["=1+1"], ["+62812"], ["-5"], ["@SUM(A1)"], ["\tx"], ["\rx"]])("%j gets a leading apostrophe", (text) => {
    expect(neutralizeFormula(text)).toBe(`'${text}`);
  });

  test("ordinary text is untouched", () => {
    expect(neutralizeFormula("POKA-FZ-SAGE-M")).toBe("POKA-FZ-SAGE-M");
    expect(neutralizeFormula("Gamis = cantik")).toBe("Gamis = cantik");
    expect(neutralizeFormula("")).toBe("");
  });
});

describe("buildCsv", () => {
  test("RFC 4180: CRLF rows, quotes only where needed, doubled quotes", () => {
    expect(
      buildCsv([
        ["Produk", "Stok"],
        ["Gamis, Basic", 3],
        ['Gamis "Poka"', 0],
        ["Baris\nbaru", null],
      ]),
    ).toBe('\ufeffProduk,Stok\r\n"Gamis, Basic",3\r\n"Gamis ""Poka""",0\r\n"Baris\nbaru",\r\n');
  });

  test("starts with a UTF-8 BOM so Excel reads the text right", () => {
    expect(buildCsv([["Warna"]]).startsWith("\ufeff")).toBe(true);
  });

  test("text cells that would run as a formula are neutralized; numbers are not", () => {
    expect(buildCsv([['=HYPERLINK("http://contoh.invalid")', -5]])).toBe('\ufeff"\'=HYPERLINK(""http://contoh.invalid"")",-5\r\n');
  });
});

describe("buildTsv", () => {
  test("tab-separated for pasting into a spreadsheet; tabs and newlines inside a cell become spaces", () => {
    expect(
      buildTsv([
        ["Produk", "SKU"],
        ["Gamis\tBasic", "A-M"],
        ["Baris\r\nbaru", "=1"],
      ]),
    ).toBe("Produk\tSKU\nGamis Basic\tA-M\nBaris baru\t'=1\n");
  });
});
