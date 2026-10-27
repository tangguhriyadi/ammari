"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Dialog, Input, Label, Select, useToast } from "@ammari/ui";
import type { AssignableRole } from "@/lib/staff/queries";
import { inviteStaffAction, renewStaffInviteAction } from "../actions";
import { InviteNotice, type InviteNoticeData } from "./invite-notice";

/** "Undang staf" (docs/plans/roles-staff.md §4.2). The role list comes from the server already
 * narrowed to what this viewer may assign; the action re-checks it anyway. */
export function InviteStaff({ roles, adminUrl }: { roles: AssignableRole[]; adminUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<(InviteNoticeData & { staffUserId: string }) | null>(null);
  const [saving, startSaving] = useTransition();
  const [resending, startResending] = useTransition();
  const selectedRole = roles.find((role) => role.id === roleId);

  function openForm() {
    setName("");
    setEmail("");
    setRoleId("");
    setError(null);
    setFieldErrors({});
    setOpen(true);
  }

  function submit() {
    if (saving) return;
    setError(null);
    setFieldErrors({});
    if (!roleId) {
      setFieldErrors({ roleId: "Pilih peran." });
      return;
    }
    startSaving(async () => {
      const result = await inviteStaffAction({ name, email, roleId });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setOpen(false);
      setNotice({ ...result.data, name: name.trim(), email: email.trim().toLowerCase() });
      router.refresh();
    });
  }

  function resend() {
    if (!notice || resending) return;
    startResending(async () => {
      const result = await renewStaffInviteAction(notice.staffUserId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setNotice({ ...notice, ...result.data });
      if (result.data.emailSent) toast.success("Undangan dikirim ulang");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button onClick={openForm} disabled={roles.length === 0}>
          Undang staf
        </Button>
      </div>
      {notice && <InviteNotice key={`${notice.staffUserId}:${notice.inviteExpiresAt}`} notice={notice} adminUrl={adminUrl} onResend={resend} resending={resending} />}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!saving) setOpen(next);
        }}
        title="Undang staf"
        description="Staf masuk dengan Google atau kode lewat email, memakai alamat email ini persis."
        confirmLabel="Kirim undangan"
        onConfirm={submit}
        loading={saving}
      >
        {/* No <form>: the submit button is the Dialog's own "Kirim undangan", outside this block. */}
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="invite-name" required>
              Nama
            </Label>
            <Input id="invite-name" value={name} onChange={(event) => setName(event.target.value)} error={fieldErrors.name} autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="invite-email" required>
              Email
            </Label>
            <Input
              id="invite-email"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={fieldErrors.email}
            />
          </div>
          <div>
            <Label htmlFor="invite-role" required>
              Peran
            </Label>
            <Select
              id="invite-role"
              aria-describedby={selectedRole ? "invite-role-summary" : undefined}
              value={roleId} onChange={(event) => setRoleId(event.target.value)} error={fieldErrors.roleId}>
              <option value="">Pilih peran</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
            {selectedRole && (
              <div id="invite-role-summary" className="mt-2 flex flex-col gap-1 text-sm text-neutral-600">
                {selectedRole.description && <p>{selectedRole.description}</p>}
                {selectedRole.canViewProfit && (
                  <Badge variant="warning" className="self-start">
                    Bisa lihat laba
                  </Badge>
                )}
              </div>
            )}
          </div>
          {error && !Object.values(fieldErrors).includes(error) && (
            <p role="alert" className="text-base text-danger-700">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}
