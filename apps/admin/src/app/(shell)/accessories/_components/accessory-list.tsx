"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, EmptyState, Switch } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import type { Size } from "@ammari/db/schema";
import { setAccessoryActiveAction } from "../actions";

export interface AccessoryListRowData {
  id: string;
  name: string;
  size: Size | null;
  sizeGroup: string | null;
  isActive: boolean;
  notes: string | null;
  qty: number;
  /** `null` for a session without finance.view_profit — stripped server-side, never just
   * hidden client-side (see page.tsx). */
  valueAmount: number | null;
}

export function AccessoryList({
  rows,
  canViewProfit,
  canManage,
}: {
  rows: AccessoryListRowData[];
  canViewProfit: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  if (rows.length === 0) {
    return <EmptyState title="Belum ada aksesoris" description="Tambah aksesoris untuk mulai mencatat stok dan pembeliannya." />;
  }

  function handleToggle(id: string, isActive: boolean) {
    startTransition(async () => {
      await setAccessoryActiveAction({ id, isActive });
      router.refresh();
    });
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((row) => {
        const averageCost =
          canViewProfit && row.valueAmount !== null && row.qty > 0 ? Math.round(row.valueAmount / row.qty) : null;
        return (
          <li key={row.id} className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3">
            <Link href={`/accessories/${row.id}`} className="flex-1">
              <p className="text-base text-neutral-900">
                {row.name}
                {row.size && <span className="ml-2 text-sm text-neutral-600">{row.size === "ALLSIZE" ? "Polos" : row.size}</span>}
              </p>
              <p className="text-sm text-neutral-600">
                {row.sizeGroup && <>{row.sizeGroup} · </>}
                {formatNumber(row.qty)} pcs
                {averageCost !== null && <> · ≈{formatRupiah(averageCost)}/pcs</>}
              </p>
            </Link>
            {!row.isActive && <Badge variant="neutral">Nonaktif</Badge>}
            {canManage ? (
              <Switch
                checked={row.isActive}
                onCheckedChange={(checked) => handleToggle(row.id, checked)}
                label=""
                accessibleLabel={`Aktif untuk ${row.name}`}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
