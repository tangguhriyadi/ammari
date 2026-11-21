"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { Button, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import type { EligibleSkuRow, ProductUsingFabricRow } from "@/lib/production/queries";
import type { SupplierOption } from "@/lib/suppliers/queries";
import type { FabricUsageStock } from "@/lib/production/fabric-usage-stock";
import { parseDecimalQuantity } from "@/lib/production/decimal-quantity";
import { estimateFabricUsageCost, formatYardsInput, pcsByFabricColor, splitYardsByPcs } from "@/lib/production/fabric-usage";
import {
  createDraftAction,
  getFabricUsageStockAction,
  listProductsUsingFabricAction,
  suggestEligibleSkusAction,
  updateDraftAction,
} from "../actions";
import { FabricUsageSection, fabricColorIdOf, sourceOf, type FabricUsageRowState } from "./fabric-usage-section";
import { BatchLinePicker } from "./batch-line-picker";
import { ExtraCostLines, type ActiveCostComponentOption, type ExtraCostLineState } from "./extra-cost-lines";

interface FabricOption {
  id: string;
  name: string;
}

interface ProductionBatchFormCommonProps {
  initialValues: {
    fabricId: string;
    producedAt: string;
    fabricYards: number | null;
    notes: string;
    lines: { sku: string; qty: number }[];
    /** The draft's saved usage rows (edit mode). Empty: the form starts on the default split by
     * pcs, which is also what a draft saved before stock per colour opens with. */
    fabricUsages: { fabricColorId: string | null; colorName: string | null; colorHex: string | null; colorIsActive: boolean; yards: number }[];
  };
  /** The selected fabric's eligible SKUs — for create mode, this is re-fetched client-side
   * (`suggestEligibleSkusAction`) whenever the fabric select changes, since the initial server
   * render has no fabric selected yet. */
  eligibleSkus: EligibleSkuRow[];
  /** Whether this session holds finance.view_profit — gates the whole cost section (fabric-cost
   * estimate + "Biaya lain"), same discipline as every other cost figure in this feature. */
  canViewProfit: boolean;
  initialExtraCosts?: ExtraCostLineState[];
  /** Only meaningful (and only ever non-empty) when canViewProfit — harmless to pass `[]`
   * otherwise. */
  activeCostComponents: ActiveCostComponentOption[];
  /** Active suppliers for the cost lines' picker — same canViewProfit-only contract as
   * activeCostComponents. */
  supplierOptions: SupplierOption[];
}

// A discriminated union, not optional `batchId?`/`fabrics?`/`fixedFabricName?` on a single
// shape — "edit" always has a real `batchId` to submit to and a fixed fabric (+ its current
// stock balance, for the yards->cost estimate) to display; "create" always has a fabric list to
// pick from. This lets the compiler enforce that pairing instead of a human-maintained `batchId!`
// non-null assertion at the one call site that needs it.
export type ProductionBatchFormProps =
  | ({ mode: "create"; fabrics: FabricOption[] } & ProductionBatchFormCommonProps)
  | ({
      mode: "edit";
      batchId: string;
      fixedFabricName: string;
      /** The fabric's stock per colour bucket (values stripped without finance.view_profit). */
      fixedFabricStock: FabricUsageStock[];
    } & ProductionBatchFormCommonProps);

function initialUsageRows(usages: ProductionBatchFormCommonProps["initialValues"]["fabricUsages"]): FabricUsageRowState[] {
  return usages.map((usage) => ({ key: sourceOf(usage.fabricColorId), source: sourceOf(usage.fabricColorId), yards: formatYardsInput(usage.yards) }));
}

/** Every bucket a usage row may draw from: the fabric's buckets with stock, "Tanpa warna" always
 * (old stock is all there), plus any colour a saved row already uses (e.g. since deactivated). */
