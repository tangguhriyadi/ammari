"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Checkbox, Input, Label } from "@ammari/ui";
import type { Size, SizeMode } from "@ammari/db/schema";
import { addVariantsAction, bulkSetMinStockAction, setVariantActiveAction, updateVariantAction } from "../actions";

export interface VariantRow {
  sku: string;
  colorName: string;
  colorHex: string | null;
  size: string;
  priceOverrideAmount: number | null;
  minStockQty: number;
  isActive: boolean;
}

export interface AvailableColor {
  id: string;
  name: string;
  hex: string | null;
}

const SIZED_SIZES = ["XS", "S", "M", "L", "XL"] as const;

function Swatch({ hex }: { hex: string | null }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 shrink-0 rounded-full border border-neutral-300"
      style={{ backgroundColor: hex ?? undefined }}
    />
  );
}

function VariantRowEditor({ variant }: { variant: VariantRow }) {
  const router = useRouter();
  const [priceOverride, setPriceOverride] = useState(variant.priceOverrideAmount != null ? String(variant.priceOverrideAmount) : "");
  const [minStock, setMinStock] = useState(String(variant.minStockQty));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await updateVariantAction({
        sku: variant.sku,
        priceOverrideAmount: priceOverride || "",
        minStockQty: Number(minStock),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function toggleActive() {
    setError(null);
    startTransition(async () => {
      const result = await setVariantActiveAction({ sku: variant.sku, isActive: !variant.isActive });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className="flex flex-col gap-2 border-b border-neutral-100 py-3 last:border-0 sm:flex-row sm:items-center sm:gap-4">
      <span className="w-14 shrink-0 font-mono text-sm text-neutral-600">{variant.size}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-neutral-900">{variant.sku}</span>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
        className="flex items-center gap-2"
      >
        <Input
          value={priceOverride}
          onChange={(event) => setPriceOverride(event.target.value)}
          placeholder="Harga dasar"
          className="w-28"
          aria-label={`Harga khusus untuk ${variant.sku}`}
          disabled={pending}
        />
        <Input
          inputMode="numeric"
          value={minStock}
          onChange={(event) => setMinStock(event.target.value)}
          className="w-20"
          aria-label={`Stok minimum untuk ${variant.sku}`}
          disabled={pending}
        />
        <Button type="submit" variant="secondary" loading={pending}>
          Simpan
        </Button>
        <Button type="button" variant={variant.isActive ? "danger" : "secondary"} onClick={toggleActive} disabled={pending}>
          {variant.isActive ? "Nonaktifkan" : "Aktifkan"}
        </Button>
      </form>
      {error && (
        <span role="alert" className="text-sm text-danger-700">
          {error}
        </span>
      )}
    </li>
  );
}

function AddVariantForm({
  productId,
  fabricId,
  sizeMode,
  availableColors,
}: {
  productId: string;
  fabricId: string;
  sizeMode: SizeMode;
  availableColors: AvailableColor[];
}) {
  const router = useRouter();
  const [selectedColorIds, setSelectedColorIds] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleColor(id: string) {
    setSelectedColorIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  function toggleSize(size: string) {
    setSizes((prev) => (prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size]));
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const sizesToUse = (sizeMode === "all_size" ? ["ALLSIZE"] : sizes) as Size[];
      // A single atomic call creates every selected color x size in one transaction (all or
      // nothing) — see productQueries.addVariants' doc comment. On failure nothing was created,
      // so the selection is simply left as-is for the user to retry after addressing the error.
      const result = await addVariantsAction({
        productId,
        selections: selectedColorIds.map((fabricColorId) => ({ fabricColorId, sizes: sizesToUse })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSelectedColorIds([]);
      setSizes([]);
      router.refresh();
    });
  }

  if (availableColors.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-center">
        <p className="text-base text-neutral-600">Belum ada warna untuk bahan ini.</p>
        <Link href={`/bahan/${fabricId}`} className="text-sm font-medium text-brand hover:underline">
          Tambah warna di halaman Bahan
        </Link>
      </div>
    );
  }

  const canSubmit = selectedColorIds.length > 0 && (sizeMode === "all_size" || sizes.length > 0);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-3 rounded-lg border border-dashed border-neutral-300 p-4"
    >
      <p className="text-base font-semibold text-neutral-900">Tambah varian</p>

      <div className="flex flex-col gap-2">
        <Label>Warna</Label>
        <div className="flex flex-wrap gap-3">
          {availableColors.map((color) => (
            <label
              key={color.id}
              className="flex min-h-11 items-center gap-2 rounded-md border border-neutral-300 px-3 text-base text-neutral-900"
            >
              <input
                type="checkbox"
                checked={selectedColorIds.includes(color.id)}
                onChange={() => toggleColor(color.id)}
                disabled={pending}
                className="size-5 rounded border-neutral-500 text-brand"
              />
              <Swatch hex={color.hex} />
              {color.name}
            </label>
          ))}
        </div>
      </div>

      {sizeMode === "sized" ? (
        <div className="flex flex-col gap-2">
          <Label>Ukuran</Label>
          <div className="flex flex-wrap gap-3">
            {SIZED_SIZES.map((size) => (
              <Checkbox key={size} label={size} checked={sizes.includes(size)} onChange={() => toggleSize(size)} disabled={pending} />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-neutral-600">Produk ini menggunakan All Size — satu varian per warna.</p>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}

      <Button type="submit" loading={pending} disabled={!canSubmit}>
        Tambah varian
      </Button>
    </form>
  );
}

function BulkMinStockForm({ productId }: { productId: string }) {
  const router = useRouter();
  const [qty, setQty] = useState("0");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function submit() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const response = await bulkSetMinStockAction({ productId, minStockQty: Number(qty) });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setResult(`Stok minimum diterapkan ke ${response.data.affected} varian aktif.`);
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bulk-min-stock">Stok minimum untuk semua ukuran</Label>
        <Input
          id="bulk-min-stock"
          inputMode="numeric"
          value={qty}
          onChange={(event) => setQty(event.target.value)}
          className="w-28"
          disabled={pending}
        />
      </div>
      <Button type="submit" variant="secondary" loading={pending}>
        Terapkan
      </Button>
      {error && (
        <span role="alert" className="text-sm text-danger-700">
          {error}
        </span>
      )}
      {result && (
        <span role="status" className="text-sm text-success-700">
          {result}
        </span>
      )}
    </form>
  );
}

export function VariantBuilder({
  productId,
  fabricId,
  sizeMode,
  variants,
  availableColors,
}: {
  productId: string;
  fabricId: string;
  sizeMode: SizeMode;
  variants: VariantRow[];
  availableColors: AvailableColor[];
}) {
  const active = variants.filter((v) => v.isActive);
  const inactive = variants.filter((v) => !v.isActive);

  const colorsOf = (list: VariantRow[]) => {
    const groups = new Map<string, VariantRow[]>();
    for (const variant of list) {
      const group = groups.get(variant.colorName) ?? [];
      group.push(variant);
      groups.set(variant.colorName, group);
    }
    return [...groups.entries()];
  };

  return (
    <div className="flex flex-col gap-6">
      {active.length > 0 && <BulkMinStockForm productId={productId} />}

      <div className="flex flex-col gap-4">
        {colorsOf(active).map(([colorName, rows]) => (
          // Keyed on the variant values that must reset when server state changes — otherwise
          // React reconciles the same component instance across a router.refresh() and
          // VariantRowEditor's local state (initialized once, on mount) goes stale.
          <div key={`${colorName}:${rows[0]?.colorHex}`} className="rounded-lg border border-neutral-200 p-4">
            <div className="mb-2 flex items-center gap-2">
              <Swatch hex={rows[0]?.colorHex ?? null} />
              <span className="text-base font-semibold text-neutral-900">{colorName}</span>
            </div>
            <ul>
              {rows.map((variant) => (
                <VariantRowEditor
                  key={`${variant.sku}:${variant.priceOverrideAmount}:${variant.minStockQty}`}
                  variant={variant}
                />
              ))}
            </ul>
          </div>
        ))}
        {active.length === 0 && <p className="text-base text-neutral-600">Belum ada varian aktif.</p>}
      </div>

      <AddVariantForm productId={productId} fabricId={fabricId} sizeMode={sizeMode} availableColors={availableColors} />

      {inactive.length > 0 && (
        <details className="rounded-lg border border-neutral-200 p-4">
          <summary className="cursor-pointer text-base font-semibold text-neutral-900">
            Nonaktif ({inactive.length})
          </summary>
          <div className="mt-3 flex flex-col gap-4">
            {colorsOf(inactive).map(([colorName, rows]) => (
              <div key={`${colorName}:${rows[0]?.colorHex}`}>
                <div className="mb-2 flex items-center gap-2">
                  <Swatch hex={rows[0]?.colorHex ?? null} />
                  <span className="text-base font-medium text-neutral-700">{colorName}</span>
                </div>
                <ul>
                  {rows.map((variant) => (
                    <VariantRowEditor
                      key={`${variant.sku}:${variant.priceOverrideAmount}:${variant.minStockQty}`}
                      variant={variant}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
