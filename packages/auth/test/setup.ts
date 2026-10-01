import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb } from "@ammari/db/test-utils";
import {
  authEmailThrottle,
  roles,
  staffAuthAccounts,
  staffAuthRateLimits,
  staffAuthSessions,
  staffAuthUsers,
  staffAuthVerifications,
  staffUsers,
} from "@ammari/db/schema";
import { createStaffAuth } from "../src/staff";
import type { CreateStaffAuthOptions } from "../src/staff";
import type { EmailSender } from "../src/email-sender";

export { testDb };

export class RecordingEmailSender implements EmailSender {
  sent: { to: string; subject: string; body: string }[] = [];
  async send(params: { to: string; subject: string; body: string }): Promise<void> {
    this.sent.push(params);
  }
}

/** Better Auth's drizzle adapter queries run against `testDb` directly, not inside our
 * `withRollback` transaction (a separate Postgres connection can't see another connection's
 * uncommitted work) — so these tests commit real rows and must clean up manually. */
export function buildStaffAuth(overrides: Partial<CreateStaffAuthOptions> = {}) {
  const emailSender = overrides.emailSender ?? new RecordingEmailSender();
  const auth = createStaffAuth({
    db: testDb,
    emailSender,
    baseURL: "http://localhost:3001",
    secret: "test-only-secret-never-used-in-production",
    ...overrides,
  });
  return { auth, emailSender: emailSender as RecordingEmailSender };
}

export async function cleanupAuthTables(): Promise<void> {
  // staff_auth_users references staff_users (ON DELETE RESTRICT), so it must go first.
  await testDb.delete(staffAuthAccounts);
  await testDb.delete(staffAuthSessions);
  await testDb.delete(staffAuthVerifications);
  await testDb.delete(staffAuthUsers);
  await testDb.delete(staffAuthRateLimits);
  await testDb.delete(authEmailThrottle);
}

/** Committed (not `withRollback`-wrapped) staff_users fixture: Better Auth's hooks query
 * `staff_users` through the same non-transactional `testDb` connection, so a row created inside
 * a rolled-back transaction would be invisible to them. Callers must delete the returned id via
 * `cleanupStaffUsers` after `cleanupAuthTables()` has run (FK is ON DELETE RESTRICT). */
export async function createCommittedStaffUser(
  overrides: { roleKey?: string; isActive?: boolean; email?: string } = {},
) {
  const [role] = await testDb.select().from(roles).where(eq(roles.key, overrides.roleKey ?? "owner")).limit(1);
  if (!role) throw new Error(`role "${overrides.roleKey ?? "owner"}" was not seeded`);
  const [staffUser] = await testDb
    .insert(staffUsers)
    .values({
      name: "Test Staff",
      email: overrides.email ?? `staff-${randomUUID()}@example.test`,
      roleId: role.id,
      isActive: overrides.isActive ?? true,
    })
    .returning();
  if (!staffUser) throw new Error("failed to insert staff user fixture");
  return staffUser;
}

export async function cleanupStaffUsers(ids: string[]): Promise<void> {
  for (const id of ids) {
    await testDb.delete(staffUsers).where(eq(staffUsers.id, id));
  }
}
