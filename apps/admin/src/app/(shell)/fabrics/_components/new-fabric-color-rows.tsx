"use client";

import { useId, useRef } from "react";
import { Button, ColorSwatch, Input, Label } from "@ammari/ui";

export interface DraftColorRow {
  /** Stable React key, independent of any server id — these rows don't exist in the DB yet. */
  key: string;
  name: string;
  supplierColorCode: string;
  hex: string;
}

/** The form always starts with exactly one row, so a fixed key is safe here (no mismatch risk
 * between server and client render) — unlike generating it from a counter or `crypto.randomUUID`,
 * either of which would run once during SSR and again, independently, during client hydration,
 * producing two DIFFERENT values for what must be the same row and triggering a hydration
 * mismatch. Rows added later (via NewFabricColorRows' own "+" button below) are a different case:
 * that only ever runs in an event handler, well after hydration, so useId()+a ref counter there is
 * safe. */
export function createInitialColorRow(): DraftColorRow {
  return { key: "row-initial", name: "", supplierColorCode: "", hex: "" };
}


/** Field errors keyed `colors.<index>.<field>`, the same convention
 * `createFabricWithColors` (apps/admin/src/lib/products/fabric-queries.ts) uses so a server-side
 * validation failure can point at the exact row. */
export function colorRowError(fieldErrors: Record<string, string>, index: number, field: string): string | undefined {
  return fieldErrors[`colors.${index}.${field}`];
}

/** The "Bahan baru" form's repeatable color editor — unlike {@link
 * ../_components/fabric-colors-section}'s FabricColorsSection (which edits colors of an ALREADY
 * saved fabric one at a time via its own server actions), this is pure local state: rows are only
 * sent to the server once, together with the rest of the fabric form, when the whole form is
 * submitted. A row left completely empty is simply ignored server-side. */
export function NewFabricColorRows({
  rows,
  onChange,
  fieldErrors = {},
  disabled = false,
}: {
  rows: DraftColorRow[];
  onChange: (rows: DraftColorRow[]) => void;
  fieldErrors?: Record<string, string>;
  disabled?: boolean;
}) {
  // Only used for rows added after mount (the click handler below never runs during SSR), so
  // there's no hydration-mismatch risk here the way there would be inside a lazy useState
  // initializer — see createInitialColorRow's doc comment.
  const idPrefix = useId();
  const nextRowNumber = useRef(0);

  function update(index: number, patch: Partial<DraftColorRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function addRow() {
    nextRowNumber.current += 1;
    onChange([...rows, { key: `${idPrefix}-${nextRowNumber.current}`, name: "", supplierColorCode: "", hex: "" }]);
  }

  return (
    <div className="flex flex-col gap-3">
      <Label>Warna</Label>
      <ul className="flex flex-col gap-3">
        {rows.map((row, index) => {
          const label = row.name.trim() || `baris ${index + 1}`;
          return (
            <li
              key={row.key}
              className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-3 sm:flex-row sm:items-start"
            >
              <ColorSwatch hex={row.hex} className="size-6" />
              <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:flex-wrap">
                <div className="flex flex-1 flex-col gap-1.5 sm:min-w-36">
                  <Label htmlFor={`new-color-name-${row.key}`}>Nama warna</Label>
                  <Input
                    id={`new-color-name-${row.key}`}
                    value={row.name}
                    onChange={(event) => update(index, { name: event.target.value })}
                    placeholder="mis. Sage"
                    error={colorRowError(fieldErrors, index, "name")}
                    disabled={disabled}
                  />
                </div>
                <div className="flex flex-1 flex-col gap-1.5 sm:min-w-32">
                  <Label htmlFor={`new-color-supplier-${row.key}`}>Kode pemasok (opsional)</Label>
                  <Input
                    id={`new-color-supplier-${row.key}`}
                    value={row.supplierColorCode}
                    onChange={(event) => update(index, { supplierColorCode: event.target.value })}
                    placeholder="mis. No. 23"
                    disabled={disabled}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`new-color-hex-${row.key}`}>Kode warna (opsional)</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={`Pilih warna untuk ${label}`}
                      value={row.hex || "#9CA3AF"}
                      onChange={(event) => update(index, { hex: event.target.value })}
                      disabled={disabled}
                      className="size-11 shrink-0 rounded border border-neutral-500"
                    />
                    <Input
                      id={`new-color-hex-${row.key}`}
                      value={row.hex}
                      onChange={(event) => update(index, { hex: event.target.value })}
                      placeholder="#RRGGBB"
                      className="w-28"
                      error={colorRowError(fieldErrors, index, "hex")}
                      disabled={disabled}
                    />
                  </div>
                </div>
              </div>
              <Button
                type="button"
                variant="danger"
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
                disabled={disabled}
                aria-label={`Hapus warna ${label}`}
              >
                Hapus
              </Button>
            </li>
          );
        })}
      </ul>
      <Button type="button" variant="secondary" onClick={addRow} disabled={disabled}>
        + Tambah warna
      </Button>
    </div>
  );
}
