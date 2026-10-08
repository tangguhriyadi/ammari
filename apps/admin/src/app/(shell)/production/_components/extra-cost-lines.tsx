"use client";

import { Button, Input, Label, Select } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { CostComponentType, CostComponentUnit } from "@ammari/db/schema";
import { previewLineTotal } from "@/lib/production/line-total-preview";

export interface ActiveCostComponentOption {
  id: string;
  name: string;
  unit: CostComponentUnit;
  costType: CostComponentType;
  defaultUnitPrice: number | null;
}

export interface ExtraCostLineState {
  /** Present only for a line that already exists on the server — see
   * lib/production/queries.ts's syncExtraCostLines for why this id matters (an existing line's
   * component/name/unit/cost_type snapshot is frozen and never re-picked; only a brand new line
   * picks a component at all). */
  id?: string;
  /** Stable React key independent of array position — a freshly-added line has no server `id`
   * yet, and keying it off its array index would make React tear down and remount every LATER
   * new line's Select/Inputs (losing focus mid-edit) whenever an earlier line is removed. Callers
   * constructing initial state from existing server rows should set this to that row's own `id`
   * (already stable); `addLine` below generates a fresh one for a new row. Never submitted to
   * the server — the submit payload maps only id/costComponentId/unitPrice. */
  clientKey: string;
  costComponentId: string;
  /** Display only for an EXISTING line (its frozen snapshot); irrelevant for a new one, whose
   * name is whatever the Select currently shows. */
  componentName?: string;
  /** For an EXISTING line, this is its frozen cost_type snapshot (never re-picked, same as
   * componentName). For a NEW line, it tracks whichever component is currently selected in the
   * dropdown (kept in sync by the Select's onChange below). Drives the price field's label
   * ("Harga per pcs" vs "Nominal") and how its preview subtotal is computed — there is no
   * `quantity` field here at all: it's always the batch's total pcs (variable) or exactly 1
   * (fixed), computed server-side (see ExtraCostLineInput's own doc comment in queries.ts). */
  costType: CostComponentType;
  unitPrice: string;
}

export interface ExtraCostLinesProps {
  activeComponents: ActiveCostComponentOption[];
  lines: ExtraCostLineState[];
  onChange: (lines: ExtraCostLineState[]) => void;
  /** The batch's current total pcs (summed across its lines) — a 'variable' line's effective
   * quantity for the live preview total below. */
  totalPcs: number;
}

function effectiveQuantity(line: ExtraCostLineState, totalPcs: number): number {
  return line.costType === "variable" ? totalPcs : 1;
}

/** The "Biaya lain" section of a production batch draft — only ever rendered by the caller when
 * the session holds finance.view_profit (see ProductionBatchForm), same gating as the fabric
 * cost estimate right above it. */
export function ExtraCostLines({ activeComponents, lines, onChange, totalPcs }: ExtraCostLinesProps) {
  const componentById = new Map(activeComponents.map((component) => [component.id, component]));

  function updateLine(index: number, patch: Partial<ExtraCostLineState>) {
    onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  function removeLine(index: number) {
    onChange(lines.filter((_, i) => i !== index));
  }

  function addLine() {
    const first = activeComponents[0];
    onChange([
      ...lines,
      {
        clientKey: crypto.randomUUID(),
        costComponentId: first?.id ?? "",
        costType: first?.costType ?? "variable",
        unitPrice: first?.defaultUnitPrice !== null && first?.defaultUnitPrice !== undefined ? String(first.defaultUnitPrice) : "",
      },
    ]);
  }

  const grandTotal = lines.reduce((sum, line) => {
    const unitPrice = Number.parseInt(line.unitPrice, 10);
    if (!Number.isFinite(unitPrice)) return sum;
    return sum + previewLineTotal(effectiveQuantity(line, totalPcs), unitPrice);
  }, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-neutral-900">Biaya lain</h2>
        <Button type="button" variant="secondary" onClick={addLine} disabled={activeComponents.length === 0}>
          + Tambah biaya
        </Button>
      </div>
      {activeComponents.length === 0 && lines.length === 0 && (
        <p className="text-sm text-neutral-600">Belum ada komponen biaya aktif. Kelola di halaman Komponen Biaya.</p>
      )}
      {lines.map((line, index) => {
        const isExisting = Boolean(line.id);
        const unitPrice = Number.parseInt(line.unitPrice, 10);
        const quantity = effectiveQuantity(line, totalPcs);
        const lineTotal = Number.isFinite(unitPrice) && quantity > 0 ? previewLineTotal(quantity, unitPrice) : null;
        const priceLabel = line.costType === "variable" ? "Harga per pcs" : "Nominal";
        const typeLabel = line.costType === "variable" ? "Variabel" : "Tetap";

        return (
          <div key={line.clientKey} className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3">
            <div className="flex items-center justify-between gap-2">
              {isExisting ? (
                <p className="text-base text-neutral-900">
                  {line.componentName} <span className="text-sm text-neutral-600">({typeLabel})</span>
                </p>
              ) : (
                <div className="flex-1">
                  <Label htmlFor={`extra-cost-component-${index}`} className="sr-only">
                    Komponen biaya
                  </Label>
                  <Select
                    id={`extra-cost-component-${index}`}
                    value={line.costComponentId}
                    onChange={(event) => {
                      const component = componentById.get(event.target.value);
                      updateLine(index, {
                        costComponentId: event.target.value,
                        costType: component?.costType ?? line.costType,
                        unitPrice: component?.defaultUnitPrice !== null && component?.defaultUnitPrice !== undefined
                          ? String(component.defaultUnitPrice)
                          : line.unitPrice,
                      });
                    }}
                  >
                    {activeComponents.map((component) => (
                      <option key={component.id} value={component.id}>
                        {component.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => removeLine(index)}
                aria-label={`Hapus biaya ${line.componentName ?? componentById.get(line.costComponentId)?.name ?? `baris ${index + 1}`}`}
              >
                Hapus
              </Button>
            </div>
            <div>
              <Label htmlFor={`extra-cost-price-${index}`}>{priceLabel}</Label>
              <Input
                id={`extra-cost-price-${index}`}
                value={line.unitPrice}
                onChange={(event) => updateLine(index, { unitPrice: event.target.value })}
                placeholder="0"
              />
            </div>
            {line.costType === "variable" &&
              (totalPcs > 0 ? (
                <p className="text-sm text-neutral-600">× {totalPcs} pcs (otomatis, dari total baris produksi)</p>
              ) : (
                <p className="text-sm text-danger-700">Isi jumlah pcs (SKU) dulu untuk menghitung biaya variabel ini.</p>
              ))}
            {lineTotal !== null && <p className="text-sm text-neutral-600 tabular-nums">Subtotal: {formatRupiah(lineTotal)}</p>}
          </div>
        );
      })}
      {lines.length > 0 && (
        <p className="text-right text-base font-semibold text-neutral-900 tabular-nums">Total biaya lain: {formatRupiah(grandTotal)}</p>
      )}
    </div>
  );
}
