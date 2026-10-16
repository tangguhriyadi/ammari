"use client";

import { useState, useTransition } from "react";
import { Button, Input, Label, Textarea } from "@ammari/ui";
import { saveStoreSettingsAction } from "../actions";

export interface StoreSettingsFormValues {
  whatsappNumber: string;
  supportEmail: string;
  businessAddress: string;
  returnPolicySummary: string;
}

/** Save = live — one "Simpan" button, no draft/publish (docs/plans/storefront-cms.md Phase 2).
 * The WhatsApp number is normalized server-side (store-settings-schema.ts's
 * normalizeWhatsappNumber) — this form just passes through whatever format the owner typed. */
export function StoreSettingsForm({ initialValues }: { initialValues: StoreSettingsFormValues }) {
  const [values, setValues] = useState(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof StoreSettingsFormValues>(key: K, value: StoreSettingsFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    setError(null);
    setSavedAt(null);
    startTransition(async () => {
      const result = await saveStoreSettingsAction(values);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedAt(Date.now());
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-whatsapp">Nomor WhatsApp</Label>
        <Input
          id="settings-whatsapp"
          value={values.whatsappNumber}
          onChange={(event) => set("whatsappNumber", event.target.value)}
          placeholder="08xx-xxxx-xxxx"
          inputMode="tel"
        />
        <p className="text-sm text-neutral-600">Format apa pun boleh (08xx, +62xx, 62xx) — disimpan otomatis dalam format yang benar.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-email">Email</Label>
        <Input id="settings-email" type="email" value={values.supportEmail} onChange={(event) => set("supportEmail", event.target.value)} placeholder="halo@ammari.id" />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-address">Alamat</Label>
        <Textarea
          id="settings-address"
          value={values.businessAddress}
          onChange={(event) => set("businessAddress", event.target.value)}
          rows={3}
          maxLength={500}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-return-policy">Ringkasan kebijakan tukar/retur</Label>
        <Textarea
          id="settings-return-policy"
          value={values.returnPolicySummary}
          onChange={(event) => set("returnPolicySummary", event.target.value)}
          rows={2}
          maxLength={300}
          placeholder="mis. Tukar ukuran gratis dalam 3 hari"
        />
        <p className="text-sm text-neutral-600">Ditampilkan di halaman produk, pada baris &quot;Pengembalian &amp; penukaran&quot;.</p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}

      {savedAt && !error && <p className="text-sm text-success-700">Tersimpan.</p>}

      <div className="flex justify-end">
        <Button type="button" onClick={handleSave} loading={pending}>
          Simpan
        </Button>
      </div>
    </div>
  );
}
