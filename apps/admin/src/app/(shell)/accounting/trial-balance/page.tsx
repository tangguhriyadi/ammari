import Link from "next/link";
import { Breadcrumb, Button, Card, CardList, EmptyState, Input, Label, PageHeader } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { parseDateRange } from "@/lib/accounting/filters";
import { formatAmount, formatBalance } from "@/lib/accounting/format";
import { getTrialBalance, type TrialBalanceRow } from "@/lib/accounting/trial-balance";
import { trialBalanceNotes, trialBalancePeriodLabel } from "@/lib/accounting/trial-balance-content";
import { rootCrumbs } from "@/lib/nav/breadcrumb";

// Neraca saldo (docs/plans/accounting.md §6, Session 4): every account with a balance or movement,
// opening / debit / credit / closing, which must balance; PDF and Excel. accounting.view. The range
// stays inside one set of books (books.ts: the December trial month or the official books from
// 1 Jan 2027), so December never reaches a 2027 balance. Filters live in the URL (a GET form).

type RawParams = { from?: string | string[]; to?: string | string[] };

/** A balance on its own side: "Rp 1.000 D" / "Rp 1.000 K". */
function sided(debit: number, credit: number): string {
  if (debit > 0) return `${formatBalance(debit)} D`;
  if (credit > 0) return `${formatBalance(credit)} K`;
  return "-";
}

function AccountLabel({ row }: { row: TrialBalanceRow }) {
  return (
    <Link href={`/accounting/ledger?account=${row.code}`} className="hover:underline">
      <span className="tabular-nums text-neutral-600">{row.code}</span> <span className="text-neutral-900">{row.name}</span>
      {!row.isActive && <span className="text-sm text-neutral-600"> (nonaktif)</span>}
    </Link>
  );
}

