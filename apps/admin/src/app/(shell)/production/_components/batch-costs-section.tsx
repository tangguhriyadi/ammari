import { formatRupiah } from "@ammari/ui/lib";
import { Badge, Card } from "@ammari/ui";
import { getBatchCosts, getBatchExtraCosts, type BatchLineRow } from "@/lib/production/queries";
import { getCurrentCostAssumption } from "@/lib/products/queries";
import { calculateBatasHpp } from "@/lib/products/batas-hpp";

/** Only ever rendered by the caller (batch detail page) when the session holds
 * finance.view_profit — see ProductBatasHpp in products/[id]/page.tsx for the identical
 * pattern. getBatchCosts/getBatchExtraCosts are the ONLY queries that read cost data, so a
 * session without the permission never triggers this component (or those queries) at all. */
export async function BatchCostsSection({
  batchId,
  fabricYards,
  lines,
}: {
  batchId: string;
  fabricYards: number | null;
  lines: BatchLineRow[];
}) {
  const costs = await getBatchCosts(batchId);
  if (!costs) return null;
  const extraCosts = await getBatchExtraCosts(batchId);
  const extraCostsTotal = extraCosts.reduce((sum, line) => sum + line.total, 0);
  const totalCost = costs.fabricCostAmount + extraCostsTotal;
  const costAssumption = await getCurrentCostAssumption();

  return (
    <Card className="flex flex-col gap-3">
      <p className="text-sm text-neutral-600">Biaya batch</p>
      <dl className="grid grid-cols-2 gap-2 text-base sm:grid-cols-4">
        <div>
          <dt className="text-sm text-neutral-600">Biaya bahan</dt>
          <dd className="font-semibold text-neutral-900 tabular-nums">
            {formatRupiah(costs.fabricCostAmount)}
            {fabricYards !== null && <span className="text-sm text-neutral-600"> ({fabricYards} yard)</span>}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-600">Biaya lain</dt>
          <dd className="font-semibold text-neutral-900 tabular-nums">{formatRupiah(extraCostsTotal)}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-600">Total biaya</dt>
          <dd className="font-semibold text-neutral-900 tabular-nums">{formatRupiah(totalCost)}</dd>
        </div>
      </dl>

      {extraCosts.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-neutral-600">Rincian biaya lain</p>
          {extraCosts.map((line) => (
            <div key={line.id} className="flex items-center justify-between gap-2 text-sm text-neutral-700">
              <span>
                {line.componentName} ({line.quantity} {line.componentUnit} × {formatRupiah(line.unitPrice)})
              </span>
              <span className="tabular-nums">{formatRupiah(line.total)}</span>
            </div>
          ))}
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
