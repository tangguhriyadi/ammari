"use server";

import { z } from "zod";
import { PERMISSIONS } from "@ammari/db/rbac";
import { requirePermission } from "@/lib/auth/require-permission";
import { adminBaseUrl, staffEmailLogoUrl, staffEmailSender } from "@/lib/auth/staff";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { staffEmailSchema } from "@/lib/staff/email";
import * as staffMutations from "@/lib/staff/mutations";
import * as roleMutations from "@/lib/staff/role-mutations";

// The staff and role write paths' thin action layer (docs/plans/roles-staff.md §5): requirePermission,
// zod, runAction. Every rule (self, subset, last super_admin/owner, rate limits, audit, session
// revocation, super_admin-only role edits) lives in lib/staff/mutations.ts and
// lib/staff/role-mutations.ts, under the staff-access lock, never here.

const PERMISSION = "staff.manage";
const ROLES_PERMISSION = "roles.manage";

// A person's name as shown in the list and greeted in the invite email: no control, format
// (bidi overrides) or line/paragraph separator characters, which could reshape the plain-text
// email; bounded like every other free-text input.
const staffNameSchema = z
  .string({ error: "Nama wajib diisi." })
  .trim()
  .min(1, "Nama wajib diisi.")
  .max(100, "Nama terlalu panjang.")
  .refine((name) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name), "Nama tidak boleh berisi karakter khusus.");

const staffUserIdSchema = z.string({ error: "Staf tidak ditemukan." }).uuid("Staf tidak ditemukan.");
const roleIdSchema = z.string({ error: "Peran tidak ditemukan." }).uuid("Peran tidak ditemukan.");

function validationError(error: z.ZodError): ActionResult<never> {
  const issue = error.issues[0];
  const field = issue?.path[0];
  const message = issue?.message ?? "Input tidak valid.";
  return typeof field === "string" ? { ok: false, error: message, fieldErrors: { [field]: message } } : { ok: false, error: message };
}

const inviteSchema = z.object({ name: staffNameSchema, email: staffEmailSchema, roleId: roleIdSchema });

export async function inviteStaffAction(
  input: z.input<typeof inviteSchema>,
): Promise<ActionResult<{ staffUserId: string; inviteExpiresAt: string; emailSent: boolean }>> {
  const session = await requirePermission(PERMISSION);
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const result = await staffMutations.inviteStaff(parsed.data, session.staffUser.id, {
      emailSender: staffEmailSender,
      loginUrl: adminBaseUrl,
      emailLogoUrl: staffEmailLogoUrl,
    });
    revalidateAdmin("/roles-staff");
    return { ...result, inviteExpiresAt: result.inviteExpiresAt.toISOString() };
  });
}

export async function renewStaffInviteAction(
  staffUserId: string,
): Promise<ActionResult<{ inviteExpiresAt: string; emailSent: boolean }>> {
  const session = await requirePermission(PERMISSION);
  const parsed = staffUserIdSchema.safeParse(staffUserId);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const result = await staffMutations.renewStaffInvite(parsed.data, session.staffUser.id, {
      emailSender: staffEmailSender,
      loginUrl: adminBaseUrl,
      emailLogoUrl: staffEmailLogoUrl,
    });
    revalidateAdmin("/roles-staff");
    return { inviteExpiresAt: result.inviteExpiresAt.toISOString(), emailSent: result.emailSent };
  });
}

const updateProfileSchema = z.object({ staffUserId: staffUserIdSchema, name: staffNameSchema, email: staffEmailSchema });

export async function updateStaffProfileAction(input: z.input<typeof updateProfileSchema>): Promise<ActionResult<{ changed: boolean }>> {
  const session = await requirePermission(PERMISSION);
  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const { staffUserId, ...profile } = parsed.data;
    const result = await staffMutations.updateStaffProfile(staffUserId, profile, session.staffUser.id);
    revalidateAdmin("/roles-staff");
    return result;
  });
}

const changeRoleSchema = z.object({ staffUserId: staffUserIdSchema, roleId: roleIdSchema });

