import { describe, expect, test } from "vitest";
import { shopeeColumn, shopeeRows, type FixtureOrder } from "../../../test/marketplace-fixtures";
import { shopeeAdapter } from "./adapters/shopee";
import type { ColumnSpec } from "./adapters/types";
import { groupOrders } from "./group-orders";
import { locateHeader } from "./headers";
import type { Cell } from "./read-sheet";

function group(rows: Cell[][], specs: readonly ColumnSpec[] = shopeeAdapter.columns!) {
  const header = locateHeader(rows, specs, "Uji");
  if (!header.ok) throw new Error(header.error.message);
  const result = groupOrders({ rows, headerRowIndex: header.value.headerRowIndex, columns: header.value.columns, specs, date1904: false, now: new Date() });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const shopee = (orders: FixtureOrder[]) => group(shopeeRows(orders) as Cell[][]);

describe("the double-count rule", () => {
  test("voucher and seller bundle discount repeated on every row of a 3-row order are counted once", () => {
    const { orders, problems } = shopee([
      {
        orderNo: "2410AAA111",
        sellerVoucher: 10000,
        sellerBundleDiscount: 3000,
        lines: [
          { sku: "POKA-FZ-SAGE-M", qty: 1, lineTotal: 249000 },
          { sku: "POKA-FZ-SAGE-L", qty: 1, lineTotal: 249000 },
          { sku: "POKA-FZ-ROSE-M", qty: 2, lineTotal: 498000 },
        ],
      },
    ]);
    expect(problems).toEqual([]);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ subtotalAmount: 996000, sellerDiscounts: { product: 0, voucher: 10000, bundle: 3000 }, sellerDiscountAmount: 13000, fees: {}, rowNumbers: [2, 3, 4] });
  });

  test("an order-level value only on the first row is still counted once", () => {
    const rows = shopeeRows([
      {
        orderNo: "2410BBB222",
        sellerVoucher: 15000,
        sellerBundleDiscount: 2000,
        lines: [
          { sku: "POKA-FZ-SAGE-M", qty: 1, lineTotal: 249000 },
          { sku: "POKA-FZ-SAGE-L", qty: 1, lineTotal: 249000 },
        ],
      },
    ]) as Cell[][];
    rows[2]![shopeeColumn("Voucher Ditanggung Penjual")] = null; // second item row
    rows[2]![shopeeColumn("Paket Diskon (Diskon dari Penjual)")] = "";
    const { orders } = group(rows);
    expect(orders[0]).toMatchObject({ sellerDiscounts: { voucher: 15000, bundle: 2000 }, sellerDiscountAmount: 17000 });
  });

  test("an order-level value that differs between rows keeps the order out, naming the column", () => {
    const rows = shopeeRows([
      {
        orderNo: "2410CCC333",
        sellerVoucher: 5000,
        lines: [
          { sku: "POKA-FZ-SAGE-M", qty: 1, lineTotal: 249000 },
          { sku: "POKA-FZ-SAGE-L", qty: 1, lineTotal: 249000 },
        ],
      },
    ]) as Cell[][];
    rows[2]![shopeeColumn("Voucher Ditanggung Penjual")] = "7.000";
    const { orders, problems } = group(rows);
    expect(orders).toEqual([]);
    expect(problems).toEqual([
      {
        channelOrderNo: "2410CCC333",
        rowNumbers: [2, 3],
        code: "inconsistent_values",
        message: "Nilai Voucher Ditanggung Penjual berbeda antar baris pesanan ini, jadi pesanan belum diimpor.",
      },
    ]);
  });

  test("status texts that differ only in case or spacing agree", () => {
    const rows = shopeeRows([{ orderNo: "2410DDD444", lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }, { sku: "A-L", qty: 1, lineTotal: 1000 }] }]) as Cell[][];
    rows[1]![1] = "Selesai";
    rows[2]![1] = " SELESAI ";
    const { orders } = group(rows);
    expect(orders[0]).toMatchObject({ rawStatus: "Selesai", statusKey: "selesai" });
  });

  test("a line-scope fee or voucher is summed over the rows (another adapter's shape)", () => {
    const specs: ColumnSpec[] = [
      { field: "channelOrderNo", label: "Order ID", aliases: ["Order ID"], required: true },
      { field: "status", label: "Status", aliases: ["Status"], required: true },
      { field: "orderedAt", label: "Created", aliases: ["Created"], required: true },
      { field: "sku", label: "SKU", aliases: ["SKU"], required: true },
      { field: "qty", label: "Qty", aliases: ["Qty"], required: true },
      { field: "listUnitPrice", label: "Price", aliases: ["Price"], required: true },
      { field: "sellerVoucher", label: "Voucher toko", aliases: ["Voucher toko"], required: true, scope: "line" },
      { field: "fee", component: "affiliate_commission", label: "Komisi afiliasi", aliases: ["Komisi afiliasi"], required: false, scope: "line" },
      { field: "fee", component: "platform_commission", label: "Komisi platform", aliases: ["Komisi platform"], required: false, scope: "order" },
    ];
    const rows: Cell[][] = [
      ["Order ID", "Status", "Created", "SKU", "Qty", "Price", "Voucher toko", "Komisi afiliasi", "Komisi platform"],
      ["5770001112", "Selesai", "2026-10-23 10:00", "A-M", "1", "100.000", "2.000", "5.000", "9.000"],
      ["5770001112", "Selesai", "2026-10-23 10:00", "A-L", "1", "100.000", "3.000", "7.000", "9.000"],
    ];
    const { orders } = group(rows, specs);
    expect(orders[0]).toMatchObject({ sellerDiscountAmount: 5000, priceMismatchRows: [], fees: { affiliate_commission: 12000, platform_commission: 9000 } });
  });
});

