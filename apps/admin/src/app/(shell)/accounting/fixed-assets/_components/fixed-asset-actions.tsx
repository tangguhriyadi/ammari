"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button, Dialog, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import type { FixedAssetAccountChoice } from "@/lib/accounting/fixed-assets";
import { disposeFixedAssetAction, voidFixedAssetAction } from "../actions";

// "Lepas aset" (sold or scrapped) and "Batalkan" (a wrongly registered asset, written reason) for one
// asset (D-19, Session 11). The server re-checks permission (accounting.manage) and every rule.

export function DisposeFixedAssetButton({ id, name, cashAccounts }: { id: string; name: string; cashAccounts: FixedAssetAccountChoice[] }) {
  const router = useRouter();
  const toast = useToast();
  const idPrefix = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState({ disposedOn: "", proceeds: "0", cashAccountCode: "" });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const set = (key: keyof typeof values) => (event: { target: { value: string } }) => setValues((previous) => ({ ...previous, [key]: event.target.value }));

  function confirm() {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await disposeFixedAssetAction(id, values);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setOpen(false);
      toast.success(`${name} dilepas`);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setValues({ disposedOn: "", proceeds: "0", cashAccountCode: "" });
          setError(null);
          setFieldErrors({});
          setOpen(true);
        }}
      >
        Lepas aset
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
        title={`Lepas ${name}?`}
        description="Untuk aset yang dijual atau dibuang. Penyusutan berhenti sebelum bulan pelepasan; selisih nilai buku dan hasil penjualan dicatat sebagai laba atau rugi pelepasan."
        confirmLabel="Lepas aset"
        onConfirm={confirm}
        loading={pending}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-date`} required>
              Tanggal pelepasan
            </Label>
            <Input id={`${idPrefix}-date`} type="date" value={values.disposedOn} onChange={set("disposedOn")} error={fieldErrors.disposedOn} disabled={pending} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-proceeds`}>Hasil penjualan (Rp)</Label>
            <Input id={`${idPrefix}-proceeds`} value={values.proceeds} onChange={set("proceeds")} inputMode="numeric" error={fieldErrors.proceeds} disabled={pending} />
            <p className="text-sm text-neutral-600">Isi 0 bila dibuang tanpa hasil.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-cash`}>Uang masuk ke</Label>
            <Select id={`${idPrefix}-cash`} value={values.cashAccountCode} onChange={set("cashAccountCode")} error={fieldErrors.cashAccountCode} disabled={pending}>
              <option value="">Pilih akun (bila ada hasil penjualan)</option>
              {cashAccounts.map((account) => (
                <option key={account.code} value={account.code}>
                  {account.code} {account.name}
                </option>
              ))}
            </Select>
          </div>
          {error && !Object.keys(fieldErrors).length && (
            <p role="alert" className="text-sm text-danger-700">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}

export function VoidFixedAssetButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const toast = useToast();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await voidFixedAssetAction(id, { reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success(`${name} dibatalkan`);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setReason("");
          setError(null);
          setOpen(true);
        }}
      >
        Batalkan aset
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
        title={`Batalkan ${name}?`}
        description="Untuk aset yang salah dicatat. Semua jurnal aset ini dibalik pada posting berikutnya, dan aset tidak bisa diubah lagi. Alasan tercatat di Log Aktivitas."
        confirmLabel="Batalkan aset"
        onConfirm={confirm}
        loading={pending}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId} required>
            Alasan
          </Label>
          <Textarea id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} disabled={pending} error={error ?? undefined} />
        </div>
      </Dialog>
    </>
  );
}
