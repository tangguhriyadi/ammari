"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Button, Dialog, Input, Label, Textarea, useToast } from "@ammari/ui";
import { SUPER_ADMIN_ONLY_PERMISSION_KEYS, permissionLabel, sortPermissionKeys } from "@/lib/staff/permission-labels";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { createRoleAction, updateRoleAction } from "../actions";
import { PermissionMatrix } from "./permission-matrix";

export interface RoleEditorValues {
  name: string;
  description: string;
  permissionKeys: readonly string[];
}

export type RoleEditorProps =
  | { mode: "create"; initialValues: RoleEditorValues; copiedFromRoleId: string | null }
  | { mode: "edit"; roleId: string; initialValues: RoleEditorValues; activeStaffCount: number };

function PermissionSummaryList({ title, keys }: { title: string; keys: string[] }) {
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium text-neutral-900">{title}</p>
      <ul className="list-disc pl-5 text-sm text-neutral-700">
        {keys.map((key) => {
          const label = permissionLabel(key);
          return (
            <li key={key}>
              {label.label}
              {label.sensitive && <span className="font-medium text-warning-700"> (Sensitif)</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Create a role, or edit one, for a super_admin (docs/plans/roles-staff.md §4.4, owner answer
 * 1). Every save goes through a confirmation that lists exactly which permissions are added and
 * removed. The server re-checks everything under the staff-access lock, including that the
 * permissions shown here are still the role's current ones. */
export function RoleEditor(props: RoleEditorProps) {
  const { initialValues } = props;
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(initialValues.name);
  const [description, setDescription] = useState(initialValues.description);
  const [granted, setGranted] = useState<Set<string>>(() => new Set(initialValues.permissionKeys));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startSaving] = useTransition();

  const initialKeys = useMemo(() => sortPermissionKeys(initialValues.permissionKeys), [initialValues.permissionKeys]);
  const nextKeys = sortPermissionKeys(granted);
  const added = nextKeys.filter((key) => !initialKeys.includes(key));
  const removed = initialKeys.filter((key) => !nextKeys.includes(key));
  const detailsChanged = name.trim() !== initialValues.name || description.trim() !== initialValues.description;
  const changed = detailsChanged || added.length > 0 || removed.length > 0;
  const dirty = props.mode === "create" || changed;
  // Only real edits ask before leaving; an untouched "Salin dari" form is prefilled, not edited.
  useUnsavedChangesGuard(changed && !saving);

  // roles.manage / audit_log.view stay with super_admin (§11a); a legacy grant can still be
  // removed, so only keys the role doesn't already hold are locked.
  const locked = useMemo(
    () =>
      new Map(
        SUPER_ADMIN_ONLY_PERMISSION_KEYS.filter((key) => !initialValues.permissionKeys.includes(key)).map((key) => [key, "Hanya untuk Super Admin."]),
      ),
    [initialValues.permissionKeys],
  );

  function toggle(key: string, checked: boolean) {
    setGranted((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function review() {
    setError(null);
    setFieldErrors({});
    if (name.trim() === "") {
      setFieldErrors({ name: "Nama peran wajib diisi." });
      return;
    }
    if (!dirty) {
      toast.success("Tidak ada perubahan");
      return;
    }
    setConfirmOpen(true);
  }

  function fail(result: { error: string; fieldErrors?: Record<string, string> }) {
    setConfirmOpen(false);
    setError(result.fieldErrors ? null : result.error);
    setFieldErrors(result.fieldErrors ?? {});
  }

  function save() {
    if (saving) return;
    startSaving(async () => {
      if (props.mode === "create") {
        const result = await createRoleAction({ name, description, permissionKeys: nextKeys, copiedFromRoleId: props.copiedFromRoleId });
        if (!result.ok) return fail(result);
        setConfirmOpen(false);
        toast.success("Peran dibuat");
        router.push(`/roles-staff/roles/${result.data.roleId}`);
        return;
      }
      // One transaction for name, description and permissions: all saved, or nothing.
      const result = await updateRoleAction({ roleId: props.roleId, name, description, permissionKeys: nextKeys, expectedPermissionKeys: initialKeys });
      if (!result.ok) return fail(result);
      setConfirmOpen(false);
      toast.success("Perubahan disimpan");
      router.refresh();
    });
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        review();
      }}
    >
      <div className="flex max-w-xl flex-col gap-4">
        <div>
          <Label htmlFor="role-name" required>
            Nama peran
          </Label>
          <Input id="role-name" value={name} onChange={(event) => setName(event.target.value)} error={fieldErrors.name} />
        </div>
        <div>
          <Label htmlFor="role-description">Deskripsi</Label>
          <Textarea id="role-description" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
          {fieldErrors.description && <p className="mt-1 text-sm text-danger-700">{fieldErrors.description}</p>}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-neutral-900">Izin</h2>
        {fieldErrors.permissionKeys && (
          <p role="alert" className="text-base text-danger-700">
            {fieldErrors.permissionKeys}
          </p>
        )}
        <PermissionMatrix granted={granted} onToggle={toggle} locked={locked} disabled={saving} />
      </div>

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-neutral-200 bg-white px-4 py-3 md:static md:mx-0 md:border-0 md:p-0">
        <Button type="submit" loading={saving}>
          {props.mode === "create" ? "Buat peran" : "Simpan perubahan"}
        </Button>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!saving) setConfirmOpen(open);
        }}
        title={props.mode === "create" ? "Buat peran ini?" : "Simpan perubahan peran?"}
        description={
          props.mode === "edit" && props.activeStaffCount > 0
            ? `Berlaku langsung untuk ${props.activeStaffCount} staf aktif dengan peran ini.`
            : undefined
        }
        confirmLabel={props.mode === "create" ? "Buat peran" : "Simpan"}
        onConfirm={save}
        loading={saving}
      >
        <div className="flex flex-col gap-3" data-testid="role-change-summary">
          {props.mode === "create" ? (
            <>
              <p className="text-sm text-neutral-700">Nama: {name.trim()}</p>
              {nextKeys.length === 0 ? (
                <p className="text-sm text-neutral-700">Belum ada izin. Peran ini belum bisa membuka halaman apa pun.</p>
              ) : (
                <PermissionSummaryList title="Izin" keys={nextKeys} />
              )}
            </>
          ) : (
            <>
              {name.trim() !== initialValues.name && (
                <p className="text-sm text-neutral-700">
                  Nama: {initialValues.name} menjadi {name.trim()}
                </p>
              )}
              {description.trim() !== initialValues.description && <p className="text-sm text-neutral-700">Deskripsi diubah.</p>}
              <PermissionSummaryList title="Izin ditambah" keys={added} />
              <PermissionSummaryList title="Izin dihapus" keys={removed} />
            </>
          )}
        </div>
      </Dialog>
    </form>
  );
}
