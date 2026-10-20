"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Checkbox, Input, Label, Switch, Textarea, useToast } from "@ammari/ui";
import { SUPPLIER_KIND_OPTIONS, SUPPLIER_KINDS, type SupplierKind } from "@/lib/suppliers/kinds";
import { createSupplierAction, updateSupplierAction } from "../actions";

export interface SupplierFormValues {
  name: string;
  kinds: SupplierKind[];
  phone: string;
  address: string;
  bankName: string;
  bankAccountNo: string;
  bankAccountName: string;
  notes: string;
  isActive: boolean;
}

// A discriminated union, not an optional `supplierId?` — same reasoning AccessoryFormProps/
// CostComponentFormProps already use: "edit" always has a real id to submit to, enforced by the
// compiler instead of a non-null assertion.
export type SupplierFormProps =
  | { mode: "create"; initialValues: SupplierFormValues }
  | { mode: "edit"; supplierId: string; initialValues: SupplierFormValues };

export function SupplierForm(props: SupplierFormProps) {
  const { initialValues } = props;
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(initialValues.name);
  const [kinds, setKinds] = useState<SupplierKind[]>(initialValues.kinds);
  const [phone, setPhone] = useState(initialValues.phone);
  const [address, setAddress] = useState(initialValues.address);
  const [bankName, setBankName] = useState(initialValues.bankName);
  const [bankAccountNo, setBankAccountNo] = useState(initialValues.bankAccountNo);
  const [bankAccountName, setBankAccountName] = useState(initialValues.bankAccountName);
  const [notes, setNotes] = useState(initialValues.notes);
  const [isActive, setIsActive] = useState(initialValues.isActive);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();

  // Rebuilt in SUPPLIER_KINDS' canonical order on every toggle, never in click order — the
  // server re-sorts it too (see actions.ts), so storage order is one thing, not two.
  function toggleKind(kind: SupplierKind, checked: boolean) {
    const next = checked ? [...kinds, kind] : kinds.filter((existing) => existing !== kind);
    setKinds(SUPPLIER_KINDS.filter((candidate) => next.includes(candidate)));
  }

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const payload = { name, kinds, phone, address, bankName, bankAccountNo, bankAccountName, notes, isActive };
      const result = props.mode === "create" ? await createSupplierAction(payload) : await updateSupplierAction(props.supplierId, payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(props.mode === "create" ? "Supplier berhasil ditambahkan" : "Perubahan berhasil disimpan");
      router.push("/suppliers");
    });
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div>
        <Label htmlFor="supplier-name" required>
          Nama supplier
        </Label>
        <Input id="supplier-name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>

      {/* A real <fieldset>/<legend>, not a bare <Label>: four checkboxes with no group name
          read as four unrelated controls to a screen reader, and a <label> with no htmlFor
          labels nothing. `aria-describedby` on the fieldset carries the hint into the group
          announcement too.
          A soft filter only (plan D13): these never restrict which supplier can be picked on a
          purchase or a cost line later, they only decide what a picker offers first. */}
      <fieldset className="flex flex-col gap-1.5" aria-describedby="supplier-kinds-hint">
        <legend className="text-sm font-medium text-neutral-900">Jenis</legend>
        <p id="supplier-kinds-hint" className="text-sm text-neutral-600">
          Boleh dikosongkan. Dipakai untuk mengurutkan pilihan, bukan membatasi.
        </p>
        <div className="flex flex-col">
          {SUPPLIER_KIND_OPTIONS.map(({ key, label }) => (
            <Checkbox
              key={key}
              label={label}
              checked={kinds.includes(key)}
              onChange={(event) => toggleKind(key, event.target.checked)}
            />
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="supplier-phone">Telepon/WhatsApp</Label>
          {/* type="tel" / inputMode: this form is filled on a phone, standing in a shop — the
              numeric keypad should come up without a tap. */}
          <Input
            id="supplier-phone"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="contoh: 0812 3456 7890"
          />
        </div>
        <div>
          <Label htmlFor="supplier-bank-name">Nama bank</Label>
          <Input id="supplier-bank-name" value={bankName} onChange={(event) => setBankName(event.target.value)} placeholder="contoh: BCA" />
        </div>
        <div>
          <Label htmlFor="supplier-bank-account-no">Nomor rekening</Label>
          <Input
            id="supplier-bank-account-no"
            inputMode="numeric"
            value={bankAccountNo}
            onChange={(event) => setBankAccountNo(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="supplier-bank-account-name">Nama pemilik rekening</Label>
          <Input id="supplier-bank-account-name" value={bankAccountName} onChange={(event) => setBankAccountName(event.target.value)} />
        </div>
      </div>

      <div>
        <Label htmlFor="supplier-address">Alamat</Label>
        <Textarea id="supplier-address" value={address} onChange={(event) => setAddress(event.target.value)} rows={2} />
      </div>
      <div>
        <Label htmlFor="supplier-notes">Catatan</Label>
        <Textarea id="supplier-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
      </div>
      <Switch checked={isActive} onCheckedChange={setIsActive} label="Aktif" />

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {props.mode === "create" && (
          <Link href="/suppliers">
            <Button type="button" variant="secondary">
              Batal
            </Button>
          </Link>
        )}
        <Button type="submit" loading={saving}>
          Simpan
        </Button>
      </div>
    </form>
  );
}
