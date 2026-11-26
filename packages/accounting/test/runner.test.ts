import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  accountMappings,
  accounts,
  businessExpenses,
  expenseCategories,
  fabrics,
  fiscalPeriods,
  journalEntries,
  journalLines,
  postingIssues,
  postingRuns,
  privateFiles,
  productionBatches,
  purchases,
  supplierPayments,
  suppliers,
  type BusinessExpenseMethod,
  type PrivateFilePurpose,
} from "@ammari/db/schema";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { expenseRule } from "../src/rules/expenses";
import { expenseSource, runPosting, supplierPaymentSource, type Database } from "../src/runner";

// The posting runner against the real 0049 triggers (docs/plans/accounting.md §2, Session 2):
// idempotent (run twice = no new rows), void → negation journal, changed mapping or rule bump →
// reverse + repost, closed period → correction dated in the first open month, unpostable sources →
// the issue queue, the D-14 guard, and the cut-over filter.
//
// Each test runs in one rolled-back transaction on `ammari_test`; the runner's per-key writes are
// savepoints inside it (READ COMMITTED, the default, as the period-lock trigger requires).
// `SET CONSTRAINTS ALL IMMEDIATE` fires the deferred balance and reversal-mirror triggers before
// the rollback, so every journal the runner wrote is checked by the database too. Assertions are
// per posting key: `ammari_test` may hold other suites' committed rows, which the runner also scans.

/** Runs the runner the way the "Posting sekarang" button does, and then has the database check
 * every deferred constraint on what it wrote. */
async function run(tx: TestTx, sources?: Parameters<typeof runPosting>[1]["sources"]) {
  const result = await runPosting(tx as Database, { trigger: "cron", sources });
  await tx.execute(sql`set constraints all immediate`);
  // Back to the declared (deferred) mode, or the next run's entries would be checked before their
  // lines are inserted.
  await tx.execute(sql`set constraints all deferred`);
  return result;
}

async function insertProof(tx: TestTx, staffId: string, purpose: PrivateFilePurpose): Promise<string> {
  const fileId = randomUUID();
  const sha = fileId.replaceAll("-", "").padEnd(64, "0");
  await tx.insert(privateFiles).values({
    id: fileId,
    purpose,
    storageKey: `test/${purpose}/${fileId}.jpg`,
    contentType: "image/jpeg",
    byteSize: 1,
    sha256: sha,
    originalFilename: "bukti.jpg",
    originalContentType: "image/jpeg",
    originalByteSize: 1,
    originalSha256: sha,
    uploadedByStaffUserId: staffId,
  });
  return fileId;
}

interface ExpenseInput {
  date: string;
  amount?: number;
  category?: string;
  method?: BusinessExpenseMethod;
  channelId?: "shopee" | "tiktok" | null;
  voidedAt?: Date;
}

async function insertExpense(tx: TestTx, staffId: string, input: ExpenseInput): Promise<string> {
  const [row] = await tx
    .insert(businessExpenses)
    .values({
      expenseNo: `BYA-T-${randomUUID().slice(0, 8)}`,
      expenseDate: input.date,
      category: input.category ?? "salary",
      amount: input.amount ?? 2_500_000,
      method: input.method ?? "transfer",
      channelId: input.channelId ?? null,
      proofFileId: await insertProof(tx, staffId, "expense_proof"),
      recordedByStaffUserId: staffId,
      ...(input.voidedAt ? { voidedAt: input.voidedAt, voidedByStaffUserId: staffId, voidReason: "Salah catat" } : {}),
    })
    .returning({ id: businessExpenses.id });
  return row!.id;
}

