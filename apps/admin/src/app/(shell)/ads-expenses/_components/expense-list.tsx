import { Badge, Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import { formatDate, formatDateTime, formatRupiah } from "@ammari/ui/lib";
import type { BusinessExpenseRow } from "@/lib/expenses/records";
import { EXPENSE_CATEGORY_LABELS, EXPENSE_METHOD_LABELS, MARKETING_CHANNEL_LABELS, type MarketingChannelId } from "@/lib/expenses/labels";
import { PrivateFileLink } from "@/components/supplier-payments/private-file-link";
import { Struck, voidedLine } from "@/components/supplier-payments/payment-history";
import { VoidRecordButton } from "@/components/supplier-payments/void-record-button";
import { voidBusinessExpenseAction } from "../actions";

// The "Pengeluaran" list (docs/plans/growth.md §6): a card per expense on phones, a table on
// tablet/desktop. Voided rows (shown only on request) stay struck through with "Dibatalkan" and
// the reason. The page is gated by ads_expenses.manage + finance.view_profit, which is also what
// opening a proof and voiding need, so every row gets both.

function channelLabel(row: BusinessExpenseRow): string | null {
  if (row.channelId === null) return null;
  return MARKETING_CHANNEL_LABELS[row.channelId as MarketingChannelId] ?? row.channelId;
}

/** "Shopee · Promo 11.11", or null for an operating cost. */
function marketingLine(row: BusinessExpenseRow): string | null {
  const parts = [channelLabel(row), row.campaign].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function ExpenseList({ rows }: { rows: BusinessExpenseRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="Belum ada biaya" description="Belum ada biaya yang cocok dengan filter ini. Catat biaya dengan tombol Catat biaya." />;
  }

  const proofCell = (row: BusinessExpenseRow) => <PrivateFileLink file={row.proof} label="Lihat bukti" title={`Bukti ${row.expenseNo}`} />;
  const voidButton = (row: BusinessExpenseRow) =>
    row.voidedAt === null ? <VoidRecordButton kind="expense" id={row.id} label={row.expenseNo} voidAction={voidBusinessExpenseAction} /> : null;

  return (
    <>
      <CardList>
        {rows.map((row) => {
          const voided = row.voidedAt !== null;
          const marketing = marketingLine(row);
          return (
            <li key={row.id} data-testid="expense-card">
              <Card className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-base font-medium text-neutral-900">
                      <Struck voided={voided}>{EXPENSE_CATEGORY_LABELS[row.category]}</Struck>
                    </p>
                    <p className="text-sm text-neutral-600">
                      {row.expenseNo} · {formatDate(new Date(row.expenseDate))} · {EXPENSE_METHOD_LABELS[row.method]}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-base font-semibold tabular-nums text-neutral-900">
                      <Struck voided={voided}>{formatRupiah(row.amount)}</Struck>
                    </span>
                    {voided && <Badge variant="neutral">Dibatalkan</Badge>}
                  </div>
                </div>
                {marketing && <p className="text-sm text-neutral-800">{marketing}</p>}
                {row.note && <p className="text-sm text-neutral-800">{row.note}</p>}
                <p className="text-sm text-neutral-600">
                  Dicatat {formatDateTime(row.createdAt)}
                  {row.recordedByName ? ` oleh ${row.recordedByName}` : ""}
                </p>
                {voided && <p className="text-sm text-neutral-700">{voidedLine(row)}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {proofCell(row)}
                  {voidButton(row)}
                </div>
              </Card>
            </li>
          );
        })}
      </CardList>
      <TableContainer>
        <TableHead>
          <Th>No. biaya</Th>
          <Th>Tanggal</Th>
          <Th>Kategori</Th>
          <Th>Kanal / kampanye</Th>
          <Th>Jumlah</Th>
          <Th>Metode</Th>
          <Th>Dicatat oleh</Th>
          <Th>Bukti</Th>
          <Th>Catatan</Th>
          <Th>Aksi</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => {
            const voided = row.voidedAt !== null;
            return (
              <Tr key={row.id} data-testid="expense-row">
                <Td className="font-medium text-neutral-900">
                  <div className="flex flex-col items-start gap-1">
                    <Struck voided={voided}>{row.expenseNo}</Struck>
                    {voided && <Badge variant="neutral">Dibatalkan</Badge>}
                  </div>
                </Td>
                <Td className="text-neutral-700">{formatDate(new Date(row.expenseDate))}</Td>
                <Td className="text-neutral-700">{EXPENSE_CATEGORY_LABELS[row.category]}</Td>
                <Td className="text-neutral-700">{marketingLine(row) ?? "-"}</Td>
                <Td className="tabular-nums text-neutral-900">
                  <Struck voided={voided}>{formatRupiah(row.amount)}</Struck>
                </Td>
                <Td className="text-neutral-700">{EXPENSE_METHOD_LABELS[row.method]}</Td>
                <Td className="text-neutral-700">
                  {row.recordedByName ?? "-"}
                  <span className="block text-sm text-neutral-600">{formatDateTime(row.createdAt)}</span>
                </Td>
                <Td>{proofCell(row)}</Td>
                <Td className="max-w-64 text-neutral-700">
                  {row.note ?? (voided ? null : "-")}
                  {voided && <span className="block text-sm text-neutral-700">{voidedLine(row)}</span>}
                </Td>
                <Td>{voidButton(row)}</Td>
              </Tr>
            );
          })}
        </tbody>
      </TableContainer>
    </>
  );
}
