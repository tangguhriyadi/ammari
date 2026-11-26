import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runPosting, type Database as LedgerDatabase } from "@ammari/accounting/runner";
import { fabrics, goodsReceiptItems, journalEntries, journalLines, postingIssues, purchaseItems, suppliers } from "@ammari/db/schema";
import { insertAccessory, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { returnDefectsToSupplier } from "@/lib/defects/dispositions";
import { closePurchase, createPurchase } from "@/lib/purchases/queries";
import { postGoodsReceiptForPurchase, reverseGoodsReceipt } from "@/lib/receipts/queries";
import { getPurchasePaymentSummary, recordPurchasePayment } from "@/lib/supplier-payments/purchase-payments";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import { getReconciliation } from "./reconciliation";

// Session 7 through the app's REAL write paths (docs/plans/accounting.md §4.4, §6.3): purchase
// documents, goods receipts (cumulative-rounding slices, rejects), receipt reversals, returns to the
// supplier, payments and closing, then the posting runner and the Rekonsiliasi checks. The ledger
// only reads these records; nothing here changes a write path. "Today" is faked to 20 Dec 2026 (the
// trial month), since every form refuses a future date. Every test rolls back.

const TODAY = new Date("2026-12-20T03:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

function storedFile(): StoredPrivateFile {
  const id = randomUUID();
  const sha = id.replaceAll("-", "").padEnd(64, "c");
  return {
    id,
    purpose: "payment_proof",
    storageKey: `test/payment_proof/2026/12/${id}.jpg`,
    processed: {
      body: Buffer.alloc(0),
      contentType: "image/jpeg",
      extension: "jpg",
      byteSize: 1234,
      sha256: sha,
      originalFilename: "bukti.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 2345,
      originalSha256: sha,
      jpegQuality: 82,
    },
  };
}

async function postAll(tx: TestTx) {
  const result = await runPosting(tx as unknown as LedgerDatabase, { trigger: "cron" });
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  return result;
}

/** A purchase with an odd fabric total (cumulative rounding) and an accessory line. */
async function purchaseFixture(tx: TestTx) {
  const staff = await insertStaffUser(tx);
  const [supplier] = await tx.insert(suppliers).values({ name: `Uji Laksmi ${randomUUID().slice(0, 8)}` }).returning();
  const [fabric] = await tx.insert(fabrics).values({ name: `Uji Katun ${randomUUID().slice(0, 8)}` }).returning();
  const accessory = await insertAccessory(tx);
  const purchase = await createPurchase(
    {
      supplierId: supplier!.id,
      orderedAt: "2026-12-01",
      lines: [
        { itemType: "fabric", itemId: fabric!.id, qtyOrdered: 7, totalAmount: 1_000_001 },
        { itemType: "accessory", itemId: accessory.id, qtyOrdered: 3, totalAmount: 100 },
      ],
    },
    staff.id,
    tx,
  );
  const lines = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
  return {
    staff,
    supplier: supplier!,
    purchase,
    fabricLine: lines.find((line) => line.itemType === "fabric")!,
    accessoryLine: lines.find((line) => line.itemType === "accessory")!,
  };
}

/** Active journal lines of this purchase's receipt items, summed per account (debit positive). */
async function receiptJournalTotals(tx: TestTx, purchaseId: string): Promise<Record<string, number>> {
  const items = await tx
    .select({ id: goodsReceiptItems.id })
    .from(goodsReceiptItems)
    .innerJoin(purchaseItems, eq(purchaseItems.id, goodsReceiptItems.purchaseItemId))
    .where(eq(purchaseItems.purchaseId, purchaseId));
  if (items.length === 0) return {};
  const rows = await tx
    .select({ code: journalLines.accountCode, net: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalEntries.sourceType, "goods_receipt_item"), inArray(journalEntries.sourceId, items.map((item) => item.id))))
    .groupBy(journalLines.accountCode);
  return Object.fromEntries(rows.map((row) => [row.code, Number(row.net)]).filter(([, net]) => net !== 0));
}

async function openIssueCodes(tx: TestTx, sourceIds: string[]): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const rows = await tx
    .select({ code: postingIssues.issueCode })
    .from(postingIssues)
    .where(and(inArray(postingIssues.sourceId, sourceIds), isNull(postingIssues.resolvedAt)));
  return rows.map((row) => row.code);
}

