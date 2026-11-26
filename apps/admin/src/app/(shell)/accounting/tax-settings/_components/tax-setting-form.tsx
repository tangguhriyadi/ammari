"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { TAXPAYER_TYPES } from "@ammari/db/schema";
import { Button, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { TAXPAYER_TYPE_LABELS } from "@/lib/accounting/labels";
import { createTaxSettingAction, updateTaxSettingAction } from "../actions";

// One PPh final setting (D-20). The server validates (lib/accounting/tax-settings-input.ts): the
// rate as a percentage with at most two decimals, stored in basis points; the exemption in whole
// rupiah, 0 or more; the end date optional, never before the start month.

export interface TaxSettingFormValues {
  taxpayerType: string;
  taxpayerLabel: string;
  npwpRegisteredYear: string;
  ratePercent: string;
  annualExemptionAmount: string;
  rateValidUntil: string;
  note: string;
}

export type TaxSettingFormProps =
  | { mode: "create"; initialValues: TaxSettingFormValues }
  | { mode: "edit"; effectiveFrom: string; monthLabel: string; initialValues: TaxSettingFormValues };

export function TaxSettingForm(props: TaxSettingFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState(props.initialValues);
  const [effectiveMonth, setEffectiveMonth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();
  const [done, setDone] = useState(false);

  const set = (key: keyof TaxSettingFormValues) => (event: { target: { value: string } }) => setValues((previous) => ({ ...previous, [key]: event.target.value }));

  function handleSubmit() {
    if (saving || done) return;
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result =
        props.mode === "create"
          ? await createTaxSettingAction({ ...values, effectiveFrom: effectiveMonth })
          : await updateTaxSettingAction(props.effectiveFrom, values);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setDone(true);
      toast.success(props.mode === "create" ? "Pengaturan pajak ditambahkan" : "Pengaturan pajak disimpan");
      router.push("/accounting/tax-settings");
    });
  }

  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      aria-label="Pengaturan pajak"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      {props.mode === "create" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tax-effective-from" required>
            Berlaku mulai bulan
          </Label>
          <Input
            id="tax-effective-from"
            type="month"
            value={effectiveMonth}
            onChange={(event) => setEffectiveMonth(event.target.value)}
            error={fieldErrors.effectiveFrom}
            required
            disabled={saving}
          />
          <p className="text-sm text-neutral-600">Format TTTT-BB, mis. 2027-01. Tidak bisa diubah setelah disimpan.</p>
        </div>
      ) : (
        <p className="text-base text-neutral-900">
          Berlaku mulai <strong>{props.monthLabel}</strong>
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tax-taxpayer-type" required>
          Jenis wajib pajak
        </Label>
        <Select id="tax-taxpayer-type" value={values.taxpayerType} onChange={set("taxpayerType")} error={fieldErrors.taxpayerType} disabled={saving}>
          {TAXPAYER_TYPES.map((option) => (
            <option key={option} value={option}>
              {TAXPAYER_TYPE_LABELS[option]}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tax-taxpayer-label" required>
          Keterangan wajib pajak
        </Label>
        <Input id="tax-taxpayer-label" value={values.taxpayerLabel} onChange={set("taxpayerLabel")} maxLength={120} error={fieldErrors.taxpayerLabel} required disabled={saving} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tax-npwp-year">Tahun NPWP terdaftar</Label>
        <Input id="tax-npwp-year" value={values.npwpRegisteredYear} onChange={set("npwpRegisteredYear")} inputMode="numeric" maxLength={4} error={fieldErrors.npwpRegisteredYear} disabled={saving} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tax-rate" required>
          Tarif (%)
        </Label>
        <Input id="tax-rate" value={values.ratePercent} onChange={set("ratePercent")} inputMode="decimal" placeholder="mis. 0,5" error={fieldErrors.ratePercent} required disabled={saving} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tax-exemption" required>
          Omzet bebas pajak per tahun (Rp)
        </Label>
        <Input
          id="tax-exemption"
          value={values.annualExemptionAmount}
          onChange={set("annualExemptionAmount")}
          inputMode="numeric"
          placeholder="mis. 500.000.000"
          error={fieldErrors.annualExemptionAmount}
          required
          disabled={saving}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tax-valid-until">Tarif berlaku sampai</Label>
        <Input id="tax-valid-until" type="date" value={values.rateValidUntil} onChange={set("rateValidUntil")} error={fieldErrors.rateValidUntil} disabled={saving} />
        <p className="text-sm text-neutral-600">Kosongkan bila tanpa batas. Setelah tanggal ini PPh final bulanan tidak diusulkan dan tutup buku menampilkan peringatan.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tax-note">Catatan</Label>
        <Textarea id="tax-note" value={values.note} onChange={set("note")} maxLength={500} error={fieldErrors.note} disabled={saving} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving}>
          Simpan
        </Button>
        <Link href="/accounting/tax-settings" className="text-base font-medium text-brand hover:underline">
          Kembali ke daftar
        </Link>
      </div>
    </form>
  );
}
