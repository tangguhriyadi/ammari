import { describe, expect, test } from "vitest";
import { csvBytes, xlsxBytes, XLSX_SKELETON, zipBytes } from "../../../test/marketplace-fixtures";
import { MAX_FILE_BYTES, MAX_UNCOMPRESSED_BYTES } from "./limits";
import { parseCsv, readSpreadsheet } from "./read-sheet";

function expectError(result: ReturnType<typeof readSpreadsheet>, code: string) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("readSpreadsheet: xlsx", () => {
  test("reads cells as text, numbers and booleans, blanks as null; rows may be ragged at the end", () => {
    const result = readSpreadsheet("pesanan.xlsx", xlsxBytes([["A", "B", "C"], ["teks", 249000, true], [null, "x", null]]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.format).toBe("xlsx");
    expect(result.value.sheets[0]!.rows).toEqual([
      ["A", "B", "C"],
      ["teks", 249000, true],
      [null, "x"],
    ]);
  });

  test("a formula cell gives its cached value; the formula is never evaluated or returned", () => {
    const result = readSpreadsheet(
      "pesanan.xlsx",
      xlsxBytes([["No. Pesanan", "Total"], [{ formula: 'HYPERLINK("http://contoh.invalid","klik")', cached: "klik" }, { formula: "1+1", cached: 999 }]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sheets[0]!.rows[1]).toEqual(["klik", 999]);
    expect(JSON.stringify(result.value)).not.toContain("HYPERLINK");
  });

  test("keeps every sheet, in workbook order", () => {
    const result = readSpreadsheet("pesanan.xlsx", xlsxBytes([["main"]], { sheetsBefore: [{ name: "Catatan", rows: [["info"]] }] }));
    expect(result.ok && result.value.sheets.map((sheet) => sheet.name)).toEqual(["Catatan", "orders"]);
  });

  test("reports a 1904 date system", () => {
    const result = readSpreadsheet("pesanan.xlsx", xlsxBytes([["x"]], { date1904: true }));
    expect(result.ok && result.value.date1904).toBe(true);
  });

  test("cuts very long cells", () => {
    const result = readSpreadsheet("pesanan.xlsx", xlsxBytes([["x".repeat(5000)]]));
    expect(result.ok && (result.value.sheets[0]!.rows[0]![0] as string).length).toBe(1000);
  });
});

describe("readSpreadsheet: refusals", () => {
  test("an empty file", () => {
    expectError(readSpreadsheet("pesanan.xlsx", new Uint8Array()), "empty_file");
  });

  test("a file over 10 MB, before anything is parsed", () => {
    expectError(readSpreadsheet("pesanan.xlsx", new Uint8Array(MAX_FILE_BYTES + 1)), "file_too_large");
  });

  test("an extension that is not .xlsx or .csv", () => {
    expectError(readSpreadsheet("pesanan.pdf", xlsxBytes([["x"]])), "unsupported_type");
    expectError(readSpreadsheet("pesanan", xlsxBytes([["x"]])), "unsupported_type");
  });

  test("an .xlsx whose bytes are not a zip", () => {
    expectError(readSpreadsheet("pesanan.xlsx", new TextEncoder().encode("No. Pesanan,Status\n1,2\n")), "unsupported_type");
  });

  test("an old .xls or a password-protected workbook (OLE container)", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expectError(readSpreadsheet("pesanan.xls", ole), "unsupported_type");
    const result = readSpreadsheet("pesanan.xlsx", ole);
    expectError(result, "unsupported_type");
    if (!result.ok) expect(result.error.message).toContain("kata sandi");
  });

  test("a .csv that is really a zip", () => {
    expectError(readSpreadsheet("pesanan.csv", xlsxBytes([["x"]])), "unsupported_type");
  });

  test("a zip that is not a workbook (no xl/workbook.xml)", () => {
    expectError(readSpreadsheet("pesanan.xlsx", zipBytes([{ name: "[Content_Types].xml", data: new Uint8Array(4) }])), "unsupported_type");
  });

  test("a zip bomb that declares its real size", () => {
    const huge = new Uint8Array(MAX_UNCOMPRESSED_BYTES + 1);
    expectError(readSpreadsheet("pesanan.xlsx", zipBytes([...XLSX_SKELETON, { name: "xl/worksheets/sheet1.xml", data: huge }])), "unsafe_file");
  });

  test("a zip bomb that lies about its size is caught while inflating", () => {
    const huge = new Uint8Array(MAX_UNCOMPRESSED_BYTES + 1);
    expectError(readSpreadsheet("pesanan.xlsx", zipBytes([...XLSX_SKELETON, { name: "xl/worksheets/sheet1.xml", data: huge, declaredSize: 1000 }])), "unsafe_file");
  });

  test("an entry whose real size differs from what it declares, even when small", () => {
    expectError(readSpreadsheet("pesanan.xlsx", zipBytes([...XLSX_SKELETON, { name: "xl/a.xml", data: new Uint8Array(5000), declaredSize: 10 }])), "unsafe_file");
  });

  test("central header 'stored' over a local 'deflate' bomb (security review H1) is refused", () => {
    const bomb = new Uint8Array(50 * 1024 * 1024);
    expectError(readSpreadsheet("pesanan.xlsx", zipBytes([...XLSX_SKELETON, { name: "xl/worksheets/sheet1.xml", data: bomb, centralMethod: 0, localMethod: 8 }])), "unsafe_file");
  });

  test("a local name that differs from the central name is refused", () => {
    expectError(readSpreadsheet("pesanan.xlsx", zipBytes([XLSX_SKELETON[0]!, { ...XLSX_SKELETON[1]!, localName: "xl/workbook.bin" }])), "unsafe_file");
  });

  test("an end record whose comment does not end the file (a fake record hidden in a comment) is refused", () => {
    const fakeEnd = new Uint8Array(22);
    new DataView(fakeEnd.buffer).setUint32(0, 0x06054b50, true);
    const honest = zipBytes([...XLSX_SKELETON]);
    const withTrailingJunk = new Uint8Array([...honest, ...fakeEnd, 1, 2, 3]);
    expectError(readSpreadsheet("pesanan.xlsx", withTrailingJunk), "unsafe_file");
  });

  test("a zip with a proper comment is still read", () => {
    const bytes = zipBytes([...XLSX_SKELETON], { comment: new TextEncoder().encode("dibuat oleh uji") });
    // Valid as a zip; the skeleton workbook itself is empty, so SheetJS may refuse it, but never as unsafe.
    const result = readSpreadsheet("pesanan.xlsx", bytes);
    expect(!result.ok && result.error.code).not.toBe("unsafe_file");
  });

  test("duplicate entry names (two readers could pick different ones)", () => {
    expectError(readSpreadsheet("pesanan.xlsx", zipBytes([...XLSX_SKELETON, XLSX_SKELETON[1]!])), "unsafe_file");
  });

  test("a truncated zip", () => {
    const bytes = xlsxBytes([["x"]]);
    expectError(readSpreadsheet("pesanan.xlsx", bytes.subarray(0, bytes.length - 30)), "unsafe_file");
  });

  test("a sheet longer than the row limit", () => {
    const rows = Array.from({ length: 20_000 + 12 }, (_, index) => [`baris ${index}`]);
    expectError(readSpreadsheet("pesanan.xlsx", xlsxBytes(rows)), "too_many_rows");
  });
});

describe("readSpreadsheet: csv", () => {
  test("comma-separated, with a BOM", () => {
    const result = readSpreadsheet("pesanan.csv", csvBytes([["No. Pesanan", "Jumlah"], ["ABC123", "2"]], { bom: true }));
    expect(result.ok && result.value.sheets[0]!.rows).toEqual([
      ["No. Pesanan", "Jumlah"],
      ["ABC123", "2"],
    ]);
    expect(result.ok && result.value.format).toBe("csv");
  });

  test("semicolon-separated (Excel in an Indonesian locale), values never turned into numbers", () => {
    const result = readSpreadsheet("pesanan.csv", csvBytes([["Total", "Kota"], ["249.000", "Bandung, Jawa Barat"]], { delimiter: ";" }));
    expect(result.ok && result.value.sheets[0]!.rows[1]).toEqual(["249.000", "Bandung, Jawa Barat"]);
  });

  test("a non-UTF-8 csv", () => {
    expectError(readSpreadsheet("pesanan.csv", new Uint8Array([0x41, 0xff, 0xfe, 0x42])), "unreadable");
  });

  test("a csv over the row limit", () => {
    const rows = Array.from({ length: 20_000 + 12 }, (_, index) => [`baris ${index}`]);
    expectError(readSpreadsheet("pesanan.csv", csvBytes(rows)), "too_many_rows");
  });
});

describe("parseCsv", () => {
  test("quoted fields with delimiters, quotes and newlines", () => {
    expect(parseCsv('a,"b, c","say ""hi""","line\nbreak"\r\n1,2,3,4\n', 100)).toEqual({
      ok: true,
      value: [
        ["a", "b, c", 'say "hi"', "line\nbreak"],
        ["1", "2", "3", "4"],
      ],
    });
  });

  test("an Excel sep= line picks the delimiter and is dropped", () => {
    expect(parseCsv("sep=;\r\na;b,c\r\n", 100)).toEqual({ ok: true, value: [["a", "b,c"]] });
  });

  test("tab-separated is detected", () => {
    expect(parseCsv("a\tb\n1\t2", 100)).toEqual({ ok: true, value: [["a", "b"], ["1", "2"]] });
  });

  test("empty fields are null; a blank line stays as an empty row so row numbers match the file", () => {
    expect(parseCsv("a,,c\n\n,b,\n", 100)).toEqual({ ok: true, value: [["a", null, "c"], [], [null, "b", null]] });
  });

  test("text after a closing quote is refused, not glued on", () => {
    expect(parseCsv('"abc"def,x\n', 100)).toEqual({ ok: false, reason: "malformed" });
    expect(parseCsv('"abc",x\r\n"y"\n', 100)).toEqual({ ok: true, value: [["abc", "x"], ["y"]] });
  });

  test("the delimiter comes from the header line even below a title line", () => {
    expect(parseCsv("Laporan Pesanan\nNo. Pesanan;Jumlah\nABC123;2\n", 100)).toEqual({
      ok: true,
      value: [["Laporan Pesanan"], ["No. Pesanan", "Jumlah"], ["ABC123", "2"]],
    });
  });

  test("cells past the column limit are dropped while reading", () => {
    const result = parseCsv(`${"a,".repeat(2000)}x\n`, 10);
    expect(result.ok && result.value[0]!.length).toBe(500);
  });

  test("an unterminated quote is refused", () => {
    expect(parseCsv('a,"b\n1,2', 100).ok).toBe(false);
  });

  test("stops at the row limit", () => {
    expect(parseCsv("a\nb\nc\n", 2)).toEqual({ ok: false, reason: "too_many_rows" });
  });
});
