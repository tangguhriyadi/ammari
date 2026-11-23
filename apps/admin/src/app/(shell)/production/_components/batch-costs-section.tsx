import { formatRupiah } from "@ammari/ui/lib";
import { Badge, Card } from "@ammari/ui";
import { getBatchAccessoryConsumption, getBatchCosts, getBatchExtraCosts, getBatchFabricConsumption, type BatchLineRow } from "@/lib/production/queries";
import { FabricColorLabel } from "@/components/fabric-color-label";
import { getCurrentCostAssumption } from "@/lib/products/queries";
import { calculateBatasHpp } from "@/lib/products/batas-hpp";
import { unabsorbedValue, type BatchReceiptSummary } from "@/lib/receipts/production";
import type { DocumentDefectMovementRow } from "@/lib/defects/queries";
import { batchVariance, summarizeDefectValues } from "@/lib/defects/variance";
import { DefectReleaseRows, formatNetLoss, VarianceRow } from "../../purchases/_components/defect-variance";

/** Only ever rendered by the caller (batch detail page) when the session holds
 * finance.view_profit — see ProductBatasHpp in products/[id]/page.tsx for the identical
 * pattern. getBatchCosts/getBatchExtraCosts/getBatchAccessoryConsumption are the ONLY queries
 * that read cost data, so a session without the permission never triggers this component (or
 * those queries) at all.
 *
 * Breakdown groups (plan requirement): Kain, Aksesoris (per item), Biaya variabel, Biaya tetap,
 * Total, HPP/pcs — plus, on a short-closed batch, "Nilai belum terserap" (§4.3, S4): the frozen
 * cost of the planned pcs that never arrived — and, once the batch has output, the §4.3 variance
 * (S6): defect value still held, released per type (Hibah and Dibuang separate, D29), proceeds,
 * "Kerugian bersih barang cacat" and "HPP riil per pcs". HPP/pcs itself is never rewritten. */