describe("lines", () => {
  test("rows with the same SKU merge: qty summed, unit price the weighted average", () => {
    const { orders } = shopee([
      {
        orderNo: "2410EEE555",
        lines: [
          { sku: "POKA-FZ-SAGE-M", qty: 1, lineTotal: 249000 },
          { sku: "poka-fz-sage-m", qty: 2, lineTotal: 450000 },
        ],
      },
    ]);
    expect(orders[0]!.lines).toEqual([
      { sku: "POKA-FZ-SAGE-M", qty: 3, unitPrice: 233000, lineTotal: 699000, rowNumbers: [2, 3], nameHints: ["Gamis Uji", "Sage,M"] },
    ]);
    expect(orders[0]).toMatchObject({ subtotalAmount: 699000, roundingDifference: 0 });
  });

  test("merged-line rounding is reported, not hidden", () => {
    const { orders } = shopee([
      {
        orderNo: "2410FFF666",
        lines: [
          { sku: "A-M", qty: 1, lineTotal: 100000 },
          { sku: "A-M", qty: 2, listUnitPrice: 100001 },
        ],
      },
    ]);
    // 300.002 / 3 rounds to 100.001 a piece: the admin lines add up to 1 more than the file.
    expect(orders[0]).toMatchObject({ subtotalAmount: 300003, roundingDifference: -1 });
    expect(orders[0]!.lines[0]!.unitPrice).toBe(100001);
  });

  test("names are hints only: same name with different SKUs stays two lines, a blank SKU stays unknown", () => {
    const { orders } = shopee([
      {
        orderNo: "2410GGG777",
        lines: [
          { sku: "A-M", qty: 1, lineTotal: 1000, productName: "Gamis Poka", variationName: "Sage,M" },
          { sku: "A-L", qty: 1, lineTotal: 1000, productName: "Gamis Poka", variationName: "Sage,M" },
          { sku: null, qty: 1, lineTotal: 1000, productName: "Gamis Poka", variationName: "Sage,M" },
        ],
      },
    ]);
    expect(orders[0]!.lines.map((line) => line.sku)).toEqual(["A-M", "A-L", null]);
    expect(orders[0]!.lines[2]!.nameHints).toEqual(["Gamis Poka", "Sage,M"]);
  });

  test("a voucher larger than the goods keeps the order out", () => {
    const { orders, problems } = shopee([{ orderNo: "2410HHH888", sellerVoucher: 2000, lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }] }]);
    expect(orders).toEqual([]);
    expect(problems[0]).toMatchObject({ code: "voucher_exceeds_subtotal" });
  });
});

