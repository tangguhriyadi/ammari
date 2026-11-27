"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { DEFAULT_ACCUMULATED_DEPRECIATION_ACCOUNT } from "@ammari/db/accounting";
import { Button, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { FixedAssetFormChoices } from "@/lib/accounting/fixed-assets";
import { createFixedAssetAction, updateFixedAssetAction } from "../actions";

// "Catat aset tetap" / "Ubah" (D-19, Session 11). The server validates (lib/accounting/fixed-asset-
// input.ts): the cost at or above the capitalisation threshold, the accounts active and of the right
// kind. The journals follow on the next posting run.

export interface FixedAssetFormValues {
  name: string;
  groupCode: string;
  acquisitionDate: string;
  cost: string;
  assetAccountCode: string;
  accumulatedAccountCode: string;
  fundingAccountCode: string;
  note: string;
}

export type FixedAssetFormProps = { choices: FixedAssetFormChoices; initialValues: FixedAssetFormValues } & ({ mode: "create" } | { mode: "edit"; id: string });

export function FixedAssetForm(props: FixedAssetFormProps) {
  const router = useRouter();
  const toast = useToast();
  const { choices } = props;
  const [values, setValues] = useState(props.initialValues);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  const set = (key: keyof FixedAssetFormValues) => (event: { target: { value: string } }) => setValues((previous) => ({ ...previous, [key]: event.target.value }));
  const group = choices.groups.find((entry) => entry.code === values.groupCode);

  function changeAssetAccount(event: { target: { value: string } }) {
    const code = event.target.value;
    const accumulated = DEFAULT_ACCUMULATED_DEPRECIATION_ACCOUNT[code];
    setValues((previous) => ({
      ...previous,
      assetAccountCode: code,
      accumulatedAccountCode: accumulated && choices.accumulatedAccounts.some((account) => account.code === accumulated) ? accumulated : previous.accumulatedAccountCode,
    }));
  }

  function handleSubmit() {
    if (saving || done) return;
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = props.mode === "create" ? await createFixedAssetAction(values) : await updateFixedAssetAction(props.id, values);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setDone(true);
      toast.success(props.mode === "create" ? "Aset tetap dicatat" : "Aset tetap disimpan");
      router.push(props.mode === "create" && result.data && "id" in result.data ? `/accounting/fixed-assets/${result.data.id}` : "/accounting/fixed-assets");
      router.refresh();
    });
  }

  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      aria-label="Aset tetap"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fa-name" required>
          Nama aset
        </Label>
        <Input id="fa-name" value={values.name} onChange={set("name")} maxLength={120} error={fieldErrors.name} required disabled={saving} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fa-group" required>
          Kelompok pajak
        </Label>
        <Select id="fa-group" value={values.groupCode} onChange={set("groupCode")} error={fieldErrors.groupCode} disabled={saving}>
          {choices.groups.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.label} ({entry.usefulLifeMonths} bulan)
            </option>
          ))}
        </Select>
        {group && <p className="text-sm text-neutral-600">Disusutkan garis lurus selama {group.usefulLifeMonths} bulan mulai bulan perolehan, tanpa nilai sisa.</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fa-date" required>
          Tanggal perolehan
        </Label>
        <Input id="fa-date" type="date" value={values.acquisitionDate} onChange={set("acquisitionDate")} error={fieldErrors.acquisitionDate} required disabled={saving} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fa-cost" required>
          Harga perolehan (Rp)
        </Label>
        <Input id="fa-cost" value={values.cost} onChange={set("cost")} inputMode="numeric" placeholder="mis. 12.000.000" error={fieldErrors.cost} required disabled={saving} />
        <p className="text-sm text-neutral-600">Minimal {formatRupiah(choices.capitalizationThreshold)}. Di bawahnya dicatat sebagai biaya biasa.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fa-asset-account" required>
          Akun aset
        </Label>
        <Select id="fa-asset-account" value={values.assetAccountCode} onChange={changeAssetAccount} error={fieldErrors.assetAccountCode} disabled={saving}>
          <option value="">Pilih akun</option>
          {choices.assetAccounts.map((account) => (
            <option key={account.code} value={account.code}>
              {account.code} {account.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fa-accumulated-account" required>
          Akun akumulasi penyusutan
        </Label>
        <Select id="fa-accumulated-account" value={values.accumulatedAccountCode} onChange={set("accumulatedAccountCode")} error={fieldErrors.accumulatedAccountCode} disabled={saving}>
          <option value="">Pilih akun</option>
          {choices.accumulatedAccounts.map((account) => (
            <option key={account.code} value={account.code}>
              {account.code} {account.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fa-funding-account">
          Dibayar dari
        </Label>
        <Select id="fa-funding-account" value={values.fundingAccountCode} onChange={set("fundingAccountCode")} error={fieldErrors.fundingAccountCode} disabled={saving}>
          <option value="">Sudah tercatat (saldo awal atau jurnal lain)</option>
          {choices.fundingAccounts.map((account) => (
            <option key={account.code} value={account.code}>
              {account.code} {account.name}
            </option>
          ))}
        </Select>
        <p className="text-sm text-neutral-600">
          Pilih rekening Kas & Bank, atau akun utang bila dibeli secara kredit. Pilih &quot;Sudah tercatat&quot; bila pembeliannya sudah ada di saldo awal atau jurnal lain, supaya tidak tercatat dua kali.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fa-note">Catatan</Label>
        <Textarea id="fa-note" value={values.note} onChange={set("note")} maxLength={500} error={fieldErrors.note} disabled={saving} />
      </div>
      {props.mode === "edit" && (
        <p className="text-sm text-neutral-600">Jurnal perolehan dan penyusutan dihitung ulang pada posting berikutnya. Koreksi untuk bulan yang sudah ditutup masuk ke bulan pertama yang masih terbuka.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving}>
          Simpan
        </Button>
        <Link href="/accounting/fixed-assets" className="text-base font-medium text-brand hover:underline">
          Kembali ke daftar
        </Link>
      </div>
    </form>
  );
}
