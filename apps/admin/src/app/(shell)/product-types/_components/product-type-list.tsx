"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, CardList, EmptyState, Switch, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import type { ProductTypeListRow } from "@/lib/product-types/queries";
import { setProductTypeActiveAction } from "../actions";

function usageText(productCount: number): string {
  return productCount === 0 ? "Belum dipakai" : `Dipakai ${productCount} produk`;
}

export function ProductTypeList({ rows }: { rows: ProductTypeListRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Same per-row pending + visible error as SupplierList: a refused toggle must say why instead
  // of the switch silently snapping back.
  const [error, setError] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);

  if (rows.length === 0) {
    return <EmptyState title="Belum ada jenis produk" description="Tambah jenis produk, mis. Gamis, untuk mengelompokkan produk." />;
  }

  function handleToggle(code: string, isActive: boolean) {
    if (pendingCode !== null) return;
    setError(null);
    setPendingCode(code);
    startTransition(async () => {
      try {
        const result = await setProductTypeActiveAction({ code, isActive });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      } finally {
        setPendingCode(null);
      }
    });
  }

  // A render helper, not a nested component: a component declared inside this one would be a new
  // type every render and remount the switch.
  function activeSwitch(row: ProductTypeListRow) {
    return (
      <Switch
        checked={row.isActive}
        onCheckedChange={(checked) => handleToggle(row.code, checked)}
        label=""
        accessibleLabel={`Aktif untuk ${row.name}`}
        pending={pendingCode === row.code}
      />
    );
  }

  return (
    <>
      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}

      <CardList>
        {rows.map((row) => (
          <li key={row.code}>
            <Card className="flex items-center gap-3">
              <Link href={`/product-types/${row.code}`} className="flex-1">
                <p className="text-base text-neutral-900">{row.name}</p>
                <p className="text-sm text-neutral-600">
                  {row.code} · {usageText(row.productCount)}
                </p>
              </Link>
              {!row.isActive && <Badge variant="neutral">Nonaktif</Badge>}
              {activeSwitch(row)}
            </Card>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Nama</Th>
          <Th>Kode</Th>
          <Th>Urutan</Th>
          <Th>Produk</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.code}>
              <Td>
                <Link href={`/product-types/${row.code}`} className="font-medium text-brand hover:underline">
                  {row.name}
                </Link>
              </Td>
              <Td className="font-mono text-neutral-700">{row.code}</Td>
              <Td className="text-neutral-700 tabular-nums">{row.sortOrder}</Td>
              <Td className="text-neutral-700">{usageText(row.productCount)}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  {!row.isActive && <Badge variant="neutral">Nonaktif</Badge>}
                  {activeSwitch(row)}
                </div>
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