export async function BatchCostsSection({
  batchId,
  fabricYards,
  lines,
  receiptSummary,
  defectRows = [],
}: {
  batchId: string;
  fabricYards: number | null;
  lines: BatchLineRow[];
  receiptSummary?: BatchReceiptSummary | null;
  /** The batch's defect rows WITH value (this section only renders for finance.view_profit). */
  defectRows?: readonly DocumentDefectMovementRow[];
}) {
  const costs = await getBatchCosts(batchId);
  if (!costs) return null;
  const extraCosts = await getBatchExtraCosts(batchId);
  const accessoryConsumption = await getBatchAccessoryConsumption(batchId);
  // Per colour bucket (docs/plans/fabric-colour-stock.md S5); one colourless row for a batch
  // posted before stock per colour.
  const fabricConsumption = await getBatchFabricConsumption(batchId);
  const variableCosts = extraCosts.filter((line) => line.costType === "variable");
  const fixedCosts = extraCosts.filter((line) => line.costType === "fixed");
  const accessoryTotal = accessoryConsumption.reduce((sum, row) => sum + row.valueAmount, 0);
  const variableTotal = variableCosts.reduce((sum, line) => sum + line.total, 0);
  const fixedTotal = fixedCosts.reduce((sum, line) => sum + line.total, 0);
  const totalCost = costs.fabricCostAmount + accessoryTotal + variableTotal + fixedTotal;
  const costAssumption = await getCurrentCostAssumption();
  // HPP per product (migration 0047): every line of one product shares one unit cost, written at
  // posting. Without scoped cost lines every product has the same one, shown as a single HPP/pcs.
  const productHpp = summarizeProductHpp({
    lines,
    sharedTotal: costs.fabricCostAmount + accessoryTotal + extraCosts.filter((line) => line.productId === null).reduce((sum, line) => sum + line.total, 0),
    extraCosts,
  });
  const hasScopedCosts = extraCosts.some((line) => line.productId !== null);
  const uniformUnitCost = !hasScopedCosts && new Set(productHpp.map((row) => row.unitCostAmount)).size === 1 ? productHpp[0]!.unitCostAmount : null;
  const unitCostByLineId = new Map(lines.map((line) => [line.id, line.unitCostAmount]));
  const unabsorbed =
    receiptSummary?.receiptStatus === "closed"
      ? unabsorbedValue(receiptSummary.lines.map((line) => ({ outstanding: line.outstanding, unitCostAmount: unitCostByLineId.get(line.id) ?? 0 })))
      : null;
  const defects = summarizeDefectValues(defectRows);
  const variance =
    receiptSummary && defects
      ? batchVariance({
          lines: receiptSummary.lines.map((line) => ({ received: line.received, outstanding: line.outstanding, unitCostAmount: unitCostByLineId.get(line.id) ?? 0 })),
          closed: receiptSummary.receiptStatus === "closed",
          defects,
        })
      : null;
  const showVariance = variance !== null && (variance.sellablePcs > 0 || defectRows.length > 0);

  return (
    <Card className="flex flex-col gap-4">
      <p className="text-sm text-neutral-600">Biaya batch</p>

      <div>
        <dt className="text-sm text-neutral-600">Kain</dt>
        <dd className="font-semibold text-neutral-900 tabular-nums">
          {formatRupiah(costs.fabricCostAmount)}
          {fabricYards !== null && <span className="text-sm text-neutral-600"> ({fabricYards} yard)</span>}
        </dd>
        {fabricConsumption.length > 1 || fabricConsumption.some((row) => row.fabricColorId !== null) ? (
          <ul className="mt-1 flex flex-col gap-1">
            {fabricConsumption.map((row) => (
              <li
                key={row.fabricColorId ?? "none"}
                data-testid="batch-fabric-cost"
                className="flex items-center justify-between gap-2 text-sm text-neutral-700"
              >
                <span className="inline-flex items-center gap-2">
                  <FabricColorLabel name={row.colorName} hex={row.colorHex} testId="batch-fabric-cost-color" />
                  <span className="tabular-nums">({row.qty.toFixed(2)} yard)</span>
                </span>
                <span className="tabular-nums" data-testid="batch-fabric-cost-value">
                  {formatRupiah(row.valueAmount)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {accessoryConsumption.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-neutral-600">Aksesoris</p>
          {accessoryConsumption.map((row) => (
            <div key={row.accessoryId} className="flex items-center justify-between gap-2 text-sm text-neutral-700">
              <span className="flex items-center gap-2">
                {row.accessoryName} ({row.qty} pcs)
                {/* A production.manage session (which may lack finance.view_profit) can override
                    an accessory's needed qty before posting, changing this line's recorded cost —
                    flagged here so a finance viewer can audit it (see getBatchAccessoryConsumption's
                    own doc comment). */}
                {row.overridden && <Badge variant="neutral">Override</Badge>}
              </span>
              <span className="tabular-nums">{formatRupiah(row.valueAmount)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 text-sm font-medium text-neutral-900">
            <span>Subtotal aksesoris</span>
            <span className="tabular-nums">{formatRupiah(accessoryTotal)}</span>
          </div>
        </div>
      )}

      {variableCosts.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-neutral-600">Biaya variabel</p>
          {variableCosts.map((line) => (
            <div key={line.id} className="flex items-center justify-between gap-2 text-sm text-neutral-700">
              <span>
                {line.componentName} ({line.quantity} {line.componentUnit} × {formatRupiah(line.unitPrice)})
                <CostLineScope productName={line.productName} productId={line.productId} />
                {line.supplierName !== null && <span className="block text-neutral-600">Supplier: {line.supplierName}</span>}
              </span>
              <span className="tabular-nums">{formatRupiah(line.total)}</span>
            </div>
          ))}
        </div>
      )}

      {fixedCosts.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-neutral-600">Biaya tetap</p>
          {fixedCosts.map((line) => (
            <div key={line.id} className="flex items-center justify-between gap-2 text-sm text-neutral-700">
              <span>
                {line.componentName}
                <CostLineScope productName={line.productName} productId={line.productId} />
                {line.supplierName !== null && <span className="block text-neutral-600">Supplier: {line.supplierName}</span>}
              </span>
              <span className="tabular-nums">{formatRupiah(line.total)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t border-neutral-200 pt-3 text-base">
        <dt className="text-neutral-600">Total biaya</dt>
        <dd className="font-semibold text-neutral-900 tabular-nums">{formatRupiah(totalCost)}</dd>
      </div>

      {uniformUnitCost !== null ? (
        <div className="flex items-center justify-between gap-2 text-base">
          <dt className="text-neutral-600">HPP/pcs</dt>
          <dd className="font-semibold text-neutral-900 tabular-nums">{formatRupiah(uniformUnitCost)}</dd>
        </div>
      ) : (
        productHpp.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-base text-neutral-600">HPP per produk</p>
            <ul className="flex flex-col gap-2">
              {productHpp.map((row) => (
                <li key={row.productId} data-testid="batch-product-hpp" className="flex flex-col gap-1 text-sm text-neutral-700">
                  <div className="flex items-center justify-between gap-2 text-base">
                    <span className="text-neutral-900">
                      {row.productName} <span className="text-sm text-neutral-600">({row.pcs} pcs)</span>
                    </span>
                    <span className="font-semibold text-neutral-900 tabular-nums" data-testid="batch-product-hpp-value">
                      {formatRupiah(row.unitCostAmount)}/pcs
                    </span>
                  </div>
                  <span className="tabular-nums">Biaya bersama {formatRupiah(Math.round(row.sharedPerPcs))}/pcs</span>
                  {row.scopedTotal > 0 && (
                    <span className="tabular-nums">Biaya khusus produk {formatRupiah(Math.round(row.scopedTotal / row.pcs))}/pcs</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-sm text-neutral-600">Rincian per pcs dibulatkan; HPP dibulatkan ke atas.</p>
          </div>
        )
      )}

      {unabsorbed !== null && (
        <div className="flex items-center justify-between gap-2 text-base">
          <dt className="text-neutral-600">Nilai belum terserap</dt>
          <dd className="font-semibold text-neutral-900 tabular-nums">{formatRupiah(unabsorbed)}</dd>
        </div>
      )}

      {showVariance && variance && (
        <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3" data-testid="variance-panel">
          <p className="text-sm font-medium text-neutral-900">Barang cacat dan HPP riil</p>
          <VarianceRow label="Nilai diterima" hint={`${variance.sellablePcs} pcs masuk stok`} value={formatRupiah(variance.sellableValue)} />
          <DefectReleaseRows defects={variance.defects} />
          {variance.defects.releasedTotal === 0 && variance.defects.netLoss === 0 && (
            <VarianceRow label="Kerugian bersih barang cacat" value={formatNetLoss(0)} />
          )}
          {variance.hppRiilPerPcs !== null && (
            <VarianceRow
              label="HPP riil per pcs"
              hint={
                variance.provisional
                  ? "Sementara: masih ada barang cacat disimpan atau hasil yang ditunggu"
                  : "Nilai diterima ditambah kerugian bersih dan nilai belum terserap, dibagi pcs yang masuk stok"
              }
              value={formatRupiah(variance.hppRiilPerPcs)}
              strong
            />
          )}
        </div>
      )}

      {costAssumption && lines.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-neutral-600">HPP per pcs vs Batas HPP</p>
          {lines.map((line) => {
            const batasHpp = calculateBatasHpp(line.productBasePrice, costAssumption);
            const isOver = line.unitCostAmount > batasHpp;
            return (
              <div key={line.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-neutral-700">
                  {line.productName} · {line.colorName} · {line.size === "ALLSIZE" ? "All Size" : line.size}
                </span>
                <span className="flex items-center gap-2 tabular-nums">
                  {formatRupiah(line.unitCostAmount)}
                  <Badge variant={isOver ? "danger" : "success"}>{isOver ? "Di atas Batas HPP" : "Di bawah Batas HPP"}</Badge>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function CostLineScope({ productId, productName }: { productId: string | null; productName: string | null }) {
  if (productId === null) return null;
  return <span className="block text-neutral-600">Berlaku untuk: {productName ?? "produk lain"}</span>;
}

interface ProductHppRow {
  productId: string;
  productName: string;
  pcs: number;
  /** The frozen HPP written to this product's lines at posting. */
  unitCostAmount: number;
  sharedPerPcs: number;
  scopedTotal: number;
}

/** One row per product of the batch, by name. The HPP itself is read back from the lines (never
 * recomputed); the shared and product-only parts are the breakdown that led to it. */
function summarizeProductHpp(params: {
  lines: readonly BatchLineRow[];
  sharedTotal: number;
  extraCosts: readonly { productId: string | null; total: number }[];
}): ProductHppRow[] {
  const totalPcs = params.lines.reduce((sum, line) => sum + line.qty, 0);
  if (totalPcs === 0) return [];
  const byProduct = new Map<string, ProductHppRow>();
  for (const line of params.lines) {
    const current = byProduct.get(line.productId);
    if (current) {
      current.pcs += line.qty;
      continue;
    }
    byProduct.set(line.productId, {
      productId: line.productId,
      productName: line.productName,
      pcs: line.qty,
      unitCostAmount: line.unitCostAmount,
      sharedPerPcs: params.sharedTotal / totalPcs,
      scopedTotal: 0,
    });
  }
  for (const cost of params.extraCosts) {
    if (cost.productId === null) continue;
    const row = byProduct.get(cost.productId);
    if (row) row.scopedTotal += cost.total;
  }
  return [...byProduct.values()].sort((a, b) => a.productName.localeCompare(b.productName, "id"));
}
