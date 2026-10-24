import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertFabricColor, insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { productVariants, stockMovements } from "@ammari/db/schema";
import { shopeeRows, xlsxBytes } from "../../../test/marketplace-fixtures";
import { commitImport } from "./commit";
import { getImportBatchDetail, listImportBatches } from "./history";
import { parseMarketplaceFile } from "./parse-file";
import { planImport } from "./plan";

// Riwayat impor and the batch detail (docs/plans/marketplace-import.md §11, §12): money (omzet,
// voucher, fees) only with finance.view_profit, in the query layer.

describe("import history", () => {
  test("lists the committed batch with counts; the detail links its orders; money only for finance", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase();
      const { product, fabric } = await insertProductVariant(tx);
      const color = await insertFabricColor(tx, fabric.id);
      const sku = `HST${marker}-M`;
      await tx.insert(productVariants).values({ sku, productId: product.id, fabricId: fabric.id, fabricColorId: color.id, closure: "front_zip", size: "M" });
      await tx.insert(stockMovements).values({ sku, qty: 10, valueAmount: 1_000_000, type: "production", refType: "manual" });
      const staff = await insertStaffUser(tx);
      const lines = [{ sku, qty: 1, lineTotal: 249_000 }];
      const commit = async (status: string, sellerVoucher: number) => {
        const parsed = parseMarketplaceFile({ channelId: "shopee", fileName: `pesanan-${status}.xlsx`, bytes: xlsxBytes(shopeeRows([{ orderNo: `${marker}A`, status, sellerVoucher, adminFee: 1_000, lines }])), assumeMappingVerified: true });
        if (!parsed.ok) throw new Error(parsed.error.message);
        const planned = await planImport(parsed.value, {}, tx);
        if (!planned.ok) throw new Error(planned.error.message);
        const outcome = await commitImport({ parsed: parsed.value, fileName: `pesanan-${status}.xlsx`, options: {}, expectedDigest: planned.value.digest, actorStaffUserId: staff.id }, tx);
        if (outcome.kind !== "committed") throw new Error(outcome.kind);
        return outcome.batchId;
      };
      const first = await commit("Perlu Dikirim", 5_000);
      const second = await commit("Selesai", 7_000);

      const withFinance = await listImportBatches({ canViewProfit: true }, tx);
      const withoutFinance = await listImportBatches({ canViewProfit: false }, tx);
      expect(withFinance.findIndex((row) => row.id === second)).toBeLessThan(withFinance.findIndex((row) => row.id === first));
      expect(withFinance.find((row) => row.id === first)).toMatchObject({ channelName: "Shopee", filename: "pesanan-Perlu Dikirim.xlsx", counts: { create: 1, update: 0 }, newOmzetAmount: 244_000 });
      expect(withoutFinance.find((row) => row.id === first)).toMatchObject({ counts: { create: 1 }, newOmzetAmount: null });

      const detail = await getImportBatchDetail(second, { canViewProfit: true }, tx);
      expect(detail?.orders).toHaveLength(1);
      expect(detail?.orders[0]).toMatchObject({ action: "updated", status: "completed", channelOrderNo: `${marker}A` });
      expect(detail?.orders[0]?.changes).toEqual(
        expect.arrayContaining([
          { kind: "status", before: "to_ship", after: "completed" },
          { kind: "voucher", before: 5_000, after: 7_000 },
          { kind: "channel_status", before: "Perlu Dikirim", after: "Selesai" },
        ]),
      );
      const hidden = await getImportBatchDetail(second, { canViewProfit: false }, tx);
      expect(hidden?.orders[0]?.changes).toEqual(expect.arrayContaining([{ kind: "voucher", before: null, after: null }]));
      const moneyChanges = (hidden?.orders ?? []).flatMap((row) => row.changes).filter((change) => change.kind === "voucher" || change.kind === "fee");
      expect(moneyChanges.length).toBeGreaterThan(0);
      expect(moneyChanges.every((change) => "before" in change && change.before === null && change.after === null)).toBe(true);
      expect(hidden?.newOmzetAmount).toBeNull();

      expect(await getImportBatchDetail(randomUUID(), { canViewProfit: true }, tx)).toBeNull();
    });
  });
});
