import { describe, expect, test } from "vitest";
import { csvBytes, FAKE_BUYER, shopeeRows, xlsxBytes, type FixtureOrder } from "../../../test/marketplace-fixtures";
import { SHOPEE_MAPPING_VERIFIED } from "./adapters/shopee";
import { MAX_ORDERS } from "./limits";
import { parseMarketplaceFile } from "./parse-file";

const ORDERS: FixtureOrder[] = [
  {
    orderNo: "2410NNN100",
    status: "Selesai",
    orderedAt: "2026-10-22 09:15",
    sellerVoucher: 10000,
    adminFee: 4500,
    serviceFee: 3000,
    lines: [
      { sku: "POKA-FZ-SAGE-M", qty: 1, lineTotal: 249000 },
      { sku: "POKA-FZ-SAGE-L", qty: 2, lineTotal: 498000 },
    ],
  },
  { orderNo: "2410NNN200", status: "Perlu Dikirim", orderedAt: "2026-10-24 21:40", lines: [{ sku: "POKA-FZ-ROSE-S", qty: 1, lineTotal: 259000 }] },
  { orderNo: "2410NNN300", status: "Menunggu Konfirmasi", orderedAt: "2026-10-23 11:00", lines: [{ sku: "POKA-FZ-ROSE-S", qty: 1, lineTotal: 259000 }] },
];

function parse(bytes: Uint8Array, channelId = "shopee", fileName = "pesanan.xlsx") {
  return parseMarketplaceFile({ channelId, fileName, bytes });
}

