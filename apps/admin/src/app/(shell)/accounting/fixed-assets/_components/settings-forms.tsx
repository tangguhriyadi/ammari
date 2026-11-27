"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button, Card, Input, Label, useToast } from "@ammari/ui";
import type { FixedAssetGroupRow } from "@/lib/accounting/fixed-assets";
import { updateCapitalizationThresholdAction, updateFixedAssetGroupAction } from "../actions";

// D-19 settings: each tax group's useful life and the capitalisation threshold. A group's months
// apply to assets saved from now on; existing assets keep the months they were saved with.

function useSave() {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();
  function save(run: () => Promise<{ ok: true } | { ok: false; error: string; fieldErrors?: Record<string, string> }>, message: string) {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await run();
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      toast.success(message);
      router.refresh();
    });
  }
  return { error, fieldErrors, saving, save };
}

export function GroupForm({ group }: { group: FixedAssetGroupRow }) {
  const id = useId();
  const [label, setLabel] = useState(group.label);
  const [months, setMonths] = useState(String(group.usefulLifeMonths));
  const { error, fieldErrors, saving, save } = useSave();
  return (
    <Card>
      <form
        className="flex flex-col gap-3"
        aria-label={`Kelompok ${group.label}`}
        onSubmit={(event) => {
          event.preventDefault();
          save(() => updateFixedAssetGroupAction(group.code, { label, usefulLifeMonths: months }), "Kelompok disimpan");
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-label`} required>
            Nama kelompok
          </Label>
          <Input id={`${id}-label`} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={60} error={fieldErrors.label} disabled={saving} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-months`} required>
            Umur manfaat (bulan)
          </Label>
          <Input id={`${id}-months`} value={months} onChange={(event) => setMonths(event.target.value)} inputMode="numeric" error={fieldErrors.usefulLifeMonths} disabled={saving} />
        </div>
        {error && !Object.keys(fieldErrors).length && (
          <p role="alert" className="text-sm text-danger-700">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" loading={saving}>
            Simpan
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function ThresholdForm({ threshold }: { threshold: number }) {
  const id = useId();
  const [value, setValue] = useState(String(threshold));
  const { error, fieldErrors, saving, save } = useSave();
  return (
    <Card>
      <form
        className="flex flex-col gap-3"
        aria-label="Batas kapitalisasi"
        onSubmit={(event) => {
          event.preventDefault();
          save(() => updateCapitalizationThresholdAction({ capitalizationThreshold: value }), "Batas kapitalisasi disimpan");
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id} required>
            Batas kapitalisasi (Rp)
          </Label>
          <Input id={id} value={value} onChange={(event) => setValue(event.target.value)} inputMode="numeric" error={fieldErrors.capitalizationThreshold ?? (error ?? undefined)} disabled={saving} />
          <p className="text-sm text-neutral-600">Pembelian di bawah batas ini dicatat sebagai biaya biasa, bukan aset tetap.</p>
        </div>
        <div>
          <Button type="submit" loading={saving}>
            Simpan
          </Button>
        </div>
      </form>
    </Card>
  );
}
