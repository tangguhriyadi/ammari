import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertOrder, insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { importBatches, orderChannelFees, orderItems, productVariants, stockMovements, type OrderStatus } from "@ammari/db/schema";
import { shopeeRows, xlsxBytes, type FixtureOrder } from "../../../test/marketplace-fixtures";
import { parseMarketplaceFile, type ParsedImport } from "./parse-file";
import { canonicalJson, MAX_SKU_OVERRIDES, planDigest, planImport, type ImportPlan, type PlanEntry } from "./plan";

// Planner (docs/plans/marketplace-import.md §6 to §8, session 3, tests 27 to 32). Every fixture is
// synthetic: invented order numbers and SKUs, built per test with a random marker so tests never
// collide with each other or with seeded data. All inside withRollback, against ammari_test.

interface Seeded {
  marker: string;
  sku: (suffix: string) => string;
  orderNo: (suffix: string) => string;
}

async function seedVariants(tx: TestDatabase, suffixes: readonly string[], stock: Readonly<Record<string, number>> = {}): Promise<Seeded> {
  const marker = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const { product, fabric } = await insertProductVariant(tx);
  const sku = (suffix: string) => `PLN${marker}-${suffix}`;
  for (const suffix of suffixes) {
    // One colour per variant: (product, colour, size) is unique.
    const color = await insertFabricColor(tx, fabric.id);
    await tx.insert(productVariants).values({ sku: sku(suffix), productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: "front_zip", size: "M" });
    const qty = stock[suffix] ?? 10;
    if (qty > 0) await tx.insert(stockMovements).values({ sku: sku(suffix), qty, valueAmount: qty * 100_000, type: "production", refType: "manual" });
  }
  return { marker, sku, orderNo: (suffix: string) => `${marker}${suffix}` };
}

