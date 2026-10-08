import { getAccessoryNeedsForBatch } from "@/lib/production/accessory-needs";
import { AccessoryNeedsList } from "./accessory-needs-list";

/** "Kebutuhan aksesoris" — the draft's computed accessory needs (from the product recipe,
 * resolved against the batch's CURRENTLY SAVED lines), current stock, and a shortage badge, with
 * a per-item override. Quantities only, never a cost/value figure — safe for any
 * production.manage session regardless of finance.view_profit (see
 * getAccessoryNeedsForBatch's own doc comment). Renders nothing when this batch's products have
 * no accessory recipe at all. */
export async function AccessoryNeedsSection({ batchId }: { batchId: string }) {
  const { rows, unresolved } = await getAccessoryNeedsForBatch(batchId);
  if (rows.length === 0 && unresolved.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-neutral-900">Kebutuhan aksesoris</h2>

      {unresolved.length > 0 && (
        <div className="rounded-lg border border-danger-200 bg-danger-50 p-3 text-sm text-danger-700">
          <p className="font-medium">Resep aksesoris belum lengkap — posting akan ditolak untuk:</p>
          <ul className="list-disc pl-5">
            {unresolved.map((row, index) => (
              <li key={index}>
                {row.productName} (ukuran {row.size === "ALLSIZE" ? "All Size" : row.size}, grup &quot;{row.sizeGroup}&quot;)
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length > 0 && <AccessoryNeedsList batchId={batchId} rows={rows} />}
    </div>
  );
}
