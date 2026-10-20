"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, ColorSwatch, Input, Label, useToast } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import type { listProductSkusForCount } from "@/lib/stock/queries";
import { saveStockCountAction } from "../actions";
import { STOREFRONT_STALE_MESSAGE } from "@/lib/storefront-stale";

type SkuRow = Awaited<ReturnType<typeof listProductSkusForCount>>[number];

export function StockCountForm({
  productId,
  skus,
  defectQtyBySku,
  reservedQtyBySku = {},
}: {
  productId: string;
  skus: SkuRow[];
  /** Defect pcs per SKU (S5), read-only: shown so the counter knows to leave them out, never
   * counted and never submitted. SKUs without defects are absent. */
  defectQtyBySku: Record<string, number>;
  /** Pcs held for unpaid web orders per SKU (docs/plans/cart-checkout.md §7), read-only: still on
   * the shelf and part of "Sistem", so they ARE counted. SKUs without a hold are absent. */
  reservedQtyBySku?: Record<string, number>;
}) {
  const router = useRouter();
  const toast = useToast();
  // sku -> physical count the operator typed, as a string (so a cleared input isn't coerced to
  // "0" while they're still typing) — only non-blank, differing entries are submitted.
  const [physicalCounts, setPhysicalCounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();

  const isDirty = Object.keys(physicalCounts).length > 0;
  useUnsavedChangesGuard(isDirty, "Ada hasil hitung stok yang belum disimpan. Tinggalkan halaman ini?");

  function handleSave() {
    setError(null);
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
      toast.success("Hitung stok berhasil disimpan");
      if (!result.data.storefrontOk) toast.error(STOREFRONT_STALE_MESSAGE);
      router.push("/stock");
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
        {skus.map((row) => {
          const defectQty = defectQtyBySku[row.sku];
          const reservedQty = reservedQtyBySku[row.sku];
          return (
            <div key={row.sku} className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3">
              <ColorSwatch hex={row.colorHex} />
              <div className="flex-1">
                <p className="text-base text-neutral-900">
                  {row.colorName} · {row.size === "ALLSIZE" ? "All Size" : row.size}
                </p>
                <p className="text-sm text-neutral-600">{row.sku} · Sistem: {formatNumber(row.currentStock)}</p>
                {defectQty !== undefined && (
                  <p className="text-sm text-neutral-600" data-testid="count-defect-qty">
                    Cacat: {formatNumber(defectQty)} pcs (tidak ikut dihitung)
                  </p>
                )}
                {reservedQty !== undefined && (
                  <p className="text-sm text-neutral-600" data-testid="count-reserved-qty">
                    Dipesan: {formatNumber(reservedQty)} pcs (tetap dihitung)
                  </p>
                )}
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
                  onChange={(event) => setPhysicalCounts((prev) => ({ ...prev, [row.sku]: event.target.value }))}
                />
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Link href="/stock">
          <Button type="button" variant="secondary">
            Batal
          </Button>
        </Link>
        <Button type="submit" loading={saving} disabled={!isDirty}>
          Simpan hasil hitung
        </Button>
      </div>
    </form>
  );
}
