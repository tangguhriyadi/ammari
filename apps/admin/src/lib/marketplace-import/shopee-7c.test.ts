import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertOrder, insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { importBatchOrders, orderChannelFees, orderItems, orders, productVariants, stockMovements, type OrderStatus } from "@ammari/db/schema";
import { FAKE_BUYER, SHOPEE_HEADER, shopeeColumn, shopeeRows, xlsxBytes, type FixtureCell, type FixtureOrder } from "../../../test/marketplace-fixtures";
import { SHOPEE_MAPPING_VERIFIED, shopeeAdapter } from "./adapters/shopee";
import { commitImport, type CommitOutcome } from "./commit";
import { parseMarketplaceFile, type ParsedImport } from "./parse-file";
import { MULTI_ROW_DISCOUNT_MESSAGE_PREFIX, planImport, type ImportPlan, type PlanEntry } from "./plan";
import { toImportPreview } from "./preview-view";

// Session 7c (docs/plans/marketplace-import.md §19.9, §19.10): the guarded unlock. The mapping lock
// is off; every case no real file has shown yet keeps its own hold. Synthetic fixtures only, the
// exact 49 headers in order, every cell text. TDD for the parser and the money/stock paths.

const NOW = new Date("2026-11-28T12:00:00Z");

/** Parse as production does: no test unlock of any kind. */
function parseRows(rows: FixtureCell[][], options: { assumeMappingVerified?: boolean } = {}): ParsedImport {
  const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(rows), now: NOW, ...options });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const parse = (orders: readonly FixtureOrder[], options: { assumeMappingVerified?: boolean } = {}) => parseRows(shopeeRows(orders), options);

interface Seeded {
  sku: (suffix: string) => string;
  orderNo: (suffix: string) => string;
}

async function seedVariants(tx: TestDatabase, suffixes: readonly string[], stock = 10): Promise<Seeded> {
  const marker = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const { product, fabric } = await insertProductVariant(tx);
  const sku = (suffix: string) => `SC${marker}-${suffix}`;
  for (const suffix of suffixes) {
    const color = await insertFabricColor(tx, fabric.id);
    await tx.insert(productVariants).values({ sku: sku(suffix), productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: "front_zip", size: "M" });
    await tx.insert(stockMovements).values({ sku: sku(suffix), qty: stock, valueAmount: stock * 100_000, type: "production", refType: "manual" });
  }
  return { sku, orderNo: (suffix: string) => `${marker}${suffix}` };
}

