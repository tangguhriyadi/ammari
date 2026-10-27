import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import type { EmailMessage, EmailSender } from "@ammari/auth";
import { loadStaffSessionData } from "@ammari/auth/staff";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { auditLog, permissions, rolePermissions, roles, staffAuthSessions, staffAuthUsers, staffUsers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import {
  changeStaffRole,
  deactivateStaff,
  inviteStaff,
  reactivateStaff,
  renewStaffInvite,
  revokeStaffSessions,
  STAFF_AUDIT_ACTIONS,
  updateStaffProfile,
} from "./mutations";

// docs/plans/roles-staff.md §10 tests 4-8. Every test runs inside a rolled-back transaction on
// the shared ammari_test database; the mutations' own db.transaction() becomes a savepoint. The
// migration 0041 trigger is DEFERRED to COMMIT, which a rolled-back test never reaches, so the
// "last holder" assertions here exercise the app-side check only (the trigger has its own test in
// packages/db/test/migration-0041.test.ts). No email ever leaves the process: a fake sender.

class FakeEmailSender implements EmailSender {
  sent: EmailMessage[] = [];
  constructor(private readonly fail = false) {}
  async send(message: EmailMessage): Promise<void> {
    if (this.fail) throw new Error("provider down for test@example.test");
    this.sent.push(message);
  }
}

const LOGIN_URL = "http://localhost:3001";

async function roleId(tx: TestTx, key: string): Promise<string> {
  const [row] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, key));
  if (!row) throw new Error(`role ${key} not seeded`);
  return row.id;
}

async function staff(tx: TestTx, roleKey: string, overrides: Partial<typeof staffUsers.$inferInsert> = {}) {
  const [row] = await tx
    .insert(staffUsers)
    .values({ name: `Staf ${roleKey}`, email: `staf-${randomUUID()}@example.test`, roleId: await roleId(tx, roleKey), ...overrides })
    .returning();
  if (!row) throw new Error("failed to insert staff fixture");
  return row;
}

/** A role holding every permission without being super_admin: the subset rule alone would let
 * it act on a super_admin; the hard super_admin-only rule must not. */
async function allPermissionsRole(tx: TestTx): Promise<string> {
  const [role] = await tx.insert(roles).values({ key: `all_${randomUUID().slice(0, 8)}`, name: "Semua izin" }).returning();
  const all = await tx.select({ id: permissions.id }).from(permissions);
  await tx.insert(rolePermissions).values(all.map((p) => ({ roleId: role!.id, permissionId: p.id })));
  return role!.id;
}

/** Leaves `keep` as the only active holder of `roleKey` inside this rolled-back transaction. */
async function onlyActiveHolder(tx: TestTx, roleKey: string, keep: string): Promise<void> {
  await tx
    .update(staffUsers)
    .set({ isActive: false })
    .where(and(eq(staffUsers.roleId, await roleId(tx, roleKey)), sql`${staffUsers.id} <> ${keep}`));
}

async function sessionsFor(tx: TestTx, staffUserId: string, n: number): Promise<void> {
  const [authUser] = await tx
    .insert(staffAuthUsers)
    .values({ staffUserId, name: "x", email: `auth-${randomUUID()}@example.test` })
    .returning();
  for (let i = 0; i < n; i++) {
    await tx.insert(staffAuthSessions).values({ userId: authUser!.id, token: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) });
  }
}

async function sessionCount(tx: TestTx, staffUserId: string): Promise<number> {
  const rows = await tx
    .select({ id: staffAuthSessions.id })
    .from(staffAuthSessions)
    .innerJoin(staffAuthUsers, eq(staffAuthSessions.userId, staffAuthUsers.id))
    .where(eq(staffAuthUsers.staffUserId, staffUserId));
  return rows.length;
}

async function auditFor(tx: TestTx, staffUserId: string) {
  return tx.select().from(auditLog).where(and(eq(auditLog.entityType, "staff_user"), eq(auditLog.entityId, staffUserId)));
}

async function expectActionError(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ActionError);
  expect((error as Error).message).toMatch(message);
}

