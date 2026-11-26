"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Badge, Button, Select, useToast } from "@ammari/ui";
import { clearItemMappingAction, setAccountMappingAction } from "../actions";

// One mapping: its label, the account it points at, and (for accounting.manage) a select + Simpan.
// One responsive layout (stacked on phones, a row from sm up), so each form exists once in the DOM.
// An item row may be set back to "Ikuti kategori" (its override removed); a category, method or
// channel always keeps an account (D-25).

export interface MappingOption {
  code: string;
  name: string;
}

export function MappingRow({
  mappingKey,
  label,
  sublabel,
  accountCode,
  options,
  canManage,
  itemId,
  indent = false,
}: {
  mappingKey: string;
  label: string;
  sublabel?: string;
  accountCode: string | null;
  options: MappingOption[];
  canManage: boolean;
  /** Set for an expense item: the empty choice clears its override. */
  itemId?: string;
  indent?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const selectId = useId();
  const [value, setValue] = useState(accountCode ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();
  const current = options.find((option) => option.code === accountCode);
  const isItem = itemId !== undefined;

  function save() {
    setError(null);
    startTransition(async () => {
      const result =
        isItem && value === "" ? await clearItemMappingAction(itemId) : await setAccountMappingAction({ mappingKey, accountCode: value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`Pemetaan ${label} disimpan`);
      router.refresh();
    });
  }

  const accountText = accountCode ? `${accountCode} ${current?.name ?? ""}`.trim() : isItem ? "Ikuti kategori" : null;

  return (
    <li
      data-testid="mapping-row"
      data-mapping-key={mappingKey}
      className={`flex flex-col gap-2 border-b border-neutral-200 py-3 sm:flex-row sm:items-center sm:justify-between ${indent ? "pl-4 sm:pl-8" : ""}`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-base font-medium text-neutral-900">
          {canManage ? <label htmlFor={selectId}>{label}</label> : label}
        </span>
        {sublabel && <span className="text-sm text-neutral-600">{sublabel}</span>}
        {!canManage &&
          (accountText ? <span className="text-sm text-neutral-700">{accountText}</span> : <Badge variant="warning">Belum dipetakan</Badge>)}
        {canManage && accountCode === null && !isItem && (
          <span>
            <Badge variant="warning">Belum dipetakan</Badge>
          </span>
        )}
      </div>
      {canManage && (
        <form
          className="flex flex-col gap-2 sm:w-[28rem] sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="flex-1">
            <Select id={selectId} value={value} onChange={(event) => setValue(event.target.value)} disabled={saving} error={error ?? undefined}>
              {isItem ? <option value="">Ikuti kategori</option> : accountCode === null && <option value="">Pilih akun</option>}
              {options.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.code} {option.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" variant="secondary" loading={saving} disabled={value === (accountCode ?? "") || (!isItem && value === "")}>
            Simpan
          </Button>
        </form>
      )}
    </li>
  );
}