function usageBuckets(
  stock: FabricUsageStock[],
  saved: ProductionBatchFormCommonProps["initialValues"]["fabricUsages"],
  skuColors: readonly Pick<EligibleSkuRow, "colorId" | "colorName" | "colorHex">[],
): FabricUsageStock[] {
  const buckets = [...stock];
  const has = (fabricColorId: string | null) => buckets.some((bucket) => bucket.fabricColorId === fabricColorId);
  for (const usage of saved) {
    if (usage.fabricColorId !== null && !has(usage.fabricColorId)) {
      buckets.push({ fabricColorId: usage.fabricColorId, name: usage.colorName, hex: usage.colorHex, isActive: usage.colorIsActive, qty: 0, valueAmount: null });
    }
  }
  // A SKU's colour the stock list leaves out (an inactive colour without history): the default
  // split can still name it, so it needs an option, or the <select> would show another colour.
  for (const sku of skuColors) {
    if (!has(sku.colorId)) {
      buckets.push({ fabricColorId: sku.colorId, name: sku.colorName, hex: sku.colorHex, isActive: false, qty: 0, valueAmount: null });
    }
  }
  const colors = buckets.filter((bucket) => bucket.fabricColorId !== null).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "id"));
  const colorless = buckets.find((bucket) => bucket.fabricColorId === null) ?? { fabricColorId: null, name: null, hex: null, isActive: true, qty: 0, valueAmount: null };
  return [...colors, colorless];
}

