"use server";

import { z } from "zod";
import { requirePermission } from "@/lib/auth/require-permission";
import { adminBaseUrl, staffEmailSender } from "@/lib/auth/staff";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { staffEmailSchema } from "@/lib/staff/email";
import * as staffMutations from "@/lib/staff/mutations";

// The staff write path's thin action layer (docs/plans/roles-staff.md §5): requirePermission,
// zod, runAction. Every rule (self, subset, last super_admin/owner, rate limits, audit, session
// revocation) lives in lib/staff/mutations.ts, under the staff-access lock, never here.

const PERMISSION = "staff.manage";

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