export async function changeStaffRoleAction(input: z.input<typeof changeRoleSchema>): Promise<ActionResult<{ changed: boolean }>> {
  const session = await requirePermission(PERMISSION);
  const parsed = changeRoleSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const result = await staffMutations.changeStaffRole(parsed.data.staffUserId, parsed.data.roleId, session.staffUser.id);
    revalidateAdmin("/roles-staff");
    return result;
  });
}

export async function deactivateStaffAction(staffUserId: string): Promise<ActionResult<{ changed: boolean; sessionsEnded: number }>> {
  const session = await requirePermission(PERMISSION);
  const parsed = staffUserIdSchema.safeParse(staffUserId);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const result = await staffMutations.deactivateStaff(parsed.data, session.staffUser.id);
    revalidateAdmin("/roles-staff");
    return result;
  });
}

export async function reactivateStaffAction(staffUserId: string): Promise<ActionResult<{ changed: boolean }>> {
  const session = await requirePermission(PERMISSION);
  const parsed = staffUserIdSchema.safeParse(staffUserId);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const result = await staffMutations.reactivateStaff(parsed.data, session.staffUser.id);
    revalidateAdmin("/roles-staff");
    return result;
  });
}

export async function revokeStaffSessionsAction(staffUserId: string): Promise<ActionResult<{ sessionsEnded: number }>> {
  const session = await requirePermission(PERMISSION);
  const parsed = staffUserIdSchema.safeParse(staffUserId);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const result = await staffMutations.revokeStaffSessions(parsed.data, session.staffUser.id);
    revalidateAdmin("/roles-staff");
    return result;
  });
}

// ---------- Roles (roles.manage; the mutations also require the actor to be super_admin) ----------

const roleNameSchema = z
  .string({ error: "Nama peran wajib diisi." })
  .trim()
  .min(1, "Nama peran wajib diisi.")
  .max(60, "Nama peran terlalu panjang.")
  .refine((name) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name), "Nama peran tidak boleh berisi karakter khusus.");

// One line of plain text; empty means "no description".
const roleDescriptionSchema = z
  .string({ error: "Deskripsi tidak valid." })
  .trim()
  .max(300, "Deskripsi terlalu panjang.")
  .refine((text) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text), "Deskripsi tidak boleh berisi karakter khusus.")
  .transform((text) => (text === "" ? null : text));

const CATALOG_KEYS = new Set<string>(PERMISSIONS.map((permission) => permission.key));
const permissionKeysSchema = z
  .array(z.string({ error: "Izin tidak valid." }), { error: "Izin tidak valid." })
  .max(CATALOG_KEYS.size, "Izin tidak valid.")
  .refine((keys) => keys.every((key) => CATALOG_KEYS.has(key)), "Ada izin yang tidak dikenal.");

const createRoleSchema = z.object({
  name: roleNameSchema,
  description: roleDescriptionSchema,
  permissionKeys: permissionKeysSchema,
  copiedFromRoleId: roleIdSchema.nullish(),
});

export async function createRoleAction(input: z.input<typeof createRoleSchema>): Promise<ActionResult<{ roleId: string }>> {
  const session = await requirePermission(ROLES_PERMISSION);
  const parsed = createRoleSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const result = await roleMutations.createRole(parsed.data, session.staffUser.id);
    revalidateAdmin("/roles-staff");
    return result;
  });
}

// The role editor's one save (details + permissions in one transaction, role-mutations.ts).
const updateRoleSchema = z.object({
  roleId: roleIdSchema,
  name: roleNameSchema,
  description: roleDescriptionSchema,
  permissionKeys: permissionKeysSchema,
  expectedPermissionKeys: permissionKeysSchema,
});

export async function updateRoleAction(input: z.input<typeof updateRoleSchema>): Promise<ActionResult<{ changed: boolean }>> {
  const session = await requirePermission(ROLES_PERMISSION);
  const parsed = updateRoleSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const { roleId, ...role } = parsed.data;
    const result = await roleMutations.updateRole(roleId, role, session.staffUser.id);
    revalidateAdmin("/roles-staff");
    return result;
  });
}
