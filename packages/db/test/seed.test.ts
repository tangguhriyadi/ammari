import { describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { seed } from "../src/seed";
import { testDb } from "./helpers";
import {
  channels,
  costAssumptions,
  permissions,
  rolePermissions,
  roles,
  staffUsers,
} from "../src/schema";

async function count(table: PgTable) {
  const [row] = await testDb.select({ count: sql<number>`count(*)::int` }).from(table);
  if (!row) throw new Error("count query returned no rows");
  return row.count;
}

async function rowCounts() {
  const [channelCount, permissionCount, roleCount, rolePermissionCount, costAssumptionCount, staffUserCount] =
    await Promise.all([
      count(channels),
      count(permissions),
      count(roles),
      count(rolePermissions),
      count(costAssumptions),
      count(staffUsers),
    ]);
  return { channelCount, permissionCount, roleCount, rolePermissionCount, costAssumptionCount, staffUserCount };
}

describe("db:seed", () => {
  test("running the seed again does not change row counts (global-setup already ran it once)", async () => {
    const before = await rowCounts();

    await seed(testDb);
    const afterFirstRerun = await rowCounts();
    expect(afterFirstRerun).toEqual(before);

    await seed(testDb);
    const afterSecondRerun = await rowCounts();
    expect(afterSecondRerun).toEqual(before);
  });
});
