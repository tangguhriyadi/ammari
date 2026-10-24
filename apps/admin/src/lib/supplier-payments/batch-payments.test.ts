import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import {
  auditLog,
  costComponents,
  fabricStockMovements,
  fabrics,
  privateFiles,
  productionBatchCosts,
  productionBatchItems,
  productionBatches,
  products,
  productVariants,
  fabricColors,
  staffUsers,
  supplierPayments,
  suppliers,
} from "@ammari/db/schema";
import { FieldError, ActionError } from "@/lib/errors";
import { recordFabricPurchase } from "@/lib/inventory/fabric-stock";
import { createDraft, listBatches, postBatch } from "@/lib/production/queries";
import type { StoredPrivateFile } from "./store-upload";
import {
  getBatchPaymentSummary,
  listBatchPayments,
  precheckBatchPayment,
  recordBatchPayment,
  type RecordBatchPaymentInput,
} from "./batch-payments";
import { voidSupplierPayment } from "./payment-records";

// docs/plans/purchase-payments.md §3.2, §8, §10, session S4: payments against a production batch,
// tracked per payee.

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function storedFile(): StoredPrivateFile {
  const id = randomUUID();
  return {
    id,
    purpose: "payment_proof",
    storageKey: `test/payment_proof/2026/10/${id}.jpg`,
    processed: {
      body: Buffer.alloc(0),
      contentType: "image/jpeg",
      extension: "jpg",
      byteSize: 1234,
      sha256: sha(id),
      originalFilename: "bukti jahit.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 2345,
      originalSha256: sha(randomUUID()),
      jpegQuality: 82,
    },
  };
}

async function insertSupplier(tx: TestDatabase, label: string) {
  const [supplier] = await tx.insert(suppliers).values({ name: `${label} ${randomUUID().slice(0, 8)}` }).returning();
  if (!supplier) throw new Error("failed to insert supplier fixture");
  return supplier;
}

async function insertComponent(tx: TestDatabase, costType: "variable" | "fixed") {
  const [component] = await tx
    .insert(costComponents)
    .values({ name: `Ongkos ${randomUUID().slice(0, 8)}`, unit: "pcs", costType })
    .returning();
  if (!component) throw new Error("failed to insert cost component fixture");
  return component;
}

/** A batch of 10 pcs, fabric Rp 1.000.000 (never due here, A2), and three service lines:
 * sewing 10 x Rp 20.000 to the tailor, finishing Rp 50.000 to the finisher, and Rp 10.000 nobody
 * was attributed. Due: tailor 200.000, finisher 50.000, "Tanpa pemasok" 10.000. */
async function batchFixture(tx: TestDatabase, options: { post?: boolean; noServiceLines?: boolean } = {}) {
  const { fabric, color, variant, product } = await insertProductVariant(tx);
  if (!fabric || !color || !variant || !product) throw new Error("fixture");
  const staff = await insertStaffUser(tx);
  const tailor = await insertSupplier(tx, "Penjahit");
  const finisher = await insertSupplier(tx, "Finishing");
  const sewing = await insertComponent(tx, "variable");
  const finishing = await insertComponent(tx, "fixed");
  const other = await insertComponent(tx, "fixed");
  await recordFabricPurchase({ fabricId: fabric.id, qty: 10, totalAmountPaid: 1_000_000, purchasedAt: "2026-09-01" }, null, tx);
  const batch = await createDraft(
    {
      fabricId: fabric.id,
      producedAt: "2026-10-01",
      fabricYards: 10,
      lines: [{ sku: variant.sku, qty: 10 }],
      extraCosts: options.noServiceLines
        ? []
        : [
            { costComponentId: sewing.id, unitPrice: 20_000, supplierId: tailor.id },
            { costComponentId: finishing.id, unitPrice: 50_000, supplierId: finisher.id },
            { costComponentId: other.id, unitPrice: 10_000, supplierId: null },
          ],
    },
    staff.id,
    tx,
  );
  if (options.post !== false) await postBatch(batch.id, staff.id, tx);
  return { staff, tailor, finisher, fabric, color, variant, product, batch, componentIds: [sewing.id, finishing.id, other.id] };
}

