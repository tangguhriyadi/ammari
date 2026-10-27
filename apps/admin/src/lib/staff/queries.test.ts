import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { roles, staffAuthSessions, staffAuthUsers, staffUsers } from "@ammari/db/schema";
import { ownerDefaultPermissionKeys, superAdminDefaultPermissionKeys } from "@ammari/db/rbac";
import { assignableRoles, getStaffDetail, listRoles, listStaff } from "./queries";

async function staff(tx: TestTx, roleKey: string, overrides: Partial<typeof staffUsers.$inferInsert> = {}) {
  const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, roleKey));
  const [row] = await tx
    .insert(staffUsers)
    .values({ name: `Staf ${randomUUID()}`, email: `q-${randomUUID()}@example.test`, roleId: role!.id, ...overrides })
    .returning();
  return row!;
}

describe("listStaff", () => {
  test("derives status and sorts active accounts first", async () => {
    await withRollback(async (tx) => {
      const now = new Date();
      const invited = await staff(tx, "finance", { name: "Aa Undangan", invitedAt: now, inviteExpiresAt: new Date(now.getTime() + 86_400_000) });
      const expired = await staff(tx, "finance", { name: "Ab Kedaluwarsa", invitedAt: now, inviteExpiresAt: new Date(now.getTime() - 1000) });
      const inactive = await staff(tx, "finance", { name: "Aa Nonaktif", isActive: false });
      const active = await staff(tx, "finance", { name: "Ac Aktif", lastLoginAt: now });

      const rows = await listStaff(tx, now);
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(invited.id)!.status).toBe("invited");
      expect(byId.get(expired.id)!.status).toBe("invite_expired");
      expect(byId.get(inactive.id)!.status).toBe("inactive");
      expect(byId.get(active.id)!).toMatchObject({ status: "active", roleName: "Keuangan" });
      const indexOf = (id: string) => rows.findIndex((row) => row.id === id);
      expect(indexOf(inactive.id)).toBeGreaterThan(indexOf(active.id));
      expect(indexOf(invited.id)).toBeLessThan(indexOf(expired.id));
    });
  });
});

describe("listRoles / assignableRoles", () => {
  test("super_admin first, active counts, and the owner never gets super_admin to assign", async () => {
    await withRollback(async (tx) => {
      const before = (await listRoles(tx)).find((role) => role.key === "content_admin")!.activeStaffCount;
      await staff(tx, "content_admin");
      await staff(tx, "content_admin", { isActive: false });
      const all = await listRoles(tx);
      expect(all[0]!.key).toBe("super_admin");
      expect(all[1]!.key).toBe("owner");
      expect(all.find((role) => role.key === "content_admin")).toMatchObject({ activeStaffCount: before + 1, permissionKeys: ["stock.view", "content.manage"] });

      const forOwner = assignableRoles(all, { staffUserId: "x", roleKey: "owner", permissionKeys: ownerDefaultPermissionKeys() }).map((role) => role.name);
      expect(forOwner).not.toContain("Super Admin");
      expect(forOwner).toEqual(expect.arrayContaining(["Owner", "Packing/Gudang", "Admin Konten", "CS/Pesanan", "Keuangan"]));
      const finance = assignableRoles(all, { staffUserId: "x", roleKey: "super_admin", permissionKeys: superAdminDefaultPermissionKeys() }).find(
        (role) => role.name === "Keuangan",
      );
      expect(finance!.canViewProfit).toBe(true);
    });
  });
});

describe("getStaffDetail", () => {
  test("counts live sessions only, knows the inviter, and applies the guard rails", async () => {
    await withRollback(async (tx) => {
      const viewerRow = await staff(tx, "owner", { name: "Istri", lastLoginAt: new Date() });
      const viewer = { staffUserId: viewerRow.id, roleKey: "owner", permissionKeys: ownerDefaultPermissionKeys() };
      const target = await staff(tx, "packing_warehouse", { invitedAt: new Date(), inviteExpiresAt: new Date(Date.now() + 86_400_000), invitedByStaffUserId: viewerRow.id });
      const [authUser] = await tx.insert(staffAuthUsers).values({ staffUserId: target.id, name: "x", email: `a-${randomUUID()}@example.test` }).returning();
      await tx.insert(staffAuthSessions).values([
        { userId: authUser!.id, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) },
        { userId: authUser!.id, token: randomUUID(), expiresAt: new Date(Date.now() - 3_600_000) },
      ]);

      const detail = await getStaffDetail(target.id, viewer, tx);
      expect(detail).toMatchObject({ invitedByName: "Istri", activeSessionCount: 1, roleKey: "packing_warehouse", status: "invited" });
      // Logged in once (an auth user exists) even though last_login_at is unset: email locked.
      expect(detail!.capabilities.manage).toBeNull();
      expect(detail!.capabilities.editEmail).toMatch(/tidak bisa diubah/);

      const superAdminRow = await staff(tx, "super_admin");
      expect((await getStaffDetail(superAdminRow.id, viewer, tx))!.capabilities.manage).toMatch(/Hanya Super Admin/);
      expect((await getStaffDetail(viewerRow.id, viewer, tx))!.capabilities.manage).toMatch(/akun Anda sendiri/);
      expect(await getStaffDetail(randomUUID(), viewer, tx)).toBeNull();
    });
  });
});
