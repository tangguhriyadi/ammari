import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { formatRupiah } from "@ammari/ui/lib";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertFabricColor, insertOrder, insertProductVariant } from "@ammari/db/test-fixtures";
import { orderChannelFees, orderItems, productVariants, stockMovements } from "@ammari/db/schema";
import { FAKE_BUYER, shopeeRows, xlsxBytes, type FixtureOrder } from "../../../test/marketplace-fixtures";
import { parseMarketplaceFile } from "./parse-file";
import { planImport } from "./plan";
import { toImportPreview, type ImportPreview } from "./preview-view";

// The preview payload (docs/plans/marketplace-import.md §11, §12, test 44): an allowlist; money only
// with finance.view_profit; never buyer data.

async function previewFor(tx: TestDatabase, build: (sku: (suffix: string) => string, no: (suffix: string) => string) => Promise<FixtureOrder[]>, canViewProfit: boolean): Promise<ImportPreview> {
  const marker = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
  const { product, fabric } = await insertProductVariant(tx);
  const sku = (suffix: string) => `PVW${marker}-${suffix}`;
  for (const suffix of ["M", "L"]) {
    const color = await insertFabricColor(tx, fabric.id);
    await tx.insert(productVariants).values({ sku: sku(suffix), productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: "front_zip", size: "M" });
    await tx.insert(stockMovements).values({ sku: sku(suffix), qty: 10, valueAmount: 1_000_000, type: "production", refType: "manual" });
  }
  const orders = await build(sku, (suffix) => `${marker}${suffix}`);
  const parsed = parseMarketplaceFile({ channelId: "shopee", fileName: "pesanan.xlsx", bytes: xlsxBytes(shopeeRows(orders)) });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const planned = await planImport(parsed.value, {}, tx);
  if (!planned.ok) throw new Error(planned.error.message);
  return toImportPreview(parsed.value, planned.value, { canViewProfit });
}

const RUPIAH = /Rp\s?\d/;