/** A purchase (and a batch) to pay against. */
async function insertDocuments(tx: TestTx, staffId: string) {
  const suffix = randomUUID().slice(0, 8);
  const [vendor] = await tx.insert(suppliers).values({ name: `Uji Toko Kain ${suffix}` }).returning({ id: suppliers.id, name: suppliers.name });
  const [tailor] = await tx.insert(suppliers).values({ name: `Uji Penjahit ${suffix}` }).returning({ id: suppliers.id, name: suppliers.name });
  const [fabric] = await tx.insert(fabrics).values({ name: `Uji Katun ${suffix}` }).returning({ id: fabrics.id });
  const [purchase] = await tx
    .insert(purchases)
    .values({ purchaseNo: `PO-T-${suffix}`, supplierId: vendor!.id, orderedAt: "2026-12-01", createdByStaffUserId: staffId })
    .returning({ id: purchases.id });
  const [batch] = await tx.insert(productionBatches).values({ fabricId: fabric!.id, batchNo: `BTC-T-${suffix}`, producedAt: "2026-12-02" }).returning({ id: productionBatches.id });
  return { vendor: vendor!, tailor: tailor!, purchaseId: purchase!.id, batchId: batch!.id };
}

interface PaymentInput {
  paidAt: string;
  amount?: number;
  method?: "cash" | "transfer";
  voidedAt?: Date;
}

async function insertPurchasePayment(tx: TestTx, staffId: string, docs: Awaited<ReturnType<typeof insertDocuments>>, input: PaymentInput): Promise<string> {
  const [row] = await tx
    .insert(supplierPayments)
    .values({
      paymentNo: `BYR-T-${randomUUID().slice(0, 8)}`,
      targetType: "purchase",
      purchaseId: docs.purchaseId,
      supplierId: docs.vendor.id,
      supplierName: docs.vendor.name,
      paidAt: input.paidAt,
      amount: input.amount ?? 1_000_000,
      method: input.method ?? "transfer",
      proofFileId: await insertProof(tx, staffId, "payment_proof"),
      recordedByStaffUserId: staffId,
      ...(input.voidedAt ? { voidedAt: input.voidedAt, voidedByStaffUserId: staffId, voidReason: "Salah nominal" } : {}),
    })
    .returning({ id: supplierPayments.id });
  return row!.id;
}

async function insertBatchPayment(tx: TestTx, staffId: string, docs: Awaited<ReturnType<typeof insertDocuments>>, input: PaymentInput & { payee: boolean }): Promise<string> {
  const [row] = await tx
    .insert(supplierPayments)
    .values({
      paymentNo: `BYR-T-${randomUUID().slice(0, 8)}`,
      targetType: "production_batch",
      productionBatchId: docs.batchId,
      supplierId: input.payee ? docs.tailor.id : null,
      supplierName: input.payee ? docs.tailor.name : null,
      paidAt: input.paidAt,
      amount: input.amount ?? 300_000,
      method: input.method ?? "cash",
      proofFileId: await insertProof(tx, staffId, "payment_proof"),
      recordedByStaffUserId: staffId,
    })
    .returning({ id: supplierPayments.id });
  return row!.id;
}