describe("inviteStaff", () => {
  test("creates a 7-day invitation, audits it, and emails the person", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const sender = new FakeEmailSender();
      const email = `baru-${randomUUID()}@example.test`;

      const result = await inviteStaff({ name: "Rina", email, roleId: await roleId(tx, "packing_warehouse") }, actor.id, {
        db: tx,
        emailSender: sender,
        loginUrl: LOGIN_URL,
      });

      expect(result.emailSent).toBe(true);
      const [row] = await tx.select().from(staffUsers).where(eq(staffUsers.id, result.staffUserId));
      expect(row).toMatchObject({ name: "Rina", email, isActive: true, lastLoginAt: null, invitedByStaffUserId: actor.id });
      const days = (row!.inviteExpiresAt!.getTime() - row!.invitedAt!.getTime()) / 86_400_000;
      expect(days).toBeCloseTo(7, 5);

      const [audit] = await auditFor(tx, result.staffUserId);
      expect(audit).toMatchObject({ action: STAFF_AUDIT_ACTIONS.invite, actorStaffUserId: actor.id });
      expect(audit!.after).toMatchObject({ name: "Rina", email, roleKey: "packing_warehouse" });

      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0]).toMatchObject({ to: email, subject: "Undangan ke Admin Ammari" });
      expect(sender.sent[0]!.body).toContain("Packing/Gudang");
      expect(sender.sent[0]!.body).toContain(LOGIN_URL);
      expect(sender.sent[0]!.body).not.toMatch(/token|kode:\s*\d/i);
    });
  });

  test("an email that already has a row (any case) is refused on the email field", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const existing = await staff(tx, "owner");
      const error = await inviteStaff({ name: "X", email: existing.email.toUpperCase(), roleId: await roleId(tx, "finance") }, actor.id, { db: tx }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(FieldError);
      expect((error as FieldError).field).toBe("email");
    });
  });

  test("an actor without staff.manage is refused, even if the action layer were bypassed", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "packing_warehouse");
      await expectActionError(
        inviteStaff({ name: "X", email: `x-${randomUUID()}@example.test`, roleId: await roleId(tx, "packing_warehouse") }, actor.id, { db: tx }),
        /Akses ditolak/,
      );
    });
  });

  test("a deactivated actor is refused", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin", { isActive: false });
      await expectActionError(
        inviteStaff({ name: "X", email: `x-${randomUUID()}@example.test`, roleId: await roleId(tx, "finance") }, actor.id, { db: tx }),
        /Akses ditolak/,
      );
    });
  });

  test("the owner (staff.manage) may invite owner and predefined roles, never super_admin", async () => {
    await withRollback(async (tx) => {
      const owner = await staff(tx, "owner");
      for (const key of ["owner", "packing_warehouse", "content_admin", "customer_service", "finance"]) {
        await inviteStaff({ name: key, email: `${key}-${randomUUID()}@example.test`, roleId: await roleId(tx, key) }, owner.id, { db: tx });
      }
      await expectActionError(
        inviteStaff({ name: "X", email: `x-${randomUUID()}@example.test`, roleId: await roleId(tx, "super_admin") }, owner.id, { db: tx }),
        /izin yang tidak Anda miliki/,
      );
    });
  });

  test("an unknown role is refused on the role field", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const error = await inviteStaff({ name: "X", email: `x-${randomUUID()}@example.test`, roleId: randomUUID() }, actor.id, { db: tx }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(FieldError);
      expect((error as FieldError).field).toBe("roleId");
    });
  });

  test("20 invitations per actor per hour; the 21st is refused", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const role = await roleId(tx, "finance");
      for (let i = 0; i < 20; i++) {
        await inviteStaff({ name: `S${i}`, email: `rate-${i}-${randomUUID()}@example.test`, roleId: role }, actor.id, { db: tx });
      }
      await expectActionError(
        inviteStaff({ name: "S20", email: `rate-20-${randomUUID()}@example.test`, roleId: role }, actor.id, { db: tx }),
        /Terlalu banyak undangan/,
      );
    });
  });

  test("a failed email keeps the invitation and records the failure without the provider message", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const result = await inviteStaff(
        { name: "Gagal", email: `gagal-${randomUUID()}@example.test`, roleId: await roleId(tx, "finance") },
        actor.id,
        { db: tx, emailSender: new FakeEmailSender(true), loginUrl: LOGIN_URL },
      );
      expect(result.emailSent).toBe(false);
      const audits = await auditFor(tx, result.staffUserId);
      expect(audits.map((a) => a.action).sort()).toEqual([STAFF_AUDIT_ACTIONS.invite, STAFF_AUDIT_ACTIONS.inviteEmailFailed].sort());
      const failure = audits.find((a) => a.action === STAFF_AUDIT_ACTIONS.inviteEmailFailed);
      expect(JSON.stringify(failure!.after)).not.toContain("@");
    });
  });
});

