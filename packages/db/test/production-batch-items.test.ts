import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { productionBatches, productionBatchItems } from "../src/schema";
import { withRollback, type TestTx } from "./helpers";
import { insertProductVariant } from "./fixtures";

async function insertBatchFixture(tx: TestTx, fabricId: string) {
  const [batch] = await tx
    .insert(productionBatches)
    .values({ fabricId, batchNo: `PRD-TEST-${randomUUID().slice(0, 8)}`, producedAt: "2026-10-01" })
    .returning();
  if (!batch) throw new Error("failed to insert production batch fixture");
  return batch;
}

describe("production_batch_items composite FKs (SKU-belongs-to-fabric guarantee)", () => {
  // Each assertion gets its own withRollback transaction — once one INSERT inside a Postgres
  // transaction fails, the whole transaction is aborted and every later statement fails too
  // ("current transaction is aborted"), so a rejected insert can never be followed by a
  // successful one in the SAME transaction.

  test("a line whose SKU belongs to a DIFFERENT fabric than its batch is rejected", async () => {
    await withRollback(async (tx) => {
      const { variant: variantB } = await insertProductVariant(tx); // an unrelated fabric
      const { fabric: fabricA } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabricA.id);

      // variantB's SKU does not belong to fabricA — production_batch_items_sku_fabric_fk must
      // reject this, not silently accept a cross-fabric line.
      await expect(
        tx.insert(productionBatchItems).values({
          productionBatchId: batch.id,
          fabricId: fabricA.id,
          sku: variantB.sku,
          qty: 1,
        }),
      ).rejects.toThrow();
    });
  });

  test("a line whose fabric_id doesn't match its own batch's fabric_id is rejected", async () => {
    await withRollback(async (tx) => {
      const { variant: variantA, fabric: fabricA } = await insertProductVariant(tx);
      const { fabric: fabricB } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabricA.id);

      // production_batch_items_batch_fabric_fk requires (production_batch_id, fabric_id) to
      // match an EXISTING production_batches row — fabricB was never this batch's fabric.
      await expect(
        tx.insert(productionBatchItems).values({
          productionBatchId: batch.id,
          fabricId: fabricB.id,
          sku: variantA.sku,
          qty: 1,
        }),
      ).rejects.toThrow();
    });
  });

  test("a line whose SKU and fabric_id both correctly match its batch's fabric is accepted", async () => {
    await withRollback(async (tx) => {
      const { variant: variantA, fabric: fabricA } = await insertProductVariant(tx);
      const batch = await insertBatchFixture(tx, fabricA.id);

      await expect(
        tx.insert(productionBatchItems).values({
          productionBatchId: batch.id,
          fabricId: fabricA.id,
          sku: variantA.sku,
          qty: 1,
        }),
      ).resolves.not.toThrow();
    });
  });
});
