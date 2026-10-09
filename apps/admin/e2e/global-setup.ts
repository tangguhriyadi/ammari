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
// A dedicated role/email for the production+stock e2e flow — owner and super_admin are already
// used right up to the 5-per-5-minutes OTP send throttle across the rest of this suite (see the
// per-test comments explaining that budget), so a 6th login on either tips it over. A fresh
// email starts with its own clean throttle window regardless of how loaded the other two are.
export const E2E_PRODUCTION_STOCK_EMAIL = "production-stock@e2e.ammari.test";
const E2E_PRODUCTION_STOCK_ROLE_KEY = "e2e_production_stock";
// A dedicated role/email for the orders e2e flow (manual entry + stock decrement/restore) — same
// "fresh email, clean OTP throttle" reasoning as E2E_PRODUCTION_STOCK_EMAIL above. Needs
// products.manage/production.manage/stock.* too, since the flow seeds its own finished-goods
// stock via a real production batch before placing an order against it.
export const E2E_ORDERS_EMAIL = "orders@e2e.ammari.test";
const E2E_ORDERS_ROLE_KEY = "e2e_orders";

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
  const url = new URL(rawUrl);
  const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const dbName = url.pathname.replace(/^\//, "");
  // Exact name, not just "is local" — e2e fixtures must land in their own database
  // (ammari_e2e), never the owner's real local `ammari` dev database (see CLAUDE.md's "Local
  // environment safety" rule and docs/SPEC.md).
  if (!isLocalHost || dbName !== "ammari_e2e") {
    throw new Error(
      `Refusing to seed e2e staff fixtures: derived target is "${url.hostname}${url.pathname}". ` +
        `e2e only ever runs against host localhost/127.0.0.1, database "ammari_e2e". Check DATABASE_URL.`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  // Loaded here, and @ammari/db imported dynamically below (not statically at module top) —
  // @ammari/db/client.ts reads DATABASE_URL at import time, so a static import would evaluate
  // (and throw) before this line ever ran, since ESM import declarations are hoisted ahead of
  // any other top-level code in this module.
  if (existsSync(".env")) process.loadEnvFile(".env");

  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed e2e staff fixtures: NODE_ENV is production.");
  }
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is not set");

  // Repoints process.env.DATABASE_URL at ammari_e2e using ONLY plain URL math — no import of
  // anything in @ammari/db yet. This has to happen BEFORE the very first import of
  // @ammari/db/test-e2e-db below: that module transitively imports ../src/client.ts, which
  // reads DATABASE_URL at module EVALUATION time (a top-level `const`) and gets cached by
  // Node's module system — if that first evaluation saw the real dev database's URL, every
  // later `@ammari/db` import in this same process (including the one further down, used to
  // seed the staff fixtures) would keep returning that same wrongly-pointed, already-cached
  // `db` singleton, silently writing e2e fixtures into the owner's real database. (This exact
  // bug shipped once already — see the cleanup note in this session's final report.)
  const e2eUrl = new URL(baseUrl);
  e2eUrl.pathname = "/ammari_e2e";
  const isLocalHost = e2eUrl.hostname === "localhost" || e2eUrl.hostname === "127.0.0.1";
  if (!isLocalHost) {
    throw new Error(`Refusing to seed e2e staff fixtures against non-local host "${e2eUrl.hostname}".`);
  }
  process.env.DATABASE_URL = e2eUrl.toString();

  // Creates (if needed), migrates, and baseline-seeds ammari_e2e. `baseUrl` is passed explicitly
  // (not read from process.env, which is already repointed above) so it can still connect to
  // the original database to issue CREATE DATABASE.
  const { ensureE2eDatabase } = await import("@ammari/db/test-e2e-db");
  await ensureE2eDatabase(baseUrl);
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

  await ensureLimitedRole(E2E_PRODUCTION_STOCK_ROLE_KEY, [
    "products.manage",
    "production.manage",
    "stock.view",
    "stock.adjust",
    "finance.view_profit",
    "inventory.view",
    "inventory.manage",
  ]);
  await ensureStaffFixture(E2E_PRODUCTION_STOCK_EMAIL, "E2E Production & Stock", E2E_PRODUCTION_STOCK_ROLE_KEY);

  await ensureLimitedRole(E2E_ORDERS_ROLE_KEY, [
    "products.manage",
    "production.manage",
    "stock.view",
    "stock.adjust",
    "finance.view_profit",
    "inventory.view",
    "inventory.manage",
    "orders.view",
    "orders.manage",
  ]);
  await ensureStaffFixture(E2E_ORDERS_EMAIL, "E2E Orders", E2E_ORDERS_ROLE_KEY);

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
    .where(
      inArray(authEmailThrottle.email, [
        E2E_SUPER_ADMIN_EMAIL,
        E2E_OWNER_EMAIL,
        E2E_PRODUCTS_NO_FINANCE_EMAIL,
        E2E_PRODUCTION_STOCK_EMAIL,
        E2E_ORDERS_EMAIL,
      ]),
    );
  await db.delete(staffAuthRateLimits);
}
