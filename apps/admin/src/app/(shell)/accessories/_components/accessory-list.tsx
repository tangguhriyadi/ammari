"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, EmptyState, Switch, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
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

  function averageCostOf(row: AccessoryListRowData): number | null {
    return canViewProfit && row.valueAmount !== null && row.qty > 0 ? Math.round(row.valueAmount / row.qty) : null;
  }

  return (
    <>
      <CardList>
        {rows.map((row) => {
          const averageCost = averageCostOf(row);
          return (
            <li key={row.id}>
              <Card className="flex items-center gap-3">
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
              </Card>
            </li>
          );
        })}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Nama</Th>
          <Th>Kelompok</Th>
          <Th>Stok</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => {
            const averageCost = averageCostOf(row);
            return (
              <Tr key={row.id}>
                <Td>
                  <Link href={`/accessories/${row.id}`} className="font-medium text-brand hover:underline">
                    {row.name}
                  </Link>
                  {row.size && <span className="ml-2 text-neutral-600">{row.size === "ALLSIZE" ? "Polos" : row.size}</span>}
                </Td>
                <Td className="text-neutral-700">{row.sizeGroup ?? "—"}</Td>
                <Td className="text-neutral-700 tabular-nums">
                  {formatNumber(row.qty)} pcs
                  {averageCost !== null && <> · ≈{formatRupiah(averageCost)}/pcs</>}
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {!row.isActive && <Badge variant="neutral">Nonaktif</Badge>}
                    {canManage ? (
                      <Switch
                        checked={row.isActive}
                        onCheckedChange={(checked) => handleToggle(row.id, checked)}
                        label=""
                        accessibleLabel={`Aktif untuk ${row.name}`}
                      />
                    ) : null}
                  </div>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </TableContainer>
    </>
  );
}
