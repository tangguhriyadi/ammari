import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb } from "@ammari/db/test-utils";
import {
  authEmailThrottle,
  customerAuthAccounts,
  customerAuthRateLimits,
  customerAuthSessions,
  customerAuthUsers,
  customerAuthVerifications,
  customers,
} from "@ammari/db/schema";
import { createCustomerAuth } from "../src/customer";
import type { CreateCustomerAuthOptions } from "../src/customer";
import type { EmailSender } from "../src/email-sender";
import { RecordingEmailSender } from "./setup";

export { testDb };

/** Better Auth's drizzle adapter queries run against `testDb` directly, not inside our
 * `withRollback` transaction (a separate Postgres connection can't see another connection's
 * uncommitted work) — so these tests commit real rows and must clean up manually, same as the
 * staff instance's own `buildStaffAuth`. */
export function buildCustomerAuth(overrides: Partial<CreateCustomerAuthOptions> = {}) {
  const emailSender = overrides.emailSender ?? new RecordingEmailSender();
  const auth = createCustomerAuth({
    db: testDb,
    emailSender,
    baseURL: "http://localhost:3000",
    secret: "test-only-secret-never-used-in-production",
    ...overrides,
  });
  return { auth, emailSender: emailSender as RecordingEmailSender };
}

export async function cleanupCustomerAuthTables(): Promise<void> {
  await testDb.delete(customerAuthAccounts);
  await testDb.delete(customerAuthSessions);
  await testDb.delete(customerAuthVerifications);
  await testDb.delete(customerAuthUsers);
  await testDb.delete(customerAuthRateLimits);
  await testDb.delete(authEmailThrottle);
}

/** Committed (not `withRollback`-wrapped) `customers` fixture — same reasoning as staff's
 * `createCommittedStaffUser`: Better Auth's hooks query `customers` through the same
 * non-transactional `testDb` connection, so a row created inside a rolled-back transaction would
 * be invisible to them. Callers must delete the returned id via `cleanupCustomers` after
 * `cleanupCustomerAuthTables()` has run (customer_auth_users.customer_id is ON DELETE RESTRICT). */
export async function createCommittedCustomer(
  overrides: { name?: string; email?: string; emailVerifiedAt?: Date | null } = {},
) {
  const [customer] = await testDb
    .insert(customers)
    .values({
      name: overrides.name ?? "Test Customer",
      email: overrides.email ?? `customer-${randomUUID()}@example.test`,
      emailVerifiedAt: overrides.emailVerifiedAt ?? null,
    })
    .returning();
  if (!customer) throw new Error("failed to insert customer fixture");
  return customer;
}

export async function cleanupCustomers(ids: string[]): Promise<void> {
  for (const id of ids) {
    await testDb.delete(customers).where(eq(customers.id, id));
  }
}

export type { EmailSender };
