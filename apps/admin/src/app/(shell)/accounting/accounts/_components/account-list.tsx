import Link from "next/link";
import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import type { AccountListRow } from "@/lib/accounting/accounts";
import { ACCOUNT_TYPE_LABELS, NORMAL_BALANCE_LABELS } from "@/lib/accounting/labels";

// The Chart of Accounts, read-only (both layouts: CardList < md, TableContainer >= md). Editing,
// deactivating and deleting happen on the account's own page.

function StatusBadges({ row }: { row: AccountListRow }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {row.isHeader && <Badge variant="neutral">Kelompok</Badge>}
      {row.isSystem && <Badge variant="warning">Sistem</Badge>}
      {row.isActive ? <Badge variant="success">Aktif</Badge> : <Badge variant="neutral">Nonaktif</Badge>}
    </span>
  );
}

function bankText(row: AccountListRow): string | null {
  if (!row.bankName && !row.accountNoLast4) return null;
  return [row.bankName, row.accountNoLast4 ? `rek. ...${row.accountNoLast4}` : null].filter(Boolean).join(", ");
}

export function AccountList({ rows, emptyText }: { rows: AccountListRow[]; emptyText: string }) {
  if (rows.length === 0) return <EmptyState title="Tidak ada akun" description={emptyText} />;

  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={row.code} data-testid="account-card">
            <Card className="flex flex-col gap-2">
              <Link href={`/accounting/accounts/${row.code}`} className="inline-flex min-h-11 items-center gap-2 text-base font-medium text-brand hover:underline">
                <span className="tabular-nums">{row.code}</span> {row.name}
              </Link>
              <p className="text-sm text-neutral-600">
                {ACCOUNT_TYPE_LABELS[row.type]} · Saldo normal {NORMAL_BALANCE_LABELS[row.normalBalance].toLowerCase()}
                {bankText(row) ? ` · ${bankText(row)}` : ""}
              </p>
              <StatusBadges row={row} />
            </Card>
          </li>
        ))}
      </CardList>

      <TableContainer>
        <TableHead>
          <Th>Kode</Th>
          <Th>Nama</Th>
          <Th>Jenis</Th>
          <Th>Saldo normal</Th>
          <Th>Bank</Th>
          <Th>Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.code} data-testid="account-row">
              <Td className="tabular-nums text-neutral-700">{row.code}</Td>
              <Td>
                {/* Indented by depth so the tree reads at a glance. */}
                <span style={{ paddingLeft: `${row.depth * 1.25}rem` }} className={row.isHeader ? "font-semibold" : undefined}>
                  <Link href={`/accounting/accounts/${row.code}`} className="font-medium text-brand hover:underline">
                    {row.name}
                  </Link>
                </span>
              </Td>
              <Td className="text-neutral-700">{ACCOUNT_TYPE_LABELS[row.type]}</Td>
              <Td className="text-neutral-700">{NORMAL_BALANCE_LABELS[row.normalBalance]}</Td>
              <Td className="text-neutral-700">{bankText(row) ?? ""}</Td>
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
