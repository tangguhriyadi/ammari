import Link from "next/link";
import type { ReactNode } from "react";
import { formatRupiah } from "@ammari/ui/lib";
import { FabricColorLabel } from "@/components/fabric-color-label";
import type { FabricColorBalanceRow } from "@/lib/inventory/fabric-stock";

/** One colour bucket as the pages render it (docs/plans/fabric-colour-stock.md S4). `valueAmount`
 * is `null` for a session without finance.view_profit, stripped server-side by the page. */
export interface FabricColorStock {
  /** `null` = "Tanpa warna". */
  fabricColorId: string | null;
  name: string | null;
  hex: string | null;
  isActive: boolean;
  qty: number;
  valueAmount: number | null;
}

/** Strips cost data for a session without finance.view_profit. */
export function toFabricColorStock(rows: FabricColorBalanceRow[], canViewProfit: boolean): FabricColorStock[] {
  return rows.map((row) => ({
    fabricColorId: row.fabricColorId,
    name: row.name,
    hex: row.hex,
    isActive: row.isActive,
    qty: row.qty,
    valueAmount: canViewProfit ? row.valueAmount : null,
  }));
}

function averageCost(qty: number, valueAmount: number | null): number | null {
  return valueAmount !== null && qty > 0 ? Math.round(valueAmount / qty) : null;
}

function qtyClass(qty: number) {
  // A bucket can only go negative through a rollback (plan §3); shown, never hidden.
  return qty < 0 ? "text-danger-700" : "text-neutral-900";
}

/** Swatch + name, "(nonaktif)" for a deactivated colour that still has history. */
export function FabricColorStockLabel({ row, testId }: { row: Pick<FabricColorStock, "name" | "hex" | "isActive">; testId?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <FabricColorLabel name={row.name} hex={row.hex} className="text-neutral-900" testId={testId} />
      {row.name !== null && !row.isActive && <span className="text-sm text-neutral-500">(nonaktif)</span>}
    </span>
  );
}

/** Per-colour stock cards plus the fabric total (/fabrics/[id], /stock/fabrics/[id]). One
 * responsive grid, the same markup at every width. */
export function FabricColorBalances({
  rows,
  total,
  footer,
}: {
  rows: FabricColorStock[];
  total: { qty: number; valueAmount: number | null };
  /** Rendered under the total, inside the section (e.g. a link to the stock history). */
  footer?: ReactNode;
}) {
  const totalAverage = averageCost(total.qty, total.valueAmount);
  return (
    <section aria-label="Stok per warna" className="mb-6 flex flex-col gap-3">
      {rows.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => {
            const average = averageCost(row.qty, row.valueAmount);
            return (
              <li
                key={row.fabricColorId ?? "none"}
                data-testid="fabric-color-balance"
                className="flex flex-col gap-1 rounded-lg border border-neutral-200 p-3"
              >
                <FabricColorStockLabel row={row} testId="fabric-color-balance-label" />
                <span className={`text-lg font-semibold tabular-nums ${qtyClass(row.qty)}`} data-testid="fabric-color-balance-qty">
                  {row.qty.toFixed(2)} yard
                </span>
                {row.valueAmount !== null && (
                  <span className="text-sm text-neutral-600 tabular-nums" data-testid="fabric-color-balance-value">
                    Nilai {formatRupiah(row.valueAmount)}
                    {average !== null && <> · ≈ {formatRupiah(average)}/yard</>}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="fabric-total-balance">
        <span className="text-base text-neutral-600">Total</span>
        <span className={`text-2xl font-semibold tabular-nums ${qtyClass(total.qty)}`} data-testid="fabric-total-balance-qty">
          {total.qty.toFixed(2)} yard
        </span>
        {total.valueAmount !== null && (
          <span className="text-base text-neutral-600 tabular-nums" data-testid="fabric-total-balance-value">
            Nilai {formatRupiah(total.valueAmount)}
            {totalAverage !== null && <> · ≈ {formatRupiah(totalAverage)}/yard</>}
          </span>
        )}
      </div>
      {footer}
    </section>
  );
}

/** Compact chips for a list row: "Sage 10.00 yard", "Tanpa warna 3.00 yard". */
export function FabricColorChips({ rows }: { rows: FabricColorStock[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Stok per warna" data-testid="fabric-color-chips">
      {rows.map((row) => {
        const average = averageCost(row.qty, row.valueAmount);
        return (
          <li
            key={row.fabricColorId ?? "none"}
            data-testid="fabric-color-chip"
            className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-0.5 text-sm text-neutral-800"
          >
            <FabricColorStockLabel row={row} testId="fabric-color-chip-label" />
            <span className={`tabular-nums ${row.qty < 0 ? "text-danger-700" : ""}`} data-testid="fabric-color-chip-qty">
              {row.qty.toFixed(2)} yard
            </span>
            {average !== null && <span className="text-neutral-600 tabular-nums">≈ {formatRupiah(average)}/yard</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** The ledger's "Warna" filter: plain links (`?warna=<id>|tanpa`), so it works without JS and
 * survives a reload. */
export function FabricLedgerColorFilter({
  basePath,
  rows,
  active,
  perPage,
}: {
  basePath: string;
  rows: FabricColorStock[];
  /** undefined = every colour. */
  active: string | null | undefined;
  perPage?: string;
}) {
  if (rows.length === 0) return null;
  const href = (warna: string | undefined) => {
    const params = new URLSearchParams();
    if (warna) params.set("warna", warna);
    if (perPage) params.set("perPage", perPage);
    const query = params.toString();
    return query ? `${basePath}?${query}` : basePath;
  };
  const options: { key: string; warna: string | undefined; current: boolean; label: ReactNode }[] = [
    { key: "all", warna: undefined, current: active === undefined, label: "Semua warna" },
    ...rows.map((row) => ({
      key: row.fabricColorId ?? "none",
      warna: row.fabricColorId ?? "tanpa",
      current: active === row.fabricColorId,
      label: <FabricColorStockLabel row={row} />,
    })),
  ];
  return (
    <nav aria-label="Filter warna" className="mb-3">
      <ul className="flex flex-wrap gap-2">
        {options.map((option) => (
          <li key={option.key}>
            <Link
              href={href(option.warna)}
              aria-current={option.current ? "page" : undefined}
              data-testid="fabric-ledger-color-filter"
              className={`inline-flex min-h-11 items-center rounded-full border px-3 text-sm ${
                option.current ? "border-brand bg-brand/10 font-medium text-neutral-900" : "border-neutral-300 text-neutral-800 hover:bg-neutral-50"
              }`}
            >
              {option.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
