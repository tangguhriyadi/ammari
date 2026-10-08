import { formatDate, formatDateTime, formatNumber } from "@ammari/ui/lib";
import { ColorSwatch } from "@ammari/ui";
import type { BatchDetail } from "@/lib/production/queries";

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
          <dd className="text-neutral-900">{batch.fabricYards !== null ? batch.fabricYards : "—"}</dd>
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
