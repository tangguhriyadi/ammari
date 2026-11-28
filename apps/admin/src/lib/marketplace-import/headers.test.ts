import { describe, expect, test } from "vitest";
import { shopeeAdapter } from "./adapters/shopee";
import { columnSpecId } from "./adapters/types";
import { MARKETPLACE_ADAPTERS } from "./adapters";
import { headerSignatureDifferences, locateHeader, normalizeHeader } from "./headers";
import type { Cell } from "./read-sheet";

const specs = shopeeAdapter.columns!;
const REQUIRED = [
  "No. Pesanan",
  "Status Pesanan",
  "Status Pembatalan/ Pengembalian",
  "Waktu Pesanan Dibuat",
  "Nomor Referensi SKU",
  "Harga Awal",
  "Harga Setelah Diskon",
  "Jumlah",
  "Diskon Dari Penjual",
  "Voucher Ditanggung Penjual",
  "Paket Diskon (Diskon dari Penjual)",
];

describe("normalizeHeader", () => {
  test("case, spacing, full-width characters and a trailing currency unit do not matter", () => {
    expect(normalizeHeader("  Harga\u00a0  Awal (Rp) ")).toBe("harga awal");
    expect(normalizeHeader("HARGA AWAL (IDR)")).toBe("harga awal");
    expect(normalizeHeader("Ｊｕｍｌａｈ")).toBe("jumlah");
    expect(normalizeHeader("No. Pesanan")).toBe("no. pesanan");
  });

  test("non-text cells are not headers", () => {
    expect(normalizeHeader(12)).toBeNull();
    expect(normalizeHeader(null)).toBeNull();
    expect(normalizeHeader("   ")).toBeNull();
  });
});

describe("adapter aliases", () => {
  test("no header text means two different columns, in any adapter", () => {
    for (const adapter of Object.values(MARKETPLACE_ADAPTERS)) {
      const seen = new Map<string, string>();
      for (const spec of adapter.columns ?? []) {
        for (const alias of spec.aliases) {
          const key = normalizeHeader(alias)!;
          expect(seen.get(key) ?? columnSpecId(spec), `${adapter.label}: "${alias}"`).toBe(columnSpecId(spec));
          seen.set(key, columnSpecId(spec));
        }
      }
    }
  });

  test("status keys are already normalized", () => {
    for (const adapter of Object.values(MARKETPLACE_ADAPTERS)) {
      for (const key of Object.keys(adapter.statusMap)) expect(normalizeHeader(key)).toBe(key);
    }
  });
});

describe("locateHeader", () => {
  test("finds the header on row 1", () => {
    const result = locateHeader([[...REQUIRED, "Nama Penerima"]], specs, "Shopee");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.headerRowIndex).toBe(0);
    expect(result.value.columns.get("sku")).toBe(4);
    expect(result.value.columns.get("sellerVoucher")).toBe(9);
  });

  test("finds the header below title rows", () => {
    const rows: Cell[][] = [["Laporan Pesanan"], [null], [...REQUIRED], ["X"]];
    const result = locateHeader(rows, specs, "Shopee");
    expect(result.ok && result.value.headerRowIndex).toBe(2);
  });

  test("the English aliases of the article mapping are gone: never seen in a real file (plan §19.2)", () => {
    const english = ["Order ID", "Order Status", "Order Creation Date", "SKU Reference No.", "Quantity", "Product Subtotal", "Seller Voucher"];
    const result = locateHeader([english], specs, "Shopee");
    expect(!result.ok && result.error.code).toBe("not_this_channel");
  });

  test("lists every missing required column by its Seller Center name", () => {
    const result = locateHeader([REQUIRED.filter((header) => header !== "Nomor Referensi SKU" && header !== "Jumlah")], specs, "Shopee");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("missing_columns");
    expect(result.error.message).toBe(
      "Kolom wajib tidak ditemukan: Nomor Referensi SKU, Jumlah. Pastikan file adalah export Pesanan dari Shopee Seller Center.",
    );
  });

  test("a file with none of the columns is not this channel's export", () => {
    const result = locateHeader([["Order No", "Buyer"], ["1", "x"]], specs, "Shopee");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_this_channel");
    expect(result.error.message).toContain("bukan export Pesanan Shopee");
  });

  test("a mapped column that appears twice is refused, never guessed", () => {
    const result = locateHeader([[...REQUIRED, "Jumlah"]], specs, "Shopee");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ambiguous_columns");
    expect(result.error.message).toContain("Jumlah");
  });

  test("two spellings of one column in the same file are refused too", () => {
    const result = locateHeader([[...REQUIRED, " HARGA AWAL (Rp)"]], specs, "Shopee");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ambiguous_columns");
  });

  test("unknown and duplicated unmapped columns are ignored", () => {
    const result = locateHeader([[...REQUIRED, "Catatan", "Catatan", "SKU Induk", "Jumlah Produk di Pesan"]], specs, "Shopee");
    expect(result.ok).toBe(true);
    // "Jumlah Produk di Pesan" never stands in for Jumlah.
    expect(result.ok && result.value.columns.get("qty")).toBe(REQUIRED.indexOf("Jumlah"));
  });

  test("reports optional columns that are missing", () => {
    const result = locateHeader([REQUIRED], specs, "Shopee");
    expect(result.ok && result.value.missingOptional.map((spec) => spec.label)).toEqual([
      "Nama Produk",
      "Nama Variasi",
      "Returned quantity",
      "Subtotal Pesanan",
      "Total Diskon",
      "Diskon Dari Shopee",
    ]);
  });
});

describe("headerSignatureDifferences (plan §19.2)", () => {
  const signature = ["A", "B", "C"];

  test("identical is empty; trailing blank cells are not columns", () => {
    expect(headerSignatureDifferences(["A", "B", "C"], signature)).toEqual([]);
    expect(headerSignatureDifferences(["A", "B", "C", "", null, " "], signature)).toEqual([]);
  });

  test("compared exactly: case and spacing count", () => {
    expect(headerSignatureDifferences(["A", "b", "C"], signature)).toEqual(['kolom "B" tidak ada', 'kolom baru "b"']);
    expect(headerSignatureDifferences(["A", "B ", "C"], signature)).toEqual(['kolom "B" tidak ada', 'kolom baru "B "']);
  });

  test("removed, added, duplicated, untitled and moved columns", () => {
    expect(headerSignatureDifferences(["A", "C"], signature)).toEqual(['kolom "B" tidak ada']);
    expect(headerSignatureDifferences(["A", "B", "C", "D"], signature)).toEqual(['kolom baru "D"']);
    expect(headerSignatureDifferences(["A", "B", "B", "C"], signature)).toEqual(['kolom baru "B"']);
    expect(headerSignatureDifferences(["A", "", "B", "C"], signature)).toEqual(["kolom baru tanpa judul"]);
    expect(headerSignatureDifferences(["B", "A", "C"], signature)).toEqual(["urutan kolom berubah"]);
  });

  test("a long list is cut, the rest counted; a long header is shortened", () => {
    const many = Array.from({ length: 12 }, (_, index) => `X${index}`);
    const result = headerSignatureDifferences([...signature, ...many], signature);
    expect(result).toHaveLength(9);
    expect(result.at(-1)).toBe("dan 4 perubahan lain");
    expect(headerSignatureDifferences(["A", "B", "C", "Y".repeat(200)], signature)).toEqual([`kolom baru "${"Y".repeat(60)}..."`]);
  });
});
