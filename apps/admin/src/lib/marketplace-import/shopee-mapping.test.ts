import { describe, expect, test } from "vitest";
import { csvBytes, FAKE_BUYER, SHOPEE_HEADER, shopeeColumn, shopeeRows, xlsxBytes, type FixtureCell, type FixtureOrder } from "../../../test/marketplace-fixtures";
import { SHOPEE_HEADER_SIGNATURE, SHOPEE_MAPPING_VERIFIED, shopeeAdapter } from "./adapters/shopee";
import { parseMarketplaceFile, type ParsedImport } from "./parse-file";

// The real Shopee "Pesanan Saya" mapping (docs/plans/marketplace-import.md §19.2, session 7a). Every
// fixture is synthetic, built in code with the exact 49 headers of the 27 Nov 2026 export and text
// cells only. Buyer columns 40-47 carry obviously fake values that must never leave the parser.


function parseRows(rows: FixtureCell[][], fileName = "pesanan.xlsx"): ParsedImport {
  const result = parseMarketplaceFile({ channelId: "shopee", fileName, bytes: xlsxBytes(rows) });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const parse = (orders: readonly FixtureOrder[]) => parseRows(shopeeRows(orders));

function withHeader(rows: FixtureCell[][], index: number, text: string): FixtureCell[][] {
  return rows.map((row, r) => (r === 0 ? row.map((cell, c) => (c === index ? text : cell)) : row));
}

function withoutColumn(rows: FixtureCell[][], index: number): FixtureCell[][] {
  return rows.map((row) => row.filter((_, c) => c !== index));
}

function setCell(rows: FixtureCell[][], rowIndex: number, column: (typeof SHOPEE_HEADER)[number], value: FixtureCell): FixtureCell[][] {
  const copy = rows.map((row) => [...row]);
  copy[rowIndex]![shopeeColumn(column)] = value;
  return copy;
}

const ONE: FixtureOrder = { orderNo: "2611AAA001", status: "Perlu Dikirim", lines: [{ sku: "POKA-SAGE-M", qty: 1, lineTotal: 229_000 }] };

describe("the real header row (plan §19.2)", () => {
  test("the signature is the exact 49 headers in the real order, and the fixture uses it", () => {
    expect(SHOPEE_HEADER_SIGNATURE).toHaveLength(49);
    expect([...SHOPEE_HEADER_SIGNATURE]).toEqual([...SHOPEE_HEADER]);
    expect(SHOPEE_HEADER_SIGNATURE[2]).toBe("Status Pembatalan/ Pengembalian");
    expect(SHOPEE_HEADER_SIGNATURE[5]).toBe("Antar ke counter/ pick-up");
  });

  test("every read field maps to its column", () => {
    const parsed = parse([ONE]);
    expect(parsed.saveBlockers).toEqual([]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.rowErrors).toEqual([]);
    expect(parsed.orders).toEqual([
      expect.objectContaining({
        channelOrderNo: "2611AAA001",
        rawStatus: "Perlu Dikirim",
        statusKey: "perlu dikirim",
        cancelReturnStatus: null,
        orderedAt: new Date("2026-10-23T07:05:00.000Z"),
        lines: [{ sku: "POKA-SAGE-M", qty: 1, unitPrice: 229_000, lineTotal: 229_000, rowNumbers: [2], nameHints: ["Gamis Uji", "Sage,M"] }],
        subtotalAmount: 229_000,
        sellerDiscountAmount: 0,
        sellerDiscounts: { product: 0, voucher: 0, bundle: 0 },
        returnedQty: 0,
        priceMismatchRows: [],
        fileSubtotals: [229_000],
        fees: {},
      }),
    ]);
  });

  test("buyer columns 40-47 never appear in the serialized result", () => {
    const serialized = JSON.stringify(parse([ONE, { ...ONE, orderNo: "2611AAA002", lines: [{ sku: null, qty: 1, lineTotal: 1_000 }] }]));
    for (const value of Object.values(FAKE_BUYER)) expect(serialized).not.toContain(value);
    // Nor the unread money columns (ongkir 12.000, Total Pembayaran 333.333) or the weight.
    for (const value of ["12.000", "12000", "333.333", "333333", "700 gr"]) expect(serialized).not.toContain(value);
  });

  test("the plan reads no column past the ones it maps; every buyer column stays unmapped", () => {
    const aliases = new Set(shopeeAdapter.columns!.flatMap((spec) => spec.aliases));
    for (const index of [40, 41, 42, 43, 44, 45, 46, 47]) expect(aliases.has(SHOPEE_HEADER[index]!)).toBe(false);
    // Never a fallback for the variant SKU (§19.2 col 12).
    expect(aliases.has("SKU Induk")).toBe(false);
    // "Jumlah Produk di Pesan" (col 25) can never be taken for Jumlah.
    expect(aliases.has("Jumlah Produk di Pesan")).toBe(false);
  });

  test("the old article headers are a missing-column error, naming the real columns", () => {
    const article = [["No. Pesanan", "Status Pesanan", "Waktu Pesanan Dibuat", "Nomor Referensi SKU", "Jumlah", "Total Harga Produk", "Voucher Ditanggung Penjual"], ["2611AAA001", "Selesai", "2026-10-23 14:05", "A-M", "1", "229.000", "0"]];
    const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(article) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("missing_columns");
    expect(result.error.message).toContain("Harga Awal");
    expect(result.error.message).toContain("Status Pembatalan/ Pengembalian");
    expect(result.error.message).not.toContain("Total Harga Produk");
  });
});

describe("header signature: any change previews but blocks saving (plan §19.2)", () => {
  test("a renamed column names both the missing and the new header", () => {
    const parsed = parseRows(withHeader(shopeeRows([ONE]), shopeeColumn("Total Berat"), "Total Berat (kg)"));
    expect(parsed.orders).toHaveLength(1);
    expect(parsed.saveBlockers).toContain(
      'Format export Shopee berubah sejak 27 Nov 2026: kolom "Total Berat" tidak ada, kolom baru "Total Berat (kg)". Pratinjau tetap bisa dipakai, tapi pesanan belum bisa disimpan. Kirim baris judul kolom yang baru ke admin teknis.',
    );
  });

  test("a removed column (even one that is read, but optional) blocks saving", () => {
    const parsed = parseRows(withoutColumn(shopeeRows([ONE]), shopeeColumn("Returned quantity")));
    expect(parsed.orders).toHaveLength(1);
    expect(parsed.saveBlockers.some((blocker) => blocker.includes('kolom "Returned quantity" tidak ada'))).toBe(true);
  });

  test("an added column blocks saving", () => {
    const rows = shopeeRows([ONE]).map((row, r) => [...row, r === 0 ? "Kolom Baru" : "x"]);
    expect(parseRows(rows).saveBlockers.some((blocker) => blocker.includes('kolom baru "Kolom Baru"'))).toBe(true);
  });

  test("the same headers in another order block saving", () => {
    const rows = shopeeRows([ONE]).map((row) => {
      const copy = [...row];
      [copy[24], copy[26]] = [copy[26]!, copy[24]!];
      return copy;
    });
    expect(parseRows(rows).saveBlockers.some((blocker) => blocker.includes("urutan kolom berubah"))).toBe(true);
  });

  test("a renamed REQUIRED column cannot be previewed at all: the file is refused, naming it", () => {
    const rows = withHeader(shopeeRows([ONE]), shopeeColumn("Status Pembatalan/ Pengembalian"), "Status Pembatalan/Pengembalian");
    const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(rows) });
    expect(result).toEqual({
      ok: false,
      error: { code: "missing_columns", message: "Kolom wajib tidak ditemukan: Status Pembatalan/ Pengembalian. Pastikan file adalah export Pesanan dari Shopee Seller Center." },
    });
  });

  test("a case-only change of a read column still previews, with the blocker", () => {
    const parsed = parseRows(withHeader(shopeeRows([ONE]), shopeeColumn("Harga Awal"), "HARGA AWAL"));
    expect(parsed.orders).toHaveLength(1);
    expect(parsed.saveBlockers.some((blocker) => blocker.includes('kolom "Harga Awal" tidak ada, kolom baru "HARGA AWAL"'))).toBe(true);
  });

  test("trailing blank header cells are not columns", () => {
    const rows = shopeeRows([ONE]).map((row, r) => [...row, r === 0 ? "" : null]);
    expect(parseRows(rows).saveBlockers).toEqual([]);
  });

  test("the e2e unlock never lifts the signature blocker", () => {
    const rows = withHeader(shopeeRows([ONE]), shopeeColumn("Total Berat"), "Berat Total");
    const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(rows), assumeMappingVerified: true });
    expect(result.ok && result.value.saveBlockers).toEqual([expect.stringContaining("Format export Shopee berubah sejak 27 Nov 2026")]);
  });

  test("a second sheet with the order header blocks saving (its orders would be silently left out)", () => {
    const bytes = xlsxBytes(shopeeRows([ONE]), { sheetsBefore: [{ name: "orders lama", rows: shopeeRows([{ ...ONE, orderNo: "2611ZZZ999" }]) }] });
    const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes, assumeMappingVerified: true });
    expect(result.ok && result.value.sheetName).toBe("orders lama");
    expect(result.ok && result.value.saveBlockers).toEqual([
      'File berisi lebih dari satu sheet pesanan ("orders lama", "orders"), jadi hanya sheet pertama yang terbaca. Export ulang file dengan satu sheet saja.',
    ]);
  });

  test("SHOPEE_MAPPING_VERIFIED is true since 7c (guarded unlock): no lock blocker", () => {
    expect(SHOPEE_MAPPING_VERIFIED).toBe(true);
    expect(shopeeAdapter.mappingVerified).toBe(true);
  });
});