async function plan(tx: TestDatabase, parsed: ParsedImport): Promise<ImportPlan> {
  const result = await planImport(parsed, {}, tx);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function previewAndCommit(tx: TestDatabase, parsed: ParsedImport, staffId: string): Promise<CommitOutcome> {
  const preview = await plan(tx, parsed);
  return commitImport({ parsed, fileName: "pesanan.xlsx", options: {}, expectedDigest: preview.digest, actorStaffUserId: staffId }, tx);
}

function entry(planned: ImportPlan, channelOrderNo: string): PlanEntry {
  const found = planned.entries.find((candidate) => candidate.channelOrderNo === channelOrderNo);
  if (!found) throw new Error(`no plan entry for ${channelOrderNo}`);
  return found;
}

function codes(found: PlanEntry): string[] {
  return found.action === "review" ? found.reasons.map((reason) => reason.code) : [];
}

async function orderByChannelNo(tx: TestDatabase, channelOrderNo: string) {
  const [order] = await tx.select().from(orders).where(and(eq(orders.channelId, "shopee"), eq(orders.channelOrderNo, channelOrderNo)));
  return order;
}

async function stockOf(tx: TestDatabase, sku: string): Promise<number> {
  const [row] = await tx.select({ qty: sql<string>`coalesce(sum(${stockMovements.qty}), 0)::bigint` }).from(stockMovements).where(eq(stockMovements.sku, sku));
  return Number(row?.qty ?? 0);
}

async function insertExisting(tx: TestDatabase, channelOrderNo: string, status: OrderStatus, sku: string) {
  const order = await insertOrder(tx, {
    channelId: "shopee",
    channelOrderNo,
    status,
    subtotalAmount: 229_000,
    shippingAmount: 0,
    discountAmount: 0,
    orderDate: new Date("2026-11-27T03:00:00Z"),
    channelStatus: "Perlu Dikirim",
  });
  await tx.insert(orderItems).values({ orderId: order.id, sku, qty: 1, unitPrice: 229_000, unitCost: 100_000 });
  return order;
}

/** The owner's second real export (28 Nov 2026, "Order.unpaid"): one row, value shapes as recorded in
 * plan §19.1 (order number, SKU and amounts as reported; buyer columns replaced by FAKE_BUYER). */
function secondRealFileRow(): FixtureCell[] {
  const row: FixtureCell[] = [
    "261128FUGHDG5C", // 0 No. Pesanan
    "Belum Bayar", // 1
    "", // 2
    "", // 3
    "Instant Prioritas", // 4
    "", // 5
    "", // 6
    "", // 7
    "2026-11-28 09:41", // 8
    "-", // 9 Waktu Pembayaran Dilakukan: a dash, not blank
    "", // 10
    "Online Payment", // 11
    "", // 12 SKU Induk
    "AMMARI Haura Dress Anti UV", // 13
    "HAURA-FZ-TAUPE-M", // 14 the variant seller SKU
    "Taupe,M", // 15
    "229.000", // 16
    "229.000", // 17
    "1", // 18
    "0", // 19
    "229.000", // 20
    "0", // 21
    "0", // 22
    "0", // 23
    "700 gr", // 24
    "1", // 25
    "700 gr", // 26
    "0", // 27
    "0", // 28
    "0", // 29
    "N", // 30
    "0", // 31
    "0", // 32
    "0", // 33
    "0", // 34
    "8.000", // 35
    "0", // 36
    "0", // 37
    "240.000", // 38 Total Pembayaran: 229.000 + 8.000 + a 3.000 buyer fee with no column of its own
    "8.000", // 39
    FAKE_BUYER.buyerNote,
    FAKE_BUYER.note,
    FAKE_BUYER.username,
    FAKE_BUYER.name,
    FAKE_BUYER.phone,
    FAKE_BUYER.address,
    FAKE_BUYER.city,
    FAKE_BUYER.province,
    "", // 48
  ];
  expect(row).toHaveLength(SHOPEE_HEADER.length);
  return row;
}

describe("the unlock (plan §19.9 7c)", () => {
  test("SHOPEE_MAPPING_VERIFIED is true: a clean file has no save blocker and no lock notice", () => {
    expect(SHOPEE_MAPPING_VERIFIED).toBe(true);
    const parsed = parse([{ orderNo: "2611CLN001", status: "Perlu Dikirim", lines: [{ sku: "A-M", qty: 1, lineTotal: 229_000 }] }]);
    expect(parsed.mappingVerified).toBe(true);
    expect(parsed.lockedMessage).toBeNull();
    expect(parsed.saveBlockers).toEqual([]);
  });

  test("the header signature still blocks saving a changed format", () => {
    const rows = shopeeRows([{ orderNo: "2611CLN001", status: "Perlu Dikirim", lines: [{ sku: "A-M", qty: 1, lineTotal: 229_000 }] }]);
    rows[0]![shopeeColumn("Total Berat")] = "Total Berat (kg)";
    expect(parseRows(rows).saveBlockers).toEqual([expect.stringContaining("Format export Shopee berubah sejak 27 Nov 2026")]);
  });

  test("statuses: seen ones are marked seen; only Dikirim / Sedang Dikirim stay unverified", () => {
    const seen = Object.entries(shopeeAdapter.statusMap)
      .filter(([, entry]) => entry.seenInRealFile)
      .map(([key]) => key);
    expect(seen.sort()).toEqual(["batal", "belum bayar", "dalam pengembalian", "perlu dikirim", "selesai"]);
    expect(parse([]).unverifiedStatusKeys).toEqual(["dikirim", "sedang dikirim"]);
    // The test/e2e-only unlock treats them as seen (shipped-path tests); production never can.
    expect(parse([], { assumeMappingVerified: true }).unverifiedStatusKeys).toEqual([]);
  });
});

describe("the second real file's row shape (28 Nov 2026)", () => {
  test("maps cleanly: no row error, the variant SKU from col 14, the dash in col 9 is no payment time", () => {
    const parsed = parseRows([[...SHOPEE_HEADER], secondRealFileRow()]);
    expect(parsed.saveBlockers).toEqual([]);
    expect(parsed.rowErrors).toEqual([]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.orders).toEqual([
      expect.objectContaining({
        channelOrderNo: "261128FUGHDG5C",
        rawStatus: "Belum Bayar",
        statusKey: "belum bayar",
        cancelReturnStatus: null,
        orderedAt: new Date("2026-11-28T02:41:00.000Z"),
        lines: [{ sku: "HAURA-FZ-TAUPE-M", qty: 1, unitPrice: 229_000, lineTotal: 229_000, rowNumbers: [2], nameHints: ["AMMARI Haura Dress Anti UV", "Taupe,M"] }],
        subtotalAmount: 229_000,
        sellerDiscountAmount: 0,
        returnedQty: 0,
        priceMismatchRows: [],
        fileSubtotals: [229_000],
        discountedRowNumbers: [],
        shippedAt: null,
        completedAt: null,
      }),
    ]);
    // Total Pembayaran (240.000) and buyer ongkir (8.000) are never read; buyer columns never leave.
    const serialized = JSON.stringify(parsed);
    for (const value of [...Object.values(FAKE_BUYER), "240000", "240.000", "8000", "Instant Prioritas", "Online Payment"]) expect(serialized).not.toContain(value);
  });

  test('"-" in Waktu Pembayaran Dilakukan is never a row error, whatever the status', () => {
    for (const status of ["Perlu Dikirim", "Belum Bayar", "Selesai", "Batal", "Dalam Pengembalian", "Dikirim"]) {
      const parsed = parse([{ orderNo: "2611DSH001", status, paymentTime: "-", lines: [{ sku: "A-M", qty: 1, lineTotal: 229_000 }] }]);
      expect(parsed.rowErrors).toEqual([]);
      expect(parsed.orders).toHaveLength(1);
    }
  });
});

describe("the multi-row discount guard, parser side (O1-a / O1-b unverified)", () => {
  const twoRows = (extra: Partial<FixtureOrder> = {}, lineExtra: Partial<FixtureOrder["lines"][number]> = {}): FixtureOrder => ({
    orderNo: "2611MRD001",
    status: "Perlu Dikirim",
    lines: [
      { sku: "A-M", qty: 1, lineTotal: 229_000, ...lineExtra },
      { sku: "A-L", qty: 1, lineTotal: 229_000 },
    ],
    ...extra,
  });

  test("all discount columns zero: no row is flagged", () => {
    expect(parse([twoRows()]).orders[0]!.discountedRowNumbers).toEqual([]);
  });

  test("each guarded column flags its row: 21-23 per row, 27 and 29-33 order level (repeated on every row)", () => {
    const cases: [string, Partial<FixtureOrder>, Partial<FixtureOrder["lines"][number]>, number[]][] = [
      ["Diskon Dari Penjual (22, with 21)", {}, { sellerDiscount: 10_000 }, [2]],
      ["Diskon Dari Shopee (23, with 21)", {}, { shopeeDiscount: 10_000 }, [2]],
      ["Voucher Ditanggung Penjual (27)", { sellerVoucher: 5_000 }, {}, [2, 3]],
      ["Voucher Ditanggung Shopee (29)", { shopeeVoucher: 5_000 }, {}, [2, 3]],
      ["Paket Diskon Y (30)", { bundleFlag: "Y" }, {}, [2, 3]],
      ["Paket Diskon (Diskon dari Shopee) (31)", { shopeeBundleDiscount: 5_000 }, {}, [2, 3]],
      ["Paket Diskon (Diskon dari Penjual) (32)", { sellerBundleDiscount: 5_000 }, {}, [2, 3]],
      ["Potongan Koin Shopee (33)", { shopeeCoins: 5_000 }, {}, [2, 3]],
    ];
    for (const [label, extra, lineExtra, rows] of cases) {
      const parsed = parse([twoRows(extra, lineExtra)]);
      expect({ label, rowErrors: parsed.rowErrors, flagged: parsed.orders[0]?.discountedRowNumbers }).toEqual({ label, rowErrors: [], flagged: rows });
    }
  });

  test("Total Diskon alone (21) flags its row", () => {
    const parsed = parse([twoRows({}, { totalDiscount: 10_000, unitPriceAfterDiscount: 219_000 })]);
    // 21 = 22 + 23 fails too (price check); the guard sees the column regardless.
    expect(parsed.orders[0]!.discountedRowNumbers).toEqual([2]);
  });

  test("Cashback Koin (28) and Diskon Kartu Kredit (34) are not guarded", () => {
    expect(parse([twoRows({ coinCashback: 5_000 })]).orders[0]!.discountedRowNumbers).toEqual([]);
  });

  test("Paket Diskon other than N, Y or blank is a row error, never guessed", () => {
    const parsed = parse([twoRows({ bundleFlag: "Ya" })]);
    expect(parsed.rowErrors).toEqual([
      { rowNumber: 2, columnLabel: "Paket Diskon", message: "Paket Diskon harus N atau Y." },
      { rowNumber: 3, columnLabel: "Paket Diskon", message: "Paket Diskon harus N atau Y." },
    ]);
    expect(parse([twoRows({ bundleFlag: "" })]).rowErrors).toEqual([]);
  });
});

describe("planner: Belum Bayar, unverified statuses, and the guards (plan §19.4, 7c)", () => {
  test("a new Belum Bayar order is skipped, never held, counted as 'belum dibayar (dilewati)'", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const parsed = parse([
        { orderNo: s.orderNo("U1"), status: "Belum Bayar", paymentTime: "-", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] },
        // Even with a blank SKU and a cancel/return text: a skip needs nothing else checked.
        { orderNo: s.orderNo("U2"), status: "Belum Bayar", paymentTime: "-", cancelReturnStatus: "Pembatalan Diajukan", lines: [{ sku: null, qty: 1, lineTotal: 229_000 }] },
        { orderNo: s.orderNo("P1"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] },
      ]);
      const planned = await plan(tx, parsed);
      expect(entry(planned, s.orderNo("U1"))).toMatchObject({ action: "skip", reason: "unpaid" });
      expect(entry(planned, s.orderNo("U2"))).toMatchObject({ action: "skip", reason: "unpaid" });
      expect(planned.counts).toMatchObject({ create: 1, skip: 2, review: 0 });
      expect(planned.unpaidSkippedCount).toBe(2);
      expect(planned.blankSkuOrderCount).toBe(0);
      expect(toImportPreview(parsed, planned, { canViewProfit: false }).unpaidSkippedCount).toBe(2);
    });
  });

  test("an order already in admin that the file shows as Belum Bayar is held, never reverted", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const existing: [string, OrderStatus][] = [
        ["T", "to_ship"],
        ["S", "shipped"],
        ["C", "completed"],
        ["X", "cancelled"],
        ["W", "awaiting_payment"],
      ];
      for (const [suffix, status] of existing) await insertExisting(tx, s.orderNo(suffix), status, s.sku("M"));
      const planned = await plan(tx, parse(existing.map(([suffix]) => ({ orderNo: s.orderNo(suffix), status: "Belum Bayar", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] }))));
      for (const [suffix] of existing) {
        expect(entry(planned, s.orderNo(suffix))).toMatchObject({
          action: "review",
          reasons: [{ code: "unpaid_in_admin", message: "Pesanan ini sudah ada di admin, tapi di file Shopee statusnya Belum Bayar. Status di admin tidak diubah; periksa manual." }],
        });
      }
      expect(planned.unpaidSkippedCount).toBe(0);
    });
  });

  test("Dikirim and Sedang Dikirim are held as unverified spellings, new or existing; the test unlock treats them as seen", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, s.orderNo("E"), "to_ship", s.sku("M"));
      const fileOrders: FixtureOrder[] = [
        { orderNo: s.orderNo("D"), status: "Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] },
        { orderNo: s.orderNo("E"), status: "Sedang Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] },
      ];
      const planned = await plan(tx, parse(fileOrders));
      expect(entry(planned, s.orderNo("D"))).toMatchObject({
        action: "review",
        reasons: [{ code: "status_unverified", message: "Status 'Dikirim' belum pernah terlihat di file asli Shopee, jadi pesanan belum diimpor. Kirim baris judul dan nilai status ini ke admin teknis." }],
      });
      expect(codes(entry(planned, s.orderNo("E")))).toEqual(["status_unverified"]);
      const trusted = await plan(tx, parse(fileOrders, { assumeMappingVerified: true }));
      expect(entry(trusted, s.orderNo("D")).action).toBe("create");
      expect(entry(trusted, s.orderNo("E")).action).toBe("update");
    });
  });

  test("an unknown Status Pesanan value is held", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("Q"), status: "Menunggu Diproses", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] }]));
      expect(codes(entry(planned, s.orderNo("Q")))).toEqual(["unknown_status"]);
    });
  });

  test("a multi-row order with all guarded columns zero is created; Subtotal Pesanan stays display only", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      // Subtotal Pesanan repeated as the order total on each row (one possible O1-b reading): unused.
      const planned = await plan(
        tx,
        parse([
          {
            orderNo: s.orderNo("Z"),
            status: "Perlu Dikirim",
            lines: [
              { sku: s.sku("M"), qty: 1, lineTotal: 229_000, fileSubtotal: 687_000 },
              { sku: s.sku("L"), qty: 2, lineTotal: 458_000, fileSubtotal: 687_000 },
            ],
          },
        ]),
      );
      expect(entry(planned, s.orderNo("Z"))).toMatchObject({ action: "create", subtotalAmount: 687_000, discountAmount: 0, totalAmount: 687_000 });
    });
  });

  test("a multi-row order with any guarded column non-zero is held; a single-row discounted order is not", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      const planned = await plan(
        tx,
        parse([
          { orderNo: s.orderNo("H"), status: "Perlu Dikirim", sellerVoucher: 10_000, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }, { sku: s.sku("L"), qty: 1, lineTotal: 229_000 }] },
          // Two rows of ONE SKU are still two rows: guarded.
          { orderNo: s.orderNo("R"), status: "Perlu Dikirim", shopeeVoucher: 5_000, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }, { sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] },
          { orderNo: s.orderNo("O"), status: "Perlu Dikirim", sellerVoucher: 10_000, shopeeVoucher: 5_000, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000, sellerDiscount: 9_000 }] },
        ]),
      );
      const held = entry(planned, s.orderNo("H"));
      expect(held).toMatchObject({ action: "review", reasons: [{ code: "multi_row_discount" }] });
      expect(held.action === "review" && held.reasons[0]!.message).toBe(`${MULTI_ROW_DISCOUNT_MESSAGE_PREFIX} (baris 2, 3). Pesanan belum diimpor sampai pola diskon file Shopee terverifikasi.`);
      expect(MULTI_ROW_DISCOUNT_MESSAGE_PREFIX).toBe("Pesanan multi-barang dengan diskon belum terverifikasi");
      expect(codes(entry(planned, s.orderNo("R")))).toEqual(["multi_row_discount"]);
      expect(entry(planned, s.orderNo("O"))).toMatchObject({ action: "create", subtotalAmount: 229_000, discountAmount: 19_000 });
    });
  });

  test("the digest follows the new hold decisions", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      const lines = [
        { sku: s.sku("M"), qty: 1, lineTotal: 229_000 },
        { sku: s.sku("L"), qty: 1, lineTotal: 229_000 },
      ];
      const clean = await plan(tx, parse([{ orderNo: s.orderNo("D"), status: "Perlu Dikirim", lines }]));
      const discounted = await plan(tx, parse([{ orderNo: s.orderNo("D"), status: "Perlu Dikirim", sellerVoucher: 10_000, lines }]));
      const unverified = await plan(tx, parse([{ orderNo: s.orderNo("D"), status: "Dikirim", lines }]));
      expect(new Set([clean.digest, discounted.digest, unverified.digest]).size).toBe(3);
    });
  });

  test("every hold of one order is listed together with the new ones", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const planned = await plan(
        tx,
        parse([
          {
            orderNo: s.orderNo("A"),
            status: "Dikirim",
            cancelReturnStatus: "Retur",
            sellerVoucher: 1_000,
            lines: [
              { sku: s.sku("M"), qty: 1, lineTotal: 229_000, returnedQty: 1 },
              { sku: null, qty: 1, lineTotal: 229_000 },
            ],
          },
        ]),
      );
      expect(codes(entry(planned, s.orderNo("A")))).toEqual(["status_unverified", "cancel_return_unknown", "returned_qty", "multi_row_discount", "blank_sku"]);
    });
  });
});