export function ProductionBatchForm(props: ProductionBatchFormProps) {
  const {
    mode,
    initialValues,
    eligibleSkus: initialEligibleSkus,
    canViewProfit,
    initialExtraCosts,
    activeCostComponents,
    supplierOptions,
  } = props;
  const router = useRouter();
  const toast = useToast();
  const [fabricId, setFabricId] = useState(initialValues.fabricId);
  const [eligibleSkus, setEligibleSkus] = useState(initialEligibleSkus);
  const [fabricStock, setFabricStock] = useState<FabricUsageStock[]>(props.mode === "edit" ? props.fixedFabricStock : []);
  // "auto" = the rows ARE the default split of the yards by pcs per colour (A4), recomputed as the
  // yards or pcs change; "manual" = the staff edited a row, so the rows stay as she left them and
  // the yards follow their sum. A saved draft with rows opens in "manual" (her rows are kept).
  const [usageMode, setUsageMode] = useState<"auto" | "manual">(initialValues.fabricUsages.length > 0 ? "manual" : "auto");
  const [manualUsageRows, setManualUsageRows] = useState<FabricUsageRowState[]>(() => initialUsageRows(initialValues.fabricUsages));
  const [producedAt, setProducedAt] = useState(initialValues.producedAt);
  const [fabricYardsText, setFabricYardsText] = useState(
    initialValues.fabricYards !== null ? String(initialValues.fabricYards) : "",
  );
  const [notes, setNotes] = useState(initialValues.notes);
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(initialValues.lines.map((line) => [line.sku, line.qty])),
  );
  const [extraCostLines, setExtraCostLines] = useState<ExtraCostLineState[]>(initialExtraCosts ?? []);
  // Create mode only — which product(s) are tied to the selected fabric, regardless of whether
  // any of their variants are currently active (see ExtraCostLines' own doc comment: this is
  // what turns the misleading "Isi jumlah pcs (SKU) dulu…" message into a correct "produk ini
  // belum punya varian aktif" one, with a link to go fix it). `[]` whenever no fabric is
  // selected, or (edit mode) always — editing a draft's fabric is fixed and was already past
  // this exact setup step when the batch was first created.
  const [productsUsingFabric, setProductsUsingFabric] = useState<ProductUsingFabricRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();
  const [, startFabricLoad] = useTransition();

  // Create mode only (the Select branch below) — editing a draft's fabric is fixed, so there is
  // nothing to re-fetch. Re-fetches the eligible-SKU list AND (when this session can see costs)
  // the fabric's current stock balance every time a non-empty fabric is picked; an empty/cleared
  // selection is handled by `visibleEligibleSkus` below instead of a synchronous setState here.
  useEffect(() => {
    if (mode !== "create" || !fabricId) return;
    // Guards against a stale response winning a race: if the fabric is switched again (A -> B)
    // before A's fetch resolves, both requests are in flight and there's no guarantee B's
    // response arrives last — without this flag, A's slower response could overwrite B's
    // already-applied eligible-SKU list/quantities after the user has moved on.
    let ignore = false;
    startFabricLoad(async () => {
      const [rows, stock, productsForFabric] = await Promise.all([
        suggestEligibleSkusAction(fabricId),
        getFabricUsageStockAction(fabricId),
        listProductsUsingFabricAction(fabricId),
      ]);
      if (ignore) return;
      setEligibleSkus(rows);
      // A fabric switch invalidates any previously staged quantities (they belonged to the OLD
      // fabric's SKUs) — clear rather than silently carrying over qty for SKUs no longer shown.
      setQuantities({});
      setFabricStock(stock);
      setUsageMode("auto");
      setManualUsageRows([]);
      setProductsUsingFabric(productsForFabric);
    });
    return () => {
      ignore = true;
    };
  }, [fabricId, mode]);

  const visibleEligibleSkus = mode === "create" && !fabricId ? [] : eligibleSkus;

  const fabricYardsNumber = parseDecimalQuantity(fabricYardsText);
  const lines = Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([sku, qty]) => ({ sku, qty }));
  const totalPcs = lines.reduce((sum, line) => sum + line.qty, 0);
  const yardsPerPcs = fabricYardsNumber !== null && totalPcs > 0 ? fabricYardsNumber / totalPcs : null;

  // Pcs per fabric colour (every SKU maps to one colour), colours by name.
  const pcsByColor = useMemo(() => {
    // eligibleSkus, not visibleEligibleSkus: with no fabric picked `quantities` is empty anyway.
    const colorBySku = new Map(eligibleSkus.map((row) => [row.sku, row]));
    const colorLines = Object.entries(quantities).flatMap(([sku, qty]) => {
      const row = colorBySku.get(sku);
      return row ? [{ colorId: row.colorId, colorName: row.colorName, qty }] : [];
    });
    colorLines.sort((a, b) => a.colorName.localeCompare(b.colorName, "id"));
    return pcsByFabricColor(colorLines);
  }, [eligibleSkus, quantities]);

  const buckets = useMemo(
    () => usageBuckets(fabricStock, initialValues.fabricUsages, eligibleSkus),
    [fabricStock, initialValues.fabricUsages, eligibleSkus],
  );
  const defaultUsageRows: FabricUsageRowState[] = splitYardsByPcs(fabricYardsNumber, pcsByColor).map((row) => ({
    key: sourceOf(row.fabricColorId),
    source: sourceOf(row.fabricColorId),
    yards: formatYardsInput(row.yards),
  }));
  const usageRows = usageMode === "auto" ? defaultUsageRows : manualUsageRows;

  /** A row edit switches to manual rows (starting from what is on screen); the yards follow. */
  function changeUsageRows(next: FabricUsageRowState[]) {
    setUsageMode("manual");
    setManualUsageRows(next);
    const centi = next.reduce((sum, row) => sum + Math.round((parseDecimalQuantity(row.yards) ?? 0) * 100), 0);
    setFabricYardsText(centi > 0 ? formatYardsInput(centi / 100) : "");
  }

  // What the rows were on open: the saved rows, or (a draft saved before stock per colour, or a new
  // one) the default split of the saved yards, so opening such a draft is not "unsaved changes".
  const [initialUsageSnapshot] = useState(() => {
    if (initialValues.fabricUsages.length > 0) return initialUsageRows(initialValues.fabricUsages).map((row) => [row.source, row.yards]);
    const colorBySku = new Map(initialEligibleSkus.map((row) => [row.sku, row]));
    const initialPcs = pcsByFabricColor(
      initialValues.lines
        .flatMap((line) => {
          const row = colorBySku.get(line.sku);
          return row ? [{ colorId: row.colorId, colorName: row.colorName, qty: line.qty }] : [];
        })
        .sort((a, b) => a.colorName.localeCompare(b.colorName, "id")),
    );
    return splitYardsByPcs(initialValues.fabricYards, initialPcs).map((row) => [sourceOf(row.fabricColorId), formatYardsInput(row.yards)]);
  });

  const isDirty =
    fabricId !== initialValues.fabricId ||
    producedAt !== initialValues.producedAt ||
    fabricYardsText !== (initialValues.fabricYards !== null ? String(initialValues.fabricYards) : "") ||
    notes !== initialValues.notes ||
    JSON.stringify(quantities) !== JSON.stringify(Object.fromEntries(initialValues.lines.map((l) => [l.sku, l.qty]))) ||
    JSON.stringify(usageRows.map((row) => [row.source, row.yards])) !==
      JSON.stringify(initialUsageSnapshot) ||
    (initialExtraCosts ? JSON.stringify(extraCostLines) !== JSON.stringify(initialExtraCosts) : false);
  useUnsavedChangesGuard(isDirty, "Ada perubahan batch produksi yang belum disimpan. Tinggalkan halaman ini?");

  const parsedUsageRows = usageRows.map((row) => ({ fabricColorId: fabricColorIdOf(row.source), yards: parseDecimalQuantity(row.yards) }));
  const estimatedFabricCost =
    canViewProfit && parsedUsageRows.every((row) => row.yards !== null)
      ? estimateFabricUsageCost(
          parsedUsageRows.map((row) => ({ fabricColorId: row.fabricColorId, yards: row.yards! })),
          (fabricColorId) => {
            const bucket = buckets.find((candidate) => candidate.fabricColorId === fabricColorId);
            return bucket && bucket.valueAmount !== null ? { qty: bucket.qty, valueAmount: bucket.valueAmount } : undefined;
          },
        )
      : null;

  function handleSubmit() {
    setError(null);
    // Early hints only; the server validates again (ownership, duplicates, the sum).
    if (parsedUsageRows.some((row) => row.yards === null)) {
      setError("Isi yard pemakaian kain dengan angka lebih dari 0, maksimal 2 desimal.");
      return;
    }
    const seenSources = new Set<string>();
    for (const row of usageRows) {
      if (seenSources.has(row.source)) {
        const bucket = buckets.find((candidate) => sourceOf(candidate.fabricColorId) === row.source);
        setError(`Warna ${bucket?.name ?? "Tanpa warna"} muncul dua kali di pemakaian kain.`);
        return;
      }
      seenSources.add(row.source);
    }
    startTransition(async () => {
      const payload = {
        producedAt,
        fabricYards: fabricYardsText,
        notes,
        lines,
        fabricUsages: usageRows.map((row) => ({ fabricColorId: fabricColorIdOf(row.source), yards: row.yards })),
        extraCosts: initialExtraCosts !== undefined
          ? extraCostLines.map((line) => ({
              id: line.id,
              costComponentId: line.costComponentId,
              unitPrice: line.unitPrice,
              supplierId: line.supplierId || null,
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
      toast.success(props.mode === "create" ? "Batch produksi berhasil ditambahkan" : "Perubahan berhasil disimpan");
      router.push("/production");
    });
  }

  return (
    <form
      className="flex max-w-3xl flex-col gap-6"
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
            onChange={(event) => {
              // Typing the total re-splits it by pcs (A4); the rows below follow.
              setFabricYardsText(event.target.value);
              setUsageMode("auto");
            }}
            placeholder="0"
            aria-describedby="batch-fabric-yards-hint"
          />
          <p id="batch-fabric-yards-hint" className="mt-1 text-sm text-neutral-600">
            Mengubah jumlah yard membagi ulang pemakaian kain sesuai pcs.
          </p>
        </div>
      </div>

      {/* Non-blocking — a genuinely thick fabric or a small batch can legitimately exceed 6
          yard/pcs, this is just a second look against a typo (e.g. an extra digit). */}
      {yardsPerPcs !== null && yardsPerPcs > 6 && (
        <p role="status" className="text-base text-warning-700">
          Pemakaian kain {yardsPerPcs.toFixed(2)} yard/pcs. Pastikan tidak salah ketik.
        </p>
      )}

      <div>
        <Label htmlFor="batch-notes">Catatan</Label>
        <Textarea id="batch-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} />
      </div>

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

      {fabricId && (
        <FabricUsageSection
          rows={usageRows}
          buckets={buckets}
          isDefaultSplit={usageMode === "auto"}
          canResplit={fabricYardsNumber !== null && pcsByColor.length > 0}
          onRowsChange={changeUsageRows}
          onResplit={() => setUsageMode("auto")}
        />
      )}

      {canViewProfit && (
        <>
          <div>
            <span className="text-sm font-medium text-neutral-900">Biaya bahan (estimasi)</span>
            <p className="min-h-11 content-center text-base text-neutral-900 tabular-nums">
              {estimatedFabricCost !== null ? formatRupiah(estimatedFabricCost) : "-"}
            </p>
            <p className="text-sm text-neutral-600">
              Dihitung dari rata-rata harga beli tiap warna saat ini × yard pemakaiannya. Nilai final dihitung ulang saat posting.
            </p>
          </div>
          <ExtraCostLines
            activeComponents={activeCostComponents}
            supplierOptions={supplierOptions}
            lines={extraCostLines}
            onChange={setExtraCostLines}
            totalPcs={totalPcs}
            productsUsingFabric={productsUsingFabric}
          />
        </>
      )}
      {!canViewProfit && mode === "edit" && (
        <p className="text-sm text-neutral-600">Biaya hanya bisa dilihat dan diisi oleh pemilik.</p>
      )}

      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {mode === "create" && (
          <Link href="/production">
            <Button type="button" variant="secondary">
              Batal
            </Button>
          </Link>
        )}
        <Button type="submit" loading={saving}>
          Simpan draf
        </Button>
      </div>
    </form>
  );
}