describe("renewStaffInvite", () => {
  test("refused within 10 minutes of the last invite email, allowed after, and extends the window", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const sender = new FakeEmailSender();
      const deps = { db: tx, emailSender: sender, loginUrl: LOGIN_URL };
      const invited = await inviteStaff({ name: "Ulang", email: `ulang-${randomUUID()}@example.test`, roleId: await roleId(tx, "finance") }, actor.id, deps);

      await expectActionError(renewStaffInvite(invited.staffUserId, actor.id, deps), /Coba lagi dalam 10 menit/);

      await tx
        .update(auditLog)
        .set({ createdAt: sql`now() - interval '11 minutes'` })
        .where(eq(auditLog.entityId, invited.staffUserId));
      await tx
        .update(staffUsers)
        .set({ inviteExpiresAt: sql`now() - interval '1 day'` })
        .where(eq(staffUsers.id, invited.staffUserId));

      const renewed = await renewStaffInvite(invited.staffUserId, actor.id, deps);
      expect(renewed.emailSent).toBe(true);
      expect(renewed.inviteExpiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      expect(sender.sent).toHaveLength(2);
      expect((await auditFor(tx, invited.staffUserId)).map((a) => a.action)).toContain(STAFF_AUDIT_ACTIONS.inviteRenew);
    });
  });

  // §11a: "Kirim ulang undangan" is offered right after a failed send and after correcting a
  // pending invite's address, so the cooldown must not refuse it in those two cases.
  test("allowed at once after a failed invite email", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const invited = await inviteStaff(
        { name: "Gagal", email: `gagal-${randomUUID()}@example.test`, roleId: await roleId(tx, "finance") },
        actor.id,
        { db: tx, emailSender: new FakeEmailSender(true), loginUrl: LOGIN_URL },
      );
      expect(invited.emailSent).toBe(false);

      const sender = new FakeEmailSender();
      const renewed = await renewStaffInvite(invited.staffUserId, actor.id, { db: tx, emailSender: sender, loginUrl: LOGIN_URL });
      expect(renewed.emailSent).toBe(true);
      expect(sender.sent).toHaveLength(1);
      // A delivered email starts the cooldown again. now() is frozen inside this one test
      // transaction, so date the failure before the renewal, as separate transactions would.
      await tx
        .update(auditLog)
        .set({ createdAt: sql`now() - interval '1 minute'` })
        .where(and(eq(auditLog.entityId, invited.staffUserId), inArray(auditLog.action, [STAFF_AUDIT_ACTIONS.invite, STAFF_AUDIT_ACTIONS.inviteEmailFailed])));
      await expectActionError(renewStaffInvite(invited.staffUserId, actor.id, { db: tx }), /Coba lagi dalam 10 menit/);
    });
  });

  test("allowed at once after the pending invite's email is corrected, not after a name-only edit", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const sender = new FakeEmailSender();
      const deps = { db: tx, emailSender: sender, loginUrl: LOGIN_URL };
      const invited = await inviteStaff({ name: "Salah", email: `salah-${randomUUID()}@example.test`, roleId: await roleId(tx, "finance") }, actor.id, deps);

      await updateStaffProfile(invited.staffUserId, { name: "Salah Ketik", email: (await tx.select().from(staffUsers).where(eq(staffUsers.id, invited.staffUserId)))[0]!.email }, actor.id, tx);
      await expectActionError(renewStaffInvite(invited.staffUserId, actor.id, deps), /Coba lagi dalam 10 menit/);

      const corrected = `benar-${randomUUID()}@example.test`;
      await updateStaffProfile(invited.staffUserId, { name: "Salah Ketik", email: corrected }, actor.id, tx);
      const renewed = await renewStaffInvite(invited.staffUserId, actor.id, deps);
      expect(renewed.emailSent).toBe(true);
      expect(sender.sent.at(-1)!.to).toBe(corrected);
    });
  });

  test("at most 3 invite emails per person per hour, even through email corrections", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const deps = { db: tx, emailSender: new FakeEmailSender(), loginUrl: LOGIN_URL };
      const invited = await inviteStaff({ name: "Spam", email: `spam-${randomUUID()}@example.test`, roleId: await roleId(tx, "finance") }, actor.id, deps);
      for (let i = 0; i < 2; i++) {
        await updateStaffProfile(invited.staffUserId, { name: "Spam", email: `spam-${i}-${randomUUID()}@example.test` }, actor.id, tx);
        await renewStaffInvite(invited.staffUserId, actor.id, deps);
      }
      await updateStaffProfile(invited.staffUserId, { name: "Spam", email: `spam-x-${randomUUID()}@example.test` }, actor.id, tx);
      await expectActionError(renewStaffInvite(invited.staffUserId, actor.id, deps), /Terlalu banyak undangan untuk staf ini/);
    });
  });

  test("refused for someone who already logged in, or is deactivated", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const loggedIn = await staff(tx, "finance", { lastLoginAt: new Date() });
      const inactive = await staff(tx, "finance", { isActive: false });
      await expectActionError(renewStaffInvite(loggedIn.id, actor.id, { db: tx }), /sudah pernah masuk/);
      await expectActionError(renewStaffInvite(inactive.id, actor.id, { db: tx }), /Aktifkan kembali/);
    });
  });
});

