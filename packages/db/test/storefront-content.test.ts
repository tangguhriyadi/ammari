import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { permissions, rolePermissions, storefrontHomepageSections } from "../src/schema";
import { HOMEPAGE_SECTION_KEYS } from "../src/schema/constants";
import { withRollback, type TestTx } from "./helpers";
import { getRoleByKey } from "./fixtures";

/** Same unwrapping other packages/db tests use — drizzle-orm wraps the driver error and puts the
 * real Postgres code on `.cause`. */
async function causeCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return (cause as { code?: string } | undefined)?.code;
  }
  throw new Error("expected promise to reject, but it resolved");
}

describe("storefront_homepage_sections", () => {
  // Migration 0019 seeds exactly these 4 rows (not seed.ts — CLAUDE.md's "reference data ships
  // in a migration" rule) so the storefront has something to read from day one.
  test("migration 0019 seeded exactly the 4 fixed section rows", async () => {
    await withRollback(async (tx) => {
      const rows = await tx.select({ key: storefrontHomepageSections.key }).from(storefrontHomepageSections);
      expect(rows.map((r) => r.key).sort()).toEqual([...HOMEPAGE_SECTION_KEYS].sort());
    });
  });

  test("each seeded row starts with an empty draft, visible, and nothing published yet", async () => {
    await withRollback(async (tx) => {
      const rows = await tx.select().from(storefrontHomepageSections);
      for (const row of rows) {
        expect(row.draftIsVisible).toBe(true);
        expect(row.draftContent).toEqual({});
        expect(row.publishedIsVisible).toBeNull();
        expect(row.publishedContent).toBeNull();
        expect(row.publishedAt).toBeNull();
      }
    });
  });

  test("rejects a key outside the fixed 4 (storefront_homepage_sections_key_check)", async () => {
    await withRollback(async (tx) => {
      const code = await causeCode(
        tx.insert(storefrontHomepageSections).values({ key: "bogus_section" }),
      );
      expect(code).toBe("23514"); // check_violation
    });
  });

  test("rejects a duplicate key", async () => {
    await withRollback(async (tx: TestTx) => {
      const code = await causeCode(tx.insert(storefrontHomepageSections).values({ key: "hero" }));
      expect(code).toBe("23505"); // unique_violation — "hero" already exists from the migration seed
    });
  });
});

describe("content.manage permission", () => {
  test("exists in the permissions catalog", async () => {
    await withRollback(async (tx) => {
      const [permission] = await tx.select().from(permissions).where(eq(permissions.key, "content.manage")).limit(1);
      expect(permission).toBeDefined();
      expect(permission?.group).toBe("content");
    });
  });

  test("is granted to super_admin and owner by default", async () => {
    await withRollback(async (tx) => {
      const [permission] = await tx.select().from(permissions).where(eq(permissions.key, "content.manage")).limit(1);
      if (!permission) throw new Error("content.manage was not seeded");

      for (const roleKey of ["super_admin", "owner"]) {
        const role = await getRoleByKey(tx, roleKey);
        const grants = await tx
          .select({ permissionId: rolePermissions.permissionId })
          .from(rolePermissions)
          .where(eq(rolePermissions.roleId, role.id));
        expect(grants.some((grant) => grant.permissionId === permission.id)).toBe(true);
      }
    });
  });
});