describe("cells are text, parsed strictly (plan §19.1, §2.2)", () => {
  test('"229.000", "0" and "" are rupiah, zero and blank', () => {
    const parsed = parse([{ ...ONE, sellerVoucher: "0", sellerBundleDiscount: null, lines: [{ sku: "A-M", qty: 1, listUnitPrice: "229.000", unitPriceAfterDiscount: "229.000" }] }]);
    expect(parsed.orders[0]).toMatchObject({ subtotalAmount: 229_000, sellerDiscountAmount: 0 });
  });

  test.each([
    ["229.000,00", "decimals"],
    ["229,000", "a comma"],
    ["229.00", "a broken group"],
    ["Rp229.000", "a currency prefix"],
    ["229.000-", "garbage"],
    ["-5.000", "a negative"],
    ["1000", "no thousands separator"],
    ["0229", "a leading zero"],
  ])("Harga Awal %s (%s) is a row error, never a guess", (value) => {
    const parsed = parse([{ ...ONE, lines: [{ sku: "A-M", qty: 1, listUnitPrice: value, unitPriceAfterDiscount: "229.000" }] }]);
    expect(parsed.orders).toEqual([]);
    expect(parsed.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Harga Awal", message: `"${value}" bukan angka rupiah dengan format 229.000.` }]);
  });

  test("a number cell in a money column is refused: the real file is all text", () => {
    const parsed = parseRows(setCell(shopeeRows([ONE]), 1, "Harga Awal", 229000));
    expect(parsed.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Harga Awal", message: "Harga Awal harus berupa teks seperti di export Shopee." }]);
  });

  test("a row amount above the cap is a row error (Harga Awal x Jumlah)", () => {
    const parsed = parse([{ ...ONE, lines: [{ sku: "A-M", qty: 2, listUnitPrice: "6.000.000.000", unitPriceAfterDiscount: "6.000.000.000" }] }]);
    expect(parsed.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Harga Awal", message: "Angka uang terlalu besar." }]);
  });

  test("a SKU stored as a number cell is a row error", () => {
    const parsed = parseRows(setCell(shopeeRows([ONE]), 1, "Nomor Referensi SKU", 123));
    expect(parsed.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Nomor Referensi SKU", message: "Nomor Referensi SKU harus berupa teks seperti di export Shopee." }]);
  });

  test("a blank Harga Awal or Harga Setelah Diskon is a row error", () => {
    const parsed = parseRows(setCell(setCell(shopeeRows([ONE, { ...ONE, orderNo: "2611AAA002" }]), 1, "Harga Awal", ""), 2, "Harga Setelah Diskon", ""));
    expect(parsed.rowErrors).toEqual([
      { rowNumber: 2, columnLabel: "Harga Awal", message: "Harga Awal kosong." },
      { rowNumber: 3, columnLabel: "Harga Setelah Diskon", message: "Harga Setelah Diskon kosong." },
    ]);
  });

  test('times are "YYYY-MM-DD HH:MM" Jakarta text; seconds, serials and other shapes are refused', () => {
    expect(parse([{ ...ONE, orderedAt: "2026-11-27 23:30" }]).orders[0]!.orderedAt).toEqual(new Date("2026-11-27T16:30:00.000Z"));
    for (const bad of ["2026-11-27 23:30:15", "27-11-2026 23:30", "2026-11-27T23:30", "2026-11-27"]) {
      const parsed = parse([{ ...ONE, orderedAt: bad }]);
      expect(parsed.rowErrors, bad).toEqual([{ rowNumber: 2, columnLabel: "Waktu Pesanan Dibuat", message: `"${bad}" bukan waktu dengan format TTTT-BB-HH JJ:MM.` }]);
    }
    const serial = parse([{ ...ONE, orderedAt: 46318.5 }]);
    expect(serial.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Waktu Pesanan Dibuat", message: "Waktu Pesanan Dibuat harus berupa teks seperti di export Shopee." }]);
  });

  test('Jumlah and Returned quantity are whole-number text; "700 gr" (Berat Produk) is never parsed', () => {
    const parsed = parseRows(setCell(shopeeRows([ONE]), 1, "Berat Produk", "bukan berat"));
    expect(parsed.rowErrors).toEqual([]);
    const badQty = parse([{ ...ONE, lines: [{ sku: "A-M", qty: "1,5", listUnitPrice: 1_000, unitPriceAfterDiscount: 1_000 }] }]);
    expect(badQty.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Jumlah", message: "Jumlah harus bilangan bulat." }]);
    const badReturned = parse([{ ...ONE, lines: [{ sku: "A-M", qty: 1, lineTotal: 1_000, returnedQty: "satu" }] }]);
    expect(badReturned.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Returned quantity", message: "Returned quantity harus bilangan bulat 0 atau lebih." }]);
  });

  test("a csv of the same export reads the same", () => {
    const rows = shopeeRows([ONE]).map((row) => row.map((cell) => (cell === null || typeof cell === "object" ? null : String(cell))));
    const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.csv", bytes: csvBytes(rows) });
    expect(result.ok && [result.value.orders[0]!.subtotalAmount, result.value.saveBlockers]).toEqual([229_000, []]);
  });
});

describe("amounts (owner Q3: revenue is everything the seller does not fund)", () => {
  test("row amount = Harga Awal x Jumlah; two rows of one SKU merge into one line", () => {
    const parsed = parse([
      {
        orderNo: "2611BBB001",
        lines: [
          { sku: "A-M", qty: 2, listUnitPrice: 229_000, sellerDiscount: 20_000 },
          { sku: "a-m ", qty: 1, listUnitPrice: 229_000 },
        ],
      },
    ]);
    expect(parsed.orders[0]).toMatchObject({ lines: [{ sku: "A-M", qty: 3, unitPrice: 229_000, lineTotal: 687_000, rowNumbers: [2, 3] }], subtotalAmount: 687_000 });
  });

  test("discount = Diskon Dari Penjual (summed over rows) + Voucher Ditanggung Penjual + Paket Diskon (Diskon dari Penjual), each once", () => {
    const parsed = parse([
      {
        orderNo: "2611CCC001",
        sellerVoucher: 10_000,
        sellerBundleDiscount: 7_000,
        lines: [
          { sku: "A-M", qty: 2, listUnitPrice: 229_000, sellerDiscount: 20_000 },
          { sku: "A-L", qty: 1, listUnitPrice: 239_000, sellerDiscount: 9_000 },
        ],
      },
    ]);
    expect(parsed.orders[0]).toMatchObject({ subtotalAmount: 697_000, sellerDiscounts: { product: 29_000, voucher: 10_000, bundle: 7_000 }, sellerDiscountAmount: 46_000 });
  });

  test("Shopee-funded columns (23, 29, 31, 33) change neither subtotal nor discount", () => {
    const plain = parse([{ orderNo: "2611DDD001", lines: [{ sku: "A-M", qty: 1, listUnitPrice: 229_000 }] }]).orders[0]!;
    const funded = parse([
      { orderNo: "2611DDD001", shopeeVoucher: 15_000, shopeeBundleDiscount: 5_000, shopeeCoins: 2_000, coinCashback: 1_000, lines: [{ sku: "A-M", qty: 1, listUnitPrice: 229_000, shopeeDiscount: 11_000 }] },
    ]).orders[0]!;
    expect(funded.priceMismatchRows).toEqual([]);
    expect([funded.subtotalAmount, funded.sellerDiscountAmount]).toEqual([plain.subtotalAmount, plain.sellerDiscountAmount]);
    expect(funded.sellerDiscountAmount).toBe(0);
  });

  test("an order-scope discount that differs between rows keeps the order out, naming the column", () => {
    const rows = setCell(shopeeRows([{ orderNo: "2611EEE001", sellerBundleDiscount: 5_000, lines: [{ sku: "A-M", qty: 1, lineTotal: 229_000 }, { sku: "A-L", qty: 1, lineTotal: 229_000 }] }]), 2, "Paket Diskon (Diskon dari Penjual)", "6.000");
    const parsed = parseRows(rows);
    expect(parsed.problems).toEqual([expect.objectContaining({ code: "inconsistent_values", message: expect.stringContaining("Paket Diskon (Diskon dari Penjual)") })]);
  });

  test("seller discounts above the subtotal keep the order out", () => {
    const parsed = parse([{ orderNo: "2611FFF001", sellerVoucher: 200_000, sellerBundleDiscount: 30_000, lines: [{ sku: "A-M", qty: 1, lineTotal: 229_000 }] }]);
    expect(parsed.problems).toEqual([
      expect.objectContaining({ code: "voucher_exceeds_subtotal", message: "Diskon penjual (voucher, diskon produk dan paket diskon) lebih besar dari total harga produk, jadi pesanan belum diimpor." }),
    ]);
  });

  test("Subtotal Pesanan is only carried for display, per row", () => {
    const parsed = parse([{ orderNo: "2611GGG001", lines: [{ sku: "A-M", qty: 1, lineTotal: 229_000, fileSubtotal: 458_000 }, { sku: "A-L", qty: 1, lineTotal: 229_000, fileSubtotal: 458_000 }] }]);
    expect(parsed.orders[0]).toMatchObject({ subtotalAmount: 458_000, fileSubtotals: [458_000, 458_000], priceMismatchRows: [] });
  });
});

describe("price check (plan §19.2): recorded, never used to repair", () => {
  test("Harga Awal x Jumlah - Total Diskon must equal Harga Setelah Diskon x Jumlah", () => {
    const parsed = parse([{ orderNo: "2611HHH001", lines: [{ sku: "A-M", qty: 2, listUnitPrice: 229_000, unitPriceAfterDiscount: 219_000, totalDiscount: 10_000, sellerDiscount: 10_000 }] }]);
    expect(parsed.orders[0]).toMatchObject({ priceMismatchRows: [2], subtotalAmount: 458_000 });
  });

  test("Total Diskon must equal Diskon Dari Penjual + Diskon Dari Shopee", () => {
    const parsed = parse([{ orderNo: "2611HHH002", lines: [{ sku: "A-M", qty: 1, listUnitPrice: 229_000, unitPriceAfterDiscount: 219_000, totalDiscount: 10_000, sellerDiscount: 4_000, shopeeDiscount: 5_000 }] }]);
    expect(parsed.orders[0]!.priceMismatchRows).toEqual([2]);
  });

  test("a consistent discounted row passes", () => {
    const parsed = parse([{ orderNo: "2611HHH003", lines: [{ sku: "A-M", qty: 2, listUnitPrice: 229_000, sellerDiscount: 10_000, shopeeDiscount: 8_000 }] }]);
    expect(parsed.orders[0]).toMatchObject({ priceMismatchRows: [], sellerDiscountAmount: 10_000, subtotalAmount: 458_000 });
  });
});

describe("order holds carried to the planner (plan §19.4, §19.6)", () => {
  test("Status Pembatalan/ Pengembalian is carried as text; blank is null", () => {
    const parsed = parse([ONE, { ...ONE, orderNo: "2611III001", cancelReturnStatus: " Pengembalian Diajukan " }]);
    expect(parsed.orders.map((order) => order.cancelReturnStatus)).toEqual([null, "Pengembalian Diajukan"]);
  });

  test("Returned quantity is summed over the order's rows", () => {
    const parsed = parse([{ orderNo: "2611JJJ001", lines: [{ sku: "A-M", qty: 2, lineTotal: 458_000, returnedQty: 1 }, { sku: "A-L", qty: 1, lineTotal: 229_000 }] }]);
    expect(parsed.orders[0]!.returnedQty).toBe(1);
  });

  test("a blank variant SKU stays blank even when SKU Induk is filled", () => {
    const parsed = parse([{ orderNo: "2611KKK001", lines: [{ sku: null, qty: 1, lineTotal: 229_000, parentSku: "POKA-INDUK" }] }]);
    expect(parsed.orders[0]!.lines[0]!.sku).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("POKA-INDUK");
  });
});

describe("ship and complete dates, cols 7 and 48 (plan §19.3, session 7b)", () => {
  // The upload time the "no more than 1 hour after upload" rule is measured from.
  const NOW = new Date("2026-11-28T05:00:00Z");
  const parseAt = (orders: readonly FixtureOrder[], now = NOW) => {
    const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(shopeeRows(orders)), now });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const SHIPPED: FixtureOrder = { orderNo: "2611DAT001", status: "Dikirim", orderedAt: "2026-10-23 14:05", shippedAt: "2026-10-24 09:15", lines: [{ sku: "A-M", qty: 1, lineTotal: 229_000 }] };

  test("both columns are required: a file without them is refused, naming them", () => {
    for (const header of ["Waktu Pengiriman Diatur", "Waktu Pesanan Selesai"] as const) {
      const rows = withoutColumn(shopeeRows([SHIPPED]), shopeeColumn(header));
      const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(rows), now: NOW });
      expect(result).toEqual({ ok: false, error: { code: "missing_columns", message: `Kolom wajib tidak ditemukan: ${header}. Pastikan file adalah export Pesanan dari Shopee Seller Center.` } });
    }
  });

  test("col 7 and col 48 are read as Jakarta wall time (UTC+7) into UTC instants", () => {
    const parsed = parseAt([{ ...SHIPPED, status: "Selesai", completedAt: "2026-10-27 18:40" }]);
    expect(parsed.rowErrors).toEqual([]);
    expect(parsed.orders[0]).toMatchObject({ shippedAt: new Date("2026-10-24T02:15:00Z"), completedAt: new Date("2026-10-27T11:40:00Z") });
  });

  test("23:30 WIB stays that Jakarta date (16:30 UTC the same day), never the next one", () => {
    const parsed = parseAt([{ ...SHIPPED, orderedAt: "2026-11-05 10:00", shippedAt: "2026-11-05 23:30" }]);
    expect(parsed.orders[0]!.shippedAt).toEqual(new Date("2026-11-05T16:30:00Z"));
  });

  test("blank cells are null", () => {
    const parsed = parseAt([{ ...SHIPPED, shippedAt: "", completedAt: "" }]);
    expect(parsed.orders[0]).toMatchObject({ shippedAt: null, completedAt: null });
  });

  test("the values are carried whatever the status: the status gate is the planner's (Perlu Dikirim + col 7)", () => {
    const parsed = parseAt([{ ...SHIPPED, status: "Perlu Dikirim" }]);
    expect(parsed.orders[0]!.shippedAt).toEqual(new Date("2026-10-24T02:15:00Z"));
  });

  test.each([
    ["2026-10-24 09:15:00", "seconds"],
    ["24/10/2026 09:15", "day first"],
    ["2026-10-24", "no time"],
    ["2026-02-30 09:15", "not a calendar date"],
    ["2026-10-24 24:10", "hour 24"],
  ])("col 7 %s (%s) is a row error, never a silent NULL", (value) => {
    const parsed = parseAt([{ ...SHIPPED, shippedAt: value }]);
    expect(parsed.orders).toEqual([]);
    expect(parsed.rowErrors).toEqual([expect.objectContaining({ rowNumber: 2, columnLabel: "Waktu Pengiriman Diatur" })]);
    expect(parsed.problems).toEqual([expect.objectContaining({ channelOrderNo: "2611DAT001", code: "invalid_rows" })]);
  });

  test("a date serial (a number cell) in col 48 is a row error", () => {
    const rows = setCell(shopeeRows([{ ...SHIPPED, status: "Selesai" }]), 1, "Waktu Pesanan Selesai", 46_320.5);
    const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(rows), now: NOW });
    expect(result.ok && result.value.rowErrors).toEqual([expect.objectContaining({ columnLabel: "Waktu Pesanan Selesai" })]);
  });

  test("shipped before the order was placed is a row error", () => {
    const parsed = parseAt([{ ...SHIPPED, shippedAt: "2026-10-23 14:04" }]);
    expect(parsed.orders).toEqual([]);
    expect(parsed.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Waktu Pengiriman Diatur", message: "Waktu Pengiriman Diatur lebih awal dari Waktu Pesanan Dibuat." }]);
  });

  test("completed before shipped is a row error", () => {
    const parsed = parseAt([{ ...SHIPPED, status: "Selesai", completedAt: "2026-10-24 09:14" }]);
    expect(parsed.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Waktu Pesanan Selesai", message: "Waktu Pesanan Selesai lebih awal dari Waktu Pengiriman Diatur." }]);
  });

  test("completed before the order was placed is a row error even without a ship time", () => {
    const parsed = parseAt([{ ...SHIPPED, status: "Selesai", shippedAt: "", completedAt: "2026-10-22 10:00" }]);
    expect(parsed.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Waktu Pesanan Selesai", message: "Waktu Pesanan Selesai lebih awal dari Waktu Pesanan Dibuat." }]);
  });

  test("equal times pass (orderedAt <= shippedAt <= completedAt)", () => {
    const parsed = parseAt([{ ...SHIPPED, status: "Selesai", shippedAt: "2026-10-23 14:05", completedAt: "2026-10-23 14:05" }]);
    expect(parsed.rowErrors).toEqual([]);
    expect(parsed.orders).toHaveLength(1);
  });

  test("more than 1 hour after the upload time is a row error; exactly 1 hour passes", () => {
    // NOW is 12:00 WIB on 28 Nov 2026.
    const late = parseAt([{ ...SHIPPED, orderedAt: "2026-11-28 08:00", shippedAt: "2026-11-28 13:01" }]);
    expect(late.rowErrors).toEqual([{ rowNumber: 2, columnLabel: "Waktu Pengiriman Diatur", message: "Waktu Pengiriman Diatur lebih dari 1 jam setelah waktu upload." }]);
    const edge = parseAt([{ ...SHIPPED, status: "Selesai", orderedAt: "2026-11-28 08:00", shippedAt: "2026-11-28 13:00", completedAt: "2026-11-28 13:00" }]);
    expect(edge.rowErrors).toEqual([]);
    const lateComplete = parseAt([{ ...SHIPPED, status: "Selesai", orderedAt: "2026-11-28 08:00", shippedAt: "2026-11-28 09:00", completedAt: "2026-11-28 13:01" }]);
    expect(lateComplete.rowErrors).toEqual([expect.objectContaining({ columnLabel: "Waktu Pesanan Selesai", message: "Waktu Pesanan Selesai lebih dari 1 jam setelah waktu upload." })]);
  });

  test("order scope: taken once across the order's rows, blanks ignored; two different values hold the order", () => {
    const two: FixtureOrder = { ...SHIPPED, lines: [{ sku: "A-M", qty: 1, lineTotal: 229_000 }, { sku: "A-L", qty: 1, lineTotal: 229_000 }] };
    const firstOnly = setCell(shopeeRows([two]), 2, "Waktu Pengiriman Diatur", "");
    const parsedFirstOnly = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(firstOnly), now: NOW });
    expect(parsedFirstOnly.ok && parsedFirstOnly.value.orders[0]!.shippedAt).toEqual(new Date("2026-10-24T02:15:00Z"));

    const differing = setCell(shopeeRows([two]), 2, "Waktu Pengiriman Diatur", "2026-10-24 09:16");
    const parsedDiffering = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(differing), now: NOW });
    expect(parsedDiffering.ok && parsedDiffering.value.problems).toEqual([expect.objectContaining({ code: "inconsistent_values", message: expect.stringContaining("Waktu Pengiriman Diatur") })]);
  });
});
