import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { loadStaffSessionData } from "@ammari/auth/staff";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { auditLog, permissions, rolePermissions, roles, staffUsers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { createRole, ROLE_AUDIT_ACTIONS, updateRole, updateRoleDetails, updateRolePermissions } from "./role-mutations";

// docs/plans/roles-staff.md §10 test 7 (+ §11a): role writes. Every test runs inside a
// rolled-back transaction on ammari_test; the mutations' own transactions become savepoints.

async function roleByKey(tx: TestTx, key: string) {
  const [row] = await tx.select().from(roles).where(eq(roles.key, key));
  if (!row) throw new Error(`role ${key} not seeded`);
  return row;
}

async function staff(tx: TestTx, roleKey: string) {
  const [row] = await tx
    .insert(staffUsers)
    .values({ name: `Staf ${roleKey}`, email: `staf-${randomUUID()}@example.test`, roleId: (await roleByKey(tx, roleKey)).id })
    .returning();
  return row!;
}

async function keysOf(tx: TestTx, roleId: string): Promise<string[]> {
  const rows = await tx
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((row) => row.key).sort();
}

async function auditFor(tx: TestTx, roleId: string) {
  return tx.select().from(auditLog).where(and(eq(auditLog.entityType, "role"), eq(auditLog.entityId, roleId)));
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("createRole", () => {
  test("a super_admin creates a role with its grants and one audit row", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const source = await roleByKey(tx, "packing_warehouse");
      const { roleId } = await createRole(
        { name: "Gudang Malam", description: "Shift malam", permissionKeys: ["stock.view", "orders.view", "stock.view"], copiedFromRoleId: source.id },
        actor.id,
        tx,
      );

      const [role] = await tx.select().from(roles).where(eq(roles.id, roleId));
      expect(role).toMatchObject({ name: "Gudang Malam", description: "Shift malam", isSystem: false });
      expect(role!.key).toMatch(/^custom_[0-9a-f]{12}$/);
      expect(await keysOf(tx, roleId)).toEqual(["orders.view", "stock.view"]);

      const audits = await auditFor(tx, roleId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: ROLE_AUDIT_ACTIONS.create, actorStaffUserId: actor.id });
      expect(audits[0]!.after).toEqual({ key: role!.key, name: "Gudang Malam", permissionKeys: ["orders.view", "stock.view"], copiedFromRoleKey: "packing_warehouse" });
    });
  });

  test("roles.manage and audit_log.view are never granted to a new role", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      for (const key of ["roles.manage", "audit_log.view"]) {
        const error = await caught(createRole({ name: `X ${key}`, description: null, permissionKeys: ["stock.view", key] }, actor.id, tx));
        expect(error).toBeInstanceOf(FieldError);
        expect((error as FieldError).field).toBe("permissionKeys");
        expect((error as Error).message).toMatch(/hanya untuk Super Admin/);
      }
    });
  });

  test("a duplicate name (any case) is refused on the name field", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const error = await caught(createRole({ name: "packing/gudang", description: null, permissionKeys: [] }, actor.id, tx));
      expect(error).toBeInstanceOf(FieldError);
      expect((error as FieldError).field).toBe("name");
    });
  });

  test("only a super_admin may write roles: the owner, and a non-super_admin role holding roles.manage, are refused", async () => {
    await withRollback(async (tx) => {
      const ownerActor = await staff(tx, "owner");
      expect(await caught(createRole({ name: "A", description: null, permissionKeys: [] }, ownerActor.id, tx))).toBeInstanceOf(ActionError);

      // A legacy role that somehow holds roles.manage: still not super_admin (owner answer 1).
      const [legacy] = await tx.insert(roles).values({ key: `legacy_${randomUUID().slice(0, 8)}`, name: `Legacy ${randomUUID()}` }).returning();
      const [rolesManage] = await tx.select().from(permissions).where(eq(permissions.key, "roles.manage"));
      await tx.insert(rolePermissions).values({ roleId: legacy!.id, permissionId: rolesManage!.id });
      const [legacyActor] = await tx.insert(staffUsers).values({ name: "L", email: `l-${randomUUID()}@example.test`, roleId: legacy!.id }).returning();
      expect(await caught(createRole({ name: "B", description: null, permissionKeys: [] }, legacyActor!.id, tx))).toBeInstanceOf(ActionError);

      const inactive = await staff(tx, "super_admin");
      await tx.update(staffUsers).set({ isActive: false }).where(eq(staffUsers.id, inactive.id));
      expect(await caught(createRole({ name: "C", description: null, permissionKeys: [] }, inactive.id, tx))).toBeInstanceOf(ActionError);
    });
  });
});

