"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Select } from "@ammari/ui";
import { saveRecipeAction } from "../actions";

export interface ActiveAccessoryOption {
  id: string;
  name: string;
  size: string | null;
}

export interface RecipeRowState {
  /** Present only for a row that already exists on the server — mirrors ExtraCostLineState's
   * own id/clientKey split (production/_components/extra-cost-lines.tsx) for the same reason:
   * a freshly-added row has no server id yet, so keying off array index alone would remount
   * later rows' Selects/Inputs (losing focus) whenever an earlier row is removed. */
  id?: string;
  clientKey: string;
  target: "accessory" | "sizeGroup";
  accessoryId: string;
  sizeGroup: string;
  qtyPerPcs: string;
}

export function AccessoryRecipeSection({
  productId,
  initialRows,
  activeAccessories,
  distinctSizeGroups,
}: {
  productId: string;
  initialRows: RecipeRowState[];
  activeAccessories: ActiveAccessoryOption[];
  distinctSizeGroups: string[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<RecipeRowState[]>(initialRows);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();

  function updateRow(index: number, patch: Partial<RecipeRowState>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    setRows((current) => current.filter((_, i) => i !== index));
  }

  function addRow() {
    const firstAccessory = activeAccessories[0];
    setRows((current) => [
      ...current,
      {
        clientKey: crypto.randomUUID(),
        target: "accessory",
        accessoryId: firstAccessory?.id ?? "",
        sizeGroup: distinctSizeGroups[0] ?? "",
        qtyPerPcs: "1",
      },
    ]);
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await saveRecipeAction({
        productId,
        lines: rows.map((row) => ({
          accessoryId: row.target === "accessory" ? row.accessoryId : undefined,
          sizeGroup: row.target === "sizeGroup" ? row.sizeGroup : undefined,
          qtyPerPcs: Number.parseInt(row.qtyPerPcs, 10) || 0,
        })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  const canAddMore = activeAccessories.length > 0 || distinctSizeGroups.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-900">Aksesoris per pcs</h2>
        <Button type="button" variant="secondary" onClick={addRow} disabled={!canAddMore}>
          + Tambah baris
        </Button>
      </div>
      {rows.length === 0 && (
        <p className="text-sm text-neutral-600">Belum ada aksesoris untuk produk ini. Tambah baris untuk mulai mencatat resep.</p>
      )}
      {!canAddMore && rows.length === 0 && (
        <p className="text-sm text-neutral-600">
          Belum ada aksesoris aktif atau grup ukuran. Tambah dulu di halaman{" "}
          <Link href="/accessories" className="text-brand hover:underline">
            Aksesoris
          </Link>
          .
        </p>
      )}
      {rows.map((row, index) => (
        <div key={row.clientKey} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 sm:flex-row sm:items-end sm:gap-3">
          <div className="flex-1">
            <Label htmlFor={`recipe-target-${index}`}>Jenis baris</Label>
            <Select
              id={`recipe-target-${index}`}
              value={row.target}
              onChange={(event) => updateRow(index, { target: event.target.value as "accessory" | "sizeGroup" })}
            >
              <option value="accessory">Aksesoris spesifik</option>
              <option value="sizeGroup">Grup ukuran</option>
            </Select>
          </div>
          <div className="flex-1">
            {row.target === "accessory" ? (
              <>
                <Label htmlFor={`recipe-accessory-${index}`}>Aksesoris</Label>
                <Select id={`recipe-accessory-${index}`} value={row.accessoryId} onChange={(event) => updateRow(index, { accessoryId: event.target.value })}>
                  {activeAccessories.length === 0 && <option value="">Tidak ada aksesoris aktif</option>}
                  {activeAccessories.map((accessory) => (
                    <option key={accessory.id} value={accessory.id}>
                      {accessory.name}
                      {accessory.size ? ` (${accessory.size === "ALLSIZE" ? "Polos" : accessory.size})` : ""}
                    </option>
                  ))}
                </Select>
              </>
            ) : (
              <>
                <Label htmlFor={`recipe-size-group-${index}`}>Grup ukuran</Label>
                <Select id={`recipe-size-group-${index}`} value={row.sizeGroup} onChange={(event) => updateRow(index, { sizeGroup: event.target.value })}>
                  {distinctSizeGroups.length === 0 && <option value="">Tidak ada grup ukuran</option>}
                  {distinctSizeGroups.map((group) => (
                    <option key={group} value={group}>
                      {group}
                    </option>
                  ))}
                </Select>
              </>
            )}
          </div>
          <div className="w-full sm:w-32">
            <Label htmlFor={`recipe-qty-${index}`}>Jumlah/pcs</Label>
            <Input
              id={`recipe-qty-${index}`}
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={row.qtyPerPcs}
              onChange={(event) => updateRow(index, { qtyPerPcs: event.target.value })}
            />
          </div>
          <Button type="button" variant="ghost" onClick={() => removeRow(index)} aria-label={`Hapus baris ${index + 1}`}>
            Hapus
          </Button>
        </div>
      ))}

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="button" onClick={handleSave} loading={saving}>
          Simpan resep
        </Button>
      </div>
    </div>
  );
}
