import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { staffAuthUsers } from "../src/schema";
import { withRollback } from "./helpers";
import { insertStaffUser } from "./fixtures";

describe("staff_auth_users.staff_user_id", () => {
  test("inserting without staff_user_id fails", async () => {
    await withRollback(async (tx) => {
      // Raw SQL, not Drizzle's typed insert builder: `staffUserId` being required in our
      // TypeScript schema already makes `.insert(staffAuthUsers).values({...})` without it a
      // compile error, which only proves the TYPE is right. This proves the DATABASE itself
      // rejects it — even if some future caller bypassed Drizzle's types entirely (e.g. Better
      // Auth's own adapter, which sees `required: false` on the additionalField).
      await expect(
        tx.execute(
          sql`insert into staff_auth_users (name, email) values ('No Link', ${`staff-auth-${randomUUID()}@example.test`})`,
        ),
      ).rejects.toThrow();
    });
  });

  test("inserting with a valid staff_user_id succeeds", async () => {
    await withRollback(async (tx) => {
      const staffUser = await insertStaffUser(tx, "owner");
      await expect(
        tx.insert(staffAuthUsers).values({
          staffUserId: staffUser.id,
          name: "Linked",
          email: `staff-auth-${randomUUID()}@example.test`,
        }),
      ).resolves.not.toThrow();
    });
  });

  test("a second staff_auth_users row cannot reuse the same staff_user_id", async () => {
    await withRollback(async (tx) => {
      const staffUser = await insertStaffUser(tx, "owner");
      await tx.insert(staffAuthUsers).values({
        staffUserId: staffUser.id,
        name: "First",
        email: `staff-auth-${randomUUID()}@example.test`,
      });
      await expect(
        tx.insert(staffAuthUsers).values({
          staffUserId: staffUser.id,
          name: "Second",
          email: `staff-auth-${randomUUID()}@example.test`,
        }),
      ).rejects.toThrow();
    });
  });
});
