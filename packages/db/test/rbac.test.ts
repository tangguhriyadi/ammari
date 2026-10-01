import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { permissions, rolePermissions, roles } from "../src/schema";
import { withRollback } from "./helpers";
import { getRoleByKey } from "./fixtures";

describe("roles", () => {
  test("deleting a system role fails", async () => {
    await withRollback(async (tx) => {
      const superAdmin = await getRoleByKey(tx, "super_admin");
      let caught: unknown;
      try {
        await tx.delete(roles).where(eq(roles.id, superAdmin.id));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const cause = caught instanceof Error && caught.cause instanceof Error ? caught.cause : caught;
      expect(String(cause)).toMatch(/cannot delete system role/i);
    });
  });

  test("deleting a non-system role succeeds", async () => {
    await withRollback(async (tx) => {
      const [customRole] = await tx
        .insert(roles)
        .values({ key: "test_role", name: "Test Role", isSystem: false })
        .returning();
      if (!customRole) throw new Error("failed to insert role fixture");
      await expect(tx.delete(roles).where(eq(roles.id, customRole.id))).resolves.not.toThrow();
    });
  });

  test("flipping is_system off a system role fails (closes the delete-guard bypass)", async () => {
    await withRollback(async (tx) => {
      const superAdmin = await getRoleByKey(tx, "super_admin");
      // Without this guard, `UPDATE ... SET is_system = false` followed by a plain DELETE
      // would silently bypass prevent_system_role_delete.
      await expect(
        tx.update(roles).set({ isSystem: false }).where(eq(roles.id, superAdmin.id)),
      ).rejects.toThrow();
    });
  });

  test("updating a system role without touching is_system succeeds", async () => {
    await withRollback(async (tx) => {
      const superAdmin = await getRoleByKey(tx, "super_admin");
      await expect(
        tx.update(roles).set({ description: "updated" }).where(eq(roles.id, superAdmin.id)),
      ).resolves.not.toThrow();
    });
  });
});

describe("role_permissions", () => {
  test("the same (role, permission) pair cannot be granted twice", async () => {
    await withRollback(async (tx) => {
      const owner = await getRoleByKey(tx, "owner");
      const [permission] = await tx.select().from(permissions).limit(1);
      if (!permission) throw new Error("no permissions seeded");

      // owner already has most permissions seeded; delete first so we control the starting state.
      await tx
        .delete(rolePermissions)
        .where(eq(rolePermissions.roleId, owner.id));
      await tx.insert(rolePermissions).values({ roleId: owner.id, permissionId: permission.id });

      await expect(
        tx.insert(rolePermissions).values({ roleId: owner.id, permissionId: permission.id }),
      ).rejects.toThrow();
    });
  });
});
