import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatAmount, formatBalance, formatDay } from "@/lib/accounting/format";
import { JOURNAL_KIND_LABELS } from "@/lib/accounting/labels";
import type { Ledger } from "@/lib/accounting/queries";

// Buku besar (docs/plans/accounting.md §6): one account's lines with a running balance, between an
// opening and a closing balance. Balances are in the account's normal direction (a debit-normal
// account's balance is debit minus credit), so a negative figure means "against its normal side".

function Totals({ ledger }: { ledger: Ledger }) {
  const items = [
    { label: "Saldo awal", value: formatBalance(ledger.openingBalance), testId: "ledger-opening" },
    { label: "Total debit", value: formatBalance(ledger.debitTotal), testId: "ledger-debit-total" },
    { label: "Total kredit", value: formatBalance(ledger.creditTotal), testId: "ledger-credit-total" },
    { label: "Saldo akhir", value: formatBalance(ledger.closingBalance), testId: "ledger-closing" },
  ];
  return (
    <dl className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="rounded-lg border border-neutral-200 p-3">
          <dt className="text-sm text-neutral-600">{item.label}</dt>
          <dd className="text-lg font-semibold tabular-nums text-neutral-900" data-testid={item.testId}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function LedgerTable({ ledger }: { ledger: Ledger }) {
  return (
    <>
      <p className="mb-3 text-base text-neutral-700">
        Saldo normal: <span className="font-medium">{ledger.account.normalBalance === "debit" ? "Debit" : "Kredit"}</span>
      </p>
      <Totals ledger={ledger} />
      {ledger.rows.length === 0 ? (
        <EmptyState title="Tidak ada transaksi pada periode ini" description="Ubah tanggal atau pilih akun lain." />
      ) : (
        <>
          <CardList>
            {ledger.rows.map((row, index) => (
              <li key={`${row.entryId}-${index}`} data-testid="ledger-line-card">
                <Card className="flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex flex-col">
                      <span className="font-medium tabular-nums text-neutral-900">{row.entryNo}</span>
                      <span className="text-sm tabular-nums text-neutral-600">{formatDay(row.entryDate)}</span>
                    </span>
                    {row.kind !== "system" && <Badge variant={row.kind === "reversal" ? "warning" : "neutral"}>{JOURNAL_KIND_LABELS[row.kind]}</Badge>}
                  </div>
                  <span className="break-words text-neutral-900">{row.memo ?? row.description}</span>
                  <div className="flex items-end justify-between gap-3 text-base tabular-nums">
                    <span>{row.debit > 0 ? `Debit ${formatAmount(row.debit)}` : `Kredit ${formatAmount(row.credit)}`}</span>
                    <span className="text-sm text-neutral-600">
                      Saldo <span className="font-medium text-neutral-900">{formatBalance(row.balance)}</span>
                    </span>
                  </div>
                </Card>
              </li>
            ))}
          </CardList>

          <TableContainer>
            <TableHead>
              <Th>Tanggal</Th>
              <Th>No. jurnal</Th>
              <Th>Keterangan</Th>
              <Th className="text-right">Debit</Th>
              <Th className="text-right">Kredit</Th>
              <Th className="text-right">Saldo</Th>
            </TableHead>
            <tbody>
              {ledger.rows.map((row, index) => (
                <Tr key={`${row.entryId}-${index}`} data-testid="ledger-line-row">
                  <Td className="whitespace-nowrap tabular-nums text-neutral-700">{formatDay(row.entryDate)}</Td>
                  <Td className="whitespace-nowrap">
                    <span className="flex flex-col items-start gap-1">
                      <span className="tabular-nums">{row.entryNo}</span>
                      {row.kind !== "system" && <Badge variant={row.kind === "reversal" ? "warning" : "neutral"}>{JOURNAL_KIND_LABELS[row.kind]}</Badge>}
                    </span>
                  </Td>
                  <Td className="break-words">{row.memo ?? row.description}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{formatAmount(row.debit)}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">{formatAmount(row.credit)}</Td>
                  <Td className="whitespace-nowrap text-right font-medium tabular-nums">{formatBalance(row.balance)}</Td>
                </Tr>
              ))}
            </tbody>
          </TableContainer>
        </>
      )}
    </>
  );
}