function parse(orders: readonly FixtureOrder[]): ParsedImport {
  const result = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(shopeeRows(orders)) });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function plan(tx: TestDatabase, parsed: ParsedImport, skuOverrides?: Record<string, string>): Promise<ImportPlan> {
  const result = await planImport(parsed, { skuOverrides }, tx);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function entry(planned: ImportPlan, channelOrderNo: string): PlanEntry {
  const found = planned.entries.find((candidate) => candidate.channelOrderNo === channelOrderNo);
  if (!found) throw new Error(`no plan entry for ${channelOrderNo}`);
  return found;
}

/** An admin order already holding the lines (as an earlier import or a manual entry left it). */
async function insertExisting(
  tx: TestDatabase,
  input: {
    channelOrderNo: string;
    status: OrderStatus;
    lines: { sku: string; qty: number; unitPrice: number }[];
    discountAmount?: number;
    shippingAmount?: number;
    channelStatus?: string | null;
    orderDate?: Date;
    needsAttention?: ("marketplace_return_pending" | "refund_due")[];
    createdByStaffUserId?: string | null;
    marketplaceShippedAt?: Date | null;
    marketplaceCompletedAt?: Date | null;
  },
) {
  const subtotalAmount = input.lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
  const order = await insertOrder(tx, {
    channelId: "shopee",
    channelOrderNo: input.channelOrderNo,
    status: input.status,
    subtotalAmount,
    shippingAmount: input.shippingAmount ?? 0,
    discountAmount: input.discountAmount ?? 0,
    orderDate: input.orderDate ?? new Date("2026-10-22T02:15:00Z"),
    channelStatus: input.channelStatus ?? null,
    needsAttention: input.needsAttention ?? [],
    createdByStaffUserId: input.createdByStaffUserId ?? null,
    marketplaceShippedAt: input.marketplaceShippedAt ?? null,
    marketplaceCompletedAt: input.marketplaceCompletedAt ?? null,
  });
  for (const line of input.lines) await tx.insert(orderItems).values({ orderId: order.id, sku: line.sku, qty: line.qty, unitPrice: line.unitPrice, unitCost: 100_000 });
  return order;
}

async function insertFees(tx: TestDatabase, orderId: string, fees: Record<string, number>) {
  for (const [component, amount] of Object.entries(fees)) {
    await tx.insert(orderChannelFees).values({ orderId, component: component as "admin_fee", amount });
  }
}

const ZERO_FEES = { admin_fee: 0, service_fee: 0, affiliate_commission: 0 };

describe("planImport: actions for a mixed file (test 27)", () => {
  test("new, updated, unchanged, Perlu dicek and dilewati, each counted", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("B"), status: "to_ship", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }], channelStatus: "Perlu Dikirim" });
      const unchanged = await insertExisting(tx, {
        channelOrderNo: s.orderNo("C"),
        status: "completed",
        lines: [{ sku: s.sku("L"), qty: 2, unitPrice: 259_000 }],
        channelStatus: "Selesai",
      });
      await insertFees(tx, unchanged.id, ZERO_FEES);

      const parsed = parse([
        { orderNo: s.orderNo("A"), status: "Selesai", orderedAt: "2026-10-22 09:15", sellerVoucher: 10_000, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }, { sku: s.sku("L"), qty: 2, lineTotal: 518_000 }] },
        { orderNo: s.orderNo("B"), status: "Selesai", orderedAt: "2026-10-22 09:15", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        { orderNo: s.orderNo("C"), status: "Selesai", orderedAt: "2026-10-22 09:15", lines: [{ sku: s.sku("L"), qty: 2, lineTotal: 518_000 }] },
        { orderNo: s.orderNo("D"), status: "Menunggu Konfirmasi", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        { orderNo: s.orderNo("E"), status: "Belum Bayar", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        { orderNo: s.orderNo("F"), status: "Batal", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        { orderNo: s.orderNo("G"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: "dua", lineTotal: 249_000 }] },
      ]);
      const planned = await plan(tx, parsed);

      expect(planned.counts).toEqual({ create: 1, update: 1, unchanged: 1, review: 2, skip: 2 });
      expect(planned.entries.map((candidate) => candidate.channelOrderNo)).toEqual(["A", "B", "C", "D", "E", "F", "G"].map(s.orderNo));

      const created = entry(planned, s.orderNo("A"));
      expect(created).toMatchObject({
        action: "create",
        rawStatus: "Selesai",
        transitions: ["shipped", "completed"],
        setReturnPending: false,
        subtotalAmount: 767_000,
        discountAmount: 10_000,
        totalAmount: 757_000,
        // The order export has no fee columns (plan §19.2): fees only come from Penghasilan Saya.
        fees: {},
        lines: [
          { sku: s.sku("L"), qty: 2, unitPrice: 259_000 },
          { sku: s.sku("M"), qty: 1, unitPrice: 249_000 },
        ],
      });
      expect(created.action === "create" && created.orderedAt.toISOString()).toBe("2026-10-22T02:15:00.000Z");

      expect(entry(planned, s.orderNo("B"))).toMatchObject({
        action: "update",
        transitions: ["shipped", "completed"],
        channelStatus: { before: "Perlu Dikirim", after: "Selesai" },
        discount: null,
        fees: [],
      });
      expect(entry(planned, s.orderNo("C"))).toMatchObject({ action: "unchanged", existing: { orderId: unchanged.id, status: "completed" } });
      expect(entry(planned, s.orderNo("D"))).toMatchObject({ action: "review", reasons: [{ code: "unknown_status" }] });
      expect(entry(planned, s.orderNo("E"))).toMatchObject({ action: "skip", reason: "unpaid" });
      expect(entry(planned, s.orderNo("F"))).toMatchObject({ action: "skip", reason: "undone_before_import" });
      // A parse problem stays in Perlu dicek with its own reason.
      expect(entry(planned, s.orderNo("G"))).toMatchObject({ action: "review", reasons: [{ code: "invalid_rows" }] });

      expect(planned.totals).toEqual({ newOrderCount: 1, newPieces: 3, newOmzetAmount: 757_000, newVoucherAmount: 10_000, newFeeAmount: 0 });
      expect(planned.digest).toMatch(/^[0-9a-f]{64}$/);
      // The lock of the unverified Shopee mapping passes through untouched.
      expect(planned.saveBlockers).toEqual(parsed.saveBlockers);
    });
  });

  test("a re-import updates the seller discount and total, leaves stored fees alone, keeps the shipping, and never touches lines or the order date", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const existing = await insertExisting(tx, {
        channelOrderNo: s.orderNo("V"),
        status: "completed",
        lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }],
        shippingAmount: 12_000,
        discountAmount: 5_000,
        channelStatus: "Selesai",
        orderDate: new Date("2026-10-20T17:30:00Z"), // 21 Okt in Jakarta
      });
      await insertFees(tx, existing.id, { admin_fee: 4_000, service_fee: 0, affiliate_commission: 0, platform_commission: 900 });

      const planned = await plan(tx, parse([{ orderNo: s.orderNo("V"), status: "Selesai", orderedAt: "2026-10-22 09:15", sellerVoucher: 8_000, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      const updated = entry(planned, s.orderNo("V"));
      expect(updated).toMatchObject({
        action: "update",
        transitions: [],
        discount: { before: 5_000, after: 8_000 },
        totalAmount: { before: 256_000, after: 253_000 },
        channelStatus: null,
        // No fee column in the order file: the stored fee rows are never touched.
        fees: [],
      });
      expect(updated.action === "update" && updated.warnings).toEqual([expect.stringContaining("Tanggal pesanan di file")]);
    });
  });

  test("Dalam Pengembalian on a completed order sets the return flag without a transition; an order the same day stays without warning", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("R"), status: "completed", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }], channelStatus: "Selesai" });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("R"), status: "Dalam Pengembalian", orderedAt: "2026-10-22 23:30", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("R"))).toMatchObject({ action: "update", transitions: [], setReturnPending: true, clearReturnPending: false, warnings: [] });
    });
  });

  test("lines that differ from admin, and an admin-final order the marketplace still sells, wait in Perlu dicek untouched", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("X"), status: "to_ship", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }] });
      await insertExisting(tx, { channelOrderNo: s.orderNo("Y"), status: "cancelled", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }] });
      const planned = await plan(
        tx,
        parse([
          { orderNo: s.orderNo("X"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 2, lineTotal: 498_000 }] },
          { orderNo: s.orderNo("Y"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        ]),
      );
      expect(entry(planned, s.orderNo("X"))).toMatchObject({ action: "review", reasons: [{ code: "lines_differ" }] });
      expect(entry(planned, s.orderNo("Y"))).toMatchObject({ action: "review", reasons: [{ code: "final_in_admin" }] });
      expect(planned.counts.review).toBe(2);
    });
  });
});

