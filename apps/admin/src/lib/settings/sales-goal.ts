import "server-only";
import { eq } from "drizzle-orm";
import { salesGoal } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";

// The one sales_goal row (migration 0039 inserts it): the Ringkasan target tracker's yearly
// revenue target and start date (docs/plans/dashboard-overview.md §2.1, §2.2). Edited on /settings
// under settings.manage; the read for the tracker is lib/overview/queries.ts's getSalesGoal.

export interface SalesGoalInput {
  revenueTargetAmount: number;
  /** Jakarta calendar date. */
  startDate: string;
}

const GOAL_COLUMNS = { revenueTargetAmount: salesGoal.revenueTargetAmount, startDate: salesGoal.startDate };

/** Input is already validated (salesGoalSchema). An upsert, not an UPDATE alone: the row should
 * always exist, but a database that lost it gets it back on the first save instead of an error.
 * The `before` read locks the row, so two concurrent saves write two audit rows in order. */
export async function saveSalesGoal(input: SalesGoalInput, actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select(GOAL_COLUMNS).from(salesGoal).where(eq(salesGoal.id, 1)).for("update");
    const [after] = await tx
      .insert(salesGoal)
      .values({ id: 1, ...input })
      .onConflictDoUpdate({ target: salesGoal.id, set: input })
      .returning(GOAL_COLUMNS);
    if (!after) throw new Error("failed to save the sales goal");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: before ? "update" : "create",
      entityType: "sales_goal",
      entityId: "1",
      before: before ?? null,
      after,
    });
  });
}