describe("commit after the unlock (TDD, stock)", () => {
  test("a clean Perlu Dikirim file saves without any test unlock: the order is Siap Kirim and stock leaves", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const outcome = await previewAndCommit(tx, parse([{ orderNo: s.orderNo("A"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 2, lineTotal: 458_000 }] }]), staff.id);
      expect(outcome).toMatchObject({ kind: "committed", created: 1, updated: 0, reviewCount: 0 });
      expect(await orderByChannelNo(tx, s.orderNo("A"))).toMatchObject({ status: "to_ship", subtotalAmount: 458_000, totalAmount: 458_000, channelStatus: "Perlu Dikirim" });
      expect(await stockOf(tx, s.sku("M"))).toBe(8);
    });
  });

  test("Belum Bayar writes nothing (no order, no stock); the same order paid in a later export is created normally", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const unpaid = await previewAndCommit(tx, parse([{ orderNo: s.orderNo("B"), status: "Belum Bayar", paymentTime: "-", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] }]), staff.id);
      expect(unpaid.kind).toBe("nothing_to_save");
      expect(await orderByChannelNo(tx, s.orderNo("B"))).toBeUndefined();
      expect(await stockOf(tx, s.sku("M"))).toBe(10);

      const paid = await previewAndCommit(tx, parse([{ orderNo: s.orderNo("B"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] }]), staff.id);
      expect(paid).toMatchObject({ kind: "committed", created: 1 });
      expect(await orderByChannelNo(tx, s.orderNo("B"))).toMatchObject({ status: "to_ship" });
      expect(await stockOf(tx, s.sku("M"))).toBe(9);
    });
  });

  test("an imported order later shown as Belum Bayar is held: status, stock and amounts untouched", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const line = [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }];
      expect(await previewAndCommit(tx, parse([{ orderNo: s.orderNo("C"), status: "Perlu Dikirim", lines: line }]), staff.id)).toMatchObject({ kind: "committed", created: 1 });
      const before = await orderByChannelNo(tx, s.orderNo("C"));
      const parsed = parse([{ orderNo: s.orderNo("C"), status: "Belum Bayar", lines: line }]);
      expect(codes(entry(await plan(tx, parsed), s.orderNo("C")))).toEqual(["unpaid_in_admin"]);
      expect((await previewAndCommit(tx, parsed, staff.id)).kind).toBe("nothing_to_save");
      expect(await orderByChannelNo(tx, s.orderNo("C"))).toEqual(before);
      expect(await stockOf(tx, s.sku("M"))).toBe(9);
    });
  });

  test("a file with a held order saves the rest; the held one is written nowhere", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      const staff = await insertStaffUser(tx);
      const outcome = await previewAndCommit(
        tx,
        parse([
          { orderNo: s.orderNo("OK"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }] },
          { orderNo: s.orderNo("HD"), status: "Perlu Dikirim", sellerVoucher: 10_000, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 229_000 }, { sku: s.sku("L"), qty: 1, lineTotal: 229_000 }] },
          { orderNo: s.orderNo("UP"), status: "Belum Bayar", lines: [{ sku: s.sku("L"), qty: 1, lineTotal: 229_000 }] },
        ]),
        staff.id,
      );
      expect(outcome).toMatchObject({ kind: "committed", created: 1, updated: 0, reviewCount: 1 });
      expect(await orderByChannelNo(tx, s.orderNo("OK"))).toMatchObject({ status: "to_ship" });
      expect(await orderByChannelNo(tx, s.orderNo("HD"))).toBeUndefined();
      expect(await orderByChannelNo(tx, s.orderNo("UP"))).toBeUndefined();
      expect(await stockOf(tx, s.sku("M"))).toBe(9);
      expect(await stockOf(tx, s.sku("L"))).toBe(10);
      const items = await tx.select().from(orderItems).where(inArray(orderItems.sku, [s.sku("M"), s.sku("L")]));
      expect(items).toHaveLength(1);
      if (outcome.kind !== "committed") throw new Error("expected a commit");
      const batchRows = await tx.select().from(importBatchOrders).where(eq(importBatchOrders.importBatchId, outcome.batchId));
      expect(batchRows.map((row) => row.action)).toEqual(["created"]);
      expect(batchRows[0]!.orderId).toBe((await orderByChannelNo(tx, s.orderNo("OK")))!.id);
      expect(await tx.select().from(orderChannelFees).where(eq(orderChannelFees.orderId, batchRows[0]!.orderId))).toEqual([]);
    });
  });
});