describe("toImportPreview", () => {
  test("without finance.view_profit: no money field, no rupiah in any text, counts and statuses kept", async () => {
    await withRollback(async (tx) => {
      const preview = await previewFor(
        tx,
        async (sku, no) => {
          const existing = await insertOrder(tx, { channelId: "shopee", channelOrderNo: no("B"), status: "to_ship", subtotalAmount: 249_000, shippingAmount: 0, discountAmount: 0, channelStatus: "Perlu Dikirim" });
          await tx.insert(orderItems).values({ orderId: existing.id, sku: sku("M"), qty: 1, unitPrice: 249_000, unitCost: 100_000 });
          await tx.insert(orderChannelFees).values({ orderId: existing.id, component: "admin_fee", amount: 1_000 });
          return [
            { orderNo: no("A"), status: "Selesai", sellerVoucher: 5_000, lines: [{ sku: sku("M"), qty: 2, lineTotal: 498_000 }] },
            { orderNo: no("B"), status: "Selesai", sellerVoucher: 3_000, lines: [{ sku: sku("M"), qty: 1, lineTotal: 249_000 }] },
          ];
        },
        false,
      );
      expect(preview.canViewProfit).toBe(false);
      expect(preview.counts).toMatchObject({ create: 1, update: 1 });
      expect(preview.totals).toEqual({ newOrderCount: 1, newPieces: 2, newOmzetAmount: null, newVoucherAmount: null, newFeeAmount: null });
      expect(preview.rows.every((row) => row.omzetAmount === null && row.fileSubtotals === null)).toBe(true);
      const update = preview.rows.find((row) => row.action === "update");
      // The stored admin fee is never touched: the order export has no fee columns (plan §19.2).
      expect(update?.changes).toEqual(["Status: Siap Kirim → Selesai", "Diskon penjual berubah", "Status marketplace: Perlu Dikirim → Selesai"]);
      // Nothing in the serialized payload carries an amount or an internal "before" state.
      const json = JSON.stringify(preview);
      expect(json).not.toMatch(RUPIAH);
      expect(json).not.toContain("expected");
      expect(json).not.toContain("unitPrice");
      expect(json).not.toContain("249000");
    });
  });

  test("with finance.view_profit: totals, omzet, seller discount and the file's Subtotal Pesanan in rupiah", async () => {
    await withRollback(async (tx) => {
      const preview = await previewFor(
        tx,
        async (sku, no) => [
          {
            orderNo: no("A"),
            status: "Selesai",
            sellerVoucher: 5_000,
            lines: [
              { sku: sku("M"), qty: 1, listUnitPrice: 249_000 },
              { sku: sku("M"), qty: 1, listUnitPrice: 249_001 },
            ],
          },
        ],
        true,
      );
      // 498.001 over 2 pieces: unit price 249.001 (rounded), subtotal 498.002, one rupiah of rounding.
      expect(preview.totals).toEqual({ newOrderCount: 1, newPieces: 2, newOmzetAmount: 493_002, newVoucherAmount: 5_000, newFeeAmount: 0 });
      const created = preview.rows.find((row) => row.action === "create");
      expect(created).toMatchObject({ omzetAmount: 493_002, targetStatus: "completed", pieces: 2, fileSubtotals: [249_000, 249_001] });
      expect(created?.warnings).toEqual([`Selisih pembulatan ${formatRupiah(1)}`]);
      expect(preview.canSave).toBe(false);
      expect(preview.saveBlockers[0]).toContain("Pemetaan kolom Shopee belum diverifikasi");
    });
  });

  test("a blank SKU: counted, linked to Daftar SKU, never offered for a manual match (plan §19.6)", async () => {
    await withRollback(async (tx) => {
      const preview = await previewFor(
        tx,
        async (sku, no) => [
          { orderNo: no("A"), lines: [{ sku: null, qty: 1, lineTotal: 249_000 }] },
          { orderNo: no("B"), lines: [{ sku: null, qty: 1, lineTotal: 249_000 }, { sku: sku("M"), qty: 1, lineTotal: 249_000 }] },
          { orderNo: no("C"), lines: [{ sku: sku("M"), qty: 1, lineTotal: 249_000 }] },
        ],
        false,
      );
      expect(preview.blankSkuOrderCount).toBe(2);
      expect(preview.unknownSkus).toEqual([]);
      const held = preview.rows.filter((row) => row.action === "review");
      expect(held).toHaveLength(2);
      expect(held.every((row) => row.reasons.every((reason) => reason.code === "blank_sku" && reason.skuListLink && reason.stockSku === null))).toBe(true);
    });
  });

  test("never buyer data", async () => {
    await withRollback(async (tx) => {
      const preview = await previewFor(tx, async (sku, no) => [{ orderNo: no("A"), lines: [{ sku: `${sku("M")}Q`, qty: 1, lineTotal: 1_000 }] }], true);
      const json = JSON.stringify(preview);
      for (const value of Object.values(FAKE_BUYER)) expect(json).not.toContain(value);
    });
  });

  test("ship and complete dates (plan §19.3): counts, per-order lines, and conflicts on unchanged orders listed", async () => {
    await withRollback(async (tx) => {
      const preview = await previewFor(
        tx,
        async (sku, no) => {
          const stored = await insertOrder(tx, {
            channelId: "shopee",
            channelOrderNo: no("C"),
            status: "completed",
            subtotalAmount: 249_000,
            shippingAmount: 0,
            discountAmount: 0,
            channelStatus: "Selesai",
            orderDate: new Date("2026-10-22T02:15:00Z"),
            marketplaceShippedAt: new Date("2026-10-23T02:15:00Z"),
            marketplaceCompletedAt: new Date("2026-10-26T13:40:00Z"),
          });
          await tx.insert(orderItems).values({ orderId: stored.id, sku: sku("M"), qty: 1, unitPrice: 249_000, unitCost: 100_000 });
          const empty = await insertOrder(tx, { channelId: "shopee", channelOrderNo: no("D"), status: "completed", subtotalAmount: 249_000, shippingAmount: 0, discountAmount: 0, channelStatus: "Selesai", orderDate: new Date("2026-10-22T02:15:00Z") });
          await tx.insert(orderItems).values({ orderId: empty.id, sku: sku("M"), qty: 1, unitPrice: 249_000, unitCost: 100_000 });
          const line = [{ sku: sku("M"), qty: 1, lineTotal: 249_000 }];
          return [
            { orderNo: no("A"), status: "Selesai", orderedAt: "2026-10-22 09:15", shippedAt: "2026-10-23 09:15", completedAt: "2026-10-26 20:40", lines: line },
            { orderNo: no("B"), status: "Perlu Dikirim", orderedAt: "2026-10-22 09:15", shippedAt: "2026-10-23 09:15", lines: line },
            { orderNo: no("C"), status: "Selesai", orderedAt: "2026-10-22 09:15", shippedAt: "2026-10-23 10:00", completedAt: "2026-10-26 20:40", lines: line },
            { orderNo: no("D"), status: "Selesai", orderedAt: "2026-10-22 09:15", shippedAt: "2026-10-23 09:15", completedAt: "2026-10-26 20:40", lines: line },
          ];
        },
        false,
      );
      expect(preview.marketplaceDates).toEqual({ shippedAtFills: 2, completedAtFills: 2, arrangedNotShipped: 1, shippedAtMissing: 0, conflicts: 1 });
      const created = preview.rows.find((row) => row.channelOrderNo.endsWith("A"));
      expect(created?.changes).toEqual(["Waktu kirim di Shopee: 23 Okt 2026, 09.15", "Waktu selesai di Shopee: 26 Okt 2026, 20.40"]);
      const updated = preview.rows.find((row) => row.channelOrderNo.endsWith("D"));
      expect(updated).toMatchObject({ action: "update", changes: ["Waktu kirim di Shopee diisi: 23 Okt 2026, 09.15", "Waktu selesai di Shopee diisi: 26 Okt 2026, 20.40"] });
      // The conflict sits on an unchanged order: listed so it is visible, never an update.
      expect(preview.unchangedWithWarnings).toEqual([
        expect.objectContaining({ channelOrderNo: expect.stringMatching(/C$/), warnings: [expect.stringContaining("Waktu kirim di file berbeda dengan yang tersimpan")] }),
      ]);
    });
  });
});