describe("parseMarketplaceFile: Shopee", () => {
  test("a synthetic export becomes orders, with the file's facts", () => {
    const bytes = xlsxBytes(shopeeRows(ORDERS));
    const result = parse(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = result.value;
    expect(parsed).toMatchObject({
      channelId: "shopee",
      channelLabel: "Shopee",
      format: "xlsx",
      sheetName: "orders",
      headerRowNumber: 1,
      dataRowCount: 4,
      problems: [],
      rowErrors: [],
      rowErrorCount: 0,
      warnings: [],
      unknownStatuses: [{ rawStatus: "Menunggu Konfirmasi", orderCount: 1 }],
      orderedAtRange: { from: new Date("2026-10-22T02:15:00.000Z"), to: new Date("2026-10-24T14:40:00.000Z") },
    });
    expect(parsed.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.orders.map((order) => [order.channelOrderNo, order.statusKey, order.subtotalAmount, order.sellerVoucherAmount, order.fees])).toEqual([
      ["2410NNN100", "selesai", 747000, 10000, { admin_fee: 4500, service_fee: 3000, affiliate_commission: 0 }],
      ["2410NNN200", "perlu dikirim", 259000, 0, { admin_fee: 0, service_fee: 0, affiliate_commission: 0 }],
      ["2410NNN300", "menunggu konfirmasi", 259000, 0, { admin_fee: 0, service_fee: 0, affiliate_commission: 0 }],
    ]);
  });

  test("buyer data in the file never appears anywhere in the result", () => {
    const result = parse(xlsxBytes(shopeeRows(ORDERS)));
    const serialized = JSON.stringify(result);
    for (const value of Object.values(FAKE_BUYER)) expect(serialized).not.toContain(value);
    // Nor do the shipping/ongkir or platform-voucher columns' values (12000 and 5000 per row).
    expect(serialized).not.toContain("12000");
  });

  test("Simpan stays locked until the real header is verified (owner decision 14)", () => {
    const result = parse(xlsxBytes(shopeeRows(ORDERS)));
    expect(SHOPEE_MAPPING_VERIFIED).toBe(false);
    expect(result.ok && result.value.mappingVerified).toBe(false);
    expect(result.ok && result.value.lockedMessage).toBe(
      "Pemetaan kolom Shopee belum diverifikasi dengan file asli, jadi pesanan belum bisa disimpan. Pratinjau tetap bisa dipakai untuk mengecek file.",
    );
  });

  test("save blockers: the lock always, plus rows that belong to no order", () => {
    expect(parse(xlsxBytes(shopeeRows(ORDERS))).ok && (parse(xlsxBytes(shopeeRows(ORDERS))) as { value: { saveBlockers: string[] } }).value.saveBlockers).toEqual([
      "Pemetaan kolom Shopee belum diverifikasi dengan file asli, jadi pesanan belum bisa disimpan. Pratinjau tetap bisa dipakai untuk mengecek file.",
    ]);
    const rows = shopeeRows(ORDERS);
    rows[2]![0] = "";
    const result = parse(xlsxBytes(rows));
    expect(result.ok && result.value.unattributedRowCount).toBe(1);
    expect(result.ok && result.value.saveBlockers[1]).toBe(
      "1 baris berisi data tapi nomor pesanannya kosong atau tidak valid, jadi tidak jelas milik pesanan mana. Perbaiki atau export ulang file, lalu periksa lagi.",
    );
  });

  test("csv row numbers match the file even after a blank line", () => {
    const rows = shopeeRows(ORDERS).map((row) => row.map((cell) => (cell === null || typeof cell === "object" ? null : String(cell))));
    rows.splice(2, 0, []);
    rows[4]![8] = "dua";
    const result = parse(csvBytes(rows), "shopee", "pesanan.csv");
    expect(result.ok && result.value.rowErrors).toEqual([{ rowNumber: 5, columnLabel: "Jumlah", message: "Jumlah harus bilangan bulat." }]);
    expect(result.ok && result.value.blankRowCount).toBe(1);
  });

  test("a csv export (semicolons, BOM) reads the same as the xlsx", () => {
    const rows = shopeeRows(ORDERS).map((row) => row.map((cell) => (cell === null || typeof cell === "object" ? null : String(cell))));
    const result = parse(csvBytes(rows, { delimiter: ";", bom: true }), "shopee", "pesanan.csv");
    expect(result.ok && result.value.orders.map((order) => order.subtotalAmount)).toEqual([747000, 259000, 259000]);
  });

  test("the order sheet is found after other sheets, and below title rows", () => {
    const rows = [["Laporan Pesanan Toko"], [null], ...shopeeRows(ORDERS)];
    const result = parse(xlsxBytes(rows, { sheetsBefore: [{ name: "Petunjuk", rows: [["Baca dulu"]] }] }));
    expect(result.ok && [result.value.sheetName, result.value.headerRowNumber, result.value.orders.length]).toEqual(["orders", 3, 3]);
  });

  test("a missing optional fee column is a warning, not a refusal", () => {
    const rows = shopeeRows(ORDERS).map((row) => row.filter((_, index) => index !== 14));
    const result = parse(xlsxBytes(rows));
    expect(result.ok && result.value.warnings).toEqual(["Kolom Biaya Layanan tidak ada di file; biaya platform pesanan di file ini dihitung belum lengkap."]);
    expect(result.ok && result.value.orders[0]!.fees).toEqual({ admin_fee: 4500, affiliate_commission: 0 });
  });

  test("a missing required column refuses the file, naming it", () => {
    const rows = shopeeRows(ORDERS).map((row) => row.filter((_, index) => index !== 8));
    const result = parse(xlsxBytes(rows));
    expect(result).toEqual({
      ok: false,
      error: { code: "missing_columns", message: "Kolom wajib tidak ditemukan: Jumlah. Pastikan file adalah export Pesanan dari Shopee Seller Center." },
    });
  });

  test("a file that is not a Shopee order export is refused (channel check)", () => {
    const tiktokShaped = [["Order ID", "Order Status", "Seller SKU", "Quantity"], ["5770001112", "Completed", "A-M", 1]];
    const result = parse(xlsxBytes(tiktokShaped));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("missing_columns");
    const unrelated = parse(xlsxBytes([["Nama", "Alamat"], ["x", "y"]]));
    expect(!unrelated.ok && unrelated.error.code).toBe("not_this_channel");
  });

  test("an Excel date serial in Waktu Pesanan Dibuat works", () => {
    const serial = 46318 + (14 * 60 + 5) / 1440;
    const result = parse(xlsxBytes(shopeeRows([{ ...ORDERS[1]!, orderedAt: serial }])));
    expect(result.ok && result.value.orders[0]!.orderedAt).toEqual(new Date("2026-10-23T07:05:00.000Z"));
  });

  test("more orders than the limit refuse the file", () => {
    const many: FixtureOrder[] = Array.from({ length: MAX_ORDERS + 1 }, (_, index) => ({
      orderNo: `ORD${String(index).padStart(6, "0")}`,
      lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }],
    }));
    const result = parse(xlsxBytes(shopeeRows(many)));
    expect(!result.ok && result.error.code).toBe("too_many_orders");
  });

  test("row errors are listed up to a cap and counted in full", () => {
    const bad: FixtureOrder[] = Array.from({ length: 250 }, (_, index) => ({
      orderNo: `BAD${String(index).padStart(6, "0")}`,
      lines: [{ sku: "A-M", qty: "x", lineTotal: 1000 }],
    }));
    const result = parse(xlsxBytes(shopeeRows(bad)));
    expect(result.ok && [result.value.rowErrors.length, result.value.rowErrorCount, result.value.problems.length]).toEqual([200, 250, 250]);
  });

  test("file-level refusals pass through", () => {
    expect(parse(new Uint8Array(), "shopee").ok).toBe(false);
  });
});

describe("parseMarketplaceFile: TikTok Shop and unknown channels", () => {
  test("TikTok is refused before any row is read, with the Indonesian message", () => {
    const result = parse(xlsxBytes(shopeeRows(ORDERS)), "tiktok");
    expect(result).toEqual({
      ok: false,
      error: {
        code: "channel_not_ready",
        message:
          "Format export TikTok Shop belum dikonfirmasi, jadi file belum bisa diimpor. Kirim contoh baris judul kolom (tanpa data pembeli) ke admin teknis untuk dipasang dulu.",
      },
    });
  });

  test("a channel that is not a marketplace is refused", () => {
    for (const channelId of ["web", "toString", "__proto__", ""]) {
      expect(parse(xlsxBytes(shopeeRows(ORDERS)), channelId)).toEqual({ ok: false, error: { code: "channel_not_ready", message: "Kanal ini tidak bisa diimpor." } });
    }
  });
});
