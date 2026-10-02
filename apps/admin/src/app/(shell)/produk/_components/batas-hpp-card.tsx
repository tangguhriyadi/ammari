import { Card } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";

/** Only ever rendered by the caller (product detail page) when the session holds
 * finance.view_profit — the value must never be computed or sent to the client otherwise, so
 * this component itself takes the already-computed number rather than re-deriving it, and the
 * page simply never renders this component at all for a session lacking the permission. */
export function BatasHppCard({ batasHpp }: { batasHpp: number }) {
  return (
    <Card>
      <p className="text-sm text-neutral-600">Batas HPP</p>
      <p className="text-2xl font-semibold text-neutral-900 tabular-nums">{formatRupiah(batasHpp)}</p>
      <p className="mt-1 text-sm text-neutral-600">
        Harga dasar x margin − biaya kemasan, dari asumsi biaya yang berlaku.
      </p>
    </Card>
  );
}
