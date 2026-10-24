import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { auditLog, fabrics, privateFiles, purchaseAttachments, purchaseItems, purchases, staffUsers, supplierPayments, suppliers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { closePurchase, createPurchase, listPurchaseDocuments, updatePurchase } from "@/lib/purchases/queries";
import { postGoodsReceiptForPurchase, reverseGoodsReceipt } from "@/lib/receipts/queries";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import type { PrivateFilePurpose } from "@ammari/db/schema";
import type { StoredPrivateFile } from "./store-upload";
import {
  attachPurchaseInvoice,
  findPaymentsWithProofHash,
  getPurchasePaymentSummary,
  listPurchaseAttachments,
  listPurchasePayments,
  overpaidIfClosed,
  precheckPurchasePayment,
  recordPurchasePayment,
  voidPurchaseAttachment,
  voidPurchasePayment,
  type RecordPurchasePaymentInput,
} from "./purchase-payments";
import { purchaseTagihan } from "./status";

// docs/plans/purchase-payments.md §10, session S3: purchase payment write paths, the
// updatePurchase/closePurchase guards and the list's SQL tagihan.

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A stored file as storePrivateUpload would return it; the bytes are never needed here (the DB
 * write path only records metadata). */
function storedFile(purpose: PrivateFilePurpose = "payment_proof", originalSha256 = sha(randomUUID())): StoredPrivateFile {
  const id = randomUUID();
  return {
    id,
    purpose,
    storageKey: `test/${purpose}/2026/10/${id}.jpg`,
    processed: {
      body: Buffer.alloc(0),
      contentType: "image/jpeg",
      extension: "jpg",
      byteSize: 1234,
      sha256: sha(id),
      originalFilename: "bukti transfer.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 2345,
      originalSha256,
      jpegQuality: 82,
    },
  };
}

async function insertSupplier(tx: TestDatabase) {
  const [supplier] = await tx.insert(suppliers).values({ name: `Supplier Bayar ${randomUUID().slice(0, 8)}` }).returning();
  if (!supplier) throw new Error("failed to insert supplier fixture");
  return supplier;
}

/** 10 yards of fabric for Rp 1.000.000. */
async function purchaseFixture(tx: TestDatabase) {
  const staff = await insertStaffUser(tx);
  const supplier = await insertSupplier(tx);
  const [fabric] = await tx.insert(fabrics).values({ name: `Katun Bayar ${randomUUID().slice(0, 8)}` }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");
  const purchase = await createPurchase(
    { supplierId: supplier.id, orderedAt: "2026-10-01", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered: 10, totalAmount: 1_000_000 }] },
    staff.id,
    tx,
  );
  const [line] = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
  return { staff, supplier, fabric, purchase, line: line! };
}