describe("planImport: unknown SKUs (test 28)", () => {
  test("one unknown line holds the whole order; other orders are unaffected; the SKU is grouped with its orders and rows", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const unknownSku = s.sku("TYPO");
      const planned = await plan(
        tx,
        parse([
          {
            orderNo: s.orderNo("U1"),
            status: "Perlu Dikirim",
            lines: [
              { sku: s.sku("M"), qty: 1, lineTotal: 249_000 },
              { sku: unknownSku.toLowerCase(), qty: 1, lineTotal: 249_000, productName: "Gamis Poka", variationName: "Sage,M" },
            ],
          },
          { orderNo: s.orderNo("U2"), status: "Perlu Dikirim", lines: [{ sku: unknownSku, qty: 1, lineTotal: 249_000, productName: "Gamis Poka", variationName: "Sage,M" }] },
          { orderNo: s.orderNo("OK"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        ]),
      );
      expect(entry(planned, s.orderNo("U1"))).toMatchObject({ action: "review", reasons: [{ code: "unknown_sku", sku: unknownSku }] });
      expect(entry(planned, s.orderNo("U2"))).toMatchObject({ action: "review", reasons: [{ code: "unknown_sku", sku: unknownSku }] });
      expect(entry(planned, s.orderNo("OK"))).toMatchObject({ action: "create", transitions: [] });
      expect(planned.unknownSkus).toEqual([
        {
          fileSku: unknownSku,
          nameHints: ["Gamis Poka", "Sage,M"],
          orders: [
            { channelOrderNo: s.orderNo("U1"), rowNumbers: [3] },
            { channelOrderNo: s.orderNo("U2"), rowNumbers: [4] },
          ],
        },
      ]);
    });
  });

  test("a blank SKU cell is its own hold, never offered for a manual match (plan §19.6)", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const planned = await plan(
        tx,
        parse([
          { orderNo: s.orderNo("BL"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }, { sku: null, qty: 1, lineTotal: 249_000, productName: "Gamis Poka", variationName: "Sage,L" }] },
          // SKU Induk filled, the variant SKU blank: still held, SKU Induk is never a fallback.
          { orderNo: s.orderNo("BI"), status: "Selesai", lines: [{ sku: null, qty: 1, lineTotal: 249_000, parentSku: s.sku("M") }] },
        ]),
      );
      expect(entry(planned, s.orderNo("BL"))).toMatchObject({
        action: "review",
        reasons: [
          {
            code: "blank_sku",
            sku: null,
            message: "SKU kosong di Shopee (Nomor Referensi SKU) untuk Gamis Poka, Sage,L (baris 3). Isi SKU penjual di Shopee dari Daftar SKU, lalu export ulang.",
          },
        ],
      });
      expect(entry(planned, s.orderNo("BI"))).toMatchObject({ action: "review", reasons: [{ code: "blank_sku" }] });
      expect(planned.unknownSkus).toEqual([]);
      expect(planned.blankSkuOrderCount).toBe(2);
      // A manual match keyed by a blank SKU is refused outright.
      const refused = await planImport(parse([{ orderNo: s.orderNo("BL"), lines: [{ sku: null, qty: 1, lineTotal: 249_000 }] }]), { skuOverrides: { "": s.sku("M") } }, tx);
      expect(refused.ok).toBe(false);
    });
  });
});

describe("planImport: Shopee holds and amounts (plan §19.2, §19.4, session 7a)", () => {
  test("a non-blank Status Pembatalan/ Pengembalian holds the order, new or existing, and is never guessed", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const existing = await insertExisting(tx, { channelOrderNo: s.orderNo("CE"), status: "to_ship", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }], channelStatus: "Perlu Dikirim" });
      const planned = await plan(
        tx,
        parse([
          { orderNo: s.orderNo("CN"), status: "Perlu Dikirim", cancelReturnStatus: "Pembatalan Diajukan", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
          { orderNo: s.orderNo("CE"), status: "Selesai", cancelReturnStatus: "Pengembalian Dana Disetujui", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        ]),
      );
      expect(entry(planned, s.orderNo("CN"))).toMatchObject({
        action: "review",
        reasons: [{ code: "cancel_return_unknown", message: "Status pembatalan/pengembalian 'Pembatalan Diajukan' belum dikenal. Beri tahu admin teknis supaya statusnya dipasang." }],
      });
      expect(entry(planned, s.orderNo("CE"))).toMatchObject({ action: "review", existing: { orderId: existing.id }, reasons: [{ code: "cancel_return_unknown" }] });
    });
  });

  test("Returned quantity above 0 holds the order", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("RQ"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 2, lineTotal: 498_000, returnedQty: 1 }] }]));
      expect(entry(planned, s.orderNo("RQ"))).toMatchObject({
        action: "review",
        reasons: [{ code: "returned_qty", message: "Ada barang diretur di Shopee (Returned quantity 1), jadi pesanan belum diimpor." }],
      });
    });
  });

  test("prices that do not add up hold the order", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const planned = await plan(
        tx,
        parse([{ orderNo: s.orderNo("PC"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, listUnitPrice: 249_000, unitPriceAfterDiscount: 239_000, totalDiscount: 5_000, sellerDiscount: 5_000 }] }]),
      );
      expect(entry(planned, s.orderNo("PC"))).toMatchObject({
        action: "review",
        reasons: [{ code: "price_inconsistent", message: "Harga di file tidak konsisten (baris 2): Harga Awal, Harga Setelah Diskon dan kolom diskon tidak cocok. Pesanan belum diimpor." }],
      });
    });
  });

  test("every hold of one order is listed together", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("AL"), status: "Selesai", cancelReturnStatus: "Retur", lines: [{ sku: null, qty: 1, lineTotal: 249_000, returnedQty: 1 }] }]));
      const held = entry(planned, s.orderNo("AL"));
      expect(held.action === "review" && held.reasons.map((reason) => reason.code)).toEqual(["cancel_return_unknown", "returned_qty", "blank_sku"]);
    });
  });

  test("a new order: discount = seller product discount + seller voucher + seller bundle; Shopee-funded money stays in revenue; no fee rows", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      const planned = await plan(
        tx,
        parse([
          {
            orderNo: s.orderNo("AM"),
            status: "Selesai",
            sellerVoucher: 10_000,
            sellerBundleDiscount: 7_000,
            shopeeVoucher: 25_000,
            shopeeCoins: 3_000,
            shopeeBundleDiscount: 4_000,
            lines: [
              { sku: s.sku("M"), qty: 2, listUnitPrice: 249_000, sellerDiscount: 20_000, shopeeDiscount: 6_000 },
              { sku: s.sku("L"), qty: 1, listUnitPrice: 259_000, sellerDiscount: 9_000 },
            ],
          },
        ]),
      );
      expect(entry(planned, s.orderNo("AM"))).toMatchObject({
        action: "create",
        lines: [
          { sku: s.sku("L"), qty: 1, unitPrice: 259_000, lineTotal: 259_000 },
          { sku: s.sku("M"), qty: 2, unitPrice: 249_000, lineTotal: 498_000 },
        ],
        subtotalAmount: 757_000,
        discountAmount: 46_000,
        totalAmount: 711_000,
        roundingDifference: 0,
        fees: {},
      });
      expect(planned.totals).toMatchObject({ newOmzetAmount: 711_000, newVoucherAmount: 46_000, newFeeAmount: 0 });
    });
  });

  test("a re-import never writes or changes fees: stored fee rows stay as they are", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const order = await insertExisting(tx, { channelOrderNo: s.orderNo("FE"), status: "completed", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }], channelStatus: "Selesai" });
      await insertFees(tx, order.id, { admin_fee: 4_000 });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("FE"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("FE")).action).toBe("unchanged");
    });
  });
});