function pay(productionBatchId: string, supplierId: string | null, amount: number, overrides: Partial<RecordBatchPaymentInput> = {}): RecordBatchPaymentInput {
  return { productionBatchId, supplierId, paidAt: "2026-10-02", amount, method: "transfer", ...overrides };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("getBatchPaymentSummary", () => {
  test("a posted batch is due its service lines per payee (by name, unattributed last), never the fabric or accessories (A2)", async () => {
    await withRollback(async (tx) => {
      const { tailor, finisher, batch } = await batchFixture(tx);
      const summary = await getBatchPaymentSummary(batch.id, tx);
      expect(summary?.overall).toMatchObject({ tagihan: 260_000, paid: 0, status: "unpaid" });
      expect(summary?.payees.map((payee) => [payee.supplierId, payee.supplierName, payee.tagihan, payee.status])).toEqual([
        [finisher.id, finisher.name, 50_000, "unpaid"],
        [tailor.id, tailor.name, 200_000, "unpaid"],
        [null, null, 10_000, "unpaid"],
      ]);
    });
  });

  test("a draft has no tagihan; a posted batch without service lines is 'Tanpa tagihan'", async () => {
    await withRollback(async (tx) => {
      const draft = await batchFixture(tx, { post: false });
      expect(await getBatchPaymentSummary(draft.batch.id, tx)).toBeNull();
      const bare = await batchFixture(tx, { noServiceLines: true });
      expect((await getBatchPaymentSummary(bare.batch.id, tx))?.overall.status).toBe("no_bill");
    });
  });
});

describe("recordBatchPayment", () => {
  test("DP then pelunasan to one payee: that payee Lunas, the batch overall still DP; payee snapshot, BYR number, audit 'record'", async () => {
    await withRollback(async (tx) => {
      const { staff, tailor, finisher, batch } = await batchFixture(tx);
      const dp = await recordBatchPayment(pay(batch.id, tailor.id, 80_000, { method: "cash", note: " DP " }), storedFile(), staff.id, tx);
      expect(dp.payment).toMatchObject({ targetType: "production_batch", productionBatchId: batch.id, purchaseId: null, supplierId: tailor.id, supplierName: tailor.name, note: "DP" });
      expect(dp.payment.paymentNo).toMatch(/^BYR-\d{6}-\d{3}$/);
      expect(dp.payee).toMatchObject({ status: "partial", remaining: 120_000 });
      expect(dp.overall).toMatchObject({ status: "partial", paid: 80_000 });

      const rest = await recordBatchPayment(pay(batch.id, tailor.id, 120_000), storedFile(), staff.id, tx);
      expect(rest.payee).toMatchObject({ status: "paid", remaining: 0 });
      expect(rest.overall).toMatchObject({ status: "partial", paid: 200_000, remaining: 60_000 });

      const summary = await getBatchPaymentSummary(batch.id, tx);
      expect(summary?.payees.find((payee) => payee.supplierId === tailor.id)?.status).toBe("paid");
      expect(summary?.payees.find((payee) => payee.supplierId === finisher.id)?.status).toBe("unpaid");
      expect(summary?.overall.status).toBe("partial");

      const audits = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "supplier_payment"), inArray(auditLog.entityId, [dp.payment.id, rest.payment.id])));
      expect(audits.map((row) => row.action)).toEqual(["record", "record"]);

      const history = await listBatchPayments(batch.id, tx);
      expect(history.map((row) => [row.supplierName, row.amount])).toEqual([
        [tailor.name, 80_000],
        [tailor.name, 120_000],
      ]);
    });
  });

  test("the cap is per payee: above the tailor's remaining is refused although the batch as a whole still owes more", async () => {
    await withRollback(async (tx) => {
      const { staff, tailor, finisher, batch } = await batchFixture(tx);
      const error = await rejection(recordBatchPayment(pay(batch.id, tailor.id, 200_001), storedFile(), staff.id, tx));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toBe("Jumlah melebihi sisa tagihan (Rp 200.000).");
      await expect(precheckBatchPayment(pay(batch.id, finisher.id, 50_001), tx)).rejects.toThrow("Jumlah melebihi sisa tagihan (Rp 50.000).");
      await expect(recordBatchPayment(pay(batch.id, finisher.id, 50_000), storedFile(), staff.id, tx)).resolves.toBeTruthy();
      await expect(recordBatchPayment(pay(batch.id, finisher.id, 1), storedFile(), staff.id, tx)).rejects.toThrow("Tagihan ini sudah lunas.");
    });
  });

  test("the unattributed lines are paid with no payee; a supplier not on the batch's lines is refused", async () => {
    await withRollback(async (tx) => {
      const { staff, batch } = await batchFixture(tx);
      const { payment } = await recordBatchPayment(pay(batch.id, null, 10_000), storedFile(), staff.id, tx);
      expect(payment).toMatchObject({ supplierId: null, supplierName: null });
      const stranger = await insertSupplier(tx, "Asing");
      const error = await rejection(recordBatchPayment(pay(batch.id, stranger.id, 1_000), storedFile(), staff.id, tx));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toBe("Penerima ini tidak ada di biaya batch ini.");
    });
  });

  test("a draft batch is refused with the rule explained, and no private_files row is left behind", async () => {
    await withRollback(async (tx) => {
      const { staff, tailor, batch } = await batchFixture(tx, { post: false });
      const message = "Batch yang belum diposting belum punya tagihan. Posting batch dulu, lalu catat pembayarannya.";
      await expect(precheckBatchPayment(pay(batch.id, tailor.id, 1_000), tx)).rejects.toThrow(message);
      const file = storedFile();
      const error = await rejection(recordBatchPayment(pay(batch.id, tailor.id, 1_000), file, staff.id, tx));
      expect(error).toBeInstanceOf(ActionError);
      expect(error.message).toBe(message);
      expect(await tx.select().from(privateFiles).where(eq(privateFiles.id, file.id))).toEqual([]);
    });
  });

  test("a batch with no service lines has nothing to pay", async () => {
    await withRollback(async (tx) => {
      const { staff, batch } = await batchFixture(tx, { noServiceLines: true });
      await expect(recordBatchPayment(pay(batch.id, null, 1), storedFile(), staff.id, tx)).rejects.toThrow("Tidak ada tagihan untuk dibayar.");
    });
  });
});

