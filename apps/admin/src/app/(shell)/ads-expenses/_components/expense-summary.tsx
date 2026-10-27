import type { ReactNode } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardList, EmptyState, Input, Label, TableContainer, TableHead, Tabs, Td, Th, Tr } from "@ammari/ui";
import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { buildRoasRows, formatRoasTenths, labaBersih, type RoasRow } from "@/lib/expenses/figures";
import { EXPENSE_CATEGORY_LABELS } from "@/lib/expenses/labels";
import { expenseListHref, expenseSummaryHref, MAX_SUMMARY_MONTHS, type ExpenseSummaryParams, type ExpenseSummaryPeriod } from "@/lib/expenses/search-params";
import { dateRangeToTimeRange, getExpenseBreakdown } from "@/lib/expenses/summary";
import { formatCalendarDate, formatMonthYear, formatPercentBps } from "@/lib/overview/format";
import { getChannelBreakdown, getPeriodTotals } from "@/lib/overview/queries";

// Iklan & Biaya, "Ringkasan" (docs/plans/growth.md §4, §6, session S3): Laba bersih and ad spend
// vs omzet for whole months. The page already required ads_expenses.manage + finance.view_profit,
// so every query here runs with canViewProfit: true. Omzet, laba and the web shipping subsidy come
// from the Ringkasan queries (one definition); expenses count on their payment date.

const PERIOD_LABELS: Record<ExpenseSummaryPeriod, string> = {
  this_month: "Bulan ini",
  last_month: "Bulan lalu",
  month: "Pilih bulan",
  range: "Rentang bulan",
};

/** "Oktober 2026 (s.d. 27 Okt 2026)", "September 2026", "Januari 2026 s.d. Maret 2026". */
function periodHeading(params: ExpenseSummaryParams, today: string): string {
  const months = params.fromMonth === params.toMonth ? formatMonthYear(params.fromMonth) : `${formatMonthYear(params.fromMonth)} s.d. ${formatMonthYear(params.toMonth)}`;
  return params.range.to === today ? `${months} (s.d. ${formatCalendarDate(today)})` : months;
}

