import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled } from "@ammari/db/test-utils";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { auditLog, businessExpenses, privateFiles, purchases, staffUsers, supplierPayments, suppliers, type PrivateFilePurpose } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { privateFileValues } from "@/lib/supplier-payments/payment-records";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import {
  findProofHashUses,
  listBusinessExpenses,
  normalizeExpenseInput,
  recordBusinessExpense,
  voidBusinessExpense,
  type BusinessExpenseInput,
} from "./records";

// docs/plans/growth.md §5, session S2: the expense write paths and the list read.

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A stored file as storePrivateUpload would return it; the DB write path records metadata only. */
function storedFile(purpose: PrivateFilePurpose = "expense_proof", originalSha256 = sha(randomUUID())): StoredPrivateFile {
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
      originalFilename: "struk iklan.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 2345,
      originalSha256,
      jpegQuality: 82,
    },
  };
}

function expense(overrides: Partial<BusinessExpenseInput> = {}): BusinessExpenseInput {
  return { expenseDate: "2026-10-05", category: "ads_shopee", amount: 500_000, method: "platform_balance", channelId: null, ...overrides };
}

function fieldOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof FieldError) return error.field;
    throw error;
  }
}

describe("normalizeExpenseInput", () => {
  test("fills the fixed channel of Iklan Shopee/TikTok and trims text", () => {
    expect(normalizeExpenseInput(expense({ campaign: "  11.11  ", note: "  " }))).toEqual({
      expenseDate: "2026-10-05",
      category: "ads_shopee",
      amount: 500_000,
      method: "platform_balance",
      channelId: "shopee",
      campaign: "11.11",
      note: null,
    });
    expect(normalizeExpenseInput(expense({ category: "ads_tiktok" })).channelId).toBe("tiktok");
  });

  test("refuses a future date, a bad date, a non-positive or huge amount", () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    expect(fieldOf(() => normalizeExpenseInput(expense({ expenseDate: todayInJakarta(tomorrow) })))).toBe("expenseDate");
    expect(fieldOf(() => normalizeExpenseInput(expense({ expenseDate: "2026-02-30" })))).toBe("expenseDate");
    expect(fieldOf(() => normalizeExpenseInput(expense({ expenseDate: "0026-10-05" })))).toBe("expenseDate");
    expect(fieldOf(() => normalizeExpenseInput(expense({ expenseDate: "1999-12-31" })))).toBe("expenseDate");
    expect(fieldOf(() => normalizeExpenseInput(expense({ amount: 0 })))).toBe("amount");
    expect(fieldOf(() => normalizeExpenseInput(expense({ amount: 1.5 })))).toBe("amount");
    expect(fieldOf(() => normalizeExpenseInput(expense({ amount: 1_000_000_001 })))).toBe("amount");
    // Today and the far past are fine (no lower bound).
    expect(normalizeExpenseInput(expense({ expenseDate: todayInJakarta() })).expenseDate).toBe(todayInJakarta());
    expect(normalizeExpenseInput(expense({ expenseDate: "2000-01-01" })).expenseDate).toBe("2000-01-01");
  });

  test("channel rules: wrong channel on a fixed ad, any channel on an operating cost, odd channel on Meta", () => {
    expect(fieldOf(() => normalizeExpenseInput(expense({ channelId: "tiktok" })))).toBe("channelId");
    expect(fieldOf(() => normalizeExpenseInput(expense({ category: "salary", method: "transfer", channelId: "web" })))).toBe("channelId");
    expect(fieldOf(() => normalizeExpenseInput(expense({ category: "ads_meta", method: "card", channelId: "offline" })))).toBe("channelId");
    expect(normalizeExpenseInput(expense({ category: "ads_meta", method: "card", channelId: null })).channelId).toBeNull();
    expect(normalizeExpenseInput(expense({ category: "endorsement", method: "transfer", channelId: "instagram" })).channelId).toBe("instagram");
  });

  test("Lainnya needs a note; campaign only on marketing; lengths", () => {
    expect(fieldOf(() => normalizeExpenseInput(expense({ category: "other", method: "cash" })))).toBe("note");
    expect(normalizeExpenseInput(expense({ category: "other", method: "cash", note: "Servis mesin" })).note).toBe("Servis mesin");
    expect(fieldOf(() => normalizeExpenseInput(expense({ category: "rent", method: "transfer", campaign: "x" })))).toBe("campaign");
    expect(fieldOf(() => normalizeExpenseInput(expense({ campaign: "x".repeat(121) })))).toBe("campaign");
    expect(fieldOf(() => normalizeExpenseInput(expense({ note: "x".repeat(501) })))).toBe("note");
  });
});

