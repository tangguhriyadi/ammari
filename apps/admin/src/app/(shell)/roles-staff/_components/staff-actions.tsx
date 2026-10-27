"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { Button, Card, Dialog, Input, Label, Select, useToast } from "@ammari/ui";
import type { StaffCapabilities } from "@/lib/staff/capabilities";
import type { AssignableRole } from "@/lib/staff/queries";
import type { StaffStatus } from "@/lib/staff/status";
import {
  changeStaffRoleAction,
  deactivateStaffAction,
  reactivateStaffAction,
  renewStaffInviteAction,
  revokeStaffSessionsAction,
  updateStaffProfileAction,
} from "../actions";
import { InviteNotice, type InviteNoticeData } from "./invite-notice";

export interface StaffActionsTarget {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  isActive: boolean;
  status: StaffStatus;
  activeSessionCount: number;
}

type Confirm = { kind: "role"; roleId: string; roleName: string } | { kind: "deactivate" } | { kind: "reactivate" } | { kind: "revoke" };

function Reason({ id, children }: { id?: string; children: string }) {
  return (
    <p id={id} className="text-sm text-neutral-600">
      {children}
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `staff-section-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section aria-labelledby={id}>
      <Card className="flex flex-col gap-3">
        <h2 id={id} className="text-lg font-semibold text-neutral-900">
          {title}
        </h2>
        {children}
      </Card>
    </section>
  );
}

/** The actions on one staff member (docs/plans/roles-staff.md §4.3, §5). `capabilities` comes
 * from the server and mirrors the mutations' guard rails: null means allowed, a string is the
 * Indonesian reason it isn't. When nothing at all may be changed (own account, a super_admin seen
 * by a non-super_admin, a role wider than the viewer's) only that one reason is shown. */
export function StaffActions({
  staff,
  capabilities,
  roles,
  adminUrl,
}: {
  staff: StaffActionsTarget;
  capabilities: StaffCapabilities;
  roles: AssignableRole[];
  adminUrl: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(staff.name);
  const [email, setEmail] = useState(staff.email);
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [roleId, setRoleId] = useState(staff.roleId);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<InviteNoticeData | null>(null);
  // After correcting a pending invite's address, offer to send the invitation to the new one
  // (§11a): the old email went to the wrong place.
  const [emailCorrected, setEmailCorrected] = useState(false);
  const [savingProfile, startProfile] = useTransition();
  const [confirming, startConfirm] = useTransition();
  const [renewing, startRenew] = useTransition();

  if (capabilities.manage) {
    return (
      <Card>
        <p className="text-base text-neutral-700" data-testid="staff-manage-refused">
          {capabilities.manage}
        </p>
      </Card>
    );
  }

  const isPending = staff.status === "invited" || staff.status === "invite_expired";
  const roleChoices = roles.some((role) => role.id === staff.roleId) ? roles : [{ id: staff.roleId, name: staff.roleName, description: null, canViewProfit: false }, ...roles];

  function saveProfile() {
    if (savingProfile) return;
    setError(null);
    setProfileErrors({});
    startProfile(async () => {
      const emailChanged = email.trim().toLowerCase() !== staff.email.toLowerCase();
      const result = await updateStaffProfileAction({ staffUserId: staff.id, name, email });
      if (!result.ok) {
        setProfileErrors(result.fieldErrors ?? {});
        if (!result.fieldErrors) showError(result.error);
        return;
      }
      toast.success(result.data.changed ? "Perubahan disimpan" : "Tidak ada perubahan");
      if (result.data.changed && emailChanged && isPending) setEmailCorrected(true);
      router.refresh();
    });
  }

  function renew() {
    if (renewing) return;
    setError(null);
    startRenew(async () => {
      const result = await renewStaffInviteAction(staff.id);
      if (!result.ok) {
        showError(result.error);
        return;
      }
      setEmailCorrected(false);
      setNotice({ name: name.trim(), email: email.trim().toLowerCase(), ...result.data });
      router.refresh();
    });
  }

  function runConfirm() {
    if (!confirm || confirming) return;
    setError(null);
    startConfirm(async () => {
      let message: string;
      if (confirm.kind === "role") {
        const result = await changeStaffRoleAction({ staffUserId: staff.id, roleId: confirm.roleId });
        if (!result.ok) return fail(result.error);
        message = "Peran diganti";
      } else if (confirm.kind === "deactivate") {
        const result = await deactivateStaffAction(staff.id);
        if (!result.ok) return fail(result.error);
        message = "Akun dinonaktifkan";
      } else if (confirm.kind === "reactivate") {
        const result = await reactivateStaffAction(staff.id);
        if (!result.ok) return fail(result.error);
        message = "Akun diaktifkan kembali";
      } else {
        const result = await revokeStaffSessionsAction(staff.id);
        if (!result.ok) return fail(result.error);
        message = `${result.data.sessionsEnded} sesi diakhiri`;
      }
      setConfirm(null);
      toast.success(message);
      router.refresh();
    });
  }

  /** Inline at the top for reading later, and as a toast: on a phone the action buttons sit far
   * below that inline message. */
  function showError(message: string) {
    setError(message);
    toast.error(message);
  }

  function fail(message: string) {
    setConfirm(null);
    showError(message);
    if (confirm?.kind === "role") setRoleId(staff.roleId);
  }

  const dialog = (() => {
    if (!confirm) return null;
    switch (confirm.kind) {
      case "role":
        return {
          title: "Ganti peran?",
          description: `${staff.name} akan menjadi ${confirm.roleName}. Perubahan berlaku langsung.`,
          confirmLabel: "Ganti peran",
          variant: "primary" as const,
        };
      case "deactivate":
        return {
          title: "Nonaktifkan akun?",
          description: "Staf ini langsung keluar dari semua perangkat dan tidak bisa masuk lagi.",
          confirmLabel: "Nonaktifkan",
          variant: "danger" as const,
        };
      case "reactivate":
        return {
          title: "Aktifkan kembali?",
          description: `${staff.name} bisa masuk lagi dengan peran ${staff.roleName}.`,
          confirmLabel: "Aktifkan kembali",
          variant: "primary" as const,
        };
      case "revoke":
        return {
          title: "Akhiri semua sesi?",
          description: "Staf ini keluar dari semua perangkat, tapi akunnya tetap aktif dan bisa masuk lagi.",
          confirmLabel: "Akhiri semua sesi",
          variant: "danger" as const,
        };
    }
  })();

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}
      {notice && <InviteNotice key={notice.inviteExpiresAt} notice={notice} adminUrl={adminUrl} onResend={renew} resending={renewing} />}

      <Section title="Data staf">
        <form
          className="flex max-w-xl flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveProfile();
          }}
        >
          <div>
            <Label htmlFor="staff-name" required>
              Nama
            </Label>
            <Input id="staff-name" value={name} onChange={(event) => setName(event.target.value)} error={profileErrors.name} />
          </div>
          <div>
            <Label htmlFor="staff-email" required>
              Email
            </Label>
            <Input
              id="staff-email"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={capabilities.editEmail !== null}
              aria-describedby={capabilities.editEmail ? "staff-email-locked" : undefined}
              error={profileErrors.email}
            />
            {capabilities.editEmail && (
              <p id="staff-email-locked" className="mt-1 text-sm text-neutral-600">
                {capabilities.editEmail}
              </p>
            )}
          </div>
          <div>
            <Button type="submit" variant="secondary" loading={savingProfile}>
              Simpan
            </Button>
          </div>
        </form>
        {emailCorrected && capabilities.renewInvite === null && (
          <div className="flex flex-col gap-2 rounded-md bg-neutral-50 p-3">
            <p className="text-base text-neutral-900">Email diubah. Kirim undangan ke alamat yang baru?</p>
            <div>
              <Button onClick={renew} loading={renewing}>
                Kirim ulang undangan
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Peran">
        <div className="flex max-w-xl flex-col gap-2">
          <Label htmlFor="staff-role">Peran saat ini</Label>
          <Select
            id="staff-role"
            value={roleId}
            disabled={capabilities.changeRole !== null}
            aria-describedby={capabilities.changeRole ? "staff-role-locked" : undefined}
            onChange={(event) => {
              const next = roleChoices.find((role) => role.id === event.target.value);
              setRoleId(event.target.value);
              if (next && next.id !== staff.roleId) setConfirm({ kind: "role", roleId: next.id, roleName: next.name });
            }}
          >
            {roleChoices.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
          {capabilities.changeRole && (
            <p id="staff-role-locked" className="text-sm text-neutral-600">
              {capabilities.changeRole}
            </p>
          )}
        </div>
      </Section>

      {isPending && (
        <Section title="Undangan">
          {capabilities.renewInvite ? (
            <Reason>{capabilities.renewInvite}</Reason>
          ) : (
            <>
              <p className="text-base text-neutral-700">
                {staff.status === "invite_expired"
                  ? "Undangan sudah kedaluwarsa. Kirim ulang supaya berlaku 7 hari lagi."
                  : "Kirim ulang email undangan. Masa berlaku diperpanjang 7 hari dari sekarang."}
              </p>
              <div>
                <Button variant="secondary" onClick={renew} loading={renewing}>
                  Kirim ulang undangan
                </Button>
              </div>
            </>
          )}
        </Section>
      )}

      <Section title="Akses">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <div>
              <Button
                variant="secondary"
                onClick={() => setConfirm({ kind: "revoke" })}
                disabled={capabilities.revokeSessions !== null || staff.activeSessionCount === 0}
                aria-describedby="staff-revoke-reason"
              >
                Akhiri semua sesi
              </Button>
            </div>
            <Reason id="staff-revoke-reason">
              {capabilities.revokeSessions ??
                (staff.activeSessionCount === 0 ? "Tidak ada sesi aktif." : "Untuk HP yang hilang: keluar dari semua perangkat, akun tetap aktif.")}
            </Reason>
          </div>
          {staff.isActive ? (
            <div className="flex flex-col gap-1">
              <div>
                <Button
                  variant="danger"
                  onClick={() => setConfirm({ kind: "deactivate" })}
                  disabled={capabilities.deactivate !== null}
                  aria-describedby={capabilities.deactivate ? "staff-deactivate-reason" : undefined}
                >
                  Nonaktifkan
                </Button>
              </div>
              {capabilities.deactivate && <Reason id="staff-deactivate-reason">{capabilities.deactivate}</Reason>}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div>
                <Button
                  onClick={() => setConfirm({ kind: "reactivate" })}
                  disabled={capabilities.reactivate !== null}
                  aria-describedby={capabilities.reactivate ? "staff-reactivate-reason" : undefined}
                >
                  Aktifkan kembali
                </Button>
              </div>
              {capabilities.reactivate && <Reason id="staff-reactivate-reason">{capabilities.reactivate}</Reason>}
            </div>
          )}
        </div>
      </Section>

      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (open || confirming) return;
          if (confirm?.kind === "role") setRoleId(staff.roleId);
          setConfirm(null);
        }}
        title={dialog?.title ?? ""}
        description={dialog?.description}
        confirmLabel={dialog?.confirmLabel}
        confirmVariant={dialog?.variant}
        onConfirm={runConfirm}
        loading={confirming}
      />
    </div>
  );
}
