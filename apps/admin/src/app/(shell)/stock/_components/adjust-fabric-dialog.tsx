"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, Input, Label, Select, Textarea } from "@ammari/ui";
import { STOCK_ADJUSTMENT_REASONS, type StockAdjustmentReason } from "@ammari/db/schema";
import { recordFabricAdjustmentAction } from "@/app/(shell)/fabrics/actions";

const REASON_LABELS: Record<StockAdjustmentReason, string> = {
  recount: "Hitung ulang",
  damaged: "Rusak/cacat",
  lost: "Hilang",
  other: "Lainnya",
};

/** One bucket the adjustment may target (already filtered server-side by isAdjustableBucket). */
export interface AdjustFabricColorOption {
  /** `null` = "Tanpa warna". */
  fabricColorId: string | null;
  name: string | null;
  isActive: boolean;
  qty: number;
}

// The <select> needs a string per option: "" = not chosen yet, "tanpa" = the colourless bucket.
const NO_COLOR = "tanpa";

function optionValue(option: AdjustFabricColorOption) {
  return option.fabricColorId ?? NO_COLOR;
}

function optionLabel(option: AdjustFabricColorOption) {
  const name = option.name === null ? "Tanpa warna" : option.isActive ? option.name : `${option.name} (nonaktif)`;
  return `${name} (stok ${option.qty.toFixed(2)} yard)`;
}

export function AdjustFabricDialog({
  fabricId,
  colorOptions,
  requireColor,
  open,
  onOpenChange,
}: {
  fabricId: string;
  colorOptions: AdjustFabricColorOption[];
  /** The fabric has active colours: the staff must pick one (no silent default). */
  requireColor: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  // Only one possible bucket and no active colour to choose between (a fabric without colours):
  // preselected. Otherwise the staff picks explicitly.
  const defaultColor = !requireColor && colorOptions.length === 1 ? optionValue(colorOptions[0]!) : "";
  const [pickedColor, setColor] = useState(defaultColor);
  // After a router.refresh() the options can change (a bucket emptied, a colour deactivated): a
  // pick that is no longer offered falls back to the default instead of pointing at nothing.
  const color = colorOptions.some((option) => optionValue(option) === pickedColor) ? pickedColor : defaultColor;
  const [deltaQty, setDeltaQty] = useState("");
  const [reason, setReason] = useState<StockAdjustmentReason>("recount");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Closing (saved, cancelled or Escape) clears every field, so a reopened dialog never carries a
  // stale pick or error into the next adjustment.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setColor(defaultColor);
      setDeltaQty("");
      setReason("recount");
      setNote("");
      setError(null);
    }
    onOpenChange(next);
  }

  function handleConfirm() {
    setError(null);
    const chosen = colorOptions.find((option) => optionValue(option) === color);
    if (!chosen) {
      setError("Pilih warna.");
      return;
    }
    const parsed = Number.parseFloat(deltaQty);
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError("Jumlah tidak boleh 0.");
      return;
    }
    // Early hint only; recordFabricAdjustment re-checks the bucket under the fabric lock.
    if (Math.round((chosen.qty + parsed) * 100) < 0) {
      setError(`Stok ${chosen.name ?? "Tanpa warna"} tidak boleh menjadi negatif (stok sekarang ${chosen.qty.toFixed(2)} yard).`);
      return;
    }
    startTransition(async () => {
      const result = await recordFabricAdjustmentAction({ fabricId, fabricColorId: chosen.fabricColorId, deltaQty: parsed, reason, note: note || undefined });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      handleOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} title="Sesuaikan stok" confirmLabel="Simpan" onConfirm={handleConfirm} loading={pending}>
      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="fabric-adjust-color" required>
            Warna
          </Label>
          <Select id="fabric-adjust-color" value={color} onChange={(event) => setColor(event.target.value)}>
            {defaultColor === "" && (
              <option value="" disabled>
                Pilih warna
              </option>
            )}
            {colorOptions.map((option) => (
              <option key={optionValue(option)} value={optionValue(option)}>
                {optionLabel(option)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="fabric-adjust-delta" required>
            Jumlah yard (+/-)
          </Label>
          <Input
            id="fabric-adjust-delta"
            type="number"
            inputMode="decimal"
            step={0.01}
            value={deltaQty}
            onChange={(event) => setDeltaQty(event.target.value)}
            placeholder="contoh: -2.5 atau 5"
          />
        </div>
        <div>
          <Label htmlFor="fabric-adjust-reason" required>
            Alasan
          </Label>
          <Select id="fabric-adjust-reason" value={reason} onChange={(event) => setReason(event.target.value as StockAdjustmentReason)}>
            {STOCK_ADJUSTMENT_REASONS.map((value) => (
              <option key={value} value={value}>
                {REASON_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="fabric-adjust-note">Catatan</Label>
          <Textarea id="fabric-adjust-note" value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
        </div>
        {error && (
          <p role="alert" className="text-base text-danger-700">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
