import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { businessExpenses, privateFiles, purchaseAttachments, purchases, supplierPayments, suppliers, type PrivateFilePurpose } from "@ammari/db/schema";
import { buildPrivateFileKey, findServablePrivateFile, PRIVATE_FILE_VIEW_PERMISSIONS } from "./private-files";

const HEX = "a".repeat(64);

async function insertFile(tx: TestTx, staffUserId: string, purpose: PrivateFilePurpose, contentType: "image/jpeg" | "application/pdf" = "image/jpeg") {
  const id = randomUUID();
  const [row] = await tx
    .insert(privateFiles)
    .values({
      id,
      purpose,
      storageKey: `test/${purpose}/2026/10/${id}.${contentType === "image/jpeg" ? "jpg" : "pdf"}`,
      contentType,
      byteSize: 10,
      sha256: HEX,
      originalFilename: "bukti.jpg",
      originalContentType: contentType,
      originalByteSize: 10,
      originalSha256: HEX,
      uploadedByStaffUserId: staffUserId,
    })
    .returning();
  return row!;
}

async function insertPurchase(tx: TestTx) {
  const [supplier] = await tx.insert(suppliers).values({ name: `Pemasok ${randomUUID().slice(0, 8)}` }).returning();
  const [purchase] = await tx
    .insert(purchases)
    .values({ purchaseNo: `PO-TEST-${randomUUID().slice(0, 8)}`, supplierId: supplier!.id, orderedAt: "2026-10-01" })
    .returning();
  return { supplier: supplier!, purchase: purchase! };
}

describe("buildPrivateFileKey", () => {
  test("prefix + purpose + Jakarta year/month + id + extension", () => {
    // 2026-10-31T18:00Z is already 1 November in Jakarta (UTC+7).
    expect(buildPrivateFileKey({ prefix: "dev/", purpose: "payment_proof", id: "abc", extension: "jpg", now: new Date("2026-10-31T18:00:00Z") })).toBe(
      "dev/payment_proof/2026/11/abc.jpg",
    );
    expect(buildPrivateFileKey({ prefix: "", purpose: "purchase_invoice", id: "x", extension: "pdf", now: new Date("2026-01-15T00:00:00Z") })).toBe(
      "purchase_invoice/2026/01/x.pdf",
    );
  });
});

describe("PRIVATE_FILE_VIEW_PERMISSIONS", () => {
  test("a proof needs supplier_payments.manage + finance.view_profit; a nota inventory.view + finance.view_profit (plan §7)", () => {
    expect(PRIVATE_FILE_VIEW_PERMISSIONS.payment_proof).toEqual(["supplier_payments.manage", "finance.view_profit"]);
    expect(PRIVATE_FILE_VIEW_PERMISSIONS.purchase_invoice).toEqual(["inventory.view", "finance.view_profit"]);
  });

  test("an expense proof needs ads_expenses.manage + finance.view_profit (docs/plans/growth.md §5)", () => {
    expect(PRIVATE_FILE_VIEW_PERMISSIONS.expense_proof).toEqual(["ads_expenses.manage", "finance.view_profit"]);
  });
});

describe("findServablePrivateFile", () => {
  test("null for a malformed or unknown id", async () => {
    await withRollback(async (tx) => {
      expect(await findServablePrivateFile(tx, "not-a-uuid")).toBeNull();
      expect(await findServablePrivateFile(tx, "../../etc/passwd")).toBeNull();
      expect(await findServablePrivateFile(tx, randomUUID())).toBeNull();
    });
  });

  test("null for an orphan file row (stored but never referenced by a payment)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const file = await insertFile(tx, staff.id, "payment_proof");
      expect(await findServablePrivateFile(tx, file.id)).toBeNull();
    });
  });

  test("a payment proof is served as <payment_no>.jpg, also after the payment is voided", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { supplier, purchase } = await insertPurchase(tx);
      const file = await insertFile(tx, staff.id, "payment_proof");
      const [payment] = await tx
        .insert(supplierPayments)
        .values({
          paymentNo: "BYR-202610-901",
          targetType: "purchase",
          purchaseId: purchase.id,
          supplierId: supplier.id,
          supplierName: supplier.name,
          paidAt: "2026-10-02",
          amount: 100_000,
          method: "transfer",
          proofFileId: file.id,
          recordedByStaffUserId: staff.id,
        })
        .returning();

      expect(await findServablePrivateFile(tx, file.id.toUpperCase())).toEqual({
        id: file.id,
        purpose: "payment_proof",
        storageKey: file.storageKey,
        contentType: "image/jpeg",
        byteSize: 10,
        sha256: HEX,
        downloadName: "BYR-202610-901.jpg",
      });

      await tx
        .update(supplierPayments)
        .set({ voidedAt: new Date(), voidedByStaffUserId: staff.id, voidReason: "salah input" })
        .where(eq(supplierPayments.id, payment!.id));
      expect((await findServablePrivateFile(tx, file.id))?.downloadName).toBe("BYR-202610-901.jpg");
    });
  });

  test("a nota attached to a purchase is served as <purchase_no>-nota.pdf", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const { purchase } = await insertPurchase(tx);
      const file = await insertFile(tx, staff.id, "purchase_invoice", "application/pdf");
      await tx.insert(purchaseAttachments).values({ purchaseId: purchase.id, kind: "invoice", fileId: file.id, createdByStaffUserId: staff.id });

      const servable = await findServablePrivateFile(tx, file.id);
      expect(servable).toMatchObject({ purpose: "purchase_invoice", contentType: "application/pdf", downloadName: `${purchase.purchaseNo}-nota.pdf` });
    });
  });

  test("an expense proof is served as <expense_no>.jpg, also after the expense is voided", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const file = await insertFile(tx, staff.id, "expense_proof");
      const [expense] = await tx
        .insert(businessExpenses)
        .values({ expenseNo: "BYA-202610-901", expenseDate: "2026-10-05", category: "packaging", amount: 250_000, method: "cash", proofFileId: file.id, recordedByStaffUserId: staff.id })
        .returning();
      expect(await findServablePrivateFile(tx, file.id)).toMatchObject({ purpose: "expense_proof", downloadName: "BYA-202610-901.jpg" });
      await tx
        .update(businessExpenses)
        .set({ voidedAt: new Date(), voidedByStaffUserId: staff.id, voidReason: "salah input" })
        .where(eq(businessExpenses.id, expense!.id));
      expect((await findServablePrivateFile(tx, file.id))?.downloadName).toBe("BYA-202610-901.jpg");
    });
  });
});
