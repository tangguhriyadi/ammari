import Link from "next/link";
import type { ReactNode } from "react";
import { Button, Card, Input, Label, Pagination, Tabs } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { VOUCHER_FILTERS, VOUCHER_FILTER_LABELS, voucherTabHref, type VoucherTabParams } from "@/lib/customers/search-params";
import { formatDateRange } from "@/lib/overview/format";
import { getVoucherPeriodStats, getVoucherStatusCounts, listExpiringSoonVouchers, listVouchers, ratePercent, type RateParts } from "@/lib/vouchers/overview";
import { VoucherList } from "./voucher-list";

// Tab "Voucher" (docs/plans/growth.md §9.2, session S5): counts by effective status, the period
// block (cards printed and claimed, claim and redemption rates), "Segera berakhir" (A12, read-only)
// and every voucher by status. Void and extend live on the customer's page. "Nilai voucher aktif"
// is read and rendered only for finance.view_profit.

function Tile({ label, value, sub, testId }: { label: string; value: ReactNode; sub?: ReactNode; testId: string }) {
  return (
    <Card className="flex flex-col gap-1 p-4" data-testid={testId}>
      <span className="text-sm text-neutral-600">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-neutral-900">{value}</span>
      {sub && <span className="text-sm text-neutral-600">{sub}</span>}
    </Card>
  );
}

/** "Segera berakhir" shows the soonest ones; the filtered list below has them all. */
const EXPIRING_LIST_LIMIT = 50;

function rateText(parts: RateParts): string {
  const percent = ratePercent(parts);
  return percent === null ? "Belum ada" : `${percent}%`;
}