describe("guard rails", () => {
  test("nobody changes their own account here", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const finance = await roleId(tx, "finance");
      await expectActionError(changeStaffRole(actor.id, finance, actor.id, tx), /akun Anda sendiri/);
      await expectActionError(deactivateStaff(actor.id, actor.id, tx), /akun Anda sendiri/);
      await expectActionError(revokeStaffSessions(actor.id, actor.id, tx), /akun Anda sendiri/);
      await expectActionError(updateStaffProfile(actor.id, { name: "Baru", email: actor.email }, actor.id, tx), /akun Anda sendiri/);
    });
  });

  test("the owner can't touch a super_admin, or promote anyone to super_admin", async () => {
    await withRollback(async (tx) => {
      const owner = await staff(tx, "owner");
      const superAdmin = await staff(tx, "super_admin");
      const packer = await staff(tx, "packing_warehouse");
      await expectActionError(deactivateStaff(superAdmin.id, owner.id, tx), /izin yang tidak Anda miliki/);
      await expectActionError(changeStaffRole(superAdmin.id, await roleId(tx, "owner"), owner.id, tx), /izin yang tidak Anda miliki/);
      await expectActionError(revokeStaffSessions(superAdmin.id, owner.id, tx), /izin yang tidak Anda miliki/);
      await expectActionError(changeStaffRole(packer.id, await roleId(tx, "super_admin"), owner.id, tx), /izin yang tidak Anda miliki/);
      // ...but manages a packer within her own permissions.
      expect(await changeStaffRole(packer.id, await roleId(tx, "customer_service"), owner.id, tx)).toEqual({ changed: true });
    });
  });

  test("only a super_admin touches super_admin, even for a role holding every permission", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "owner", { roleId: await allPermissionsRole(tx) });
      const superAdmin = await staff(tx, "super_admin");
      const packer = await staff(tx, "packing_warehouse");
      await expectActionError(deactivateStaff(superAdmin.id, actor.id, tx), /izin yang tidak Anda miliki/);
      await expectActionError(changeStaffRole(superAdmin.id, await roleId(tx, "owner"), actor.id, tx), /izin yang tidak Anda miliki/);
      await expectActionError(changeStaffRole(packer.id, await roleId(tx, "super_admin"), actor.id, tx), /izin yang tidak Anda miliki/);
      await expectActionError(
        inviteStaff({ name: "X", email: `x-${randomUUID()}@example.test`, roleId: await roleId(tx, "super_admin") }, actor.id, { db: tx }),
        /izin yang tidak Anda miliki/,
      );
      // A super_admin may manage another super_admin (the actor itself always remains).
      const superActor = await staff(tx, "super_admin", { lastLoginAt: new Date() });
      expect(await changeStaffRole(superAdmin.id, await roleId(tx, "owner"), superActor.id, tx)).toEqual({ changed: true });
    });
  });

  test("the last active owner can't be deactivated or moved to another role; a pending owner invite doesn't count", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const lastOwner = await staff(tx, "owner", { lastLoginAt: new Date() });
      await onlyActiveHolder(tx, "owner", lastOwner.id);
      // A pending owner invitation: the person may never accept, so it is not a holder.
      await staff(tx, "owner", { invitedAt: new Date(), inviteExpiresAt: new Date(Date.now() + 86_400_000) });

      await expectActionError(deactivateStaff(lastOwner.id, actor.id, tx), /Owner aktif terakhir/);
      await expectActionError(changeStaffRole(lastOwner.id, await roleId(tx, "finance"), actor.id, tx), /Owner aktif terakhir/);
      // Another owner can still be invited, and then the first one can be moved.
      await staff(tx, "owner");
      expect(await changeStaffRole(lastOwner.id, await roleId(tx, "finance"), actor.id, tx)).toEqual({ changed: true });
    });
  });

  test("an unknown staff id is refused", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      await expectActionError(deactivateStaff(randomUUID(), actor.id, tx), /Staf tidak ditemukan/);
    });
  });
});

