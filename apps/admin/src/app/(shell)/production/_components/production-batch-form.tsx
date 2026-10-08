"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button, Input, Label, Select, Textarea } from "@ammari/ui";
import type { FabricPriceUnit } from "@ammari/db/schema";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import type { EligibleSkuRow } from "@/lib/production/queries";
import { suggestFabricCost } from "@/lib/production/fabric-cost";
import { parseDecimalQuantity } from "@/lib/production/decimal-quantity";
import { createDraftAction, suggestEligibleSkusAction, updateDraftAction } from "../actions";
import { BatchLinePicker } from "./batch-line-picker";
import { ExtraCostLines, type ActiveCostComponentOption, type ExtraCostLineState } from "./extra-cost-lines";

export interface ProductionBatchFormCosts {
  fabricCostAmount: string;
}

interface FabricOption {
  id: string;
  name: string;
  priceAmount: number | null;
  priceUnit: FabricPriceUnit | null;
}

interface ProductionBatchFormCommonProps {
  initialValues: {
    fabricId: string;
    producedAt: string;
    fabricYards: number | null;
    notes: string;
    lines: { sku: string; qty: number }[];
  };
  /** The selected fabric's eligible SKUs — for create mode, this is re-fetched client-side
   * (`suggestEligibleSkusAction`) whenever the fabric select changes, since the initial server
   * render has no fabric selected yet. */
  eligibleSkus: EligibleSkuRow[];
  /** `undefined` when the session lacks finance.view_profit — the cost field and the whole
   * "Biaya lain" section then simply don't render at all, and nothing is submitted for them. */
  initialCosts?: ProductionBatchFormCosts;
  initialExtraCosts?: ExtraCostLineState[];
  /** Only meaningful (and only ever non-empty) when initialCosts is defined — harmless to pass
   * `[]` otherwise. */
  activeCostComponents: ActiveCostComponentOption[];
}

// A discriminated union, not optional `batchId?`/`fabrics?`/`fixedFabricName?` on a single
// shape — "edit" always has a real `batchId` to submit to and a fixed fabric (+ its price info,
// for the yards->cost prefill) to display; "create" always has a fabric list to pick from. This
// lets the compiler enforce that pairing instead of a human-maintained `batchId!` non-null
// assertion at the one call site that needs it.
export type ProductionBatchFormProps =
  | ({ mode: "create"; fabrics: FabricOption[] } & ProductionBatchFormCommonProps)
  | ({ mode: "edit"; batchId: string; fixedFabricName: string; fixedFabricPrice: { priceAmount: number | null; priceUnit: FabricPriceUnit | null } } & ProductionBatchFormCommonProps);

