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
            { orderNo: no("A"), status: "Selesai", sellerVoucher: 5_000, adminFee: 2_000, lines: [{ sku: sku("M"), qty: 2, lineTotal: 498_001 }] },
            { orderNo: no("B"), status: "Selesai", sellerVoucher: 3_000, adminFee: 2_500, lines: [{ sku: sku("M"), qty: 1, lineTotal: 249_000 }] },
          ];
        },
        false,
      );
      expect(preview.canViewProfit).toBe(false);
      expect(preview.counts).toMatchObject({ create: 1, update: 1 });
      expect(preview.totals).toEqual({ newOrderCount: 1, newPieces: 2, newOmzetAmount: null, newVoucherAmount: null, newFeeAmount: null });
      expect(preview.rows.every((row) => row.omzetAmount === null)).toBe(true);
      const update = preview.rows.find((row) => row.action === "update");
      // The fixture's zero service fee and affiliate commission are new (known zero) rows.
      expect(update?.changes).toEqual([
        "Status: Siap Kirim → Selesai",
        "Voucher penjual berubah",
        "Biaya Administrasi berubah",
        "Biaya Layanan berubah",
        "Komisi afiliasi berubah",
        "Status marketplace: Perlu Dikirim → Selesai",
      ]);
      // Nothing in the serialized payload carries an amount or an internal "before" state.
      const json = JSON.stringify(preview);
      expect(json).not.toMatch(RUPIAH);
      expect(json).not.toContain("expected");
      expect(json).not.toContain("unitPrice");
      expect(json).not.toContain("249000");
    });
  });

  test("with finance.view_profit: totals, omzet, voucher and fee changes in rupiah", async () => {
    await withRollback(async (tx) => {
      const preview = await previewFor(
        tx,
        async (sku, no) => [{ orderNo: no("A"), status: "Selesai", sellerVoucher: 5_000, adminFee: 2_000, serviceFee: 1_000, lines: [{ sku: sku("M"), qty: 2, lineTotal: 498_001 }] }],
        true,
      );
      // 498.001 over 2 pieces: unit price 249.001 (rounded), subtotal 498.002, one rupiah of rounding.
      expect(preview.totals).toEqual({ newOrderCount: 1, newPieces: 2, newOmzetAmount: 493_002, newVoucherAmount: 5_000, newFeeAmount: 3_000 });
      const created = preview.rows.find((row) => row.action === "create");
      expect(created).toMatchObject({ omzetAmount: 493_002, targetStatus: "completed", pieces: 2 });
      expect(created?.warnings).toEqual([`Selisih pembulatan ${formatRupiah(1)}`]);
      expect(preview.canSave).toBe(false);
      expect(preview.saveBlockers[0]).toContain("Pemetaan kolom Shopee belum diverifikasi");
    });
  });

  test("never buyer data", async () => {
    await withRollback(async (tx) => {
      const preview = await previewFor(tx, async (sku, no) => [{ orderNo: no("A"), lines: [{ sku: `${sku("M")}Q`, qty: 1, lineTotal: 1_000 }] }], true);
      const json = JSON.stringify(preview);
      for (const value of Object.values(FAKE_BUYER)) expect(json).not.toContain(value);
    });
  });
});
