import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { accountMappings, businessExpenses, expenseCategories, postingIssues, privateFiles } from "@ammari/db/schema";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { expenseRule } from "../src/rules/expenses";
import { checkPostingCompleteness, expenseSource, runPosting, type Database, type PostingCompleteness } from "../src/runner";

// Rekonsiliasi check 5 (docs/plans/accounting.md §6.3, Session 10): a read-only dry run of the
// runner. Every source event in the window has its active journal or an open issue; anything else is
// a gap, and a posting run closes every gap. Assertions are per key: ammari_test may hold other
// suites' committed rows.

const WINDOW = { from: "2027-03-01", to: "2027-03-31" };

async function insertExpense(tx: TestTx, staffId: string, input: { date: string; amount?: number; category?: string; voidedAt?: Date }): Promise<string> {
  const fileId = randomUUID();
  const sha = fileId.replaceAll("-", "").padEnd(64, "0");
  await tx.insert(privateFiles).values({
    id: fileId,
    purpose: "expense_proof",
    storageKey: `test/expense_proof/${fileId}.jpg`,
    contentType: "image/jpeg",
    byteSize: 1,
    sha256: sha,
    originalFilename: "bukti.jpg",
    originalContentType: "image/jpeg",
    originalByteSize: 1,
    originalSha256: sha,
    uploadedByStaffUserId: staffId,
  });
  const [row] = await tx
    .insert(businessExpenses)
    .values({
      expenseNo: `BYA-T-${randomUUID().slice(0, 8)}`,
      expenseDate: input.date,
      category: input.category ?? "salary",
      amount: input.amount ?? 2_500_000,
      method: "transfer",
      proofFileId: fileId,
      recordedByStaffUserId: staffId,
      ...(input.voidedAt ? { voidedAt: input.voidedAt, voidedByStaffUserId: staffId, voidReason: "Salah catat" } : {}),
    })
    .returning({ id: businessExpenses.id });
  return row!.id;
}

const forExpense = (report: PostingCompleteness, id: string) => ({
  gaps: report.gaps.filter((gap) => gap.key.sourceId === id).map((gap) => `${gap.key.sourceEvent}:${gap.status}${gap.issueCode ? `:${gap.issueCode}` : ""}`),
  orphans: report.orphans.filter((orphan) => orphan.key.sourceId === id).map((orphan) => orphan.key.sourceEvent),
});

async function run(tx: TestTx) {
  await runPosting(tx as Database, { trigger: "cron", sources: [expenseSource()] });
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
}

const check = (tx: TestTx) => checkPostingCompleteness(tx as Database, WINDOW, { sources: [expenseSource()] });

describe("checkPostingCompleteness (check 5)", () => {
  test("a new source is a gap until posted; a posted one is not; writes nothing", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const id = await insertExpense(tx, staff.id, { date: "2027-03-10" });
      const before = await check(tx);
      expect(forExpense(before, id).gaps).toEqual(["paid:missing"]);
      // Read-only: still nothing booked for it.
      expect(forExpense(await check(tx), id).gaps).toEqual(["paid:missing"]);
      await run(tx);
      expect(forExpense(await check(tx), id)).toEqual({ gaps: [], orphans: [] });
    });
  });

  test("a source changed after posting is outdated; a void not yet posted is missing; outside the window is not checked", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const changed = await insertExpense(tx, staff.id, { date: "2027-03-11" });
      const voided = await insertExpense(tx, staff.id, { date: "2027-03-12" });
      const april = await insertExpense(tx, staff.id, { date: "2027-04-02" });
      await run(tx);
      // business_expenses is append-only: a re-map is what changes a posted journal.
      await tx.update(accountMappings).set({ accountCode: "6-2901" }).where(eq(accountMappings.mappingKey, "expense.category.salary"));
      await tx.update(businessExpenses).set({ voidedAt: new Date("2027-03-20T03:00:00Z"), voidedByStaffUserId: staff.id, voidReason: "Salah catat" }).where(eq(businessExpenses.id, voided));
      const report = await check(tx);
      expect(forExpense(report, changed).gaps).toEqual(["paid:outdated"]);
      expect(forExpense(report, voided).gaps).toEqual(["paid:outdated", "void:missing"]);
      expect(forExpense(report, april).gaps).toEqual([]);
      await run(tx);
      const after = await check(tx);
      expect(forExpense(after, voided).gaps).toEqual([]);
      expect(forExpense(after, changed).gaps).toEqual([]);
    });
  });

  test("an unmapped category is a gap until the run records the issue, then explained by the open issue", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const code = `uji_${randomUUID().slice(0, 8)}`;
      await tx.insert(expenseCategories).values({ code, name: `Uji ${code}`, kind: "operating" });
      const id = await insertExpense(tx, staff.id, { date: "2027-03-13", category: code });
      expect(forExpense(await check(tx), id).gaps).toEqual(["paid:issue_unrecorded:unmapped_expense_category"]);
      await run(tx);
      const report = await check(tx);
      expect(forExpense(report, id).gaps).toEqual([]);
      expect(report.withOpenIssue).toBeGreaterThan(0);
    });
  });

  test("a stale open issue (cause fixed, no run since) does not hide a missing journal; a failed write does", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const id = await insertExpense(tx, staff.id, { date: "2027-03-16" });
      const key = { sourceType: "business_expense", sourceId: id, sourceEvent: "paid" };
      await tx.insert(postingIssues).values({ ...key, sourceDate: "2027-03-16", issueCode: "unmapped_expense_category", details: {} });
      expect(forExpense(await check(tx), id).gaps).toEqual(["paid:missing"]);
      await tx.insert(postingIssues).values({ ...key, sourceDate: "2027-03-16", issueCode: "posting_failed", details: { message: "x" } });
      expect(forExpense(await check(tx), id).gaps).toEqual([]);
    });
  });

  test("a rule version bump makes every posted journal of that rule outdated", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const id = await insertExpense(tx, staff.id, { date: "2027-03-14" });
      await run(tx);
      const bumped = await checkPostingCompleteness(tx as Database, WINDOW, { sources: [expenseSource({ ...expenseRule, ruleVersion: expenseRule.ruleVersion + 1 })] });
      expect(forExpense(bumped, id).gaps).toEqual(["paid:outdated"]);
    });
  });

  test("an active journal no rule produces any more is an orphan", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const id = await insertExpense(tx, staff.id, { date: "2027-03-15" });
      await run(tx);
      const report = await checkPostingCompleteness(tx as Database, WINDOW, { sources: [] });
      expect(forExpense(report, id).orphans).toEqual(["paid"]);
    });
  });
});
