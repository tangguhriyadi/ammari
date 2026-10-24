import { describe, expect, test } from "vitest";
import { shopeeAdapter } from "./adapters/shopee";
import { columnSpecId } from "./adapters/types";
import { MARKETPLACE_ADAPTERS } from "./adapters";
import { locateHeader, normalizeHeader } from "./headers";
import type { Cell } from "./read-sheet";

const specs = shopeeAdapter.columns!;
const REQUIRED = ["No. Pesanan", "Status Pesanan", "Waktu Pesanan Dibuat", "Nomor Referensi SKU", "Jumlah", "Total Harga Produk", "Voucher Ditanggung Penjual"];

describe("normalizeHeader", () => {
  test("case, spacing, full-width characters and a trailing currency unit do not matter", () => {
    expect(normalizeHeader("  Total   Harga\u00a0Produk (Rp) ")).toBe("total harga produk");
    expect(normalizeHeader("TOTAL HARGA PRODUK (IDR)")).toBe("total harga produk");
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
    expect(result.value.columns.get("sku")).toBe(3);
    expect(result.value.columns.get("sellerVoucher")).toBe(6);
  });

  test("finds the header below title rows", () => {
    const rows: Cell[][] = [["Laporan Pesanan"], [null], [...REQUIRED], ["X"]];
    const result = locateHeader(rows, specs, "Shopee");
    expect(result.ok && result.value.headerRowIndex).toBe(2);
  });

  test("English Seller Center headers map to the same columns", () => {
    const english = ["Order ID", "Order Status", "Order Creation Date", "SKU Reference No.", "Quantity", "Product Subtotal", "Seller Voucher"];
    const result = locateHeader([english], specs, "Shopee");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.columns.keys()].sort()).toEqual(["channelOrderNo", "lineTotal", "orderedAt", "qty", "sellerVoucher", "sku", "status"]);
  });

  test("lists every missing required column by its Seller Center name", () => {
    const result = locateHeader([["No. Pesanan", "Status Pesanan", "Waktu Pesanan Dibuat", "Total Harga Produk", "Voucher Ditanggung Penjual"]], specs, "Shopee");
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

  test("two aliases of one column in the same file are refused too", () => {
    const result = locateHeader([[...REQUIRED, "Quantity"]], specs, "Shopee");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ambiguous_columns");
  });

  test("unknown and duplicated unmapped columns are ignored", () => {
    const result = locateHeader([[...REQUIRED, "Catatan", "Catatan", "SKU Induk"]], specs, "Shopee");
    expect(result.ok).toBe(true);
  });

  test("reports optional columns that are missing", () => {
    const result = locateHeader([REQUIRED], specs, "Shopee");
    expect(result.ok && result.value.missingOptional.map((spec) => spec.label)).toEqual([
      "Biaya Administrasi",
      "Biaya Layanan",
      "Biaya Komisi AMS",
      "Nama Produk",
      "Nama Variasi",
    ]);
  });
});
