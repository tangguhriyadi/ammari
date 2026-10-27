"use client";

import { Check, Minus } from "lucide-react";
import { Badge, Checkbox } from "@ammari/ui";
import { permissionAreaGroups, permissionLabel } from "@/lib/staff/permission-labels";

const GROUPS = permissionAreaGroups();

export interface PermissionMatrixProps {
  granted: ReadonlySet<string>;
  /** Omitted = read-only. */
  onToggle?: (key: string, checked: boolean) => void;
  /** Keys shown but never tickable, with the reason (e.g. super_admin-only keys). */
  locked?: ReadonlyMap<string, string>;
  disabled?: boolean;
}

function SensitiveNote({ permissionKey, id }: { permissionKey: string; id?: string }) {
  const label = permissionLabel(permissionKey);
  if (!label.sensitive) return null;
  return (
    <span id={id} className="flex flex-wrap items-center gap-2">
      <Badge variant="warning">Sensitif</Badge>
      {label.warning && <span className="text-sm text-neutral-600">{label.warning}</span>}
    </span>
  );
}

/** Every permission, grouped by area with Indonesian labels (docs/plans/roles-staff.md §4.4).
 * Read-only shows Diizinkan/Tidak per row; editable shows a checkbox per row. One column, so it
 * reads the same on a phone and a desktop. */
export function PermissionMatrix({ granted, onToggle, locked, disabled }: PermissionMatrixProps) {
  return (
    <div className="flex flex-col gap-4" data-testid="permission-matrix">
      {GROUPS.map((group) => {
        const headingId = `permission-area-${group.area.toLowerCase().replace(/[^a-z]+/g, "-")}`;
        return (
          <section key={group.area} aria-labelledby={headingId} className="rounded-lg border border-neutral-200">
            <h3 id={headingId} className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-base font-semibold text-neutral-900">
              {group.area}
            </h3>
            <ul className="divide-y divide-neutral-100">
              {group.keys.map((key) => {
                const label = permissionLabel(key);
                const isGranted = granted.has(key);
                const lockReason = locked?.get(key);
                const noteId = `permission-${key.replace(/[^a-z_]/g, "-")}`;
                return (
                  <li key={key} className="flex flex-col gap-1 px-4 py-2" data-testid="permission-row" data-permission={key}>
                    {onToggle ? (
                      <>
                        <Checkbox
                          label={label.label}
                          checked={isGranted}
                          disabled={disabled || Boolean(lockReason)}
                          onChange={(event) => onToggle(key, event.target.checked)}
                          aria-describedby={
                            [label.sensitive ? `${noteId}-sensitive` : null, lockReason ? `${noteId}-locked` : null].filter(Boolean).join(" ") ||
                            undefined
                          }
                        />
                        <SensitiveNote permissionKey={key} id={`${noteId}-sensitive`} />
                        {lockReason && (
                          <span id={`${noteId}-locked`} className="text-sm text-neutral-600">
                            {lockReason}
                          </span>
                        )}
                      </>
                    ) : (
                      <div className="flex min-h-11 items-start justify-between gap-3 py-1">
                        <div className="flex flex-col gap-1">
                          <span className={isGranted ? "text-base text-neutral-900" : "text-base text-neutral-500"}>{label.label}</span>
                          <SensitiveNote permissionKey={key} />
                        </div>
                        {isGranted ? (
                          <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-success-700">
                            <Check aria-hidden="true" className="size-4" />
                            Diizinkan
                          </span>
                        ) : (
                          <span className="flex shrink-0 items-center gap-1 text-sm text-neutral-500">
                            <Minus aria-hidden="true" className="size-4" />
                            Tidak
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