describe("planImport: manual SKU match (test 29)", () => {
  test("a matched order becomes ready, is merged with a line of the same admin SKU, and changes the digest", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const parsed = parse([
        {
          orderNo: s.orderNo("MM"),
          status: "Selesai",
          lines: [
            { sku: s.sku("M"), qty: 1, lineTotal: 249_000 },
            { sku: s.sku("TYPO"), qty: 1, lineTotal: 250_000 },
          ],
        },
      ]);
      const without = await plan(tx, parsed);
      expect(entry(without, s.orderNo("MM")).action).toBe("review");

      const matched = await plan(tx, parsed, { [` ${s.sku("TYPO").toLowerCase()} `]: s.sku("M").toLowerCase() });
      expect(entry(matched, s.orderNo("MM"))).toMatchObject({
        action: "create",
        lines: [{ sku: s.sku("M"), qty: 2, unitPrice: 249_500, lineTotal: 499_000 }],
        subtotalAmount: 499_000,
        skuMatches: [{ fileSku: s.sku("TYPO"), adminSku: s.sku("M") }],
      });
      expect(matched.unknownSkus).toEqual([]);
      expect(matched.skuMatches).toEqual([{ fileSku: s.sku("TYPO"), adminSku: s.sku("M"), channelOrderNos: [s.orderNo("MM")] }]);
      expect(matched.digest).not.toBe(without.digest);
    });
  });

  test("refuses an override for a known SKU, for an admin SKU that does not exist, and for a SKU not in the file", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      const parsed = parse([{ orderNo: s.orderNo("RF"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }, { sku: s.sku("TYPO"), qty: 1, lineTotal: 249_000 }] }]);

      const known = await planImport(parsed, { skuOverrides: { [s.sku("M")]: s.sku("L") } }, tx);
      expect(known).toMatchObject({ ok: false, error: { code: "invalid_sku_override" } });
      expect(!known.ok && known.error.message).toContain(s.sku("M"));

      const missingTarget = await planImport(parsed, { skuOverrides: { [s.sku("TYPO")]: s.sku("NOPE") } }, tx);
      expect(missingTarget).toMatchObject({ ok: false, error: { code: "invalid_sku_override" } });
      expect(!missingTarget.ok && missingTarget.error.message).toContain(s.sku("NOPE"));

      const notInFile = await planImport(parsed, { skuOverrides: { [s.sku("ELSEWHERE")]: s.sku("L") } }, tx);
      expect(notInFile).toMatchObject({ ok: false, error: { code: "invalid_sku_override" } });
    });
  });
});

