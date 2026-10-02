import { existsSync } from "node:fs";

// Fixed, e2e-only addresses — the sign-in backdoor (app/api/test/login/route.ts) refuses any
// email outside this suffix, so these fixtures can never double as real staff credentials.
export const E2E_SUPER_ADMIN_EMAIL = "super-admin@e2e.ammari.test";
export const E2E_OWNER_EMAIL = "owner@e2e.ammari.test";
// A non-system role with products.manage but NOT finance.view_profit — owner and super_admin
// both hold finance.view_profit by default (docs/SPEC.md §9), so neither can exercise the Batas
// HPP gating test; this fixture exists specifically for that.
export const E2E_PRODUCTS_NO_FINANCE_EMAIL = "products-no-finance@e2e.ammari.test";
const E2E_LIMITED_ROLE_KEY = "e2e_products_no_finance";

// Enough rows to force a second page at the real PAGE_SIZE (20) — see apps/admin's
// lib/products/queries.ts. A distinct name prefix keeps this from colliding with anything a
// test itself creates.
export const E2E_PAGINATION_PRODUCT_PREFIX = "E2E Pagination Produk";
const E2E_PAGINATION_PRODUCT_COUNT = 21;

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

  const { and, eq, inArray, notInArray } = await import("drizzle-orm");
  const { db } = await import("@ammari/db");
  const { roles, permissions, rolePermissions, staffUsers, authEmailThrottle, staffAuthRateLimits, fabrics, products } =
    await import("@ammari/db/schema");
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

  /** Non-system role holding exactly `permissionKeys` — same insert-then-prune pattern as
   * packages/db/src/seed.ts's upsertSystemRole, so it stays race-safe across repeated runs. */
  async function ensureLimitedRole(roleKey: string, permissionKeys: readonly string[]): Promise<string> {
    const [role] = await db
      .insert(roles)
      .values({ key: roleKey, name: roleKey, isSystem: false })
      .onConflictDoUpdate({ target: roles.key, set: { name: roleKey } })
      .returning();
    if (!role) throw new Error(`failed to upsert role "${roleKey}"`);

    const permissionRows = await db.select({ id: permissions.id }).from(permissions).where(inArray(permissions.key, permissionKeys));
    const desiredIds = permissionRows.map((row) => row.id);
    if (desiredIds.length > 0) {
      await db
        .insert(rolePermissions)
        .values(desiredIds.map((permissionId) => ({ roleId: role.id, permissionId })))
        .onConflictDoNothing({ target: [rolePermissions.roleId, rolePermissions.permissionId] });
    }
    // Prune anything beyond the desired set (e.g. a previous run of this fixture with different
    // permissions) — insert-then-prune, not delete-then-insert, so this stays race-safe.
    await db
      .delete(rolePermissions)
      .where(
        desiredIds.length > 0
          ? and(eq(rolePermissions.roleId, role.id), notInArray(rolePermissions.permissionId, desiredIds))
          : eq(rolePermissions.roleId, role.id),
      );
    return role.id;
  }

  await ensureStaffFixture(E2E_SUPER_ADMIN_EMAIL, "E2E Super Admin", SUPER_ADMIN_ROLE_KEY);
  await ensureStaffFixture(E2E_OWNER_EMAIL, "E2E Owner", OWNER_ROLE_KEY);

  await ensureLimitedRole(E2E_LIMITED_ROLE_KEY, ["products.manage"]);
  await ensureStaffFixture(E2E_PRODUCTS_NO_FINANCE_EMAIL, "E2E Products (no finance)", E2E_LIMITED_ROLE_KEY);

  const [paginationFabric] = await db
    .insert(fabrics)
    .values({ name: "E2E Pagination Fabric" })
    .onConflictDoNothing()
    .returning({ id: fabrics.id });
  const paginationFabricId =
    paginationFabric?.id ??
    (await db.select({ id: fabrics.id }).from(fabrics).where(eq(fabrics.name, "E2E Pagination Fabric")).limit(1))[0]?.id;
  if (!paginationFabricId) throw new Error("failed to seed the e2e pagination fixture fabric");

  for (let i = 0; i < E2E_PAGINATION_PRODUCT_COUNT; i += 1) {
    const suffix = String(i).padStart(2, "0");
    await db
      .insert(products)
      .values({
        name: `${E2E_PAGINATION_PRODUCT_PREFIX} ${suffix}`,
        code: `E2EPAGINATION${suffix}`,
        slug: `e2e-pagination-produk-${suffix}`,
        fabricId: paginationFabricId,
        closure: "front_zip",
        sizeMode: "sized",
        basePrice: 100_000,
      })
      .onConflictDoNothing({ target: products.slug });
  }

  // Clears rate-limit state left over from a previous run (repeated runs within the same
  // 5-minute window would otherwise throttle out the fixture logins below). Test-only infra
  // against a local DB — never touches anything in a real environment.
  await db
    .delete(authEmailThrottle)
    .where(inArray(authEmailThrottle.email, [E2E_SUPER_ADMIN_EMAIL, E2E_OWNER_EMAIL, E2E_PRODUCTS_NO_FINANCE_EMAIL]));
  await db.delete(staffAuthRateLimits);
}