/** Every journal (active, superseded and reversals) for one source, oldest first, with its lines. */
async function journalsFor(tx: TestTx, sourceType: string, sourceId: string) {
  const entries = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, sourceType), eq(journalEntries.sourceId, sourceId)))
    .orderBy(asc(journalEntries.entryNo));
  return Promise.all(
    entries.map(async (entry) => {
      const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).orderBy(asc(journalLines.lineNo));
      return { ...entry, sides: lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`)), lines };
    }),
  );
}

async function journalCount(tx: TestTx): Promise<{ entries: number; lines: number }> {
  const [entries] = await tx.select({ count: sql<number>`count(*)::int` }).from(journalEntries);
  const [lines] = await tx.select({ count: sql<number>`count(*)::int` }).from(journalLines);
  return { entries: entries!.count, lines: lines!.count };
}

async function openIssuesFor(tx: TestTx, sourceId: string) {
  return tx
    .select({ sourceEvent: postingIssues.sourceEvent, issueCode: postingIssues.issueCode, details: postingIssues.details })
    .from(postingIssues)
    .where(and(eq(postingIssues.sourceId, sourceId), isNull(postingIssues.resolvedAt)))
    .orderBy(asc(postingIssues.sourceEvent));
}

async function closeMonth(tx: TestTx, month: string, staffId: string) {
  await tx.insert(fiscalPeriods).values({ month, status: "closed", closedAt: new Date(), closedByStaffUserId: staffId });
}

describe("runPosting", () => {
  test("posts E1, P3 and R4 as system journals and records the run", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const docs = await insertDocuments(tx, staff.id);
      const expenseId = await insertExpense(tx, staff.id, { date: "2026-12-05", method: "card" });
      const purchasePaymentId = await insertPurchasePayment(tx, staff.id, docs, { paidAt: "2026-12-07" });
      const batchPaymentId = await insertBatchPayment(tx, staff.id, docs, { paidAt: "2026-12-08", payee: true });
      const noPayeeId = await insertBatchPayment(tx, staff.id, docs, { paidAt: "2026-12-09", payee: false });

      const result = await run(tx);

      const [expense] = await journalsFor(tx, "business_expense", expenseId);
      expect(expense).toMatchObject({ kind: "system", sourceEvent: "paid", entryDate: "2026-12-05", sourceDate: "2026-12-05", ruleVersion: 1, reversedByEntryId: null });
      expect(expense!.entryNo).toMatch(/^JU-202612-\d{4}$/);
      expect(expense!.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // D-18: the card is a debit card, paid from Bank utama.
      expect(expense!.sides).toEqual(["Dr 6-2101 2500000", "Cr 1-1201 2500000"]);
      expect((await journalsFor(tx, "supplier_payment", purchasePaymentId)).map((entry) => entry.sides)).toEqual([["Dr 2-1101 1000000", "Cr 1-1201 1000000"]]);
      expect((await journalsFor(tx, "supplier_payment", batchPaymentId)).map((entry) => entry.sides)).toEqual([["Dr 2-1102 300000", "Cr 1-1101 300000"]]);
      expect((await journalsFor(tx, "supplier_payment", noPayeeId)).map((entry) => entry.sides)).toEqual([["Dr 2-1103 300000", "Cr 1-1101 300000"]]);
      expect((await journalsFor(tx, "supplier_payment", purchasePaymentId))[0]!.lines.every((line) => line.supplierId === docs.vendor.id)).toBe(true);

      expect(result.insertedCount).toBeGreaterThanOrEqual(4);
      expect(result.failedCount).toBe(0);
      const [runRow] = await tx.select().from(postingRuns).where(eq(postingRuns.id, result.runId));
      expect(runRow).toMatchObject({ status: "succeeded", trigger: "cron", insertedCount: result.insertedCount, error: null });
      expect(runRow!.finishedAt).not.toBeNull();
    });
  });

  test("is idempotent: a second run inserts and reverses nothing", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const docs = await insertDocuments(tx, staff.id);
      await insertExpense(tx, staff.id, { date: "2026-12-05" });
      await insertExpense(tx, staff.id, { date: "2026-12-06", voidedAt: new Date("2026-12-10T03:00:00Z") });
      await insertPurchasePayment(tx, staff.id, docs, { paidAt: "2026-12-07", voidedAt: new Date("2026-12-11T03:00:00Z") });
      await run(tx);
      const before = await journalCount(tx);

      const second = await run(tx);

      expect(second.insertedCount).toBe(0);
      expect(second.reversedCount).toBe(0);
      expect(second.failedCount).toBe(0);
      expect(await journalCount(tx)).toEqual(before);
    });
  });

  test("a void after posting adds the exact negation, dated voided_at, and leaves E1 active (E2)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const expenseId = await insertExpense(tx, staff.id, { date: "2026-12-05" });
      await run(tx);
      // The one change an append-only expense ever gets: the void stamp (17:30 UTC = 00:30 WIB).
      await tx
        .update(businessExpenses)
        .set({ voidedAt: new Date("2026-12-09T17:30:00Z"), voidedByStaffUserId: staff.id, voidReason: "Salah catat" })
        .where(eq(businessExpenses.id, expenseId));

      const result = await run(tx);
      const journals = await journalsFor(tx, "business_expense", expenseId);

      expect(result.reversedCount).toBe(0);

      expect(journals.map((entry) => [entry.sourceEvent, entry.entryDate, entry.kind, entry.reversedByEntryId])).toEqual([
        ["paid", "2026-12-05", "system", null],
        ["void", "2026-12-10", "system", null],
      ]);
      expect(journals[1]!.sides).toEqual(["Cr 6-2101 2500000", "Dr 1-1201 2500000"]);
    });
  });

  test("a voided supplier payment posts P3 and its negation P4", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const docs = await insertDocuments(tx, staff.id);
      const paymentId = await insertPurchasePayment(tx, staff.id, docs, { paidAt: "2026-12-07", method: "cash", voidedAt: new Date("2026-12-08T02:00:00Z") });

      await run(tx);

      expect((await journalsFor(tx, "supplier_payment", paymentId)).map((entry) => [entry.sourceEvent, entry.entryDate, entry.sides])).toEqual([
        ["paid", "2026-12-07", ["Dr 2-1101 1000000", "Cr 1-1101 1000000"]],
        ["void", "2026-12-08", ["Cr 2-1101 1000000", "Dr 1-1101 1000000"]],
      ]);
    });
  });

  test("a changed mapping reverses the active journal and re-posts on the new account", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const expenseId = await insertExpense(tx, staff.id, { date: "2026-12-05" });
      await run(tx);
      await tx.update(accountMappings).set({ accountCode: "6-2901" }).where(eq(accountMappings.mappingKey, "expense.category.salary"));

      const result = await run(tx);

      const [original, reversal, reposted] = await journalsFor(tx, "business_expense", expenseId);
      expect(result.reversedCount).toBeGreaterThanOrEqual(1);
      expect(original).toMatchObject({ kind: "system", reversedByEntryId: reversal!.id });
      expect(reversal).toMatchObject({ kind: "reversal", reversesEntryId: original!.id, entryDate: "2026-12-05", sourceEvent: "paid" });
      expect(reversal!.sides).toEqual(["Cr 6-2101 2500000", "Dr 1-1201 2500000"]);
      expect(reversal!.description).toBe(`Pembalik ${original!.entryNo}: ${original!.description}`);
      expect(reposted).toMatchObject({ kind: "system", reversedByEntryId: null, entryDate: "2026-12-05" });
      expect(reposted!.sides).toEqual(["Dr 6-2901 2500000", "Cr 1-1201 2500000"]);

      // And a third run is a no-op again.
      const before = await journalCount(tx);
      expect((await run(tx)).insertedCount).toBe(0);
      expect(await journalCount(tx)).toEqual(before);
    });
  });

  test("a journal on an account deactivated after a re-map can still be reversed and re-posted (migration 0050)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const expenseId = await insertExpense(tx, staff.id, { date: "2026-12-05" });
      await run(tx);
      await tx.update(accountMappings).set({ accountCode: "6-2901" }).where(eq(accountMappings.mappingKey, "expense.category.salary"));
      // Allowed: no mapping points at 6-2101 any more.
      await tx.update(accounts).set({ isActive: false }).where(eq(accounts.code, "6-2101"));

      const result = await run(tx);

      expect(result.failedCount).toBe(0);
      const journals = await journalsFor(tx, "business_expense", expenseId);
      expect(journals.map((entry) => [entry.kind, entry.sides])).toEqual([
        ["system", ["Dr 6-2101 2500000", "Cr 1-1201 2500000"]],
        ["reversal", ["Cr 6-2101 2500000", "Dr 1-1201 2500000"]],
        ["system", ["Dr 6-2901 2500000", "Cr 1-1201 2500000"]],
      ]);
      expect(await openIssuesFor(tx, expenseId)).toEqual([]);
    });
  });

  test("a new (non-reversal) journal is still never posted to an inactive account", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await tx.update(accountMappings).set({ accountCode: "6-2901" }).where(eq(accountMappings.mappingKey, "expense.category.salary"));
      await tx.update(accounts).set({ isActive: false }).where(eq(accounts.code, "6-2101"));
      const [entry] = await tx
        .insert(journalEntries)
        .values({ entryNo: "JU-202612-9999", entryDate: "2026-12-05", kind: "manual", description: "Uji", postedByStaffUserId: staff.id })
        .returning({ id: journalEntries.id });
      await expect(
        tx.transaction(async (inner) => {
          await inner.insert(journalLines).values({ entryId: entry!.id, lineNo: 1, accountCode: "6-2101", debit: 1, credit: 0 });
        }),
      ).rejects.toThrow();
    });
  });

  test("a rule version bump re-derives every journal of that rule, even with identical lines", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const expenseId = await insertExpense(tx, staff.id, { date: "2026-12-05" });
      await run(tx);

      await run(tx, [expenseSource({ ...expenseRule, ruleVersion: 2 }), supplierPaymentSource()]);

      const journals = await journalsFor(tx, "business_expense", expenseId);
      expect(journals.map((entry) => [entry.kind, entry.ruleVersion])).toEqual([
        ["system", 1],
        ["reversal", 1],
        ["system", 2],
      ]);
      expect(journals[2]!.sides).toEqual(journals[0]!.sides);
    });
  });

  test("a correction to a journal in a closed month is dated the first day of the first open month (D-23)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const expenseId = await insertExpense(tx, staff.id, { date: "2027-01-17" });
      await run(tx);
      await closeMonth(tx, "2027-01-01", staff.id);
      await closeMonth(tx, "2027-02-01", staff.id);
      await tx.update(accountMappings).set({ accountCode: "6-2901" }).where(eq(accountMappings.mappingKey, "expense.category.salary"));

      await run(tx);

      const [original, reversal, reposted] = await journalsFor(tx, "business_expense", expenseId);
      expect(original).toMatchObject({ entryDate: "2027-01-17", sourceDate: "2027-01-17" });
      expect(reversal).toMatchObject({ kind: "reversal", entryDate: "2027-03-01", sourceDate: "2027-01-17" });
      expect(reversal!.entryNo).toMatch(/^JU-202703-/);
      expect(reposted).toMatchObject({ kind: "system", entryDate: "2027-03-01", sourceDate: "2027-01-17" });
      expect(reposted!.sides).toEqual(["Dr 6-2901 2500000", "Cr 1-1201 2500000"]);
    });
  });

  test("a new source dated in a closed month is booked in the first open month and keeps its source date", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await closeMonth(tx, "2027-01-01", staff.id);
      const expenseId = await insertExpense(tx, staff.id, { date: "2027-01-20" });

      await run(tx);

      expect((await journalsFor(tx, "business_expense", expenseId)).map((entry) => [entry.entryDate, entry.sourceDate])).toEqual([["2027-02-01", "2027-01-20"]]);
    });
  });

  test("nothing dated before the posting start (the trial month, D-22) is posted, nor its later void: no journal, no issue (plan §2)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const docs = await insertDocuments(tx, staff.id);
      const expenseId = await insertExpense(tx, staff.id, { date: "2026-11-30", voidedAt: new Date("2026-12-02T03:00:00Z") });
      const paymentId = await insertPurchasePayment(tx, staff.id, docs, { paidAt: "2026-11-29", voidedAt: new Date("2026-12-03T03:00:00Z") });
      // Even an unmapped pre-cut-over record raises nothing for its void.
      const code = `uji_${randomUUID().slice(0, 8)}`;
      await tx.insert(expenseCategories).values({ code, name: `Uji ${code}`, kind: "operating" });
      const unmappedId = await insertExpense(tx, staff.id, { date: "2026-11-28", category: code, voidedAt: new Date("2026-12-04T03:00:00Z") });

      await run(tx);
      await run(tx);

      for (const [type, id] of [["business_expense", expenseId], ["supplier_payment", paymentId], ["business_expense", unmappedId]] as const) {
        expect(await journalsFor(tx, type, id)).toEqual([]);
        expect(await openIssuesFor(tx, id)).toEqual([]);
      }
    });
  });

  test("an unmapped category is queued once as a posting issue, then posts and resolves once mapped (D-25)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const code = `uji_${randomUUID().slice(0, 8)}`;
      await tx.insert(expenseCategories).values({ code, name: `Uji ${code}`, kind: "operating" });
      const expenseId = await insertExpense(tx, staff.id, { date: "2026-12-05", category: code, voidedAt: new Date("2026-12-06T03:00:00Z") });

      await run(tx);
      await run(tx);

      expect(await journalsFor(tx, "business_expense", expenseId)).toEqual([]);
      const issues = await openIssuesFor(tx, expenseId);
      // The void waits silently behind its original: one issue, on the original only.
      expect(issues.map((issue) => [issue.sourceEvent, issue.issueCode])).toEqual([["paid", "unmapped_expense_category"]]);
      expect(issues[0]!.details).toMatchObject({ mappingKey: `expense.category.${code}`, category: code });

      await tx.insert(accountMappings).values({ mappingKey: `expense.category.${code}`, accountCode: "6-2501" });
      // One run posts E1, then E2 in the same run (E1 is active by the time E2 is checked).
      await run(tx);

      expect(await openIssuesFor(tx, expenseId)).toEqual([]);
      expect((await journalsFor(tx, "business_expense", expenseId)).map((entry) => entry.sides)).toEqual([
        ["Dr 6-2501 2500000", "Cr 1-1201 2500000"],
        ["Cr 6-2501 2500000", "Dr 1-1201 2500000"],
      ]);
    });
  });

  test("an issue never un-posts what is already booked", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const expenseId = await insertExpense(tx, staff.id, { date: "2026-12-05", method: "cash" });
      await run(tx);
      await tx.delete(accountMappings).where(eq(accountMappings.mappingKey, "cash.method.cash"));

      await run(tx);

      const journals = await journalsFor(tx, "business_expense", expenseId);
      expect(journals.map((entry) => [entry.kind, entry.reversedByEntryId])).toEqual([["system", null]]);
      expect((await openIssuesFor(tx, expenseId)).map((issue) => issue.issueCode)).toEqual(["unmapped_payment_method"]);
    });
  });

  describe("fabric-as-inventory guard (D-14)", () => {
    /** The re-map is refused by account_mappings_guard_target (migration 0051). A savepoint keeps
     * the failed statement from aborting the test's transaction. */
    async function expectMappingRefused(tx: TestTx, mappingKey: string, accountCode: string, message: RegExp) {
      const error = await tx
        .transaction((savepoint) => savepoint.update(accountMappings).set({ accountCode }).where(eq(accountMappings.mappingKey, mappingKey)))
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      // drizzle wraps the Postgres error ("Failed query: ...") and keeps it as the cause.
      expect(String((error as { cause?: unknown } | null)?.cause)).toMatch(message);
    }

    /** Runs `write` with migration 0051's mapping trigger off. ALTER TABLE is transactional, so
     * withRollback's rollback turns it back on. */
    async function withoutMappingGuard(tx: TestTx, write: () => Promise<unknown>) {
      await tx.execute(sql`alter table account_mappings disable trigger account_mappings_guard_target`);
      await write();
      await tx.execute(sql`alter table account_mappings enable trigger account_mappings_guard_target`);
    }

    test("a supplier payment whose utang mapping points at an expense is refused: an issue, no journal", async () => {
      await withRollback(async (tx) => {
        const staff = await insertStaffUser(tx);
        const docs = await insertDocuments(tx, staff.id);
        const paymentId = await insertPurchasePayment(tx, staff.id, docs, { paidAt: "2026-12-07" });
        // Since migration 0051 the database refuses this re-map itself (a supplier payable maps to
        // a liability only); the engine must still refuse a bad mapping that got in some other way
        // (written before 0051, or with the trigger disabled by the owner), so the trigger is
        // bypassed inside this rolled-back transaction.
        await expectMappingRefused(tx, "supplier_payable.kind.material", "6-3101", /liability account/);
        await withoutMappingGuard(tx, () =>
          tx.update(accountMappings).set({ accountCode: "6-3101" }).where(eq(accountMappings.mappingKey, "supplier_payable.kind.material")),
        );

        await run(tx);

        expect(await journalsFor(tx, "supplier_payment", paymentId)).toEqual([]);
        expect(await openIssuesFor(tx, paymentId)).toEqual([{ sourceEvent: "paid", issueCode: "purchase_guard_violation", details: { accountCodes: ["6-3101"] } }]);
      });
    });

    test("a business expense mapped to fabric inventory (1-1501) is refused: an issue, no journal", async () => {
      await withRollback(async (tx) => {
        const staff = await insertStaffUser(tx);
        const expenseId = await insertExpense(tx, staff.id, { date: "2026-12-05", category: "material_shipping" });
        // Refused by the database since 0051 (D-14); the engine's own check is the second line.
        await expectMappingRefused(tx, "expense.category.material_shipping", "1-1501", /never mapped to inventory/);
        await withoutMappingGuard(tx, () =>
          tx.update(accountMappings).set({ accountCode: "1-1501" }).where(eq(accountMappings.mappingKey, "expense.category.material_shipping")),
        );

        await run(tx);

        expect(await journalsFor(tx, "business_expense", expenseId)).toEqual([]);
        expect((await openIssuesFor(tx, expenseId)).map((issue) => issue.issueCode)).toEqual(["expense_mapped_to_inventory"]);
      });
    });

    test("every supplier payment journal the runner writes sits on utang or cash/bank only", async () => {
      await withRollback(async (tx) => {
        const staff = await insertStaffUser(tx);
        const docs = await insertDocuments(tx, staff.id);
        const ids = [
          await insertPurchasePayment(tx, staff.id, docs, { paidAt: "2026-12-07", voidedAt: new Date("2026-12-08T02:00:00Z") }),
          await insertBatchPayment(tx, staff.id, docs, { paidAt: "2026-12-08", payee: true }),
          await insertBatchPayment(tx, staff.id, docs, { paidAt: "2026-12-09", payee: false }),
        ];

        await run(tx);

        for (const id of ids) {
          const journals = await journalsFor(tx, "supplier_payment", id);
          expect(journals.length).toBeGreaterThan(0);
          for (const line of journals.flatMap((entry) => entry.lines)) expect(line.accountCode).toMatch(/^(2-11|1-1[12])/);
        }
      });
    });
  });

  test("a platform-balance expense credits the marketplace's seller balance (M4)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const expenseId = await insertExpense(tx, staff.id, { date: "2026-12-05", category: "ads_shopee", method: "platform_balance", channelId: "shopee", amount: 75_000 });

      await run(tx);

      const [journal] = await journalsFor(tx, "business_expense", expenseId);
      expect(journal!.sides).toEqual(["Dr 6-1101 75000", "Cr 1-1302 75000"]);
      expect(journal!.lines.every((line) => line.channelId === "shopee" && line.cashAccountCode === "1-1302")).toBe(true);
    });
  });
});
