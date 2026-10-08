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

export function AdjustFabricDialog({
  fabricId,
  open,
  onOpenChange,
}: {
  fabricId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [deltaQty, setDeltaQty] = useState("");
  const [reason, setReason] = useState<StockAdjustmentReason>("recount");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    const parsed = Number.parseFloat(deltaQty);
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError("Jumlah tidak boleh 0.");
      return;
    }
    startTransition(async () => {
      const result = await recordFabricAdjustmentAction({ fabricId, deltaQty: parsed, reason, note: note || undefined });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDeltaQty("");
      setNote("");
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Sesuaikan stok" confirmLabel="Simpan" onConfirm={handleConfirm} loading={pending}>
      <div className="flex flex-col gap-3">
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
