"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, Input, Label, Select, Textarea } from "@ammari/ui";
import { STOCK_ADJUSTMENT_REASONS, type StockAdjustmentReason } from "@ammari/db/schema";
import { recordAccessoryAdjustmentAction } from "@/app/(shell)/accessories/actions";

const REASON_LABELS: Record<StockAdjustmentReason, string> = {
  recount: "Hitung ulang",
  damaged: "Rusak/cacat",
  lost: "Hilang",
  other: "Lainnya",
};

export function AdjustAccessoryDialog({
  accessoryId,
  open,
  onOpenChange,
}: {
  accessoryId: string;
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
    const parsed = Number.parseInt(deltaQty, 10);
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError("Jumlah tidak boleh 0.");
      return;
    }
    startTransition(async () => {
      const result = await recordAccessoryAdjustmentAction({ accessoryId, deltaQty: parsed, reason, note: note || undefined });
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
          <Label htmlFor="accessory-adjust-delta" required>
            Jumlah (+/-)
          </Label>
          <Input
            id="accessory-adjust-delta"
            type="number"
            inputMode="numeric"
            step={1}
            value={deltaQty}
            onChange={(event) => setDeltaQty(event.target.value)}
            placeholder="contoh: -2 atau 5"
          />
        </div>
        <div>
          <Label htmlFor="accessory-adjust-reason" required>
            Alasan
          </Label>
          <Select id="accessory-adjust-reason" value={reason} onChange={(event) => setReason(event.target.value as StockAdjustmentReason)}>
            {STOCK_ADJUSTMENT_REASONS.map((value) => (
              <option key={value} value={value}>
                {REASON_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="accessory-adjust-note">Catatan</Label>
          <Textarea id="accessory-adjust-note" value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
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