describe("planImport: stock (test 30)", () => {
  test("the check is cumulative within one file, earliest order first; a short order does not use up stock", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"], { M: 1, L: 0 });
      const planned = await plan(
        tx,
        parse([
          // Listed later but ordered earlier: it gets the one piece.
          { orderNo: s.orderNo("S2"), status: "Perlu Dikirim", orderedAt: "2026-10-23 10:00", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
          { orderNo: s.orderNo("S1"), status: "Selesai", orderedAt: "2026-10-23 09:00", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
          { orderNo: s.orderNo("S3"), status: "Perlu Dikirim", orderedAt: "2026-10-23 08:00", lines: [{ sku: s.sku("L"), qty: 1, lineTotal: 249_000 }] },
          // Skipped orders never need stock.
          { orderNo: s.orderNo("S4"), status: "Belum Bayar", orderedAt: "2026-10-23 07:00", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        ]),
      );
      expect(entry(planned, s.orderNo("S1")).action).toBe("create");
      expect(entry(planned, s.orderNo("S2"))).toMatchObject({
        action: "review",
        reasons: [{ code: "stock_short", sku: s.sku("M"), message: `Stok ${s.sku("M")} di admin tersisa 0, pesanan butuh 1.` }],
      });
      expect(entry(planned, s.orderNo("S3"))).toMatchObject({ action: "review", reasons: [{ code: "stock_short", sku: s.sku("L") }] });
      expect(entry(planned, s.orderNo("S4")).action).toBe("skip");
    });
  });

  test("an existing order paid on the marketplace while waiting for payment in admin needs stock too", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"], { M: 0 });
      await insertExisting(tx, { channelOrderNo: s.orderNo("AW"), status: "awaiting_payment", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }] });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("AW"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("AW"))).toMatchObject({ action: "review", reasons: [{ code: "stock_short" }] });
    });
  });

  test("the digest follows the stock decision", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"], { M: 0 });
      const parsed = parse([{ orderNo: s.orderNo("DG"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]);
      const short = await plan(tx, parsed);
      expect(await plan(tx, parsed)).toMatchObject({ digest: short.digest });
      await tx.insert(stockMovements).values({ sku: s.sku("M"), qty: 1, valueAmount: 100_000, type: "production", refType: "manual" });
      const ready = await plan(tx, parsed);
      expect(entry(ready, s.orderNo("DG")).action).toBe("create");
      expect(ready.digest).not.toBe(short.digest);
    });
  });
});

describe("planImport: matching a manual order (test 31)", () => {
  test("a manual order typed with other case and stray spaces is the same order", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const staff = await insertStaffUser(tx);
      const manual = await insertExisting(tx, {
        channelOrderNo: `  ${s.orderNo("mn").toLowerCase()} `,
        status: "to_ship",
        lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }],
        createdByStaffUserId: staff.id,
      });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("MN"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("MN"))).toMatchObject({
        action: "update",
        transitions: [],
        existing: { orderId: manual.id, orderNo: manual.orderNo, manual: true, storedChannelOrderNo: `  ${s.orderNo("mn").toLowerCase()} ` },
      });
    });
  });

  test("two admin orders that both match one number are never guessed between", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("DUP"), status: "to_ship", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }] });
      await insertExisting(tx, { channelOrderNo: ` ${s.orderNo("dup").toLowerCase()}`, status: "to_ship", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }] });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("DUP"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("DUP"))).toMatchObject({ action: "review", existing: null, reasons: [{ code: "ambiguous_match" }] });
    });
  });

  test("an order of another channel with the same number is not a match", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertOrder(tx, { channelId: "tiktok", channelOrderNo: s.orderNo("CH") });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("CH"), status: "Perlu Dikirim", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("CH")).action).toBe("create");
    });
  });
});

describe("planImport: read-only (test 32)", () => {
  test("planning writes nothing, and a file already committed is reported", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("RO"), status: "to_ship", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }] });
      const parsed = parse([
        { orderNo: s.orderNo("RO"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        { orderNo: s.orderNo("RN"), status: "Selesai", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
      ]);
      const tables = ["orders", "order_items", "stock_movements", "order_channel_fees", "import_batches", "import_batch_orders", "audit_log", "thank_you_cards"];
      const counts = async () => {
        const result: Record<string, number> = {};
        for (const table of tables) {
          const rows = await tx.execute<{ count: number }>(sql.raw(`select count(*)::int as count from "${table}"`));
          result[table] = rows[0]!.count;
        }
        return result;
      };

      const before = await counts();
      const first = await plan(tx, parsed);
      expect(first.previousCommit).toBeNull();
      expect(await counts()).toEqual(before);

      const staff = await insertStaffUser(tx);
      const committedAt = new Date("2026-10-23T07:05:00Z");
      await tx.insert(importBatches).values({ channelId: "shopee", kind: "orders", filename: "lama.xlsx", status: "committed", uploadedBy: staff.id, fileSha256: parsed.fileSha256, committedAt });
      // The same bytes on another channel are a different file.
      await tx.insert(importBatches).values({ channelId: "tiktok", kind: "orders", filename: "x.xlsx", status: "committed", uploadedBy: staff.id, fileSha256: parsed.fileSha256, committedAt: new Date() });
      const again = await plan(tx, parsed);
      expect(again.previousCommit).toMatchObject({ committedAt });
    });
  });
});