describe("voidSupplierPayment (batch)", () => {
  test("a voided payment stays in history with its reason, stops counting, and can't be voided twice", async () => {
    await withRollback(async (tx) => {
      const { staff, tailor, batch } = await batchFixture(tx);
      const { payment } = await recordBatchPayment(pay(batch.id, tailor.id, 200_000), storedFile(), staff.id, tx);
      const voided = await voidSupplierPayment(payment.id, "  Salah penerima  ", staff.id, tx);
      expect(voided).toMatchObject({ voidReason: "Salah penerima", voidedByStaffUserId: staff.id });
      const summary = await getBatchPaymentSummary(batch.id, tx);
      expect(summary?.payees.find((payee) => payee.supplierId === tailor.id)).toMatchObject({ paid: 0, status: "unpaid" });
      const history = await listBatchPayments(batch.id, tx);
      expect(history[0]).toMatchObject({ voidReason: "Salah penerima", voidedByName: staff.name });
      await expect(voidSupplierPayment(payment.id, "Lagi", staff.id, tx)).rejects.toThrow("Pembayaran ini sudah dibatalkan.");
      const voids = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, payment.id), eq(auditLog.action, "void")));
      expect(voids).toHaveLength(1);
      // The full amount is payable again.
      await expect(recordBatchPayment(pay(batch.id, tailor.id, 200_000), storedFile(), staff.id, tx)).resolves.toBeTruthy();
    });
  });
});

describe("listBatches payment column and filter", () => {
  test("the SQL figures equal computeBatchPaymentSummary's overall, drafts have none, and the filter follows the status", async () => {
    await withRollback(async (tx) => {
      const { staff, tailor, finisher, batch } = await batchFixture(tx);
      const draft = await batchFixture(tx, { post: false });
      const find = async (payment?: "unpaid" | "partial" | "paid") =>
        (await listBatches({ payment }, undefined, "100", tx)).rows.find((row) => row.id === batch.id);

      expect((await find())?.payment).toEqual((await getBatchPaymentSummary(batch.id, tx))?.overall);
      expect((await listBatches({}, undefined, "100", tx)).rows.find((row) => row.id === draft.batch.id)?.payment).toBeNull();
      expect(await find("unpaid")).toBeTruthy();
      expect(await find("partial")).toBeUndefined();
      // A draft never matches any payment tab.
      for (const tab of ["unpaid", "partial", "paid"] as const) {
        expect((await listBatches({ payment: tab }, undefined, "100", tx)).rows.some((row) => row.id === draft.batch.id)).toBe(false);
      }

      await recordBatchPayment(pay(batch.id, tailor.id, 200_000), storedFile(), staff.id, tx);
      expect((await find())?.payment).toEqual((await getBatchPaymentSummary(batch.id, tx))?.overall);
      expect((await find())?.payment?.status).toBe("partial");
      expect(await find("partial")).toBeTruthy();
      expect(await find("unpaid")).toBeUndefined();

      await recordBatchPayment(pay(batch.id, finisher.id, 50_000), storedFile(), staff.id, tx);
      await recordBatchPayment(pay(batch.id, null, 10_000), storedFile(), staff.id, tx);
      expect((await find())?.payment?.status).toBe("paid");
      expect(await find("paid")).toBeTruthy();
    });
  });
});

