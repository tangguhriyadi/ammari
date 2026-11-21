"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { reclassifyFabricStockAction } from "@/app/(shell)/fabrics/actions";

/** One bucket as the "Pindahkan ke warna" dialog offers it (server-filtered). */
export interface MoveFabricColourOption {
  /** `null` = "Tanpa warna". */
  fabricColorId: string | null;
  name: string | null;
  isActive: boolean;
  qty: number;
}

// The <select> needs a string per option: "" = not chosen yet, "tanpa" = the colourless bucket.
const NO_COLOR = "tanpa";

function optionValue(option: MoveFabricColourOption) {
  return option.fabricColorId ?? NO_COLOR;
}

function optionName(option: MoveFabricColourOption) {
  if (option.name === null) return "Tanpa warna";
  return option.isActive ? option.name : `${option.name} (nonaktif)`;
}

/** "Pindahkan ke warna" (docs/plans/fabric-colour-stock.md D7, owner decision A3): moves yards
 * from "Tanpa warna" or a colour into another colour of the same fabric. The fabric's total
 * quantity and value don't change; reclassifyFabricStock re-checks everything under the lock. */
export function MoveFabricColourDialog({
  fabricId,
  sources,
  targets,
  open,
  onOpenChange,
}: {
  fabricId: string;
  /** Buckets holding stock (qty > 0). */
  sources: MoveFabricColourOption[];
  /** Active colours. */
  targets: MoveFabricColourOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  // Only one bucket holds stock (typically all old stock in Tanpa warna): preselected.
  const defaultFrom = sources.length === 1 ? optionValue(sources[0]!) : "";
  const [pickedFrom, setFrom] = useState(defaultFrom);
  const [pickedTo, setTo] = useState("");
  // After a router.refresh() the options can change: a pick no longer offered falls back.
  const from = sources.some((option) => optionValue(option) === pickedFrom) ? pickedFrom : defaultFrom;
  const to = targets.some((option) => optionValue(option) === pickedTo && optionValue(option) !== from) ? pickedTo : "";
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    if (!next) {
      setFrom(defaultFrom);
      setTo("");
      setQty("");
      setNote("");
      setError(null);
    }
    onOpenChange(next);
  }

  function handleConfirm() {
    setError(null);
    const source = sources.find((option) => optionValue(option) === from);
    if (!source) {
      setError("Pilih warna asal.");
      return;
    }
    const target = targets.find((option) => optionValue(option) === to);
    if (!target || target.fabricColorId === null) {
      setError("Pilih warna tujuan.");
      return;
    }
    const trimmed = qty.trim();
    const parsed = Number(trimmed);
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed) || parsed <= 0) {
      setError("Jumlah harus lebih dari 0, maksimal 2 desimal.");
      return;
    }
    // Early hint only; the source is re-checked under the fabric lock.
    if (Math.round(parsed * 100) > Math.round(source.qty * 100)) {
      setError(`Stok ${optionName(source)} tidak cukup (stok sekarang ${source.qty.toFixed(2)} yard).`);
      return;
    }
    if (note.trim() === "") {
      setError("Alasan wajib diisi.");
      return;
    }
    const toColorId = target.fabricColorId;
    startTransition(async () => {
      const result = await reclassifyFabricStockAction({ fabricId, fromColorId: source.fabricColorId, toColorId, qty: parsed, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(`${parsed.toFixed(2)} yard dipindahkan dari ${optionName(source)} ke ${optionName(target)}`);
      handleOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} title="Pindahkan ke warna" confirmLabel="Pindahkan" onConfirm={handleConfirm} loading={pending}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-600">Total yard dan nilai bahan tidak berubah. Nilai ikut pindah sesuai rata-rata harga warna asal.</p>
        <div>
          <Label htmlFor="fabric-move-from" required>
            Dari
          </Label>
          <Select id="fabric-move-from" value={from} onChange={(event) => setFrom(event.target.value)}>
            {defaultFrom === "" && (
              <option value="" disabled>
                Pilih warna asal
              </option>
            )}
            {sources.map((option) => (
              <option key={optionValue(option)} value={optionValue(option)}>
                {`${optionName(option)} (stok ${option.qty.toFixed(2)} yard)`}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="fabric-move-to" required>
            Ke warna
          </Label>
          <Select id="fabric-move-to" value={to} onChange={(event) => setTo(event.target.value)}>
            <option value="" disabled>
              Pilih warna tujuan
            </option>
            {targets
              .filter((option) => optionValue(option) !== from)
              .map((option) => (
                <option key={optionValue(option)} value={optionValue(option)}>
                  {`${optionName(option)} (stok ${option.qty.toFixed(2)} yard)`}
                </option>
              ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="fabric-move-qty" required>
            Jumlah yard
          </Label>
          <Input id="fabric-move-qty" inputMode="decimal" value={qty} onChange={(event) => setQty(event.target.value)} placeholder="contoh: 13.45" />
        </div>
        <div>
          <Label htmlFor="fabric-move-note" required>
            Alasan
          </Label>
          <Textarea
            id="fabric-move-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder="contoh: hitung ulang stok lama per warna"
          />
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