function PeriodPicker({ params }: { params: ExpenseSummaryParams }) {
  return (
    <div className="flex flex-col gap-3">
      <Tabs
        aria-label="Pilih periode"
        items={(Object.keys(PERIOD_LABELS) as ExpenseSummaryPeriod[]).map((period) => ({
          label: PERIOD_LABELS[period],
          href: expenseSummaryHref({ period }),
          isActive: period === params.period,
        }))}
      />
      {(params.period === "month" || params.period === "range") && (
        <form method="get" action="/ads-expenses" className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 sm:flex-row sm:items-end">
          <input type="hidden" name="tab" value="ringkasan" />
          <input type="hidden" name="period" value={params.period} />
          {params.period === "month" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="summary-month">Bulan</Label>
              <Input id="summary-month" name="month" type="month" defaultValue={params.invalid ? "" : params.fromMonth} required />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:flex">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="summary-from">Dari bulan</Label>
                <Input id="summary-from" name="from" type="month" defaultValue={params.invalid ? "" : params.fromMonth} required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="summary-to">Sampai bulan</Label>
                <Input id="summary-to" name="to" type="month" defaultValue={params.invalid ? "" : params.toMonth} required />
              </div>
            </div>
          )}
          <Button type="submit" variant="secondary">
            Tampilkan
          </Button>
          {params.invalid && (
            <p role="alert" className="text-sm text-danger-700 sm:self-center">
              {params.period === "month"
                ? "Pilih bulan yang sudah berjalan. Sekarang menampilkan bulan ini."
                : `Pilih rentang paling lama ${MAX_SUMMARY_MONTHS} bulan dan tidak melewati bulan ini. Sekarang menampilkan bulan ini.`}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

function Tile({ label, value, valueClassName, testId, children }: { label: string; value: number; valueClassName?: string; testId: string; children?: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <h3 className="text-sm font-medium text-neutral-600">{label}</h3>
      <p className={`text-2xl font-semibold tabular-nums ${valueClassName ?? "text-neutral-900"}`} data-testid={`${testId}-value`}>
        {formatRupiah(value)}
      </p>
      {children}
    </Card>
  );
}

function RoasBadge({ row }: { row: RoasRow }) {
  if (row.status === null) return <span className="text-sm text-neutral-600">Belum ada iklan</span>;
  return row.status === "above" ? <Badge variant="success">Di atas titik impas</Badge> : <Badge variant="danger">Di bawah titik impas</Badge>;
}

/** Only Shopee and TikTok Shop ads are tied to their channel by category; every other ROAS mixes
 * in Meta, which drives buyers to several channels, so it is an estimate (§4.1). */
const EXACT_ROAS_KEYS: readonly RoasRow["key"][] = ["shopee", "tiktok"];

function roasText(row: RoasRow): string {
  if (row.roasTenths === null) return "-";
  return EXACT_ROAS_KEYS.includes(row.key) ? formatRoasTenths(row.roasTenths) : `${formatRoasTenths(row.roasTenths)} (perkiraan)`;
}

function percentOfOmzet(amount: number, omzet: number): string {
  return omzet > 0 ? formatPercentBps(Math.round((amount * 10_000) / omzet)) : "-";
}

export async function ExpenseSummary({ params, today, now }: { params: ExpenseSummaryParams; today: string; now: Date }) {
  const time = dateRangeToTimeRange(params.range, now);
  const [totals, channels, expenses] = await Promise.all([
    getPeriodTotals(time, { canViewProfit: true }),
    getChannelBreakdown(time, { canViewProfit: true }),
    getExpenseBreakdown(params.range),
  ]);
  const money = totals.money;
  if (!money) throw new Error("expense summary needs the money totals");
  const net = labaBersih({ labaSetelahBiayaPlatform: money.labaSetelahBiayaPlatform, webShippingSubsidy: money.webShippingSubsidy, expenses: expenses.total });
  const incomplete = money.linesWithoutCost > 0 || money.platformFees.ordersWithoutFees > 0;
  const roasRows = buildRoasRows(expenses.marketing, new Map(channels.map((channel) => [channel.channelId, channel.omzet ?? 0])));

  return (
    <div className="flex flex-col gap-6">
      <PeriodPicker params={params} />
      <section aria-labelledby="summary-heading" className="flex flex-col gap-3">
        <h2 id="summary-heading" className="text-lg font-semibold text-neutral-900" data-testid="summary-period">
          {periodHeading(params, today)}
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Tile label="Omzet" value={money.omzet} testId="summary-omzet">
            <p className="text-sm text-neutral-600 tabular-nums">{formatNumber(totals.orders)} pesanan</p>
          </Tile>
          <Tile label="Laba setelah biaya platform" value={money.labaSetelahBiayaPlatform} testId="summary-after-fees" />
          <Tile label="Total biaya" value={expenses.total} testId="summary-expenses">
            <p className="text-sm text-neutral-600">Iklan dan operasional, tanpa yang dibatalkan</p>
          </Tile>
          <Tile label="Laba bersih" value={net} valueClassName={net >= 0 ? "text-success-700" : "text-danger-700"} testId="summary-net">
            <p className="text-sm text-neutral-600 tabular-nums" data-testid="summary-subsidy">
              Subsidi ongkir situs {formatRupiah(money.webShippingSubsidy)}
            </p>
          </Tile>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          {money.linesWithoutCost > 0 && (
            <p className="text-warning-700" data-testid="summary-hpp-incomplete">
              HPP belum lengkap untuk {formatNumber(money.linesWithoutCost)} item
            </p>
          )}
          {money.platformFees.ordersWithoutFees > 0 && (
            <p className="text-warning-700" data-testid="summary-fee-incomplete">
              Biaya platform belum lengkap untuk {formatNumber(money.platformFees.ordersWithoutFees)} pesanan
            </p>
          )}
          {incomplete && (
            <p className="font-medium text-warning-700" data-testid="summary-net-incomplete">
              Laba bersih belum lengkap: angka sebenarnya lebih kecil dari yang tampil.
            </p>
          )}
          <p className="text-pretty text-neutral-600">
            Laba bersih: laba setelah biaya platform, dikurangi subsidi ongkir situs dan semua biaya iklan dan operasional. Biaya dihitung pada tanggal dibayar. Gaji dan sewa
            yang dibayar di awal bulan masuk ke bulan itu.
          </p>
        </div>
      </section>

      <section aria-labelledby="summary-categories-heading" className="flex flex-col gap-3">
        <h2 id="summary-categories-heading" className="text-lg font-semibold text-neutral-900">
          Biaya per kategori
        </h2>
        {expenses.byCategory.length === 0 ? (
          <EmptyState title="Belum ada biaya" description="Belum ada biaya tercatat di periode ini." />
        ) : (
          <>
            <CardList>
              {expenses.byCategory.map((entry) => (
                <li key={entry.category} data-testid="summary-category-card">
                  <Card className="flex items-center justify-between gap-3">
                    <span className="text-base font-medium text-neutral-900">{EXPENSE_CATEGORY_LABELS[entry.category]}</span>
                    <span className="flex flex-col items-end">
                      <span className="text-base font-semibold tabular-nums text-neutral-900">{formatRupiah(entry.amount)}</span>
                      <span className="text-sm text-neutral-600 tabular-nums">{percentOfOmzet(entry.amount, money.omzet)} dari omzet</span>
                    </span>
                  </Card>
                </li>
              ))}
            </CardList>
            <TableContainer>
              <TableHead>
                <Th>Kategori</Th>
                <Th className="text-right">Jumlah</Th>
                <Th className="text-right">% dari omzet</Th>
              </TableHead>
              <tbody>
                {expenses.byCategory.map((entry) => (
                  <Tr key={entry.category} data-testid="summary-category-row">
                    <Td>{EXPENSE_CATEGORY_LABELS[entry.category]}</Td>
                    <Td className="text-right tabular-nums">{formatRupiah(entry.amount)}</Td>
                    <Td className="text-right tabular-nums">{percentOfOmzet(entry.amount, money.omzet)}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableContainer>
          </>
        )}
      </section>

      <section aria-labelledby="summary-roas-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id="summary-roas-heading" className="text-lg font-semibold text-neutral-900">
            Iklan vs omzet
          </h2>
          <p className="text-sm text-neutral-600 text-pretty">
            ROAS = omzet dibagi biaya iklan. Titik impas 8,3. Iklan Meta mendorong pembeli ke beberapa kanal, jadi ROAS Situs, Instagram, WhatsApp dan Total adalah perkiraan.
          </p>
        </div>
        <CardList>
          {roasRows.map((row) => (
            <li key={row.key} data-testid="summary-roas-card" data-channel={row.key}>
              <Card className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className={`text-base text-neutral-900 ${row.key === "total" ? "font-semibold" : "font-medium"}`}>{row.label}</span>
                  <RoasBadge row={row} />
                </div>
                <dl className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-neutral-600">Biaya iklan</dt>
                    <dd className="font-medium tabular-nums text-neutral-900">{formatRupiah(row.adSpend)}</dd>
                  </div>
                  <div>
                    <dt className="text-neutral-600">Omzet</dt>
                    <dd className="font-medium tabular-nums text-neutral-900">{row.omzet === null ? "-" : formatRupiah(row.omzet)}</dd>
                  </div>
                  <div>
                    <dt className="text-neutral-600">ROAS</dt>
                    <dd className="font-medium tabular-nums text-neutral-900">{roasText(row)}</dd>
                  </div>
                </dl>
              </Card>
            </li>
          ))}
        </CardList>
        <TableContainer>
          <TableHead>
            <Th>Kanal</Th>
            <Th className="text-right">Biaya iklan</Th>
            <Th className="text-right">Omzet</Th>
            <Th className="text-right">ROAS</Th>
            <Th>Status</Th>
          </TableHead>
          <tbody>
            {roasRows.map((row) => (
              <Tr key={row.key} data-testid="summary-roas-row" data-channel={row.key} className={row.key === "total" ? "font-semibold" : undefined}>
                <Td>{row.label}</Td>
                <Td className="text-right tabular-nums">{formatRupiah(row.adSpend)}</Td>
                <Td className="text-right tabular-nums">{row.omzet === null ? "-" : formatRupiah(row.omzet)}</Td>
                <Td className="text-right tabular-nums">{roasText(row)}</Td>
                <Td>
                  <RoasBadge row={row} />
                </Td>
              </Tr>
            ))}
          </tbody>
        </TableContainer>
        <div className="flex flex-col gap-1 text-base text-neutral-800">
          <p data-testid="summary-endorsement">
            Biaya endorse <span className="font-semibold tabular-nums">{formatRupiah(expenses.marketing.endorsement)}</span>
            <span className="text-sm text-neutral-600"> (tidak masuk ROAS)</span>
          </p>
          <p data-testid="summary-marketing-total">
            Biaya pemasaran <span className="font-semibold tabular-nums">{formatRupiah(expenses.marketing.marketingTotal)}</span>
            <span className="text-sm text-neutral-600"> (iklan + endorse)</span>
          </p>
        </div>
      </section>
      <p className="text-sm text-neutral-600">
        Rincian per biaya ada di tab{" "}
        <Link href={expenseListHref({ month: params.toMonth, showVoided: false })} className="font-medium text-brand underline-offset-2 hover:underline">
          Pengeluaran
        </Link>
        .
      </p>
    </div>
  );
}