describe("deactivate / reactivate / sessions / role change", () => {
  test("deactivating ends only that person's sessions, and they lose access at once", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "owner");
      const packer = await staff(tx, "packing_warehouse", { lastLoginAt: new Date() });
      const other = await staff(tx, "packing_warehouse", { lastLoginAt: new Date() });
      await sessionsFor(tx, packer.id, 2);
      await sessionsFor(tx, other.id, 1);
      const db = tx as unknown as Parameters<typeof loadStaffSessionData>[0];
      expect(await loadStaffSessionData(db, packer.id)).not.toBeNull();

      expect(await deactivateStaff(packer.id, actor.id, tx)).toEqual({ changed: true, sessionsEnded: 2 });
      expect(await sessionCount(tx, packer.id)).toBe(0);
      expect(await sessionCount(tx, other.id)).toBe(1);
      expect(await loadStaffSessionData(db, packer.id)).toBeNull();
      const [row] = await tx.select().from(staffUsers).where(eq(staffUsers.id, packer.id));
      expect(row!.deactivatedAt).not.toBeNull();

      // Idempotent: a second deactivate changes nothing and writes no second audit row.
      expect(await deactivateStaff(packer.id, actor.id, tx)).toEqual({ changed: false, sessionsEnded: 0 });

      expect(await reactivateStaff(packer.id, actor.id, tx)).toEqual({ changed: true });
      expect(await loadStaffSessionData(db, packer.id)).not.toBeNull();
      const [reactivated] = await tx.select().from(staffUsers).where(eq(staffUsers.id, packer.id));
      expect(reactivated!.deactivatedAt).toBeNull();

      const actions = (await auditFor(tx, packer.id)).map((a) => a.action);
      expect(actions.sort()).toEqual([STAFF_AUDIT_ACTIONS.deactivate, STAFF_AUDIT_ACTIONS.reactivate].sort());
      const deactivation = (await auditFor(tx, packer.id)).find((a) => a.action === STAFF_AUDIT_ACTIONS.deactivate);
      expect(deactivation!.after).toEqual({ isActive: false, sessionsEnded: 2 });
    });
  });

  test("Akhiri semua sesi ends sessions but keeps the account active", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const cs = await staff(tx, "customer_service", { lastLoginAt: new Date() });
      await sessionsFor(tx, cs.id, 3);
      expect(await revokeStaffSessions(cs.id, actor.id, tx)).toEqual({ sessionsEnded: 3 });
      expect(await sessionCount(tx, cs.id)).toBe(0);
      const [row] = await tx.select().from(staffUsers).where(eq(staffUsers.id, cs.id));
      expect(row!.isActive).toBe(true);
      expect((await auditFor(tx, cs.id)).map((a) => a.action)).toEqual([STAFF_AUDIT_ACTIONS.sessionsRevoke]);
    });
  });

  test("a role change is live on the next permission load, keeps sessions, and is audited", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const person = await staff(tx, "packing_warehouse", { lastLoginAt: new Date() });
      await sessionsFor(tx, person.id, 1);
      const db = tx as unknown as Parameters<typeof loadStaffSessionData>[0];
      expect((await loadStaffSessionData(db, person.id))!.permissionKeys).not.toContain("finance.view_profit");

      expect(await changeStaffRole(person.id, await roleId(tx, "finance"), actor.id, tx)).toEqual({ changed: true });
      expect((await loadStaffSessionData(db, person.id))!.permissionKeys).toContain("finance.view_profit");
      expect(await sessionCount(tx, person.id)).toBe(1);
      // Same role again: no change, no audit row.
      expect(await changeStaffRole(person.id, await roleId(tx, "finance"), actor.id, tx)).toEqual({ changed: false });

      const audits = await auditFor(tx, person.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: STAFF_AUDIT_ACTIONS.roleChange, before: { roleKey: "packing_warehouse" }, after: { roleKey: "finance" } });
    });
  });
});

