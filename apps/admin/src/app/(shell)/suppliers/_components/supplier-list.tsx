"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, EmptyState, Switch, TableContainer, TableHead, Th, Tr, Td, CardList } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import { supplierKindLabels } from "@/lib/suppliers/kinds";
import type { SupplierBalance } from "@/lib/supplier-payments/supplier-balance";
import { setSupplierActiveAction } from "../actions";

export interface SupplierListRowData {
  id: string;
  name: string;
  kinds: string[];
  phone: string | null;
  isActive: boolean;
  /** "Total utang" (docs/plans/purchase-payments.md §9); null for a viewer without
   * finance.view_profit, who sees no column at all. */
  balance: SupplierBalance | null;
}

/** "Rp X", plus "Lebih bayar Rp Y" when a document was paid above its bill (A4). */
function SupplierBalanceText({ balance }: { balance: SupplierBalance }) {
  return (
    <span data-testid="supplier-balance" className="flex flex-col">
      <span data-testid="supplier-outstanding" className={balance.outstanding > 0 ? "text-neutral-900" : "text-neutral-600"}>
        {formatRupiah(balance.outstanding)}
      </span>
      {balance.overpaid > 0 && (
        <span data-testid="supplier-overpaid" className="text-sm text-warning-700">
          Lebih bayar {formatRupiah(balance.overpaid)}
        </span>
      )}
    </span>
  );
}

export function SupplierList({ rows, canManage }: { rows: SupplierListRowData[]; canManage: boolean }) {
  const showBalance = rows.some((row) => row.balance !== null);
  const router = useRouter();
  const [, startTransition] = useTransition();
  // The toggle's own failure surface. Without it a refused setSupplierActiveAction (e.g. the
  // supplier was removed in another tab) would just snap the switch back with no explanation —
  // the switch's visual state comes from the server render, so "nothing happened" is exactly
  // what a silent failure looks like here.
  const [error, setError] = useState<string | null>(null);
  // Per ROW, not useTransition's single boolean: that one is shared, so it would spin every
  // other supplier's switch too. It also stops a double-click re-firing the same toggle while
  // the first call is still in flight (the switch still reads the pre-refresh `checked`).
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Belum ada supplier"
        description="Tambah supplier untuk mencatat dari siapa kain, aksesoris, atau jasa jahit dibeli."
      />
    );
  }

  function handleToggle(id: string, isActive: boolean) {
    if (pendingId !== null) return;
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      try {
        const result = await setSupplierActiveAction({ id, isActive });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } finally {
        setPendingId(null);
      }
    });
  }

  function kindsText(kinds: string[]): string | null {
    const labels = supplierKindLabels(kinds);
    return labels.length > 0 ? labels.join(", ") : null;
  }

  return (
    <>
      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <CardList>
        {rows.map((row) => {
          const kinds = kindsText(row.kinds);
          return (
            <li key={row.id}>
              <Card className="flex items-center gap-3">
                <Link href={`/suppliers/${row.id}`} className="flex-1">
                  <p className="text-base text-neutral-900">{row.name}</p>
                  <p className="text-sm text-neutral-600">
                    {kinds ?? "Jenis belum diisi"}
                    {row.phone && <> · {row.phone}</>}
                  </p>
                  {row.balance && (
                    <div className="mt-1 flex items-baseline gap-1 text-sm text-neutral-600">
                      Utang <SupplierBalanceText balance={row.balance} />
                    </div>
                  )}
                </Link>
                {!row.isActive && <Badge variant="neutral">Nonaktif</Badge>}
                {canManage ? (
                  <Switch
                    checked={row.isActive}
                    onCheckedChange={(checked) => handleToggle(row.id, checked)}
                    label=""
                    accessibleLabel={`Aktif untuk ${row.name}`}
                    pending={pendingId === row.id}
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
          <Th>Jenis</Th>
          <Th>Telepon/WhatsApp</Th>
          {showBalance && <Th>Total utang</Th>}
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.id}>
              <Td>
                <Link href={`/suppliers/${row.id}`} className="font-medium text-brand hover:underline">
                  {row.name}
                </Link>
              </Td>
              <Td className="text-neutral-700">{kindsText(row.kinds) ?? "-"}</Td>
              <Td className="text-neutral-700">{row.phone ?? "-"}</Td>
              {showBalance && <Td>{row.balance && <SupplierBalanceText balance={row.balance} />}</Td>}
              <Td>
                <div className="flex items-center gap-2">
                  {!row.isActive && <Badge variant="neutral">Nonaktif</Badge>}
                  {canManage ? (
                    <Switch
                      checked={row.isActive}
                      onCheckedChange={(checked) => handleToggle(row.id, checked)}
                      label=""
                      accessibleLabel={`Aktif untuk ${row.name}`}
                      pending={pendingId === row.id}
                    />
                  ) : null}
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