describe("updateRolePermissions", () => {
  test("replaces the set, is live on the next permission load, and writes one audit row with full sorted lists", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const role = await roleByKey(tx, "content_admin");
      const holder = await staff(tx, "content_admin");
      const before = await keysOf(tx, role.id);
      expect(before).toEqual(["content.manage", "stock.view"]);

      const result = await updateRolePermissions(
        role.id,
        { permissionKeys: ["products.manage", "content.manage"], expectedPermissionKeys: ["stock.view", "content.manage"] },
        actor.id,
        tx,
      );
      expect(result).toEqual({ changed: true });
      expect(await keysOf(tx, role.id)).toEqual(["content.manage", "products.manage"]);
      const session = await loadStaffSessionData(tx as unknown as Parameters<typeof loadStaffSessionData>[0], holder.id);
      expect([...session!.permissionKeys].sort()).toEqual(["content.manage", "products.manage"]);

      const audits = await auditFor(tx, role.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: ROLE_AUDIT_ACTIONS.permissionsUpdate,
        before: { permissionKeys: ["stock.view", "content.manage"] },
        after: { permissionKeys: ["products.manage", "content.manage"] },
      });
    });
  });

  test("the super_admin role is never editable", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const superAdminRole = await roleByKey(tx, "super_admin");
      const all = await keysOf(tx, superAdminRole.id);
      const error = await caught(updateRolePermissions(superAdminRole.id, { permissionKeys: [], expectedPermissionKeys: all }, actor.id, tx));
      expect(error).toBeInstanceOf(ActionError);
      expect((error as Error).message).toMatch(/Super Admin selalu punya semua izin/);
      expect(await caught(updateRoleDetails(superAdminRole.id, { name: "Bos", description: null }, actor.id, tx))).toBeInstanceOf(ActionError);
    });
  });

  test("never grants roles.manage / audit_log.view to another role, the owner included", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const ownerRole = await roleByKey(tx, "owner");
      const current = await keysOf(tx, ownerRole.id);
      const error = await caught(
        updateRolePermissions(ownerRole.id, { permissionKeys: [...current, "audit_log.view"], expectedPermissionKeys: current }, actor.id, tx),
      );
      expect(error).toBeInstanceOf(FieldError);
      expect(await keysOf(tx, ownerRole.id)).toEqual(current);
    });
  });

  test("refused when the role changed since the editor loaded it", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const role = await roleByKey(tx, "finance");
      const error = await caught(updateRolePermissions(role.id, { permissionKeys: ["overview.view"], expectedPermissionKeys: ["overview.view"] }, actor.id, tx));
      expect(error).toBeInstanceOf(ActionError);
      expect((error as Error).message).toMatch(/baru saja diubah/);
    });
  });

  test("no change: no write, no audit row", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const role = await roleByKey(tx, "content_admin");
      const current = await keysOf(tx, role.id);
      expect(await updateRolePermissions(role.id, { permissionKeys: current, expectedPermissionKeys: current }, actor.id, tx)).toEqual({ changed: false });
      expect(await auditFor(tx, role.id)).toHaveLength(0);
    });
  });
});

describe("updateRoleDetails", () => {
  test("rename and description are audited with only the changed fields", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const role = await roleByKey(tx, "customer_service");
      expect(await updateRoleDetails(role.id, { name: "CS", description: role.description }, actor.id, tx)).toEqual({ changed: true });
      const [audit] = await auditFor(tx, role.id);
      expect(audit).toMatchObject({ action: ROLE_AUDIT_ACTIONS.update, before: { name: "CS/Pesanan" }, after: { name: "CS" } });
      expect(await caught(updateRoleDetails(role.id, { name: "Keuangan", description: null }, actor.id, tx))).toBeInstanceOf(FieldError);
    });
  });
});

describe("updateRole (the editor's one save)", () => {
  test("saves details and permissions together, one audit row each", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const role = await roleByKey(tx, "content_admin");
      const result = await updateRole(
        role.id,
        { name: "Konten", description: "Toko online", permissionKeys: ["content.manage"], expectedPermissionKeys: ["content.manage", "stock.view"] },
        actor.id,
        tx,
      );
      expect(result).toEqual({ changed: true });
      expect((await tx.select().from(roles).where(eq(roles.id, role.id)))[0]).toMatchObject({ name: "Konten", description: "Toko online" });
      expect(await keysOf(tx, role.id)).toEqual(["content.manage"]);
      expect((await auditFor(tx, role.id)).map((row) => row.action).sort()).toEqual([ROLE_AUDIT_ACTIONS.permissionsUpdate, ROLE_AUDIT_ACTIONS.update].sort());
    });
  });

  test("a refused permission change leaves the rename unsaved too", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const role = await roleByKey(tx, "content_admin");
      const error = await caught(
        updateRole(role.id, { name: "Konten Baru", description: null, permissionKeys: ["content.manage", "audit_log.view"], expectedPermissionKeys: ["content.manage", "stock.view"] }, actor.id, tx),
      );
      expect(error).toBeInstanceOf(FieldError);
      // The mutation's savepoint rolled back as a whole.
      expect((await tx.select().from(roles).where(eq(roles.id, role.id)))[0]!.name).toBe("Admin Konten");
      expect(await auditFor(tx, role.id)).toHaveLength(0);
    });
  });

  test("an unknown copy source is refused", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const error = await caught(createRole({ name: "Salinan", description: null, permissionKeys: [], copiedFromRoleId: randomUUID() }, actor.id, tx));
      expect(error).toBeInstanceOf(FieldError);
      expect((error as FieldError).field).toBe("copiedFromRoleId");
    });
  });
});
