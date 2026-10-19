"use client";

import { Select } from "@ammari/ui";
import type { SupplierOption } from "@/lib/suppliers/queries";

export interface CurrentSupplier {
  id: string;
  name: string;
  isActive: boolean;
}

/** The supplier picker shared by the cost-component form and the batch form's cost lines (plan
 * D9). `options` is ACTIVE suppliers only (listActiveSupplierOptions), so an inactive supplier
 * is never offered as a new choice. `current` is the record's own saved supplier: when it is no
 * longer in `options` (deactivated since), it is still rendered as the selected value, marked
 * "(nonaktif)", so the record keeps displaying and re-saving it unchanged — the server accepts
 * an unchanged supplier, and refuses only a NEW choice of an inactive one. `value` is "" for
 * "no supplier". */
export function SupplierSelect({
  id,
  value,
  onChange,
  options,
  current,
  "aria-label": ariaLabel,
}: {
  id: string;
  value: string;
  onChange: (supplierId: string) => void;
  options: readonly SupplierOption[];
  current?: CurrentSupplier | null;
  "aria-label"?: string;
}) {
  const currentIsMissing = current && !options.some((option) => option.id === current.id);

  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel}>
      <option value="">Tanpa supplier</option>
      {currentIsMissing && (
        <option value={current.id}>
          {current.isActive ? current.name : `${current.name} (nonaktif)`}
        </option>
      )}
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </Select>
  );
}