describe("recordBusinessExpense", () => {
  test("writes the file row, the expense (BYA number) and one audit entry", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const file = storedFile();
      const row = await recordBusinessExpense(expense({ campaign: "Promo 11.11" }), file, staff.id, tx);

      expect(row.expenseNo).toMatch(/^BYA-\d{6}-\d{3}$/);
      expect(row).toMatchObject({ category: "ads_shopee", channelId: "shopee", amount: 500_000, campaign: "Promo 11.11", proofFileId: file.id, voidedAt: null });
      const [fileRow] = await tx.select().from(privateFiles).where(eq(privateFiles.id, file.id));
      expect(fileRow).toMatchObject({ purpose: "expense_proof", uploadedByStaffUserId: staff.id });
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, row.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "record", entityType: "business_expense", actorStaffUserId: staff.id });
    });
  });

  test("numbers run on within a month", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const first = await recordBusinessExpense(expense(), storedFile(), staff.id, tx);
      const second = await recordBusinessExpense(expense({ category: "packaging", method: "cash" }), storedFile(), staff.id, tx);
      const seq = (no: string) => Number(no.split("-")[2]);
      expect(seq(second.expenseNo)).toBe(seq(first.expenseNo) + 1);
    });
  });

  test("refuses a file stored for another purpose, and invalid input before writing anything", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await expect(recordBusinessExpense(expense(), storedFile("payment_proof"), staff.id, tx)).rejects.toThrow(/expense_proof/);
      const file = storedFile();
      await expect(recordBusinessExpense(expense({ amount: 0 }), file, staff.id, tx)).rejects.toBeInstanceOf(FieldError);
      expect(await tx.select().from(privateFiles).where(eq(privateFiles.id, file.id))).toHaveLength(0);
    });
  });
});

describe("voidBusinessExpense", () => {
  test("stamps the void once, with the reason and an audit entry; a second void is refused", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const row = await recordBusinessExpense(expense(), storedFile(), staff.id, tx);
      const voided = await voidBusinessExpense(row.id, "  Salah nominal  ", staff.id, tx);
      expect(voided).toMatchObject({ voidReason: "Salah nominal", voidedByStaffUserId: staff.id });
      expect(voided.voidedAt).toBeInstanceOf(Date);
      await expect(voidBusinessExpense(row.id, "Lagi", staff.id, tx)).rejects.toThrow("Biaya ini sudah dibatalkan.");
      const voids = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, "void")));
      expect(voids).toHaveLength(1);
    });
  });

  test("requires a reason; unknown id is an Indonesian error", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const row = await recordBusinessExpense(expense(), storedFile(), staff.id, tx);
      await expect(voidBusinessExpense(row.id, "   ", staff.id, tx)).rejects.toBeInstanceOf(FieldError);
      await expect(voidBusinessExpense(randomUUID(), "x", staff.id, tx)).rejects.toThrow("Biaya tidak ditemukan.");
    });
  });

  test("a concurrent double void: exactly one wins (real commits)", async () => {
    const staff = await insertStaffUser(testDb);
    const file = storedFile();
    let expenseId: string | null = null;
    try {
      const row = await recordBusinessExpense(expense(), file, staff.id, testDb);
      expenseId = row.id;
      const outcomes = await Promise.allSettled([
        voidBusinessExpense(row.id, "A", staff.id, testDb),
        voidBusinessExpense(row.id, "B", staff.id, testDb),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const failed = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      expect(failed[0]!.reason).toBeInstanceOf(ActionError);
      expect(String(failed[0]!.reason.message)).toBe("Biaya ini sudah dibatalkan.");
      const voids = await testDb.select().from(auditLog).where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, "void")));
      expect(voids).toHaveLength(1);
    } finally {
      // Disposable fixtures only: the rows are append-only, so the triggers are disabled by name.
      if (expenseId) {
        await testDb.delete(auditLog).where(eq(auditLog.entityId, expenseId));
        await withTriggerDisabled(testDb, "business_expenses", "prevent_business_expense_mutation", () =>
          testDb.delete(businessExpenses).where(eq(businessExpenses.id, expenseId!)),
        );
      }
      await withTriggerDisabled(testDb, "private_files", "prevent_private_file_mutation", () => testDb.delete(privateFiles).where(eq(privateFiles.id, file.id)));
      await testDb.delete(staffUsers).where(eq(staffUsers.id, staff.id));
    }
  });
});

