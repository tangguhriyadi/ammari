import { and, desc, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { auditLog, salesGoal } from "@ammari/db/schema";
import { getSalesGoal } from "@/lib/overview/queries";
import { saveSalesGoal } from "./sales-goal";

// docs/plans/dashboard-overview.md §2.1 / §2.2: the one sales_goal row, saved from /settings.

async function latestGoalAudit(tx: TestDatabase) {
  const [entry] = await tx
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "sales_goal"), eq(auditLog.entityId, "1")))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);
  return entry;
}

describe("saveSalesGoal", () => {
  test("updates the migration's row and the Ringkasan read sees it", async () => {
    await withRollback(async (tx) => {
      await saveSalesGoal({ revenueTargetAmount: 750_000_000, startDate: "2026-12-01" }, null, tx);
      expect(await getSalesGoal(tx)).toEqual({ revenueTargetAmount: 750_000_000, startDate: "2026-12-01" });
    });
  });

  test("writes an audit row with before and after", async () => {
    await withRollback(async (tx) => {
      await tx.update(salesGoal).set({ revenueTargetAmount: 1_000_000_000, startDate: "2026-11-01" }).where(eq(salesGoal.id, 1));
      await saveSalesGoal({ revenueTargetAmount: 1_200_000_000, startDate: "2026-11-15" }, null, tx);

      const entry = await latestGoalAudit(tx);
      expect(entry).toMatchObject({
        action: "update",
        before: { revenueTargetAmount: 1_000_000_000, startDate: "2026-11-01" },
        after: { revenueTargetAmount: 1_200_000_000, startDate: "2026-11-15" },
      });
    });
  });

  test("recreates a missing row instead of failing, audited as a create", async () => {
    await withRollback(async (tx) => {
      await tx.delete(salesGoal).where(eq(salesGoal.id, 1));
      await saveSalesGoal({ revenueTargetAmount: 500_000_000, startDate: "2027-01-01" }, null, tx);

      expect(await getSalesGoal(tx)).toEqual({ revenueTargetAmount: 500_000_000, startDate: "2027-01-01" });
      expect(await latestGoalAudit(tx)).toMatchObject({ action: "create", before: null });
    });
  });
});
