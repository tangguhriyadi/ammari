"use client";

import { Button, Input, Label, Select } from "@ammari/ui";
import { FabricColorLabel } from "@/components/fabric-color-label";
import type { FabricUsageStock } from "@/lib/production/fabric-usage-stock";
import { parseDecimalQuantity } from "@/lib/production/decimal-quantity";
import { usageShortfall } from "@/lib/production/fabric-usage";

/** The <select> needs a string per bucket: a colour id, or this for "Tanpa warna". */
export const NO_COLOR_SOURCE = "tanpa";

export interface FabricUsageRowState {
  /** Stable React key (rows can be added and removed). */
  key: string;
  /** A colour id, or NO_COLOR_SOURCE. */
  source: string;
  /** As typed ("12.5"). */
  yards: string;
}

export function sourceOf(fabricColorId: string | null): string {
  return fabricColorId ?? NO_COLOR_SOURCE;
}

export function fabricColorIdOf(source: string): string | null {
  return source === NO_COLOR_SOURCE ? null : source;
}

function bucketLabel(bucket: Pick<FabricUsageStock, "name" | "isActive">): string {
  if (bucket.name === null) return "Tanpa warna";
  return bucket.isActive ? bucket.name : `${bucket.name} (nonaktif)`;
}

/** "Pemakaian kain" (docs/plans/fabric-colour-stock.md D6, owner decision A4): one row per source
 * bucket, each with that bucket's current stock next to it. Controlled by the batch form, which
 * owns the default split (by pcs per colour) and decides when it applies. */
export function FabricUsageSection({
  rows,
  buckets,
  isDefaultSplit,
  canResplit,
  onRowsChange,
  onResplit,
}: {
  rows: FabricUsageRowState[];
  /** Every bucket a row may draw from ("Tanpa warna" always included), with its stock. */
  buckets: FabricUsageStock[];
  /** Whether `rows` is the automatic split by pcs (so a hint says so). */
  isDefaultSplit: boolean;
  /** The batch has pcs and yards to split. */
  canResplit: boolean;
  onRowsChange: (rows: FabricUsageRowState[]) => void;
  onResplit: () => void;
}) {
  const bucketBySource = new Map(buckets.map((bucket) => [sourceOf(bucket.fabricColorId), bucket]));
  const usedSources = new Set(rows.map((row) => row.source));
  const colorless = bucketBySource.get(NO_COLOR_SOURCE);
  const totalCenti = rows.reduce((sum, row) => sum + Math.round((parseDecimalQuantity(row.yards) ?? 0) * 100), 0);

  function update(index: number, patch: Partial<FabricUsageRowState>) {
    onRowsChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    // The first unused bucket that holds stock, else the first unused one at all.
    const unused = buckets.filter((bucket) => !usedSources.has(sourceOf(bucket.fabricColorId)));
    const next = unused.find((bucket) => bucket.qty > 0) ?? unused[0];
    if (!next) return;
    // Not crypto.randomUUID(): it is missing outside a secure context (the admin opened over a LAN
    // IP on a phone during development).
    onRowsChange([...rows, { key: `new-${Date.now()}-${rows.length}`, source: sourceOf(next.fabricColorId), yards: "" }]);
  }

  const canAdd = buckets.some((bucket) => !usedSources.has(sourceOf(bucket.fabricColorId)));

  return (
    <section aria-labelledby="fabric-usage-heading" className="flex flex-col gap-3" data-testid="fabric-usage-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="fabric-usage-heading" className="text-lg font-semibold text-neutral-900">
          Pemakaian kain
        </h2>
        {canResplit && !isDefaultSplit && (
          <Button type="button" variant="secondary" onClick={onResplit}>
            Bagi sesuai pcs
          </Button>
        )}
      </div>
      <p className="text-sm text-neutral-600">
        {isDefaultSplit
          ? "Jumlah yard dibagi otomatis sesuai pcs tiap warna. Ubah yard atau warna sumber bila perlu."
          : "Yard per warna diisi manual. Jumlah yard di atas mengikuti total pemakaian."}
      </p>

      {rows.length === 0 ? (
        <p className="text-base text-neutral-600">Isi jumlah yard dan pcs per SKU untuk membagi pemakaian kain per warna.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row, index) => {
            const number = index + 1;
            const bucket = bucketBySource.get(row.source);
            const yards = parseDecimalQuantity(row.yards);
            const shortfall = yards !== null && bucket ? usageShortfall(yards, bucket.qty) : 0;
            const colorlessCovers =
              shortfall > 0 &&
              row.source !== NO_COLOR_SOURCE &&
              !usedSources.has(NO_COLOR_SOURCE) &&
              colorless !== undefined &&
              yards !== null &&
              usageShortfall(yards, colorless.qty) === 0;
            return (
              <li key={row.key} data-testid="fabric-usage-row" className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
                <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
                  <div>
                    <Label htmlFor={`usage-source-${row.key}`}>Warna sumber</Label>
                    <Select
                      id={`usage-source-${row.key}`}
                      aria-label={`Warna sumber ${number}`}
                      value={row.source}
                      onChange={(event) => update(index, { source: event.target.value })}
                    >
                      {buckets.map((option) => {
                        const value = sourceOf(option.fabricColorId);
                        return (
                          <option key={value} value={value} disabled={value !== row.source && usedSources.has(value)}>
                            {`${bucketLabel(option)} (stok ${option.qty.toFixed(2)} yard)`}
                          </option>
                        );
                      })}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`usage-yards-${row.key}`}>Yard</Label>
                    <Input
                      id={`usage-yards-${row.key}`}
                      aria-label={`Yard ${number}`}
                      inputMode="decimal"
                      value={row.yards}
                      onChange={(event) => update(index, { yards: event.target.value })}
                      placeholder="0"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="col-span-2 justify-self-end sm:col-span-1"
                    aria-label={`Hapus pemakaian ${number}`}
                    onClick={() => onRowsChange(rows.filter((_, i) => i !== index))}
                  >
                    Hapus
                  </Button>
                </div>
                {bucket && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-600" data-testid="fabric-usage-stock">
                    <span className="inline-flex items-center gap-1">
                      Stok <FabricColorLabel name={bucket.name} hex={bucket.hex} testId="fabric-usage-stock-color" />
                    </span>
                    <span className="tabular-nums">{bucket.qty.toFixed(2)} yard</span>
                    {shortfall > 0 && (
                      <span className="font-medium text-danger-700 tabular-nums" data-testid="fabric-usage-shortfall">
                        kurang {shortfall.toFixed(2)} yard
                      </span>
                    )}
                  </p>
                )}
                {colorlessCovers && (
                  <Button type="button" variant="secondary" className="self-start" onClick={() => update(index, { source: NO_COLOR_SOURCE })}>
                    Ambil dari Tanpa warna
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {canAdd ? (
          <Button type="button" variant="ghost" onClick={addRow}>
            + Tambah warna
          </Button>
        ) : (
          <span />
        )}
        {rows.length > 0 && (
          <p className="text-base text-neutral-900 tabular-nums" data-testid="fabric-usage-total">
            Total pemakaian {(totalCenti / 100).toFixed(2)} yard
          </p>
        )}
      </div>
    </section>
  );
}