describe("findProofHashUses", () => {
  test("finds non-voided expenses (and supplier payments only when asked) with the same upload", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const hash = sha(randomUUID());
      const first = await recordBusinessExpense(expense(), storedFile("expense_proof", hash), staff.id, tx);
      const voided = await recordBusinessExpense(expense({ category: "rent", method: "transfer" }), storedFile("expense_proof", hash), staff.id, tx);
      await voidBusinessExpense(voided.id, "dobel", staff.id, tx);

      expect(await findProofHashUses(hash, { includeSupplierPayments: false }, tx)).toEqual([first.expenseNo]);
      expect(await findProofHashUses(sha("never uploaded"), { includeSupplierPayments: true }, tx)).toEqual([]);

      // The same bytes as a supplier payment proof: listed only when asked, and never once voided.
      const [paymentFile] = await tx.insert(privateFiles).values(privateFileValues(storedFile("payment_proof", hash), staff.id)).returning();
      const [purchaseSupplier] = await tx.insert(suppliers).values({ name: `Supplier Bukti ${randomUUID().slice(0, 8)}` }).returning();
      const [purchase] = await tx
        .insert(purchases)
        .values({ purchaseNo: `PO-209901-${randomUUID().slice(0, 3)}`, supplierId: purchaseSupplier!.id, orderedAt: "2026-10-01", createdByStaffUserId: staff.id })
        .returning();
      const [payment] = await tx
        .insert(supplierPayments)
        .values({
          paymentNo: "BYR-209901-001",
          targetType: "purchase",
          purchaseId: purchase!.id,
          supplierId: purchaseSupplier!.id,
          supplierName: purchaseSupplier!.name,
          paidAt: "2026-10-02",
          amount: 1000,
          method: "transfer",
          proofFileId: paymentFile!.id,
          recordedByStaffUserId: staff.id,
        })
        .returning();
      expect(await findProofHashUses(hash, { includeSupplierPayments: false }, tx)).toEqual([first.expenseNo]);
      expect((await findProofHashUses(hash, { includeSupplierPayments: true }, tx)).sort()).toEqual([first.expenseNo, "BYR-209901-001"].sort());
      await tx.update(supplierPayments).set({ voidedAt: new Date(), voidedByStaffUserId: staff.id, voidReason: "dobel" }).where(eq(supplierPayments.id, payment!.id));
      expect(await findProofHashUses(hash, { includeSupplierPayments: true }, tx)).toEqual([first.expenseNo]);
      expect(await findProofHashUses("not-a-hash", { includeSupplierPayments: true }, tx)).toEqual([]);
    });
  });
});

describe("listBusinessExpenses", () => {
  test("filters by month, group, category and search; voided rows only on request; total of the non-voided", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const ad = await recordBusinessExpense(expense({ expenseDate: "2026-09-30", campaign: "Kampanye Unik Uji" }), storedFile(), staff.id, tx);
      const salary = await recordBusinessExpense(expense({ expenseDate: "2026-09-01", category: "salary", method: "transfer", amount: 3_000_000 }), storedFile(), staff.id, tx);
      const voided = await recordBusinessExpense(expense({ expenseDate: "2026-09-15", category: "rent", method: "transfer", amount: 9_999 }), storedFile(), staff.id, tx);
      await voidBusinessExpense(voided.id, "salah", staff.id, tx);
      await recordBusinessExpense(expense({ expenseDate: "2026-08-31", category: "packaging", method: "cash" }), storedFile(), staff.id, tx);

      const september = await listBusinessExpenses({ month: "2026-09" }, undefined, undefined, tx);
      // Newest payment date first.
      expect(september.rows.map((row) => row.id)).toEqual([ad.id, salary.id]);
      expect(september.total).toBe(3_500_000);
      expect(september.rows[0]).toMatchObject({ recordedByName: "Test Staff", proof: { contentType: "image/jpeg" } });

      const withVoided = await listBusinessExpenses({ month: "2026-09", showVoided: true }, undefined, undefined, tx);
      expect(withVoided.rows.map((row) => row.id)).toEqual([ad.id, voided.id, salary.id]);
      expect(withVoided.total).toBe(3_500_000);

      expect((await listBusinessExpenses({ month: "2026-09", group: "marketing" }, undefined, undefined, tx)).rows.map((row) => row.id)).toEqual([ad.id]);
      expect((await listBusinessExpenses({ month: "2026-09", group: "operational" }, undefined, undefined, tx)).rows.map((row) => row.id)).toEqual([salary.id]);
      expect((await listBusinessExpenses({ month: "2026-09", category: "salary" }, undefined, undefined, tx)).total).toBe(3_000_000);
      expect((await listBusinessExpenses({ month: "2026-09", q: "unik uji" }, undefined, undefined, tx)).rows.map((row) => row.id)).toEqual([ad.id]);
      expect((await listBusinessExpenses({ month: "2026-09", q: salary.expenseNo }, undefined, undefined, tx)).rows.map((row) => row.id)).toEqual([salary.id]);
      // Rows of other tests never leak in: month is required.
      const ids = (await listBusinessExpenses({ month: "2026-08" }, undefined, undefined, tx)).rows.map((row) => row.id);
      expect(ids).not.toEqual(expect.arrayContaining([ad.id]));
    });
  });
});