function pay(purchaseId: string, amount: number, overrides: Partial<RecordPurchasePaymentInput> = {}): RecordPurchasePaymentInput {
  return { purchaseId, paidAt: "2026-10-02", amount, method: "transfer", ...overrides };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("recordPurchasePayment", () => {
  test("DP then pelunasan: Belum bayar -> DP -> Lunas, numbered BYR, payee snapshot, audit 'record'", async () => {
    await withRollback(async (tx) => {
      const { staff, supplier, purchase } = await purchaseFixture(tx);
      expect((await getPurchasePaymentSummary(purchase.id, tx))?.status).toBe("unpaid");

      const dp = await recordPurchasePayment(pay(purchase.id, 300_000, { method: "cash", note: "  DP  " }), storedFile(), staff.id, tx);
      expect(dp.payment.paymentNo).toMatch(/^BYR-\d{6}-\d{3}$/);
      expect(dp.payment.supplierId).toBe(supplier.id);
      expect(dp.payment.supplierName).toBe(supplier.name);
      expect(dp.payment.note).toBe("DP");
      expect(dp.summary).toMatchObject({ status: "partial", paid: 300_000, remaining: 700_000 });

      const rest = await recordPurchasePayment(pay(purchase.id, 700_000), storedFile(), staff.id, tx);
      expect(rest.summary).toMatchObject({ status: "paid", paid: 1_000_000, remaining: 0 });
      expect(await getPurchasePaymentSummary(purchase.id, tx)).toMatchObject({ status: "paid", tagihan: 1_000_000, paid: 1_000_000 });

      const audits = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "supplier_payment"), inArray(auditLog.entityId, [dp.payment.id, rest.payment.id])));
      expect(audits.map((row) => row.action)).toEqual(["record", "record"]);

      const history = await listPurchasePayments(purchase.id, tx);
      expect(history.map((row) => row.amount)).toEqual([300_000, 700_000]);
      expect(history[0]).toMatchObject({ method: "cash", recordedByName: staff.name, voidedAt: null });
      expect(history[0]!.proof).toMatchObject({ contentType: "image/jpeg", originalFilename: "bukti transfer.jpg" });
    });
  });

  test("a payment above the remaining balance is refused with the Indonesian message; exactly the remaining is allowed", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await purchaseFixture(tx);
      await recordPurchasePayment(pay(purchase.id, 400_000), storedFile(), staff.id, tx);
      const error = await rejection(recordPurchasePayment(pay(purchase.id, 600_001), storedFile(), staff.id, tx));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toBe("Jumlah melebihi sisa tagihan (Rp 600.000).");
      await expect(recordPurchasePayment(pay(purchase.id, 600_000), storedFile(), staff.id, tx)).resolves.toBeTruthy();
      await expect(recordPurchasePayment(pay(purchase.id, 1), storedFile(), staff.id, tx)).rejects.toThrow("Tagihan ini sudah lunas.");
    });
  });

  test("the refused payment leaves no private_files row behind (the row is inserted only after the cap check)", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await purchaseFixture(tx);
      const file = storedFile();
      await expect(recordPurchasePayment(pay(purchase.id, 2_000_000), file, staff.id, tx)).rejects.toThrow("melebihi");
      expect(await tx.select().from(privateFiles).where(eq(privateFiles.id, file.id))).toEqual([]);
    });
  });

  test("a future date is refused, today is allowed, and there is no lower bound (A9)", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await purchaseFixture(tx);
      const tomorrow = new Date(`${todayInJakarta()}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const error = await rejection(recordPurchasePayment(pay(purchase.id, 1, { paidAt: tomorrow.toISOString().slice(0, 10) }), storedFile(), staff.id, tx));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toBe("Tanggal bayar tidak boleh di masa depan.");
      await expect(recordPurchasePayment(pay(purchase.id, 1, { paidAt: todayInJakarta() }), storedFile(), staff.id, tx)).resolves.toBeTruthy();
      await expect(recordPurchasePayment(pay(purchase.id, 1, { paidAt: "2019-01-31" }), storedFile(), staff.id, tx)).resolves.toBeTruthy();
      await expect(recordPurchasePayment(pay(purchase.id, 1, { paidAt: "2026-02-31x" }), storedFile(), staff.id, tx)).rejects.toThrow("Tanggal bayar tidak valid.");
    });
  });

  test("a cancelled purchase can't be paid; an unknown purchase is refused; a note over 500 characters is refused", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await purchaseFixture(tx);
      await closePurchase(purchase.id, "Batal pesan", staff.id, tx);
      await expect(recordPurchasePayment(pay(purchase.id, 1), storedFile(), staff.id, tx)).rejects.toThrow("Pesanan yang dibatalkan tidak bisa dibayar.");
      await expect(recordPurchasePayment(pay(randomUUID(), 1), storedFile(), staff.id, tx)).rejects.toThrow("Pesanan pembelian tidak ditemukan.");
      const { purchase: other } = await purchaseFixture(tx);
      await expect(recordPurchasePayment(pay(other.id, 1, { note: "x".repeat(501) }), storedFile(), staff.id, tx)).rejects.toThrow("Catatan maksimal 500");
    });
  });

  test("precheckPurchasePayment refuses what recordPurchasePayment would, without writing anything", async () => {
    await withRollback(async (tx) => {
      const { purchase } = await purchaseFixture(tx);
      await expect(precheckPurchasePayment(pay(purchase.id, 1_000_001), tx)).rejects.toThrow("Jumlah melebihi sisa tagihan (Rp 1.000.000).");
      await expect(precheckPurchasePayment(pay(purchase.id, 1_000_000), tx)).resolves.toBeUndefined();
      expect(await tx.select().from(supplierPayments).where(eq(supplierPayments.purchaseId, purchase.id))).toEqual([]);
    });
  });

  test("a closed purchase is due only what arrived (A1): the cap follows the settled value", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, line } = await purchaseFixture(tx);
      await postGoodsReceiptForPurchase({ purchaseId: purchase.id, receivedAt: "2026-10-03", lines: [{ purchaseItemId: line.id, qtyAccepted: 4 }] }, staff.id, tx);
      await closePurchase(purchase.id, "Sisa tidak dikirim", staff.id, tx);
      expect(await getPurchasePaymentSummary(purchase.id, tx)).toMatchObject({ status: "unpaid", tagihan: 400_000 });
      await expect(recordPurchasePayment(pay(purchase.id, 400_001), storedFile(), staff.id, tx)).rejects.toThrow("Rp 400.000");
      await recordPurchasePayment(pay(purchase.id, 400_000), storedFile(), staff.id, tx);
      expect((await getPurchasePaymentSummary(purchase.id, tx))?.status).toBe("paid");
    });
  });
});

describe("voidPurchasePayment", () => {
  test("a voided payment stays in history but stops counting; audit 'void' with before/after", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await purchaseFixture(tx);
      await recordPurchasePayment(pay(purchase.id, 300_000), storedFile(), staff.id, tx);
      const { payment } = await recordPurchasePayment(pay(purchase.id, 700_000), storedFile(), staff.id, tx);

      const voided = await voidPurchasePayment(payment.id, "  Salah nominal  ", staff.id, tx);
      expect(voided.voidReason).toBe("Salah nominal");
      expect(voided.voidedByStaffUserId).toBe(staff.id);
      expect(await getPurchasePaymentSummary(purchase.id, tx)).toMatchObject({ status: "partial", paid: 300_000, remaining: 700_000 });

      const history = await listPurchasePayments(purchase.id, tx);
      expect(history).toHaveLength(2);
      expect(history.find((row) => row.id === payment.id)).toMatchObject({ voidReason: "Salah nominal", voidedByName: staff.name });

      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "supplier_payment"), eq(auditLog.entityId, payment.id), eq(auditLog.action, "void")));
      expect((audit?.before as { voidedAt: unknown }).voidedAt).toBeNull();
      expect((audit?.after as { voidReason: string }).voidReason).toBe("Salah nominal");
    });
  });

  test("void-once: a second void is refused; a reason is required; an unknown id is refused", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await purchaseFixture(tx);
      const { payment } = await recordPurchasePayment(pay(purchase.id, 100), storedFile(), staff.id, tx);
      const blank = await rejection(voidPurchasePayment(payment.id, "   ", staff.id, tx));
      expect(blank).toBeInstanceOf(FieldError);
      expect(blank.message).toBe("Alasan pembatalan wajib diisi.");
      await voidPurchasePayment(payment.id, "Dobel", staff.id, tx);
      const twice = await rejection(voidPurchasePayment(payment.id, "Lagi", staff.id, tx));
      expect(twice).toBeInstanceOf(ActionError);
      expect(twice.message).toBe("Pembayaran ini sudah dibatalkan.");
      await expect(voidPurchasePayment(randomUUID(), "x", staff.id, tx)).rejects.toThrow("Pembayaran tidak ditemukan.");
    });
  });
});

describe("updatePurchase and closePurchase with payments (§3.1)", () => {
  test("the supplier can't change once a payment exists, even a voided one; without payments it can", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric } = await purchaseFixture(tx);
      const other = await insertSupplier(tx);
      const lines = [{ itemType: "fabric" as const, itemId: fabric.id, qtyOrdered: 10, totalAmount: 1_000_000 }];
      const edit = (supplierId: string) => updatePurchase(purchase.id, { supplierId, orderedAt: "2026-10-01", lines }, staff.id, tx);

      const { payment } = await recordPurchasePayment(pay(purchase.id, 100_000), storedFile(), staff.id, tx);
      const error = await rejection(edit(other.id));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toBe("Pemasok tidak bisa diganti karena sudah ada pembayaran.");
      await voidPurchasePayment(payment.id, "Salah", staff.id, tx);
      await expect(edit(other.id)).rejects.toThrow("Pemasok tidak bisa diganti");
      // Keeping the supplier is still fine.
      await expect(edit(purchase.supplierId)).resolves.toBeTruthy();

      const { purchase: unpaid } = await purchaseFixture(tx);
      const [unpaidLine] = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, unpaid.id));
      await expect(
        updatePurchase(
          unpaid.id,
          { supplierId: other.id, orderedAt: "2026-10-01", lines: [{ itemType: "fabric", itemId: unpaidLine!.fabricId!, qtyOrdered: 10, totalAmount: 1 }] },
          staff.id,
          tx,
        ),
      ).resolves.toMatchObject({ supplierId: other.id });
    });
  });

  test("the order total can't drop below what was paid", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, fabric } = await purchaseFixture(tx);
      await recordPurchasePayment(pay(purchase.id, 500_000), storedFile(), staff.id, tx);
      const edit = (totalAmount: number) =>
        updatePurchase(purchase.id, { supplierId: purchase.supplierId, orderedAt: "2026-10-01", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered: 10, totalAmount }] }, staff.id, tx);
      await expect(edit(499_999)).rejects.toThrow("Total pembelian tidak boleh lebih kecil dari yang sudah dibayar (Rp 500.000).");
      await expect(edit(500_000)).resolves.toBeTruthy();
    });
  });

  test("closing below the DP is allowed and shows 'Lebih bayar'; overpaidIfClosed predicts it", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase, line } = await purchaseFixture(tx);
      await recordPurchasePayment(pay(purchase.id, 500_000), storedFile(), staff.id, tx);
      await postGoodsReceiptForPurchase({ purchaseId: purchase.id, receivedAt: "2026-10-03", lines: [{ purchaseItemId: line.id, qtyAccepted: 2 }] }, staff.id, tx);
      expect(await overpaidIfClosed(purchase.id, "closed", tx)).toBe(300_000);
      await closePurchase(purchase.id, "Supplier kehabisan stok", staff.id, tx);
      expect(await getPurchasePaymentSummary(purchase.id, tx)).toMatchObject({ status: "overpaid", tagihan: 200_000, overpaid: 300_000, remaining: 0 });
      await expect(recordPurchasePayment(pay(purchase.id, 1), storedFile(), staff.id, tx)).rejects.toThrow("Pembayaran sudah melebihi tagihan.");
    });
  });
});

describe("listPurchaseDocuments payment column and filter", () => {
  test("the SQL tagihan equals purchaseTagihan for open, short-closed and cancelled documents, and the filter follows it", async () => {
    await withRollback(async (tx) => {
      const { staff, supplier, fabric } = await purchaseFixture(tx);
      const make = async (qtyOrdered: number, totalAmount: number) =>
        createPurchase({ supplierId: supplier.id, orderedAt: "2026-10-01", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered, totalAmount }] }, staff.id, tx);
      const lineOf = async (purchaseId: string) => (await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)))[0]!;

      const unpaid = await make(3, 1_000_000);
      const partial = await make(3, 1_000_000);
      await recordPurchasePayment(pay(partial.id, 1), storedFile(), staff.id, tx);
      // Short-closed at 1 of 3 yards: roundHalfUp(1_000_000 / 3) = 333_333.
      const shortClosed = await make(3, 1_000_000);
      await postGoodsReceiptForPurchase({ purchaseId: shortClosed.id, receivedAt: "2026-10-03", lines: [{ purchaseItemId: (await lineOf(shortClosed.id)).id, qtyAccepted: 1 }] }, staff.id, tx);
      await closePurchase(shortClosed.id, "Tutup", staff.id, tx);
      await recordPurchasePayment(pay(shortClosed.id, 333_333), storedFile(), staff.id, tx);
      // Fractional: 2 of 3 yards -> roundHalfUp(2_000_000 / 3) = 666_667 (half-up, not truncated).
      const twoThirds = await make(3, 1_000_000);
      await postGoodsReceiptForPurchase({ purchaseId: twoThirds.id, receivedAt: "2026-10-03", lines: [{ purchaseItemId: (await lineOf(twoThirds.id)).id, qtyAccepted: 2 }] }, staff.id, tx);
      await closePurchase(twoThirds.id, "Tutup", staff.id, tx);
      const cancelled = await make(3, 1_000_000);
      await closePurchase(cancelled.id, "Batal", staff.id, tx);

      const { rows } = await listPurchaseDocuments({ q: supplier.name }, undefined, "100", tx);
      const byId = new Map(rows.map((row) => [row.id, row.payment]));
      expect(byId.get(unpaid.id)).toMatchObject({ status: "unpaid", tagihan: 1_000_000 });
      expect(byId.get(partial.id)).toMatchObject({ status: "partial", paid: 1 });
      expect(byId.get(shortClosed.id)).toMatchObject({ status: "paid", tagihan: purchaseTagihan("closed", [{ qtyOrdered: 3, totalAmount: 1_000_000, qtySettled: 1 }]) });
      expect(byId.get(twoThirds.id)).toMatchObject({ tagihan: 666_667 });
      expect(purchaseTagihan("closed", [{ qtyOrdered: 3, totalAmount: 1_000_000, qtySettled: 2 }])).toBe(666_667);
      expect(byId.get(cancelled.id)).toMatchObject({ status: "no_bill", tagihan: 0 });
      // The TS summary on the detail page agrees with every list row.
      for (const row of rows) expect(await getPurchasePaymentSummary(row.id, tx)).toEqual(row.payment);

      const ids = async (payment: "unpaid" | "partial" | "paid") =>
        (await listPurchaseDocuments({ q: supplier.name, payment }, undefined, "100", tx)).rows.map((row) => row.id).sort();
      // The fixture's own first purchase is unpaid too.
      expect(await ids("unpaid")).not.toContain(cancelled.id);
      expect(await ids("unpaid")).toEqual(expect.arrayContaining([unpaid.id, twoThirds.id]));
      expect(await ids("partial")).toEqual([partial.id]);
      expect(await ids("paid")).toEqual([shortClosed.id]);
    });
  });
});

describe("listPurchaseDocuments SQL tagihan: defects, reversals, rounding", () => {
  test("a reject at receipt counts as settled, a reversed receipt does not, and half a rupiah rounds up", async () => {
    await withRollback(async (tx) => {
      const { staff, supplier, fabric } = await purchaseFixture(tx);
      const make = async (qtyOrdered: number, totalAmount: number) => {
        const purchase = await createPurchase(
          { supplierId: supplier.id, orderedAt: "2026-10-01", lines: [{ itemType: "fabric", itemId: fabric.id, qtyOrdered, totalAmount }] },
          staff.id,
          tx,
        );
        const [line] = await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, purchase.id));
        return { purchase, line: line! };
      };
      const receive = (purchaseId: string, purchaseItemId: string, qtyAccepted: number, qtyRejected = 0) =>
        postGoodsReceiptForPurchase({ purchaseId, receivedAt: "2026-10-03", lines: [{ purchaseItemId, qtyAccepted, qtyRejected }] }, staff.id, tx);

      // 2 accepted + 1 rejected of 4, then one more accepted receipt that is reversed: settled 3.
      const withDefects = await make(4, 1_000_000);
      await receive(withDefects.purchase.id, withDefects.line.id, 2, 1);
      const extra = await receive(withDefects.purchase.id, withDefects.line.id, 1);
      await reverseGoodsReceipt(extra.receipt.id, staff.id, tx);
      await closePurchase(withDefects.purchase.id, "Tutup", staff.id, tx);
      // Exactly half a rupiah: 1_000_001 × 1 / 2 = 500_000.5 -> 500_001 (half up).
      const half = await make(2, 1_000_001);
      await receive(half.purchase.id, half.line.id, 1);
      await closePurchase(half.purchase.id, "Tutup", staff.id, tx);
      // A fractional quantity: 2.5 of 7.25 yards of Rp 999.999.
      const fractional = await make(7.25, 999_999);
      await receive(fractional.purchase.id, fractional.line.id, 2.5);
      await closePurchase(fractional.purchase.id, "Tutup", staff.id, tx);

      const { rows } = await listPurchaseDocuments({ q: supplier.name }, undefined, "100", tx);
      const tagihanOf = (id: string) => (rows.find((row) => row.id === id)?.payment as { tagihan: number }).tagihan;
      expect(tagihanOf(withDefects.purchase.id)).toBe(purchaseTagihan("closed", [{ qtyOrdered: 4, totalAmount: 1_000_000, qtySettled: 3 }]));
      expect(tagihanOf(withDefects.purchase.id)).toBe(750_000);
      expect(tagihanOf(half.purchase.id)).toBe(500_001);
      expect(tagihanOf(half.purchase.id)).toBe(purchaseTagihan("closed", [{ qtyOrdered: 2, totalAmount: 1_000_001, qtySettled: 1 }]));
      expect(tagihanOf(fractional.purchase.id)).toBe(purchaseTagihan("closed", [{ qtyOrdered: 7.25, totalAmount: 999_999, qtySettled: 2.5 }]));
      for (const row of rows) expect(await getPurchasePaymentSummary(row.id, tx)).toEqual(row.payment);
    });
  });
});

describe("purchase attachments (nota)", () => {
  test("attach, list, void once with a reason; audited", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await purchaseFixture(tx);
      const attachment = await attachPurchaseInvoice({ purchaseId: purchase.id, note: "Nota asli" }, storedFile("purchase_invoice"), staff.id, tx);
      expect((await listPurchaseAttachments(purchase.id, tx)).map((row) => row.note)).toEqual(["Nota asli"]);
      await expect(voidPurchaseAttachment(attachment.id, " ", staff.id, tx)).rejects.toThrow("Alasan pembatalan wajib diisi.");
      await voidPurchaseAttachment(attachment.id, "Salah foto", staff.id, tx);
      await expect(voidPurchaseAttachment(attachment.id, "Lagi", staff.id, tx)).rejects.toThrow("Nota ini sudah dibatalkan.");
      expect((await listPurchaseAttachments(purchase.id, tx))[0]).toMatchObject({ voidReason: "Salah foto" });
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "purchase_attachment"), eq(auditLog.entityId, attachment.id)));
      expect(audits.map((row) => row.action).sort()).toEqual(["attach", "void"]);
    });
  });

  test("a payment proof and a nota can't swap purposes", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await purchaseFixture(tx);
      await expect(attachPurchaseInvoice({ purchaseId: purchase.id }, storedFile("payment_proof"), staff.id, tx)).rejects.toThrow("expected a purchase_invoice");
      await expect(recordPurchasePayment(pay(purchase.id, 1), storedFile("purchase_invoice"), staff.id, tx)).rejects.toThrow("expected a payment_proof");
    });
  });
});

describe("findPaymentsWithProofHash (duplicate-proof warning)", () => {
  test("names non-voided payments whose proof had the same original bytes", async () => {
    await withRollback(async (tx) => {
      const { staff, purchase } = await purchaseFixture(tx);
      const hash = sha(`same-photo-${randomUUID()}`);
      const { payment } = await recordPurchasePayment(pay(purchase.id, 100), storedFile("payment_proof", hash), staff.id, tx);
      expect(await findPaymentsWithProofHash(hash, tx)).toEqual([payment.paymentNo]);
      await voidPurchasePayment(payment.id, "Dobel", staff.id, tx);
      expect(await findPaymentsWithProofHash(hash, tx)).toEqual([]);
      expect(await findPaymentsWithProofHash("not-a-hash", tx)).toEqual([]);
    });
  });
});

// Real commits, not withRollback's single shared transaction: row-lock contention needs two
// separate transactions. The rows are append-only, so cleanup disables the triggers by name for
// these disposable fixtures only (withTriggerDisabled).
async function cleanup(purchaseId: string, extra: { supplierId: string; fabricId: string; staffId: string }) {
  const payments = await testDb.select().from(supplierPayments).where(eq(supplierPayments.purchaseId, purchaseId));
  const fileIds = payments.map((row) => row.proofFileId);
  await testDb.delete(auditLog).where(inArray(auditLog.entityId, [purchaseId, ...payments.map((row) => row.id)]));
  await withTriggerDisabled(testDb, "supplier_payments", "prevent_supplier_payment_mutation", () =>
    testDb.delete(supplierPayments).where(eq(supplierPayments.purchaseId, purchaseId)),
  );
  await withTriggerDisabled(testDb, "purchase_attachments", "prevent_purchase_attachment_mutation", () =>
    testDb.delete(purchaseAttachments).where(eq(purchaseAttachments.purchaseId, purchaseId)),
  );
  if (fileIds.length > 0) {
    await withTriggerDisabled(testDb, "private_files", "prevent_private_file_mutation", () => testDb.delete(privateFiles).where(inArray(privateFiles.id, fileIds)));
  }
  await testDb.delete(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId));
  await testDb.delete(purchases).where(eq(purchases.id, purchaseId));
  await testDb.delete(suppliers).where(eq(suppliers.id, extra.supplierId));
  await testDb.delete(fabrics).where(eq(fabrics.id, extra.fabricId));
  await testDb.delete(staffUsers).where(eq(staffUsers.id, extra.staffId));
}

describe("concurrency (real commits)", () => {
  test("two parallel payments that together exceed the remaining: exactly one succeeds", async () => {
    const { staff, supplier, fabric, purchase } = await purchaseFixture(testDb);
    try {
      const outcomes = await Promise.allSettled([
        recordPurchasePayment(pay(purchase.id, 600_000), storedFile(), staff.id, testDb),
        recordPurchasePayment(pay(purchase.id, 600_000), storedFile(), staff.id, testDb),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const failed = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(failed).toHaveLength(1);
      expect(String(failed[0]!.reason.message)).toBe("Jumlah melebihi sisa tagihan (Rp 400.000).");
      expect(await getPurchasePaymentSummary(purchase.id, testDb)).toMatchObject({ paid: 600_000, status: "partial" });
      // Only the winner's proof row exists.
      expect(await testDb.select().from(supplierPayments).where(eq(supplierPayments.purchaseId, purchase.id))).toHaveLength(1);
    } finally {
      await cleanup(purchase.id, { supplierId: supplier.id, fabricId: fabric.id, staffId: staff.id });
    }
  });

  test("a concurrent double void: exactly one wins", async () => {
    const { staff, supplier, fabric, purchase } = await purchaseFixture(testDb);
    try {
      const { payment } = await recordPurchasePayment(pay(purchase.id, 100), storedFile(), staff.id, testDb);
      const outcomes = await Promise.allSettled([
        voidPurchasePayment(payment.id, "A", staff.id, testDb),
        voidPurchasePayment(payment.id, "B", staff.id, testDb),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const failed = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(String(failed[0]!.reason.message)).toBe("Pembayaran ini sudah dibatalkan.");
      const voids = await testDb.select().from(auditLog).where(and(eq(auditLog.entityId, payment.id), eq(auditLog.action, "void")));
      expect(voids).toHaveLength(1);
    } finally {
      await cleanup(purchase.id, { supplierId: supplier.id, fabricId: fabric.id, staffId: staff.id });
    }
  });
});