export async function VoucherTab({ params, canViewProfit, rawPage, rawPerPage }: { params: VoucherTabParams; canViewProfit: boolean; rawPage?: string; rawPerPage?: string }) {
  const { period } = params;
  const [counts, stats, expiring, list] = await Promise.all([
    getVoucherStatusCounts({ canViewProfit }),
    getVoucherPeriodStats(period.range),
    listExpiringSoonVouchers(EXPIRING_LIST_LIMIT),
    listVouchers({ status: params.status, q: params.q }, rawPage, rawPerPage),
  ]);
  const periodLink = { status: params.status, q: params.q };

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="voucher-counts-heading" className="flex flex-col gap-3">
        <h2 id="voucher-counts-heading" className="text-lg font-semibold text-neutral-900">
          Semua voucher saat ini
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile
            label="Aktif"
            value={formatNumber(counts.active)}
            testId="voucher-count-active"
            sub={
              <>
                {counts.expiringSoon > 0 && <span className="block">{formatNumber(counts.expiringSoon)} segera berakhir</span>}
                {counts.activeValue !== null && <span className="block" data-testid="voucher-active-value">Nilai voucher aktif {formatRupiah(counts.activeValue)}</span>}
              </>
            }
          />
          <Tile label="Terpakai" value={formatNumber(counts.used)} testId="voucher-count-used" />
          <Tile label="Kedaluwarsa" value={formatNumber(counts.expired)} testId="voucher-count-expired" />
          <Tile label="Dibatalkan" value={formatNumber(counts.void)} testId="voucher-count-void" />
        </div>
      </section>

      <section aria-labelledby="voucher-period-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="voucher-period-heading" className="text-lg font-semibold text-neutral-900">
            Kartu dan voucher per periode
          </h2>
          <p className="text-sm text-neutral-600" data-testid="voucher-period-range">
            {formatDateRange(period.fromDate, period.toDate)}
          </p>
        </div>
        <Tabs
          aria-label="Periode voucher"
          items={[
            { label: "Bulan ini", href: voucherTabHref({ ...periodLink, period: "this_month" }), isActive: period.period === "this_month" },
            { label: "Bulan lalu", href: voucherTabHref({ ...periodLink, period: "last_month" }), isActive: period.period === "last_month" },
          ]}
        />
        <form method="GET" action="/customers" className="flex flex-wrap items-end gap-3" aria-label="Rentang tanggal voucher">
          <input type="hidden" name="tab" value="voucher" />
          <input type="hidden" name="period" value="custom" />
          {params.status && <input type="hidden" name="status" value={params.status} />}
          {params.q && <input type="hidden" name="q" value={params.q} />}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="voucher-from">Dari</Label>
            <Input id="voucher-from" name="from" type="date" defaultValue={period.period === "custom" ? period.fromDate : ""} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="voucher-to">Sampai</Label>
            <Input id="voucher-to" name="to" type="date" defaultValue={period.period === "custom" ? period.toDate : ""} />
          </div>
          <Button type="submit" variant="secondary">
            Terapkan rentang
          </Button>
        </form>
        {params.periodFellBack && (
          <p role="alert" className="text-base text-danger-700">
            Rentang tanggal tidak valid (maksimal 366 hari, tidak melewati hari ini). Menampilkan bulan ini.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Tile label="Kartu dicetak" value={formatNumber(stats.cardsPrinted)} testId="voucher-period-printed" />
          <Tile label="Kartu diklaim" value={formatNumber(stats.cardsClaimed)} testId="voucher-period-claimed" />
          <Tile label="Voucher dipakai" value={formatNumber(stats.vouchersUsed)} testId="voucher-period-used" />
          <Tile
            label="Tingkat klaim"
            value={rateText(stats.claimRate)}
            testId="voucher-claim-rate"
            sub={`${formatNumber(stats.claimRate.part)} dari ${formatNumber(stats.claimRate.whole)} kartu yang batas klaimnya sudah lewat`}
          />
          <Tile
            label="Tingkat pemakaian"
            value={rateText(stats.redemptionRate)}
            testId="voucher-redemption-rate"
            sub={`${formatNumber(stats.redemptionRate.part)} dari ${formatNumber(stats.redemptionRate.whole)} voucher yang sudah dipakai atau kedaluwarsa`}
          />
        </div>
        <p className="text-sm text-neutral-600">
          Kartu yang masih bisa diklaim dan voucher yang masih aktif belum dihitung di tingkat klaim dan tingkat pemakaian.
        </p>
      </section>

      <section aria-labelledby="voucher-expiring-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="voucher-expiring-heading" className="text-lg font-semibold text-neutral-900">
            Segera berakhir
          </h2>
          <p className="text-sm text-neutral-600">
            Voucher aktif yang berakhir dalam 14 hari. Hanya daftar, tidak ada pesan yang dikirim dari sini.
            {counts.expiringSoon > expiring.length && (
              <>
                {" "}
                Menampilkan {formatNumber(expiring.length)} yang paling cepat berakhir dari {formatNumber(counts.expiringSoon)};{" "}
                <Link href={voucherTabHref({ status: "expiring" })} className="font-medium text-brand hover:underline">
                  lihat semua
                </Link>
                .
              </>
            )}
          </p>
        </div>
        <VoucherList rows={expiring} testId="voucher-expiring" emptyTitle="Tidak ada" emptyDescription="Tidak ada voucher aktif yang berakhir dalam 14 hari." />
      </section>

      <section aria-labelledby="voucher-all-heading" className="flex flex-col gap-3">
        <h2 id="voucher-all-heading" className="text-lg font-semibold text-neutral-900">
          Daftar voucher
        </h2>
        <Tabs
          aria-label="Filter status voucher"
          items={[undefined, ...VOUCHER_FILTERS].map((status) => ({
            label: VOUCHER_FILTER_LABELS[status ?? "all"],
            href: voucherTabHref({ status, q: params.q, period: period.period, from: period.fromDate, to: period.toDate }),
            isActive: status === params.status,
          }))}
        />
        <form method="GET" action="/customers" className="flex flex-wrap items-end gap-3" aria-label="Cari voucher">
          <input type="hidden" name="tab" value="voucher" />
          {params.status && <input type="hidden" name="status" value={params.status} />}
          {period.period !== "this_month" && <input type="hidden" name="period" value={period.period} />}
          {period.period === "custom" && (
            <>
              <input type="hidden" name="from" value={period.fromDate} />
              <input type="hidden" name="to" value={period.toDate} />
            </>
          )}
          <div className="flex min-w-60 flex-1 flex-col gap-1.5 sm:max-w-sm">
            <Label htmlFor="voucher-q">Cari pelanggan</Label>
            <Input id="voucher-q" name="q" defaultValue={params.q ?? ""} placeholder="Nama atau email" />
          </div>
          <Button type="submit">Cari</Button>
          <Link href={voucherTabHref({})} className="text-base font-medium text-brand hover:underline">
            Reset
          </Link>
        </form>
        <VoucherList rows={list.rows} testId="voucher" emptyTitle="Belum ada voucher" emptyDescription="Tidak ada voucher yang cocok dengan filter ini." />
        <Pagination
          pagination={list.pagination}
          basePath="/customers"
          searchParams={{ tab: "voucher", status: params.status, q: params.q, perPage: rawPerPage }}
          itemLabel="voucher"
        />
      </section>
    </div>
  );
}