export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<RawParams> }) {
  await requirePermission("accounting.view");
  const raw = await searchParams;
  const requested = parseDateRange(raw, jakartaDate());
  const report = await getTrialBalance(requested);
  const { range, rows, totals } = report;
  const exportQuery = `from=${range.from}&to=${range.to}`;
  const ledgerRange = `&from=${range.from}&to=${range.to}`;

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/trial-balance")} />
      <PageHeader
        title="Neraca Saldo"
        description={`Saldo awal, mutasi debit dan kredit, dan saldo akhir setiap akun. Periode ${trialBalancePeriodLabel(range)}.`}
        actions={
          <div className="flex flex-wrap gap-3">
            <a href={`/accounting/trial-balance/export?${exportQuery}&format=pdf`} download>
              <Button variant="secondary">Unduh PDF</Button>
            </a>
            <a href={`/accounting/trial-balance/export?${exportQuery}&format=xlsx`} download>
              <Button variant="secondary">Unduh Excel</Button>
            </a>
          </div>
        }
      />
      <form method="GET" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end lg:max-w-3xl" aria-label="Filter neraca saldo">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="trial-balance-from">Dari tanggal</Label>
          <Input id="trial-balance-from" name="from" type="date" defaultValue={range.from} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="trial-balance-to">Sampai tanggal</Label>
          <Input id="trial-balance-to" name="to" type="date" defaultValue={range.to} />
        </div>
        <div>
          <Button type="submit">Tampilkan</Button>
        </div>
      </form>
      {trialBalanceNotes(range).length > 0 && (
        <ul className="mb-4 flex flex-col gap-1 text-sm text-neutral-600" data-testid="trial-balance-notes">
          {trialBalanceNotes(range).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {rows.length === 0 ? (
        <EmptyState title="Belum ada saldo di periode ini" description="Neraca saldo terisi setelah ada jurnal (posting otomatis, jurnal manual, atau saldo awal)." />
      ) : (
        <>
          <CardList>
            {rows.map((row) => (
              <li key={row.code} data-testid="trial-balance-card">
                <Card className="flex flex-col gap-2">
                  <AccountLabel row={row} />
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-base tabular-nums">
                    <dt className="text-neutral-600">Saldo awal</dt>
                    <dd className="text-right">{sided(row.openingDebit, row.openingCredit)}</dd>
                    <dt className="text-neutral-600">Debit</dt>
                    <dd className="text-right">{formatAmount(row.debit) || "-"}</dd>
                    <dt className="text-neutral-600">Kredit</dt>
                    <dd className="text-right">{formatAmount(row.credit) || "-"}</dd>
                    <dt className="font-medium text-neutral-900">Saldo akhir</dt>
                    <dd className="text-right font-medium">{sided(row.closingDebit, row.closingCredit)}</dd>
                  </dl>
                  <Link href={`/accounting/ledger?account=${row.code}${ledgerRange}`} className="text-sm font-medium text-brand hover:underline">
                    Buka buku besar
                  </Link>
                </Card>
              </li>
            ))}
            <li data-testid="trial-balance-total-card">
              <Card className="flex flex-col gap-2">
                <span className="font-medium text-neutral-900">Total</span>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-base tabular-nums">
                  <dt className="text-neutral-600">Debit</dt>
                  <dd className="text-right">{formatBalance(totals.debit)}</dd>
                  <dt className="text-neutral-600">Kredit</dt>
                  <dd className="text-right">{formatBalance(totals.credit)}</dd>
                  <dt className="text-neutral-600">Saldo akhir D / K</dt>
                  <dd className="text-right">
                    {formatBalance(totals.closingDebit)} / {formatBalance(totals.closingCredit)}
                  </dd>
                </dl>
                <BalancedLine balanced={report.balanced} />
              </Card>
            </li>
          </CardList>

          <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block">
            <table className="w-full text-left text-base" aria-label="Neraca saldo">
              <thead className="border-b border-neutral-200 bg-neutral-50 text-sm text-neutral-600">
                <tr>
                  <th rowSpan={2} scope="col" className="px-4 py-2 align-bottom font-medium">
                    Akun
                  </th>
                  <th colSpan={2} scope="colgroup" className="whitespace-nowrap px-4 pt-2 text-center font-medium">
                    Saldo awal
                  </th>
                  <th colSpan={2} scope="colgroup" className="whitespace-nowrap px-4 pt-2 text-center font-medium">
                    Mutasi
                  </th>
                  <th colSpan={2} scope="colgroup" className="whitespace-nowrap px-4 pt-2 text-center font-medium">
                    Saldo akhir
                  </th>
                </tr>
                <tr>
                  {["Debit", "Kredit", "Debit", "Kredit", "Debit", "Kredit"].map((label, index) => (
                    <th key={index} scope="col" className="whitespace-nowrap px-4 pb-2 text-right font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.code} data-testid="trial-balance-row" className="border-b border-neutral-100 hover:bg-neutral-50">
                    <th scope="row" className="px-4 py-2 text-left font-normal">
                      <AccountLabel row={row} />
                    </th>
                    {[row.openingDebit, row.openingCredit, row.debit, row.credit, row.closingDebit, row.closingCredit].map((amount, index) => (
                      <td key={index} className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                        {formatAmount(amount)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-neutral-300 bg-neutral-50 font-medium">
                <tr data-testid="trial-balance-total-row">
                  <th scope="row" className="px-4 py-3 text-left font-medium">
                    Total <BalancedLine balanced={report.balanced} />
                  </th>
                  {[totals.openingDebit, totals.openingCredit, totals.debit, totals.credit, totals.closingDebit, totals.closingCredit].map((amount, index) => (
                    <td key={index} className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                      {formatBalance(amount)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function BalancedLine({ balanced }: { balanced: boolean }) {
  return balanced ? <span className="text-sm font-medium text-success-700">Seimbang</span> : <span className="text-sm font-medium text-danger-700">Tidak seimbang</span>;
}
