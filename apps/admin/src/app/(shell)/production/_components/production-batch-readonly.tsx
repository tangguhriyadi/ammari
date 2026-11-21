import { formatDate, formatDateTime, formatNumber } from "@ammari/ui/lib";
import { ColorSwatch } from "@ammari/ui";
import type { BatchDetail } from "@/lib/production/queries";
import { FabricColorLabel } from "@/components/fabric-color-label";

export function ProductionBatchReadOnly({ batch }: { batch: BatchDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 text-base sm:grid-cols-4">
        <div>
          <dt className="text-sm text-neutral-600">Bahan</dt>
          <dd className="text-neutral-900">{batch.fabricName}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-600">Tanggal produksi</dt>
          <dd className="text-neutral-900">{formatDate(new Date(batch.producedAt))}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-600">Jumlah yard</dt>
          <dd className="text-neutral-900">{batch.fabricYards !== null ? batch.fabricYards : "-"}</dd>
        </div>
        <div>
          <dt className="text-sm text-neutral-600">Diposting pada</dt>
          <dd className="text-neutral-900">
            {batch.postedAt ? formatDateTime(batch.postedAt) : "-"}
            {batch.postedByName ? ` · ${batch.postedByName}` : ""}
          </dd>
        </div>
      </dl>
      {batch.notes && (
        <div>
          <p className="text-sm text-neutral-600">Catatan</p>
          <p className="text-base text-neutral-900">{batch.notes}</p>
        </div>
      )}

      <FabricUsageList batch={batch} />

      <div className="flex flex-col gap-2">
        {batch.lines.map((line) => (
          <div key={line.id} className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3">
            <ColorSwatch hex={line.colorHex} />
            <div className="flex-1">
              <p className="text-base text-neutral-900">{line.productName}</p>
              <p className="text-sm text-neutral-600">
                {line.colorName} · {line.size === "ALLSIZE" ? "All Size" : line.size}
              </p>
            </div>
            <span className="text-base font-semibold tabular-nums text-neutral-900">{formatNumber(line.qty)} pcs</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Pemakaian kain" per colour bucket (quantities only; the cost per colour is in
 * BatchCostsSection, behind finance.view_profit). A batch posted before stock per colour has no
 * usage rows: its consumption was one colourless movement, said so instead of an empty list. */
function FabricUsageList({ batch }: { batch: BatchDetail }) {
  if (batch.fabricUsages.length === 0) {
    if (batch.status !== "posted" || batch.fabricYards === null) return null;
    return (
      <p className="text-base text-neutral-700" data-testid="batch-fabric-usage-legacy">
        Kain: {batch.fabricYards} yard (Tanpa warna, sebelum stok per warna)
      </p>
    );
  }
  return (
    <section aria-labelledby="batch-fabric-usage-heading" className="flex flex-col gap-2">
      <h2 id="batch-fabric-usage-heading" className="text-sm text-neutral-600">
        Pemakaian kain
      </h2>
      <ul className="flex flex-wrap gap-2">
        {batch.fabricUsages.map((usage) => (
          <li
            key={usage.fabricColorId ?? "none"}
            data-testid="batch-fabric-usage"
            className="inline-flex items-center gap-2 rounded-full border border-neutral-200 px-3 py-1 text-base"
          >
            <FabricColorLabel name={usage.colorName} hex={usage.colorHex} className="text-base text-neutral-900" testId="batch-fabric-usage-color" />
            <span className="tabular-nums text-neutral-900" data-testid="batch-fabric-usage-yards">
              {usage.yards.toFixed(2)} yard
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
