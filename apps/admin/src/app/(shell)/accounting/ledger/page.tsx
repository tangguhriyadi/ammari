import Link from "next/link";
import { Breadcrumb, Button, EmptyState, Input, Label, PageHeader, Pagination, Select } from "@ammari/ui";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { requirePermission } from "@/lib/auth/require-permission";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { parseLedgerFilters, toSearchParams, type RawLedgerParams } from "@/lib/accounting/filters";
import { getLedger, listChannelOptions, listPostableAccounts, listSupplierOptions } from "@/lib/accounting/queries";
import { trialBalanceNotes } from "@/lib/accounting/trial-balance-content";
import { LedgerTable } from "../_components/ledger-table";

// Buku besar (docs/plans/accounting.md §6, Session 2): one account at a time, with its opening
// balance, every line in the range and a running balance; sub-ledger filters by supplier and
// channel. Read-only. Filters live in the URL (a plain GET form).

export default async function LedgerPage({ searchParams }: { searchParams: Promise<RawLedgerParams & { page?: string; perPage?: string }> }) {
  await requirePermission("accounting.view");
  const raw = await searchParams;
  const today = jakartaDate();
  const filters = parseLedgerFilters(raw, today);

  const [ledger, accountOptions, supplierOptions, channelOptions] = await Promise.all([
    getLedger(filters, raw.page, raw.perPage),
    listPostableAccounts(),
    listSupplierOptions(),
    listChannelOptions(),
  ]);

  const ledgerNotes = ledger ? trialBalanceNotes(ledger.range) : [];

  return (
    <>
      <Breadcrumb items={rootCrumbs("/accounting/ledger")} />
      <PageHeader
        title={ledger ? `Buku Besar ${ledger.account.code} ${ledger.account.name}` : "Buku Besar"}
        description="Semua transaksi satu akun dengan saldo berjalan."
      />
      <form method="GET" className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end" aria-label="Filter buku besar">
        {raw.perPage && <input type="hidden" name="perPage" value={raw.perPage} />}
        <div className="flex flex-col gap-1.5 lg:col-span-2">
          <Label htmlFor="ledger-account">Akun</Label>
          <Select id="ledger-account" name="account" defaultValue={filters.accountCode ?? ""}>
            <option value="">Pilih akun</option>
            {accountOptions.map((account) => (
              <option key={account.code} value={account.code}>
                {account.code} {account.name}
                {account.isActive ? "" : " (nonaktif)"}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ledger-from">Dari tanggal</Label>
          <Input id="ledger-from" name="from" type="date" defaultValue={filters.from} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ledger-to">Sampai tanggal</Label>
          <Input id="ledger-to" name="to" type="date" defaultValue={filters.to} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ledger-supplier">Supplier</Label>
          <Select id="ledger-supplier" name="supplier" defaultValue={filters.supplierId ?? ""}>
            <option value="">Semua</option>
            {supplierOptions.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ledger-channel">Kanal</Label>
          <Select id="ledger-channel" name="channel" defaultValue={filters.channelId ?? ""}>
            <option value="">Semua</option>
            {channelOptions.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit">Tampilkan</Button>
          {filters.accountCode && (
            <Link href="/accounting/ledger" className="text-base font-medium text-brand hover:underline">
              Reset
            </Link>
          )}
        </div>
      </form>
      {ledger ? (
        <>
          {/* One set of books per view (D-22, books.ts): December 2026 never reaches 2027. */}
          {ledgerNotes.length > 0 && (
            <ul className="mb-4 flex flex-col gap-1 text-sm text-neutral-600" data-testid="ledger-notes">
              {ledgerNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <LedgerTable ledger={ledger} />
          <Pagination
            pagination={ledger.pagination}
            basePath="/accounting/ledger"
            searchParams={{
              ...toSearchParams({ account: filters.accountCode, from: ledger.range.from, to: ledger.range.to, supplier: filters.supplierId, channel: filters.channelId }),
              perPage: raw.perPage,
            }}
            itemLabel="baris"
          />
        </>
      ) : (
        <EmptyState title="Pilih akun" description="Pilih akun dan periode, lalu tekan Tampilkan." />
      )}
    </>
  );
}