export function ProductionBatchForm(props: ProductionBatchFormProps) {
  const { mode, initialValues, eligibleSkus: initialEligibleSkus, initialCosts, initialExtraCosts, activeCostComponents } = props;
  const router = useRouter();
  const [fabricId, setFabricId] = useState(initialValues.fabricId);
  const [eligibleSkus, setEligibleSkus] = useState(initialEligibleSkus);
  const [producedAt, setProducedAt] = useState(initialValues.producedAt);
  const [fabricYardsText, setFabricYardsText] = useState(
    initialValues.fabricYards !== null ? String(initialValues.fabricYards) : "",
  );
  const [notes, setNotes] = useState(initialValues.notes);
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(initialValues.lines.map((line) => [line.sku, line.qty])),
  );
  const [costs, setCosts] = useState<ProductionBatchFormCosts>(initialCosts ?? { fabricCostAmount: "" });
  const [fabricCostTouched, setFabricCostTouched] = useState(false);
  const [extraCostLines, setExtraCostLines] = useState<ExtraCostLineState[]>(initialExtraCosts ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();
  const [, startFabricLoad] = useTransition();

  // Create mode only (the Select branch below) — editing a draft's fabric is fixed, so there is
  // nothing to re-fetch. Re-fetches the eligible-SKU list every time a non-empty fabric is
  // picked; an empty/cleared selection is handled by `visibleEligibleSkus` below instead of a
  // synchronous setState here.
  useEffect(() => {
    if (mode !== "create" || !fabricId) return;
    // Guards against a stale response winning a race: if the fabric is switched again (A -> B)
    // before A's fetch resolves, both requests are in flight and there's no guarantee B's
    // response arrives last — without this flag, A's slower response could overwrite B's
    // already-applied eligible-SKU list/quantities after the user has moved on.
    let ignore = false;
    startFabricLoad(async () => {
      const rows = await suggestEligibleSkusAction(fabricId);
      if (ignore) return;
      setEligibleSkus(rows);
      // A fabric switch invalidates any previously staged quantities (they belonged to the OLD
      // fabric's SKUs) — clear rather than silently carrying over qty for SKUs no longer shown.
      setQuantities({});
    });
    return () => {
      ignore = true;
    };
  }, [fabricId, mode]);

  const visibleEligibleSkus = mode === "create" && !fabricId ? [] : eligibleSkus;

  const selectedFabricPrice =
    props.mode === "create"
      ? (props.fabrics.find((fabric) => fabric.id === fabricId) ?? { priceAmount: null, priceUnit: null })
      : props.fixedFabricPrice;

  // Prefills the fabric cost from yards x the fabric's own price — same "touched" idiom as
  // product-form.tsx's codeTouched/slugTouched, but computed as a plain derived value during
  // render (not synchronized via an effect's setState, which would just trigger an extra
  // cascading render for no benefit): until the user edits the cost field themselves (the
  // vendor's actual price can differ per purchase), the INPUT shows the live suggestion instead
  // of whatever is in `costs` state; once touched, `costs` itself is the source of truth again.
  const suggestedFabricCost =
    initialCosts !== undefined ? suggestFabricCost(parseDecimalQuantity(fabricYardsText), selectedFabricPrice) : null;
  const fabricCostAmountDisplay =
    !fabricCostTouched && suggestedFabricCost !== null ? String(suggestedFabricCost) : costs.fabricCostAmount;

  const isDirty =
    fabricId !== initialValues.fabricId ||
    producedAt !== initialValues.producedAt ||
    fabricYardsText !== (initialValues.fabricYards !== null ? String(initialValues.fabricYards) : "") ||
    notes !== initialValues.notes ||
    JSON.stringify(quantities) !== JSON.stringify(Object.fromEntries(initialValues.lines.map((l) => [l.sku, l.qty]))) ||
    (initialCosts ? fabricCostAmountDisplay !== initialCosts.fabricCostAmount : false) ||
    (initialExtraCosts ? JSON.stringify(extraCostLines) !== JSON.stringify(initialExtraCosts) : false);
  useUnsavedChangesGuard(isDirty, "Ada perubahan batch produksi yang belum disimpan. Tinggalkan halaman ini?");

  const fabricYardsNumber = parseDecimalQuantity(fabricYardsText);
  const lines = Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([sku, qty]) => ({ sku, qty }));

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const payload = {
        producedAt,
        fabricYards: fabricYardsText,
        notes,
        lines,
        costs: initialCosts !== undefined ? { fabricCostAmount: fabricCostAmountDisplay } : undefined,
        extraCosts:
          initialExtraCosts !== undefined
            ? extraCostLines.map((line) => ({
                id: line.id,
                costComponentId: line.costComponentId,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
              }))
            : undefined,
      };
      const result =
        props.mode === "create"
          ? await createDraftAction({ ...payload, fabricId })
          : await updateDraftAction(props.batchId, payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/production/${result.data.id}`);
    });
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          {props.mode === "create" ? (
            <>
              <Label htmlFor="batch-fabric" required>
                Bahan
              </Label>
              <Select id="batch-fabric" value={fabricId} onChange={(event) => setFabricId(event.target.value)}>
                <option value="">Pilih bahan</option>
                {props.fabrics.map((fabric) => (
                  <option key={fabric.id} value={fabric.id}>
                    {fabric.name}
                  </option>
                ))}
              </Select>
            </>
          ) : (
            <>
              {/* Not a <Label htmlFor>, unlike the create branch above — there's no form control
                  here to point at, just a fixed, non-editable value. */}
              <span className="text-sm font-medium text-neutral-900">Bahan</span>
              <p className="min-h-11 content-center text-base text-neutral-900">{props.fixedFabricName}</p>
            </>
          )}
        </div>
        <div>
          <Label htmlFor="batch-date" required>
            Tanggal produksi
          </Label>
          <Input id="batch-date" type="date" value={producedAt} onChange={(event) => setProducedAt(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="batch-fabric-yards">Jumlah yard</Label>
          <Input
            id="batch-fabric-yards"
            inputMode="decimal"
            value={fabricYardsText}
            onChange={(event) => setFabricYardsText(event.target.value)}
            placeholder="0"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="batch-notes">Catatan</Label>
        <Textarea id="batch-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
      </div>

      {initialCosts !== undefined && (
        <>
          <div>
            {/* Not `required` — unlike a product's basePrice, this can stay blank while the
                draft is saved; only posting enforces fabric cost > 0 (see postBatch). */}
            <Label htmlFor="batch-fabric-cost">Biaya bahan</Label>
            <Input
              id="batch-fabric-cost"
              value={fabricCostAmountDisplay}
              onChange={(event) => {
                setFabricCostTouched(true);
                setCosts({ fabricCostAmount: event.target.value });
              }}
              placeholder="0"
            />
          </div>
          <ExtraCostLines activeComponents={activeCostComponents} lines={extraCostLines} onChange={setExtraCostLines} />
        </>
      )}
      {initialCosts === undefined && mode === "edit" && (
        <p className="text-sm text-neutral-600">Menunggu biaya diisi oleh pemilik.</p>
      )}

      {fabricId ? (
        <BatchLinePicker
          eligibleSkus={visibleEligibleSkus}
          quantities={quantities}
          onQtyChange={(sku, qty) => setQuantities((q) => ({ ...q, [sku]: qty }))}
          fabricYards={fabricYardsNumber}
        />
      ) : (
        <p className="text-base text-neutral-600">Pilih bahan untuk memilih SKU.</p>
      )}

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={saving}>
          Simpan draf
        </Button>
      </div>
    </form>
  );
}