describe("updateStaffProfile", () => {
  test("name always; email only before the first login; duplicates refused", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const invited = await staff(tx, "finance");
      const taken = await staff(tx, "finance");
      const loggedIn = await staff(tx, "finance", { lastLoginAt: new Date() });

      const fixed = `benar-${randomUUID()}@example.test`;
      expect(await updateStaffProfile(invited.id, { name: "Nama Baru", email: fixed }, actor.id, tx)).toEqual({ changed: true });
      const [row] = await tx.select().from(staffUsers).where(eq(staffUsers.id, invited.id));
      expect(row).toMatchObject({ name: "Nama Baru", email: fixed });
      const [audit] = await auditFor(tx, invited.id);
      expect(audit).toMatchObject({ action: STAFF_AUDIT_ACTIONS.update, before: { name: invited.name, email: invited.email }, after: { name: "Nama Baru", email: fixed } });

      // Unchanged input: nothing written.
      expect(await updateStaffProfile(invited.id, { name: "Nama Baru", email: fixed.toUpperCase().toLowerCase() }, actor.id, tx)).toEqual({ changed: false });

      const loggedInError = await updateStaffProfile(loggedIn.id, { name: loggedIn.name, email: `lain-${randomUUID()}@example.test` }, actor.id, tx).catch(
        (caught: unknown) => caught,
      );
      expect(loggedInError).toBeInstanceOf(FieldError);
      expect((loggedInError as Error).message).toMatch(/setelah staf pernah masuk/);
      // Renaming someone who logged in is fine.
      expect(await updateStaffProfile(loggedIn.id, { name: "Ganti Nama", email: loggedIn.email }, actor.id, tx)).toEqual({ changed: true });

      const duplicate = await tx.transaction(async (inner) =>
        updateStaffProfile(invited.id, { name: "Nama Baru", email: taken.email }, actor.id, inner).catch((caught: unknown) => caught),
      );
      expect(duplicate).toBeInstanceOf(FieldError);
      expect((duplicate as FieldError).field).toBe("email");
    });
  });
});

describe("audit coverage", () => {
  test("every audit action name is distinct and namespaced", () => {
    const names = Object.values(STAFF_AUDIT_ACTIONS);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^staff\./);
  });

  test("no staff mutation leaves a staff_users row without its audit trail", async () => {
    await withRollback(async (tx) => {
      const actor = await staff(tx, "super_admin");
      const invited = await inviteStaff({ name: "A", email: `a-${randomUUID()}@example.test`, roleId: await roleId(tx, "finance") }, actor.id, { db: tx });
      await changeStaffRole(invited.staffUserId, await roleId(tx, "content_admin"), actor.id, tx);
      await deactivateStaff(invited.staffUserId, actor.id, tx);
      const actions = (await auditFor(tx, invited.staffUserId)).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining([STAFF_AUDIT_ACTIONS.invite, STAFF_AUDIT_ACTIONS.roleChange, STAFF_AUDIT_ACTIONS.deactivate]));
      const actors = await tx.select({ actor: auditLog.actorStaffUserId }).from(auditLog).where(inArray(auditLog.entityId, [invited.staffUserId]));
      expect(new Set(actors.map((a) => a.actor))).toEqual(new Set([actor.id]));
    });
  });
});
