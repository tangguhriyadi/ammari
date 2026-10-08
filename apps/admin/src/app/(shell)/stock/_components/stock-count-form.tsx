"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, ColorSwatch, Input, Label } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import type { listProductSkusForCount } from "@/lib/stock/queries";
import { saveStockCountAction } from "../actions";

type SkuRow = Awaited<ReturnType<typeof listProductSkusForCount>>[number];

export function StockCountForm({ productId, skus }: { productId: string; skus: SkuRow[] }) {
  const router = useRouter();
  // sku -> physical count the operator typed, as a string (so a cleared input isn't coerced to
  // "0" while they're still typing) — only non-blank, differing entries are submitted.
  const [physicalCounts, setPhysicalCounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // Distinct from `saving` — the button's `disabled` is `true` both WHILE saving and AFTER a
  // successful save (isDirty becomes false either way), so without a separate signal a user who
  // just saved sees the exact same inert button as mid-save, with no confirmation anything
  // happened. Cleared as soon as the user starts a new edit.
  const [justSaved, setJustSaved] = useState(false);
  const [saving, startTransition] = useTransition();

  const isDirty = Object.keys(physicalCounts).length > 0;
  useUnsavedChangesGuard(isDirty, "Ada hasil hitung stok yang belum disimpan. Tinggalkan halaman ini?");

  function handleSave() {
    setError(null);
    setJustSaved(false);
    const lines = Object.entries(physicalCounts)
      .filter(([, value]) => value.trim() !== "")
      .map(([sku, value]) => ({ sku, physicalQty: Number.parseInt(value, 10) }))
      .filter((line) => Number.isFinite(line.physicalQty));

    startTransition(async () => {
      const result = await saveStockCountAction({ productId, lines });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPhysicalCounts({});
      setJustSaved(true);
      router.refresh();
    });
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        handleSave();
      }}
    >
      <div className="flex flex-col gap-2">
        {skus.map((row) => (
          <div key={row.sku} className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3">
            <ColorSwatch hex={row.colorHex} />
            <div className="flex-1">
              <p className="text-base text-neutral-900">
                {row.colorName} · {row.size === "ALLSIZE" ? "All Size" : row.size}
              </p>
              <p className="text-sm text-neutral-600">{row.sku} · Sistem: {formatNumber(row.currentStock)}</p>
            </div>
            <div className="w-28">
              <Label htmlFor={`count-${row.sku}`} className="sr-only">
                Jumlah fisik untuk {row.sku}
              </Label>
              <Input
                id={`count-${row.sku}`}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                placeholder={String(row.currentStock)}
                value={physicalCounts[row.sku] ?? ""}
                onChange={(event) => {
                  setJustSaved(false);
                  setPhysicalCounts((prev) => ({ ...prev, [row.sku]: event.target.value }));
                }}
              />
            </div>
          </div>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}
      {justSaved && (
        <p aria-live="polite" className="text-base text-success-700">
          Tersimpan.
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={saving} disabled={!isDirty}>
          Simpan hasil hitung
        </Button>
      </div>
    </form>
  );
}