describe("Session 7 through the real purchase write paths", () => {
  test("Σ P1 of a short-closed document equals its tagihan exactly (cumulative rounding), and the over-paid DP becomes a supplier claim", async () => {
    vi.useFakeTimers({ now: TODAY, toFake: ["Date"] });
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine, accessoryLine } = await purchaseFixture(tx);
      await recordPurchasePayment({ purchaseId: purchase.id, paidAt: "2026-12-01", amount: 600_000, method: "transfer" }, storedFile(), staff.id, tx);
      await postGoodsReceiptForPurchase(
        {
          purchaseId: purchase.id,
          receivedAt: "2026-12-03",
          lines: [
            { purchaseItemId: fabricLine.id, qtyAccepted: 3.33, qtyRejected: 0.5 },
            { purchaseItemId: accessoryLine.id, qtyAccepted: 3 },
          ],
        },
        staff.id,
        tx,
      );
      await closePurchase(purchase.id, "Sisa kain tidak tersedia", staff.id, tx);
      const summary = await getPurchasePaymentSummary(purchase.id, tx);

      const result = await postAll(tx);
      expect(result.failedCount).toBe(0);

      const totals = await receiptJournalTotals(tx, purchase.id);
      const received = (totals["1-1501"] ?? 0) + (totals["1-1502"] ?? 0) + (totals["1-1506"] ?? 0);
      expect(received).toBe(summary!.tagihan);
      // The DP was applied first; nothing is left as utang.
      expect(totals["1-1601"]).toBe(-summary!.tagihan);
      expect(totals["2-1101"]).toBeUndefined();

      const reconciliation = await getReconciliation("2026-12-20", tx);
      const row = reconciliation.payables.find((candidate) => candidate.purchaseId === purchase.id);
      expect(row).toMatchObject({ ledgerPayable: 0, ledgerAdvance: 0, ledgerClaim: summary!.overpaid, notReceived: 0, difference: 0, status: "ok" });
      expect(summary!.overpaid).toBeGreaterThan(0);
    });
  });

  test("receipt reversal and return to the supplier: every journal posts, no issue, and the document reconciles (difference 0)", async () => {
    vi.useFakeTimers({ now: TODAY, toFake: ["Date"] });
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine } = await purchaseFixture(tx);
      await recordPurchasePayment({ purchaseId: purchase.id, paidAt: "2026-12-02", amount: 200_000, method: "cash" }, storedFile(), staff.id, tx);
      const first = await postGoodsReceiptForPurchase(
        { purchaseId: purchase.id, receivedAt: "2026-12-04", lines: [{ purchaseItemId: fabricLine.id, qtyAccepted: 2, qtyRejected: 1 }] },
        staff.id,
        tx,
      );
      const second = await postGoodsReceiptForPurchase({ purchaseId: purchase.id, receivedAt: "2026-12-06", lines: [{ purchaseItemId: fabricLine.id, qtyAccepted: 1.5 }] }, staff.id, tx);
      await postAll(tx);
      await reverseGoodsReceipt(second.receipt.id, staff.id, tx);
      await returnDefectsToSupplier({ source: { purchaseItemId: fabricLine.id }, qty: 1, reason: "Tukar kain cacat", occurredAt: "2026-12-10" }, staff.id, tx);
      await recordPurchasePayment({ purchaseId: purchase.id, paidAt: "2026-12-12", amount: 100_000, method: "transfer" }, storedFile(), staff.id, tx);

      const result = await postAll(tx);
      expect(result.failedCount).toBe(0);

      const itemIds = (
        await tx
          .select({ id: goodsReceiptItems.id })
          .from(goodsReceiptItems)
          .innerJoin(purchaseItems, eq(purchaseItems.id, goodsReceiptItems.purchaseItemId))
          .where(eq(purchaseItems.purchaseId, purchase.id))
      ).map((row) => row.id);
      expect(itemIds).toHaveLength(3);
      expect(await openIssueCodes(tx, [...itemIds, purchase.id])).toEqual([]);
      expect(first.receipt.id).toBeTruthy();

      const reconciliation = await getReconciliation("2026-12-20", tx);
      const row = reconciliation.payables.find((candidate) => candidate.purchaseId === purchase.id)!;
      expect(row.difference).toBe(0);
      expect(row.status).not.toBe("mismatch");
      // Open document: the app is owed the whole order, the ledger only what arrived (D-13).
      expect(row.notReceived).toBeGreaterThan(0);
      expect(row.paid).toBe(300_000);

      // A second run is a no-op (idempotent).
      const again = await postAll(tx);
      expect(again).toMatchObject({ insertedCount: 0, reversedCount: 0, failedCount: 0 });
    });
  });

  test("check 1: 1-1501/1-1502 follow the stock ledgers once every receipt is posted", async () => {
    vi.useFakeTimers({ now: TODAY, toFake: ["Date"] });
    await withRollback(async (tx) => {
      const { staff, purchase, fabricLine, accessoryLine } = await purchaseFixture(tx);
      await postGoodsReceiptForPurchase(
        {
          purchaseId: purchase.id,
          receivedAt: "2026-12-05",
          lines: [
            { purchaseItemId: fabricLine.id, qtyAccepted: 4 },
            { purchaseItemId: accessoryLine.id, qtyAccepted: 2 },
          ],
        },
        staff.id,
        tx,
      );
      const before = await getReconciliation("2026-12-20", tx);
      const fabricBefore = before.materials.find((row) => row.material === "fabric")!;
      expect(fabricBefore.receipts).toBeGreaterThan(0);
      expect(fabricBefore.difference).toBeLessThan(0); // not posted yet: the ledger is short

      await postAll(tx);

      const after = await getReconciliation("2026-12-20", tx);
      for (const row of after.materials) expect(row.difference).toBe(0);
      expect(after.segment).toBe("trial");
      expect(after.segmentStart).toBe("2026-12-01");
    });
  });
});
