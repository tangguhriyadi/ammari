import { existsSync } from "node:fs";

// Fixed, e2e-only addresses — the sign-in backdoor (app/api/test/login/route.ts) refuses any
// email outside this suffix, so these fixtures can never double as real staff credentials.
export const E2E_SUPER_ADMIN_EMAIL = "super-admin@e2e.ammari.test";
export const E2E_OWNER_EMAIL = "owner@e2e.ammari.test";

function assertSafeTarget(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed e2e staff fixtures: NODE_ENV is production.");
  }
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is not set");
  const hostname = new URL(rawUrl).hostname;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(`Refusing to seed e2e staff fixtures against non-local host "${hostname}".`);
  }
}

export default async function globalSetup(): Promise<void> {
  // Loaded here, and @ammari/db imported dynamically below (not statically at module top) —
  // @ammari/db/client.ts reads DATABASE_URL at import time, so a static import would evaluate
  // (and throw) before this line ever ran, since ESM import declarations are hoisted ahead of
  // any other top-level code in this module.
  if (existsSync(".env")) process.loadEnvFile(".env");
  assertSafeTarget();

  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("@ammari/db");
  const { roles, staffUsers, authEmailThrottle, staffAuthRateLimits } = await import("@ammari/db/schema");
  const { OWNER_ROLE_KEY, SUPER_ADMIN_ROLE_KEY } = await import("@ammari/db/rbac");

  async function ensureStaffFixture(email: string, name: string, roleKey: string): Promise<void> {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, roleKey)).limit(1);
    if (!role) {
      throw new Error(`role "${roleKey}" is not seeded — run "pnpm --filter @ammari/db db:seed" first`);
    }
    // onConflictDoNothing, not check-then-write (CLAUDE.md) — idempotent across repeated runs.
    await db
      .insert(staffUsers)
      .values({ name, email, roleId: role.id })
      .onConflictDoNothing({ target: staffUsers.email });
  }

  await ensureStaffFixture(E2E_SUPER_ADMIN_EMAIL, "E2E Super Admin", SUPER_ADMIN_ROLE_KEY);
  await ensureStaffFixture(E2E_OWNER_EMAIL, "E2E Owner", OWNER_ROLE_KEY);

  // Clears rate-limit state left over from a previous run (repeated runs within the same
  // 5-minute window would otherwise throttle out the fixture logins below). Test-only infra
  // against a local DB — never touches anything in a real environment.
  await db.delete(authEmailThrottle).where(inArray(authEmailThrottle.email, [E2E_SUPER_ADMIN_EMAIL, E2E_OWNER_EMAIL]));
  await db.delete(staffAuthRateLimits);
}
