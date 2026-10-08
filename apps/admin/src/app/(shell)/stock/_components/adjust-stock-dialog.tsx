"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, Input, Label, Select, Textarea } from "@ammari/ui";
import { STOCK_ADJUSTMENT_REASONS, type StockAdjustmentReason } from "@ammari/db/schema";
import { adjustStockAction } from "../actions";

const REASON_LABELS: Record<StockAdjustmentReason, string> = {
  recount: "Hitung ulang",
  damaged: "Rusak/cacat",
  lost: "Hilang",
  other: "Lainnya",
};

export function AdjustStockDialog({ sku, open, onOpenChange }: { sku: string; open: boolean; onOpenChange: (open: boolean) => void }) {
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
      const result = await adjustStockAction({ sku, deltaQty: parsed, reason, note });
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

  // This dialog's actual "submit" control (the Confirm button) is rendered by the shared
  // <Dialog> itself, outside these fields — a <form> wrapped around just the fields below has
  // no submit button inside it, so it wouldn't get native Enter-to-submit (the HTML spec only
  // grants implicit submission to a multi-field form when a submit control is INSIDE it).
  // Wiring Enter explicitly on the single-line fields (not the Textarea, where Enter must stay
  // a newline) reaches the same outcome without restructuring the shared Dialog component.
  function submitOnEnter(event: React.KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    handleConfirm();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sesuaikan stok"
      confirmLabel="Simpan"
      onConfirm={handleConfirm}
      loading={pending}
    >
      <div className="flex flex-col gap-3">
        <div>
          <Label htmlFor="adjust-delta" required>
            Jumlah (+/-)
          </Label>
          <Input
            id="adjust-delta"
            type="number"
            inputMode="numeric"
            step={1}
            value={deltaQty}
            onChange={(event) => setDeltaQty(event.target.value)}
            onKeyDown={submitOnEnter}
            placeholder="contoh: -2 atau 5"
          />
        </div>
        <div>
          <Label htmlFor="adjust-reason" required>
            Alasan
          </Label>
          <Select
            id="adjust-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value as StockAdjustmentReason)}
            onKeyDown={submitOnEnter}
          >
            {STOCK_ADJUSTMENT_REASONS.map((value) => (
              <option key={value} value={value}>
                {REASON_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="adjust-note">Catatan</Label>
          <Textarea id="adjust-note" value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
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