describe("planImport: more status and stock paths", () => {
  test("Dalam Pengembalian: a new order is created shipped and flagged; an admin to_ship order is walked to shipped and flagged (status-rules, session 1)", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("RT"), status: "to_ship", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }] });
      const planned = await plan(
        tx,
        parse([
          { orderNo: s.orderNo("RN"), status: "Dalam Pengembalian", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
          { orderNo: s.orderNo("RT"), status: "Dalam Pengembalian", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        ]),
      );
      expect(entry(planned, s.orderNo("RN"))).toMatchObject({ action: "create", transitions: ["shipped"], setReturnPending: true });
      expect(entry(planned, s.orderNo("RT"))).toMatchObject({ action: "update", transitions: ["shipped"], setReturnPending: true });
    });
  });

  test("an admin-cancelled order still flagged for a return is cleared when the marketplace says Batal", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, {
        channelOrderNo: s.orderNo("CL"),
        status: "returned",
        lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }],
        channelStatus: "Batal",
        needsAttention: ["marketplace_return_pending"],
      });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("CL"), status: "Batal", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("CL"))).toMatchObject({ action: "update", transitions: [], clearReturnPending: true });
    });
  });

  test("an awaiting_payment admin order with enough stock moves to to_ship and spends stock a later new order then lacks", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"], { M: 1 });
      await insertExisting(tx, { channelOrderNo: s.orderNo("AW"), status: "awaiting_payment", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }] });
      const planned = await plan(
        tx,
        parse([
          { orderNo: s.orderNo("AW"), status: "Perlu Dikirim", orderedAt: "2026-10-22 08:00", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
          { orderNo: s.orderNo("NW"), status: "Perlu Dikirim", orderedAt: "2026-10-22 09:00", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] },
        ]),
      );
      expect(entry(planned, s.orderNo("AW"))).toMatchObject({ action: "update", transitions: ["to_ship"] });
      expect(entry(planned, s.orderNo("NW"))).toMatchObject({ action: "review", reasons: [{ code: "stock_short" }] });
    });
  });

  test("a status text too long to store waits in Perlu dicek", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("LS"), status: `Perlu${" ".repeat(60)}Dikirim`, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("LS"))).toMatchObject({ action: "review", reasons: [{ code: "unknown_status" }] });
    });
  });

  test("an override onto an existing order's SKU still has to match its stored lines", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("EO"), status: "to_ship", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }] });
      const parsed = parse([{ orderNo: s.orderNo("EO"), status: "Perlu Dikirim", lines: [{ sku: s.sku("TYPO"), qty: 1, lineTotal: 249_000 }] }]);
      expect(entry(await plan(tx, parsed, { [s.sku("TYPO")]: s.sku("M") }), s.orderNo("EO"))).toMatchObject({ action: "update", skuMatches: [{ fileSku: s.sku("TYPO"), adminSku: s.sku("M") }] });
      const changed = parse([{ orderNo: s.orderNo("EO"), status: "Perlu Dikirim", lines: [{ sku: s.sku("TYPO"), qty: 2, lineTotal: 498_000 }] }]);
      expect(entry(await plan(tx, changed, { [s.sku("TYPO")]: s.sku("M") }), s.orderNo("EO"))).toMatchObject({ action: "review", reasons: [{ code: "lines_differ" }] });
    });
  });

  test("overrides: conflicting targets for one SKU, a prototype key, and too many are refused", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M", "L"]);
      const parsed = parse([{ orderNo: s.orderNo("OV"), status: "Selesai", lines: [{ sku: s.sku("TYPO"), qty: 1, lineTotal: 249_000 }] }]);
      const conflicting = await planImport(parsed, { skuOverrides: { [s.sku("TYPO")]: s.sku("M"), [s.sku("TYPO").toLowerCase()]: s.sku("L") } }, tx);
      expect(conflicting).toMatchObject({ ok: false, error: { code: "invalid_sku_override" } });
      const proto = await planImport(parsed, { skuOverrides: JSON.parse(`{"__proto__": "${s.sku("M")}"}`) as Record<string, string> }, tx);
      expect(proto).toMatchObject({ ok: false, error: { code: "invalid_sku_override" } });
      const many = Object.fromEntries(Array.from({ length: MAX_SKU_OVERRIDES + 1 }, (_, index) => [`X${index}`, s.sku("M")]));
      expect(await planImport(parsed, { skuOverrides: many }, tx)).toMatchObject({ ok: false, error: { code: "invalid_sku_override" } });
    });
  });
});

describe("planDigest", () => {
  const create: PlanEntry = {
    action: "create",
    channelOrderNo: "AAA111",
    rowNumbers: [2],
    rawStatus: "Selesai",
    orderedAt: new Date("2026-10-22T02:15:00Z"),
    lines: [{ sku: "X-M", qty: 1, unitPrice: 249_000, lineTotal: 249_000, rowNumbers: [2] }],
    subtotalAmount: 249_000,
    discountAmount: 0,
    totalAmount: 249_000,
    roundingDifference: 0,
    fees: { admin_fee: 4_500 },
    transitions: ["shipped", "completed"],
    setReturnPending: false,
    skuMatches: [],
    marketplaceShippedAt: null,
    marketplaceCompletedAt: null,
  };
  const review: PlanEntry = { action: "review", channelOrderNo: "BBB222", rowNumbers: [3], existing: null, reasons: [{ code: "stock_short", sku: "X-M", message: "Stok X-M di admin tersisa 0, pesanan butuh 1." }] };

  test("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { e: 3, f: 2 }] }, b: 1 }));
  });

  test("entry order, messages and row numbers never change it; a decision does", () => {
    const digest = planDigest("shopee", [create, review]);
    expect(planDigest("shopee", [review, create])).toBe(digest);
    expect(planDigest("shopee", [{ ...create, rowNumbers: [9] }, { ...review, reasons: [{ code: "stock_short", sku: "X-M", message: "lain" }] }])).toBe(digest);
    expect(planDigest("tiktok", [create, review])).not.toBe(digest);
    expect(planDigest("shopee", [{ ...create, fees: { admin_fee: 5_000 } }, review])).not.toBe(digest);
    expect(planDigest("shopee", [{ ...create, skuMatches: [{ fileSku: "Y", adminSku: "X-M" }] }, review])).not.toBe(digest);
    expect(planDigest("shopee", [create, { ...review, reasons: [{ code: "stock_short", sku: "X-L", message: "" }] }])).not.toBe(digest);
    // A ship or complete date to write is a decision (plan §19.3).
    expect(planDigest("shopee", [{ ...create, marketplaceShippedAt: new Date("2026-10-23T02:00:00Z") }, review])).not.toBe(digest);
    expect(planDigest("shopee", [{ ...create, marketplaceCompletedAt: new Date("2026-10-25T02:00:00Z") }, review])).not.toBe(digest);
  });
});

