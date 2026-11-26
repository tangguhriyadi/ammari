import Link from "next/link";
import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { EXPENSE_CATEGORY_KIND_LABELS } from "@/lib/expense-categories/catalog";
import type { ExpenseCategoryListRow } from "@/lib/expense-categories/queries";
import { SystemBadge } from "./system-badge";
import { expenseUsageText } from "./usage";

// Read-only list (both layouts, CardList < md, TableContainer >= md). Activating and deactivating
// happen on the detail page, which can explain why a system category has no "Nonaktifkan".

function itemCountText(itemCount: number): string {
  return itemCount === 0 ? "Belum ada item" : `${itemCount} item`;
}

function StatusBadges({ row }: { row: ExpenseCategoryListRow }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {row.isSystem && <SystemBadge />}
      {row.isActive ? <Badge variant="success">Aktif</Badge> : <Badge variant="neutral">Nonaktif</Badge>}
    </span>
  );
}

export function ExpenseCategoryList({ rows, filtered }: { rows: ExpenseCategoryListRow[]; filtered: boolean }) {
  if (rows.length === 0) {
    return filtered ? (
      <EmptyState title="Tidak ada kategori" description="Tidak ada kategori biaya dengan status ini." />
    ) : (
      <EmptyState title="Belum ada kategori biaya" description="Tambah kategori, mis. Langganan, untuk mengelompokkan biaya." />
    );
  }

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.code} data-testid="expense-category-card">
            <Card className="flex flex-col gap-2">
              <Link href={`/expense-categories/${row.code}`} className="inline-flex min-h-11 items-center text-base font-medium text-brand hover:underline">
                {row.name}
              </Link>
              <p className="text-sm text-neutral-600">
                {EXPENSE_CATEGORY_KIND_LABELS[row.kind]} · {itemCountText(row.itemCount)} · {expenseUsageText(row.expenseCount)}
              </p>
              <StatusBadges row={row} />
            </Card>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Nama</Th>
          <Th>Jenis</Th>
          <Th>Item</Th>
          <Th>Dipakai</Th>
          <Th>Urutan</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.code} data-testid="expense-category-row">
              <Td>
                <Link href={`/expense-categories/${row.code}`} className="font-medium text-brand hover:underline">
                  {row.name}
                </Link>
              </Td>
              <Td className="text-neutral-700">{EXPENSE_CATEGORY_KIND_LABELS[row.kind]}</Td>
              <Td className="text-neutral-700 tabular-nums">{itemCountText(row.itemCount)}</Td>
              <Td className="text-neutral-700">{expenseUsageText(row.expenseCount)}</Td>
              <Td className="text-neutral-700 tabular-nums">{row.sortOrder}</Td>
              <Td>
                <StatusBadges row={row} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}