describe("invalid rows", () => {
  test("a bad cell keeps its whole order out and is reported with row and column; other orders are kept", () => {
    const { orders, problems, rowErrors } = shopee([
      { orderNo: "2410III999", lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }, { sku: "A-L", qty: "dua", lineTotal: 1000 }] },
      { orderNo: "2410JJJ000", lines: [{ sku: "A-M", qty: 1, listUnitPrice: "1.000", unitPriceAfterDiscount: "1.000" }] },
    ]);
    expect(orders.map((order) => order.channelOrderNo)).toEqual(["2410JJJ000"]);
    expect(problems).toEqual([expect.objectContaining({ channelOrderNo: "2410III999", code: "invalid_rows", rowNumbers: [2, 3] })]);
    expect(problems[0]!.message).toContain("baris 3");
    expect(rowErrors).toEqual([{ rowNumber: 3, columnLabel: "Jumlah", message: "Jumlah harus bilangan bulat." }]);
  });

  test("a row without a usable order number is reported on its own", () => {
    const { orders, rowErrors } = shopee([{ orderNo: "=HYPERLINK(1)", lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }] }]);
    expect(orders).toEqual([]);
    expect(rowErrors).toEqual([{ rowNumber: 2, columnLabel: "No. Pesanan", message: "Nomor pesanan hanya boleh huruf dan angka (6 sampai 32 karakter)." }]);
  });

  test("a blank status or order time keeps the order out", () => {
    const { problems } = shopee([
      { orderNo: "2410KKK111", status: "", lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }] },
      { orderNo: "2410LLL222", orderedAt: "", lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }] },
    ]);
    expect(problems.map((problem) => [problem.channelOrderNo, problem.code, problem.message])).toEqual([
      ["2410KKK111", "missing_value", "Status Pesanan kosong untuk pesanan ini, jadi pesanan belum diimpor."],
      ["2410LLL222", "missing_value", "Waktu Pesanan Dibuat kosong untuk pesanan ini, jadi pesanan belum diimpor."],
    ]);
  });

  test("a row of a multi-item order with a bad order number is counted as unattributed (it could belong to any order)", () => {
    const rows = shopeeRows([
      {
        orderNo: "2410OOO444",
        lines: [
          { sku: "A-M", qty: 1, lineTotal: 1000 },
          { sku: "A-L", qty: 1, lineTotal: 1000 },
          { sku: "A-S", qty: 1, lineTotal: 1000 },
        ],
      },
    ]) as Cell[][];
    rows[3]![0] = null;
    const result = group(rows);
    expect(result.unattributedRowCount).toBe(1);
    expect(result.rowErrors).toEqual([{ rowNumber: 4, columnLabel: "No. Pesanan", message: "Nomor pesanan kosong atau tidak valid." }]);
  });

  test("a status that normalizes to nothing is invalid, not a status", () => {
    const { problems, rowErrors } = shopee([{ orderNo: "2410PPP555", status: "(Rp)", lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }] }]);
    expect(problems[0]).toMatchObject({ code: "invalid_rows" });
    expect(rowErrors[0]).toMatchObject({ columnLabel: "Status Pesanan", message: "Status pesanan tidak valid." });
  });

  test("order times that really differ between rows keep the order out", () => {
    const rows = shopeeRows([{ orderNo: "2410QQQ666", lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }, { sku: "A-L", qty: 1, lineTotal: 1000 }] }]) as Cell[][];
    rows[2]![shopeeColumn("Waktu Pesanan Dibuat")] = "2026-10-23 14:06";
    expect(group(rows).problems[0]).toMatchObject({ code: "inconsistent_values", message: expect.stringContaining("Waktu Pesanan Dibuat") });
  });

  test("rows whose mapped columns are all blank are skipped and counted", () => {
    const rows = shopeeRows([{ orderNo: "2410MMM333", lines: [{ sku: "A-M", qty: 1, lineTotal: 1000 }] }]) as Cell[][];
    // "Total" in an unmapped column (No. Resi): the mapped ones are all blank.
    rows.push(Array.from({ length: 49 }, (_, index) => (index === shopeeColumn("No. Resi") ? "Total" : null)));
    const result = group(rows);
    expect(result).toMatchObject({ blankRowCount: 1, dataRowCount: 1 });
  });
});
