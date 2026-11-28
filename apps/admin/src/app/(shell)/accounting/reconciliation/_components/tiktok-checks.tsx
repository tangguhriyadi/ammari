import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardList, EmptyState, TableContainer, TableHead, Td, Th, Tr } from "@ammari/ui";
import type { TikTokReconciliation } from "@/lib/accounting/tiktok-reconciliation";
import type { ReconciliationStatus } from "@/lib/accounting/reconciliation-rules";
import { Amount, StatusBadge } from "./status";

// Rekonsiliasi "TikTok Shop" (docs/plans/tiktok-shop-integration.md §5.4, T8): 1-1303 Saldo Penjual
// TikTok per order (a), per statement (b), per payout (c) and as a whole (d), plus the M4/M5 ads pairs.
// Every list renders twice: CardList on phones, a table from md up (packages/ui Table.tsx).

const DATE = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" });
const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

function MaybeAmount({ value }: { value: number | null }) {
  return value === null ? <span className="text-neutral-600">belum terbaca</span> : <Amount value={value} />;
}

/** One responsive list: the same rows as cards (phones) and as a table (md and up). */
function ResponsiveList<Row>({
  rows,
  caption,
  firstColumn,
  testId,
  rowKey,
  columns,
  status,
  title,
}: {
  rows: Row[];
  caption: string;
  firstColumn: string;
  testId: string;
  rowKey: (row: Row) => string;
  columns: { label: string; numeric?: boolean; cell: (row: Row) => ReactNode }[];
  status: (row: Row) => ReconciliationStatus;
  title: (row: Row) => ReactNode;
}) {
  return (
    <>
      <CardList>
        {rows.map((row) => (
          <li key={rowKey(row)} data-testid={`${testId}-card`}>
            <Card className="flex flex-col gap-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                {title(row)}
                <StatusBadge status={status(row)} />
              </div>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-base">
                {columns.map((column) => (
                  <div key={column.label} className="contents">
                    <dt className="text-neutral-600">{column.label}</dt>
                    <dd className="text-right">{column.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </li>
        ))}
      </CardList>
      <TableContainer>
        <caption className="sr-only">{caption}</caption>
        <TableHead>
          <Th scope="col">{firstColumn}</Th>
          {columns.map((column) => (
            <Th key={column.label} scope="col" className={column.numeric ? "text-right" : undefined}>
              {column.label}
            </Th>
          ))}
          <Th scope="col">Status</Th>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <Tr key={rowKey(row)} data-testid={`${testId}-row`}>
              <Td>{title(row)}</Td>
              {columns.map((column) => (
                <Td key={column.label} className={column.numeric ? "whitespace-nowrap text-right" : undefined}>
                  {column.cell(row)}
                </Td>
              ))}
              <Td>
                <StatusBadge status={status(row)} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </TableContainer>
    </>
  );
}

function Block({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3" data-testid={id}>
      <h3 id={id} className="text-base font-semibold text-neutral-900">
        {title}
      </h3>
      <p className="text-sm text-neutral-600">{description}</p>
      {children}
    </section>
  );
}

function Shown({ shown, total, what }: { shown: number; total: number; what: string }) {
  return total > shown ? (
    <p className="text-sm text-neutral-600">
      Menampilkan {shown} dari {total} {what}, yang tidak cocok lebih dulu.
    </p>
  ) : null;
}

export function TikTokChecks({ check, asOf, segmentStart }: { check: TikTokReconciliation; asOf: string; segmentStart: string }) {
  const { balance } = check;
  return (
    <div className="flex flex-col gap-6">
      <Block
        id="reconciliation-tiktok-balance"
        title="Saldo Penjual TikTok seluruhnya"
        description="Saldo akun dibandingkan dengan yang menurut data TikTok yang tersimpan masih menjadi hak toko: perkiraan pesanan yang belum cair ditambah laporan yang sudah cair tetapi belum ditarik ke bank. Selisih kecil wajar karena waktu (pesanan baru, perkiraan yang belum diganti angka sebenarnya); selisih yang menetap perlu diperiksa."
      >
        <Card className="flex flex-col gap-1 text-base md:max-w-xl">
          <div className="flex justify-between gap-3">
            <Link href={`/accounting/ledger?account=${check.accountCode}&from=${segmentStart}&to=${asOf}`} className="text-neutral-600 hover:underline">
              Saldo di buku besar ({check.accountCode})
            </Link>
            <Amount value={balance.ledger} />
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-neutral-600">Belum cair (perkiraan TikTok)</span>
            <Amount value={balance.unsettled} />
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-neutral-600">Sudah cair, belum ditarik ke bank</span>
            <Amount value={balance.settledNotPaidOut} />
          </div>
          {balance.heldStatements > 0 && (
            <p className="text-sm text-warning-700">{balance.heldStatements} laporan TikTok ditahan (nilainya belum terbaca) dan belum dihitung di atas.</p>
          )}
          <div className="flex justify-between gap-3 font-medium">
            <span>Selisih</span>
            <span data-testid="reconciliation-tiktok-balance-difference">
              <Amount value={balance.difference} />
            </span>
          </div>
          <div>
            <StatusBadge status={balance.status} />
          </div>
        </Card>
      </Block>

      <Block
        id="reconciliation-tiktok-orders"
        title="Per pesanan"
        description="Jurnal Saldo Penjual TikTok tiap pesanan (penjualan dikurangi biaya, retur dan refund) dibandingkan dengan yang dicairkan TikTok untuk pesanan itu di laporannya. Pesanan yang belum ada di laporan masih menunggu pencairan."
      >
        <p className="text-sm text-neutral-600">
          Tidak cocok: <span data-testid="reconciliation-tiktok-order-mismatches">{check.orders.mismatchCount}</span>. Menunggu pencairan: {check.orders.waitingCount}.
        </p>
        {check.orders.rows.length === 0 ? (
          <EmptyState title="Belum ada pesanan TikTok" description="Pesanan TikTok muncul di sini setelah dibukukan atau dicairkan." />
        ) : (
          <>
            <Shown shown={check.orders.rows.length} total={check.orders.rowCount} what="pesanan" />
            <ResponsiveList
              rows={check.orders.rows}
              caption="Pesanan TikTok"
              firstColumn="Pesanan"
              testId="reconciliation-tiktok-order"
              rowKey={(row) => row.orderId}
              title={(row) => (
                <Link href={`/orders/${row.orderId}`} className="font-medium text-neutral-900 hover:underline">
                  {row.orderNo}
                </Link>
              )}
              status={(row) => row.status}
              columns={[
                { label: "Jurnal pesanan", numeric: true, cell: (row) => <Amount value={row.ledger} /> },
                { label: "Dicairkan TikTok", numeric: true, cell: (row) => (row.settlement === null ? <span className="text-neutral-600">belum cair</span> : <Amount value={row.settlement} />) },
                { label: "Selisih", numeric: true, cell: (row) => <Amount value={row.difference} /> },
              ]}
            />
          </>
        )}
      </Block>

      <Block id="reconciliation-tiktok-statements" title="Per laporan" description="Jumlah semua transaksi di satu laporan TikTok harus sama dengan nilai cair laporan itu. Laporan yang ditahan tidak dibukukan sampai cocok.">
        {check.statements.rows.length === 0 ? (
          <EmptyState title="Belum ada laporan TikTok" description="Laporan muncul setelah sinkronisasi keuangan TikTok berjalan." />
        ) : (
          <>
            <Shown shown={check.statements.rows.length} total={check.statements.rowCount} what="laporan" />
            <ResponsiveList
              rows={check.statements.rows}
              caption="Laporan TikTok"
              firstColumn="Laporan"
              testId="reconciliation-tiktok-statement"
              rowKey={(row) => row.statementId}
              title={(row) => (
                <span className="flex flex-col">
                  <Link href="/settings/integrations/tiktok/finance" className="font-medium text-neutral-900 hover:underline">
                    {row.statementId}
                  </Link>
                  <span className="text-sm text-neutral-600">{DATE.format(row.statementTime)}</span>
                </span>
              )}
              status={(row) => row.status}
              columns={[
                { label: "Nilai cair", numeric: true, cell: (row) => <MaybeAmount value={row.settlement} /> },
                { label: "Jumlah transaksi", numeric: true, cell: (row) => <MaybeAmount value={row.transactionsTotal} /> },
                { label: "Selisih", numeric: true, cell: (row) => (row.heldReason ? <span className="text-neutral-600">ditahan</span> : <MaybeAmount value={row.difference} />) },
              ]}
            />
          </>
        )}
      </Block>

      <Block
        id="reconciliation-tiktok-payouts"
        title="Per pencairan ke bank"
        description="Uang yang ditransfer TikTok ke bank harus sama dengan jumlah laporan yang dibayarnya, dan setiap pencairan yang sudah berhasil harus sudah dijurnal (Bank utama / Saldo Penjual TikTok)."
      >
        {check.payouts.rows.length === 0 ? (
          <EmptyState title="Belum ada pencairan TikTok" description="Pencairan muncul setelah sinkronisasi keuangan TikTok berjalan." />
        ) : (
          <>
            <Shown shown={check.payouts.rows.length} total={check.payouts.rowCount} what="pencairan" />
            <ResponsiveList
              rows={check.payouts.rows}
              caption="Pencairan TikTok"
              firstColumn="Pencairan"
              testId="reconciliation-tiktok-payout"
              rowKey={(row) => row.paymentId}
              title={(row) => (
                <span className="flex flex-col">
                  <span className="font-medium text-neutral-900">{row.paymentId}</span>
                  <span className="text-sm text-neutral-600">
                    {row.paidTime ? DATE.format(row.paidTime) : "belum ada tanggal"}, {row.journaled ? "sudah dijurnal" : row.status === "PAID" ? "belum dijurnal" : "belum berhasil"}
                  </span>
                </span>
              )}
              status={(row) => row.rowStatus}
              columns={[
                { label: "Dicairkan", numeric: true, cell: (row) => <MaybeAmount value={row.amount} /> },
                { label: "Jumlah laporan", numeric: true, cell: (row) => <MaybeAmount value={row.statementsTotal} /> },
                { label: "Selisih", numeric: true, cell: (row) => <MaybeAmount value={row.difference} /> },
              ]}
            />
          </>
        )}
      </Block>

      <Block
        id="reconciliation-tiktok-ads"
        title="Iklan yang mungkin tercatat dua kali"
        description="Penyesuaian iklan dari laporan TikTok di samping biaya yang dicatat dengan kanal TikTok dan dibayar dari saldo, di bulan yang sama dengan nilai yang sama. Jika keduanya iklan yang sama, batalkan catatan biayanya atau petakan ulang jenis penyesuaiannya."
      >
        {check.adsPairs.length === 0 ? (
          <p className="text-sm text-neutral-600" data-testid="reconciliation-tiktok-ads-empty">
            Tidak ada pasangan.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="reconciliation-tiktok-ads-list">
            {check.adsPairs.map((pair) => (
              <li key={`${pair.adjustment.id}-${pair.expense.id}`}>
                <Card className="flex flex-col gap-1 text-base sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    {MONTH_NAMES[Number(pair.month.slice(5, 7)) - 1]} {pair.month.slice(0, 4)}: {pair.adjustment.label}
                  </span>
                  <span className="flex flex-wrap items-center gap-3">
                    <Amount value={pair.amount} />
                    <Link href="/expenses" className="font-medium text-brand hover:underline">
                      Biaya {pair.expense.label}
                    </Link>
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}
