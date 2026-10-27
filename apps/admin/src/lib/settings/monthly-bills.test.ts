import { and, desc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { auditLog, salesGoal } from "@ammari/db/schema";
import { getSalesGoal } from "@/lib/overview/queries";
import { getMonthlyBillCategories, parseMonthlyBillCategories, saveMonthlyBillCategories } from "./monthly-bills";

// docs/plans/growth.md §6, owner answer A6: "Pengingat biaya bulanan" on the sales_goal row
// (migration 0043), saved from /settings.

describe("parseMonthlyBillCategories (server-side validation)", () => {
  test("only offered categories; duplicates collapse; stored in display order; [] is off", () => {
    expect(parseMonthlyBillCategories([])).toEqual([]);
    expect(parseMonthlyBillCategories(["utilities", "salary", "salary"])).toEqual(["salary", "utilities"]);
    expect(parseMonthlyBillCategories(["rent", "salary", "utilities"])).toEqual(["salary", "rent", "utilities"]);
  });

  test("anything else is refused", () => {
    for (const bad of [undefined, null, "salary", {}, ["gift"], ["salary", 1], ["ads_meta"], ["packaging"], Array(7).fill("salary")]) {
      expect(parseMonthlyBillCategories(bad)).toBeNull();
    }
  });
});

async function latestAudit(tx: TestDatabase) {
  const [entry] = await tx
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "monthly_bills_reminder"), eq(auditLog.entityId, "1")))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);
  return entry;
}

describe("saveMonthlyBillCategories / getMonthlyBillCategories", () => {
  test("saves on the goal row without touching the goal, with an audit row (before and after)", async () => {
    await withRollback(async (tx) => {
      await tx.update(salesGoal).set({ revenueTargetAmount: 1_000_000_000, startDate: "2026-11-01", monthlyBillCategories: [] }).where(eq(salesGoal.id, 1));
      await saveMonthlyBillCategories(["salary", "rent"], null, tx);
      expect(await getMonthlyBillCategories(tx)).toEqual(["salary", "rent"]);
      expect(await getSalesGoal(tx)).toEqual({ revenueTargetAmount: 1_000_000_000, startDate: "2026-11-01" });
      expect(await latestAudit(tx)).toMatchObject({
        action: "update",
        before: { monthlyBillCategories: [] },
        after: { monthlyBillCategories: ["salary", "rent"] },
      });

      await saveMonthlyBillCategories([], null, tx);
      expect(await getMonthlyBillCategories(tx)).toEqual([]);
      // Both saves share the transaction's now(), so look for the entry rather than the latest.
      const entries = await tx.select().from(auditLog).where(and(eq(auditLog.entityType, "monthly_bills_reminder"), eq(auditLog.entityId, "1")));
      expect(entries).toContainEqual(expect.objectContaining({ before: { monthlyBillCategories: ["salary", "rent"] }, after: { monthlyBillCategories: [] } }));
    });
  });

  test("a lost row reads as off and comes back on the first save", async () => {
    await withRollback(async (tx) => {
      await tx.delete(salesGoal).where(eq(salesGoal.id, 1));
      expect(await getMonthlyBillCategories(tx)).toEqual([]);
      await saveMonthlyBillCategories(["utilities"], null, tx);
      expect(await getMonthlyBillCategories(tx)).toEqual(["utilities"]);
      expect(await latestAudit(tx)).toMatchObject({ before: null, after: { monthlyBillCategories: ["utilities"] } });
    });
  });
});