// Real commits: row-lock contention needs two separate transactions. Every table touched is
// append-only or posted-frozen, so cleanup disables the triggers by name for these disposable
// fixtures only (withTriggerDisabled).
async function cleanup(fixture: Awaited<ReturnType<typeof batchFixture>>) {
  const { batch } = fixture;
  const payments = await testDb.select().from(supplierPayments).where(eq(supplierPayments.productionBatchId, batch.id));
  const fileIds = payments.map((row) => row.proofFileId);
  await testDb.delete(auditLog).where(inArray(auditLog.entityId, [batch.id, ...payments.map((row) => row.id)]));
  await withTriggerDisabled(testDb, "supplier_payments", "prevent_supplier_payment_mutation", () =>
    testDb.delete(supplierPayments).where(eq(supplierPayments.productionBatchId, batch.id)),
  );
  if (fileIds.length > 0) {
    await withTriggerDisabled(testDb, "private_files", "prevent_private_file_mutation", () => testDb.delete(privateFiles).where(inArray(privateFiles.id, fileIds)));
  }
  await withTriggerDisabled(testDb, "production_batch_costs", "prevent_posted_batch_cost_mutation", () =>
    testDb.delete(productionBatchCosts).where(eq(productionBatchCosts.productionBatchId, batch.id)),
  );
  await withTriggerDisabled(testDb, "production_batch_items", "prevent_posted_batch_items_mutation", () =>
    testDb.delete(productionBatchItems).where(eq(productionBatchItems.productionBatchId, batch.id)),
  );
  await withTriggerDisabled(testDb, "production_batches", "prevent_posted_batch_delete", () =>
    testDb.delete(productionBatches).where(eq(productionBatches.id, batch.id)),
  );
  await withTriggerDisabled(testDb, "fabric_stock_movements", "prevent_fabric_stock_movement_mutation", () =>
    testDb.delete(fabricStockMovements).where(eq(fabricStockMovements.fabricId, fixture.fabric.id)),
  );
  await testDb.delete(costComponents).where(inArray(costComponents.id, fixture.componentIds));
  await testDb.delete(suppliers).where(inArray(suppliers.id, [fixture.tailor.id, fixture.finisher.id]));
  await testDb.delete(productVariants).where(eq(productVariants.sku, fixture.variant.sku));
  await testDb.delete(products).where(eq(products.id, fixture.product.id));
  await testDb.delete(fabricColors).where(eq(fabricColors.id, fixture.color.id));
  await testDb.delete(fabrics).where(eq(fabrics.id, fixture.fabric.id));
  await testDb.delete(staffUsers).where(eq(staffUsers.id, fixture.staff.id));
}

describe("concurrency (real commits)", () => {
  test("two parallel payments to one payee that together exceed its remaining: exactly one succeeds", async () => {
    const fixture = await batchFixture(testDb);
    try {
      const { staff, tailor, batch } = fixture;
      const outcomes = await Promise.allSettled([
        recordBatchPayment(pay(batch.id, tailor.id, 150_000), storedFile(), staff.id, testDb),
        recordBatchPayment(pay(batch.id, tailor.id, 150_000), storedFile(), staff.id, testDb),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const failed = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(String(failed[0]!.reason.message)).toBe("Jumlah melebihi sisa tagihan (Rp 50.000).");
      expect(await testDb.select().from(supplierPayments).where(eq(supplierPayments.productionBatchId, batch.id))).toHaveLength(1);
    } finally {
      await cleanup(fixture);
    }
  });
});