describe("planImport: Shopee ship and complete dates (plan §19.3, session 7b)", () => {
  const SHIP = "2026-10-23 09:15"; // 02:15 UTC
  const DONE = "2026-10-26 20:40"; // 13:40 UTC
  const SHIP_AT = new Date("2026-10-23T02:15:00Z");
  const DONE_AT = new Date("2026-10-26T13:40:00Z");

  test("status gate on create: col 7 only once Shopee says shipped or later, col 48 only on Selesai", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const line = [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }];
      const parsed = parse([
        { orderNo: s.orderNo("A"), status: "Perlu Dikirim", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, lines: line },
        { orderNo: s.orderNo("B"), status: "Dikirim", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, completedAt: DONE, lines: line },
        { orderNo: s.orderNo("C"), status: "Selesai", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, completedAt: DONE, lines: line },
        { orderNo: s.orderNo("D"), status: "Dalam Pengembalian", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, lines: line },
        { orderNo: s.orderNo("E"), status: "Sedang Dikirim", orderedAt: "2026-10-22 09:15", lines: line },
        { orderNo: s.orderNo("F"), status: "Perlu Dikirim", orderedAt: "2026-10-22 09:15", lines: line },
      ]);
      const planned = await plan(tx, parsed);
      expect(entry(planned, s.orderNo("A"))).toMatchObject({ action: "create", marketplaceShippedAt: null, marketplaceCompletedAt: null });
      expect(entry(planned, s.orderNo("B"))).toMatchObject({ action: "create", marketplaceShippedAt: SHIP_AT, marketplaceCompletedAt: null });
      expect(entry(planned, s.orderNo("C"))).toMatchObject({ action: "create", marketplaceShippedAt: SHIP_AT, marketplaceCompletedAt: DONE_AT });
      expect(entry(planned, s.orderNo("D"))).toMatchObject({ action: "create", marketplaceShippedAt: SHIP_AT, marketplaceCompletedAt: null });
      // Blank col 7 on a shipped order: no date (M1 stays a posting issue), never the import time.
      expect(entry(planned, s.orderNo("E"))).toMatchObject({ action: "create", marketplaceShippedAt: null, marketplaceCompletedAt: null });
      expect(planned.marketplaceDates).toEqual({ shippedAtFills: 3, completedAtFills: 1, arrangedNotShipped: 1, shippedAtMissing: 1, conflicts: 0 });
    });
  });

  test("re-import fills an empty stored date; the order becomes Diperbarui even with nothing else changing", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const existing = await insertExisting(tx, { channelOrderNo: s.orderNo("R"), status: "completed", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }], channelStatus: "Selesai" });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("R"), status: "Selesai", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, completedAt: DONE, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("R"))).toMatchObject({
        action: "update",
        existing: { orderId: existing.id },
        transitions: [],
        channelStatus: null,
        discount: null,
        marketplaceShippedAt: SHIP_AT,
        marketplaceCompletedAt: DONE_AT,
        warnings: [],
      });
      expect(planned.marketplaceDates).toMatchObject({ shippedAtFills: 1, completedAtFills: 1, shippedAtMissing: 0, conflicts: 0 });
    });
  });

  test("a Perlu Dikirim re-import moving to Dikirim fills the ship date together with the status step", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("P"), status: "to_ship", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }], channelStatus: "Perlu Dikirim" });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("P"), status: "Dikirim", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("P"))).toMatchObject({ action: "update", transitions: ["shipped"], marketplaceShippedAt: SHIP_AT, marketplaceCompletedAt: null });
    });
  });

  test("write once: the same stored value is unchanged; a different one is a warning and never an update; a blank never clears", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const lines = [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }];
      const stored = { status: "completed" as const, lines, channelStatus: "Selesai", marketplaceShippedAt: SHIP_AT, marketplaceCompletedAt: DONE_AT };
      await insertExisting(tx, { channelOrderNo: s.orderNo("S"), ...stored });
      await insertExisting(tx, { channelOrderNo: s.orderNo("T"), ...stored });
      await insertExisting(tx, { channelOrderNo: s.orderNo("U"), ...stored });
      const fileLine = [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }];
      const planned = await plan(
        tx,
        parse([
          { orderNo: s.orderNo("S"), status: "Selesai", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, completedAt: DONE, lines: fileLine },
          { orderNo: s.orderNo("T"), status: "Selesai", orderedAt: "2026-10-22 09:15", shippedAt: "2026-10-23 10:00", completedAt: "2026-10-27 08:00", lines: fileLine },
          { orderNo: s.orderNo("U"), status: "Selesai", orderedAt: "2026-10-22 09:15", lines: fileLine },
        ]),
      );
      expect(entry(planned, s.orderNo("S"))).toMatchObject({ action: "unchanged", warnings: [] });
      const conflict = entry(planned, s.orderNo("T"));
      expect(conflict).toMatchObject({ action: "unchanged" });
      expect(conflict.action === "unchanged" && conflict.warnings).toEqual([
        expect.stringContaining("Waktu kirim di file berbeda dengan yang tersimpan"),
        expect.stringContaining("Waktu selesai di file berbeda dengan yang tersimpan"),
      ]);
      // A blank on an order with a stored date is not "missing".
      expect(entry(planned, s.orderNo("U"))).toMatchObject({ action: "unchanged", warnings: [] });
      expect(planned.marketplaceDates).toEqual({ shippedAtFills: 0, completedAtFills: 0, arrangedNotShipped: 0, shippedAtMissing: 0, conflicts: 1 });
    });
  });

  test("a conflict on an order that changes for another reason: the status still moves, the stored date stays, the warning is shown", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("W"), status: "shipped", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }], channelStatus: "Dikirim", marketplaceShippedAt: SHIP_AT });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("W"), status: "Selesai", orderedAt: "2026-10-22 09:15", shippedAt: "2026-10-23 10:00", completedAt: DONE, lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      const updated = entry(planned, s.orderNo("W"));
      expect(updated).toMatchObject({ action: "update", transitions: ["completed"], marketplaceShippedAt: null, marketplaceCompletedAt: DONE_AT });
      expect(updated.action === "update" && updated.warnings).toEqual([expect.stringContaining("Waktu kirim di file berbeda dengan yang tersimpan")]);
      expect(planned.marketplaceDates).toEqual({ shippedAtFills: 0, completedAtFills: 1, arrangedNotShipped: 0, shippedAtMissing: 0, conflicts: 1 });
    });
  });

  test("an order held in Perlu dicek gets no date and counts nothing, not even a ship time the gate would keep out", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const planned = await plan(
        tx,
        parse([
          { orderNo: s.orderNo("H"), status: "Selesai", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, completedAt: DONE, lines: [{ sku: null, qty: 1, lineTotal: 249_000 }] },
          { orderNo: s.orderNo("I"), status: "Perlu Dikirim", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, lines: [{ sku: null, qty: 1, lineTotal: 249_000 }] },
          { orderNo: s.orderNo("J"), status: "Dikirim", orderedAt: "2026-10-22 09:15", lines: [{ sku: null, qty: 1, lineTotal: 249_000 }] },
        ]),
      );
      expect(planned.counts.review).toBe(3);
      expect(planned.marketplaceDates).toEqual({ shippedAtFills: 0, completedAtFills: 0, arrangedNotShipped: 0, shippedAtMissing: 0, conflicts: 0 });
    });
  });

  test("Batal stores col 7 only when the admin order already shipped (cancelled after shipping, owner 28 Nov 2026); never col 48", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      const lines = [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }];
      await insertExisting(tx, { channelOrderNo: s.orderNo("K"), status: "shipped", lines, channelStatus: "Dikirim" });
      await insertExisting(tx, { channelOrderNo: s.orderNo("L"), status: "returned", lines, channelStatus: "Batal" });
      await insertExisting(tx, { channelOrderNo: s.orderNo("N"), status: "to_ship", lines, channelStatus: "Perlu Dikirim" });
      const fileLine = [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }];
      const batal = (suffix: string) => ({ orderNo: s.orderNo(suffix), status: "Batal", orderedAt: "2026-10-22 09:15", shippedAt: SHIP, completedAt: DONE, lines: fileLine });
      const planned = await plan(tx, parse([batal("K"), batal("L"), batal("N"), batal("Q")]));
      // Shipped in admin: the cancel is a return, and the ship date lets M1 post before S4 reverses it.
      expect(entry(planned, s.orderNo("K"))).toMatchObject({ action: "update", transitions: ["returned"], marketplaceShippedAt: SHIP_AT, marketplaceCompletedAt: null });
      // Already returned in admin with no date: filled, nothing else changes.
      expect(entry(planned, s.orderNo("L"))).toMatchObject({ action: "update", transitions: [], channelStatus: null, marketplaceShippedAt: SHIP_AT, marketplaceCompletedAt: null });
      // Still waiting to ship in admin: a cancel before shipping, no recognition to date.
      expect(entry(planned, s.orderNo("N"))).toMatchObject({ action: "update", transitions: ["cancelled"], marketplaceShippedAt: null, marketplaceCompletedAt: null });
      // A new Batal order is never imported.
      expect(entry(planned, s.orderNo("Q"))).toMatchObject({ action: "skip", reason: "undone_before_import" });
      expect(planned.marketplaceDates).toEqual({ shippedAtFills: 2, completedAtFills: 0, arrangedNotShipped: 0, shippedAtMissing: 0, conflicts: 0 });
    });
  });

  test("Batal after shipping with a blank col 7 is counted as a missing ship time", async () => {
    await withRollback(async (tx) => {
      const s = await seedVariants(tx, ["M"]);
      await insertExisting(tx, { channelOrderNo: s.orderNo("K"), status: "shipped", lines: [{ sku: s.sku("M"), qty: 1, unitPrice: 249_000 }], channelStatus: "Dikirim" });
      const planned = await plan(tx, parse([{ orderNo: s.orderNo("K"), status: "Batal", orderedAt: "2026-10-22 09:15", lines: [{ sku: s.sku("M"), qty: 1, lineTotal: 249_000 }] }]));
      expect(entry(planned, s.orderNo("K"))).toMatchObject({ action: "update", transitions: ["returned"], marketplaceShippedAt: null });
      expect(planned.marketplaceDates.shippedAtMissing).toBe(1);
    });
  });
});
