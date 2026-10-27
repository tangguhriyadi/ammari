import { formatNumber, formatRupiah } from "@ammari/ui/lib";
import { formatCalendarDate, formatMonthYear, formatPercentBps } from "@/lib/overview/format";
import { formatRoasTenths, type BreakEvenRoas, type RoasRow } from "./figures";
import { EXPENSE_CATEGORY_LABELS, MARKETING_CHANNEL_LABELS, MARKETING_CHANNEL_OPTIONS, type MarketingChannelId } from "./labels";
import type { ExpenseSummaryParams } from "./search-params";
import type { ExpenseSummary } from "./summary";

// What the monthly report says, shared by the PDF and the Excel file (docs/plans/growth.md
// session S6, owner addition A). Pure: built from getExpenseSummary's result, so both files and the
// Ringkasan tab show the same figures. No em dash anywhere (house style for UI text).

/** "Februari 2026", "Januari 2026 s.d. Maret 2026", "Oktober 2026 (s.d. 27 Okt 2026)". */
export function reportPeriodLabel(params: ExpenseSummaryParams, today: string): string {
  const months = params.fromMonth === params.toMonth ? formatMonthYear(params.fromMonth) : `${formatMonthYear(params.fromMonth)} s.d. ${formatMonthYear(params.toMonth)}`;
  return params.range.to === today ? `${months} (s.d. ${formatCalendarDate(today)})` : months;
}

export function reportTitle(params: ExpenseSummaryParams, today: string): string {
  return `Laporan Keuangan ${reportPeriodLabel(params, today)}`;
}

/** "laporan-keuangan-2026-02.pdf", "laporan-keuangan-2026-01-sd-2026-03.xlsx". Only digits,
 * letters and dashes: safe in a Content-Disposition header as is. */
export function reportFileName(params: ExpenseSummaryParams, format: "pdf" | "xlsx"): string {
  const period = params.fromMonth === params.toMonth ? params.fromMonth : `${params.fromMonth}-sd-${params.toMonth}`;
  return `laporan-keuangan-${period}.${format}`;
}

/** "Rp 1.000" or "-Rp 1.000". */
export function formatSignedRupiah(amount: number): string {
  return amount < 0 ? `-${formatRupiah(-amount)}` : formatRupiah(Math.abs(amount));
}

export interface ProfitLossLine {
  label: string;
  /** Signed as it affects laba: costs are negative. */
  amount: number;
  /** "result" lines (Laba kotor, Laba bersih, ...) are bold; "detail" lines are indented. */
  kind: "line" | "result" | "detail";
}

/** The management P&L (owner addition A), top to bottom. Costs are negative so the column adds up:
 * Omzet - HPP = Laba kotor; - Biaya platform = Laba setelah biaya platform; - Subsidi ongkir situs
 * - Biaya operasional & iklan = Laba bersih. */
export function profitAndLossLines(summary: ExpenseSummary): ProfitLossLine[] {
  const { money, expenses } = summary;
  // 0 - x, not -x: a cost of 0 stays 0, never -0 ("Rp -0").
  const cost = (amount: number) => 0 - amount;
  return [
    { label: "Omzet", amount: money.omzet, kind: "line" },
    { label: "HPP", amount: cost(money.hpp), kind: "line" },
    { label: "Laba kotor", amount: money.labaKotor, kind: "result" },
    { label: "Biaya platform", amount: cost(money.platformFee), kind: "line" },
    { label: "Laba setelah biaya platform", amount: money.labaSetelahBiayaPlatform, kind: "result" },
    { label: "Subsidi ongkir situs", amount: cost(money.webShippingSubsidy), kind: "line" },
    { label: "Biaya operasional & iklan", amount: cost(expenses.total), kind: "line" },
    ...expenses.byCategory.map((entry): ProfitLossLine => ({ label: EXPENSE_CATEGORY_LABELS[entry.category], amount: cost(entry.amount), kind: "detail" })),
    { label: "Laba bersih", amount: summary.net, kind: "result" },
  ];
}

export interface ChannelReportRow {
  key: string;
  label: string;
  /** Null on "Tanpa kanal" (untagged Meta spend has no omzet or orders of its own). */
  omzet: number | null;
  orders: number | null;
  adSpend: number;
  roas: string;
  status: string;
}

const STATUS_TEXT: Record<NonNullable<RoasRow["status"]>, string> = {
  above: "Di atas titik impas",
  below: "Di bawah titik impas",
  unknown: "Belum bisa dinilai",
};

/** Only Shopee and TikTok Shop ads are tied to their channel; the rest mixes in Meta (§4.1). */
const EXACT_ROAS_KEYS: readonly string[] = ["shopee", "tiktok"];

export function roasText(row: Pick<RoasRow, "key" | "roasTenths">): string {
  if (row.roasTenths === null) return "-";
  return EXACT_ROAS_KEYS.includes(row.key) ? formatRoasTenths(row.roasTenths) : `${formatRoasTenths(row.roasTenths)} (perkiraan)`;
}

export function roasStatusText(row: Pick<RoasRow, "status">): string {
  return row.status === null ? "Belum ada iklan" : STATUS_TEXT[row.status];
}

function isMarketingChannel(channelId: string): channelId is MarketingChannelId {
  return (MARKETING_CHANNEL_OPTIONS as readonly string[]).includes(channelId);
}

/** "Per kanal": every channel with counted orders (biggest omzet first, as Ringkasan) and every
 * ad channel with spend but no order, then "Tanpa kanal" and "Total". Ad spend and ROAS come from
 * the Ringkasan's own ROAS rows. */
export function channelReportRows(summary: ExpenseSummary): ChannelReportRow[] {
  const roasByKey = new Map(summary.roasRows.map((row) => [row.key as string, row]));
  const rows: ChannelReportRow[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string, omzet: number | null, orders: number | null) => {
    const roas = roasByKey.get(key);
    rows.push({ key, label, omzet, orders, adSpend: roas?.adSpend ?? 0, roas: roas ? roasText(roas) : "-", status: roas ? roasStatusText(roas) : "Belum ada iklan" });
    seen.add(key);
  };
  for (const channel of summary.channels) {
    push(channel.channelId, isMarketingChannel(channel.channelId) ? MARKETING_CHANNEL_LABELS[channel.channelId] : channel.channelName, channel.omzet ?? 0, channel.orders);
  }
  for (const row of summary.roasRows) {
    if (row.key === "untagged" || row.key === "total" || seen.has(row.key) || row.adSpend === 0) continue;
    push(row.key, row.label, 0, 0);
  }
  const untagged = roasByKey.get("untagged");
  if (untagged) push("untagged", untagged.label, null, null);
  push("total", "Total", summary.money.omzet, summary.totals.orders);
  return rows;
}

/** "3,0 (margin kontribusi 33,3%)", or why there is none. */
export function breakEvenText(breakEven: BreakEvenRoas): string {
  switch (breakEven.kind) {
    case "computed":
      return `${formatRoasTenths(breakEven.tenths)} (margin kontribusi ${formatPercentBps(breakEven.marginBps)})`;
    case "no_margin":
      return "Tidak ada: laba setelah biaya platform dan subsidi ongkir sudah nol atau minus, jadi setiap iklan menambah rugi";
    case "no_omzet":
      return "Belum bisa dihitung: belum ada omzet di periode ini";
  }
}

export const BREAK_EVEN_EXPLANATION =
  "Titik impas ROAS = omzet dibagi (laba setelah biaya platform dikurangi subsidi ongkir situs) di periode ini. ROAS di bawah angka ini berarti iklan menghabiskan lebih dari laba yang dihasilkannya. Gaji, sewa dan biaya tetap lain tidak dihitung karena tidak bertambah karena iklan.";

/** The notes under the figures: incomplete inputs first (so a reader never takes a laba as clean
 * when it is not), then how the figures are counted. */
export function reportNotes(summary: ExpenseSummary): string[] {
  const { money } = summary;
  const notes: string[] = [];
  if (money.linesWithoutCost > 0) notes.push(`HPP belum lengkap untuk ${formatNumber(money.linesWithoutCost)} item (harga pokoknya Rp 0).`);
  if (money.platformFees.ordersWithoutFees > 0) notes.push(`Biaya platform belum lengkap untuk ${formatNumber(money.platformFees.ordersWithoutFees)} pesanan (belum ada data biaya dari impor).`);
  if (summary.incomplete) notes.push("Laba bersih belum lengkap: angka sebenarnya lebih kecil dari yang tertulis, dan titik impas ROAS sebenarnya lebih tinggi.");
  notes.push(`Titik impas ROAS: ${breakEvenText(summary.breakEven)}. ${BREAK_EVEN_EXPLANATION}`);
  notes.push("ROAS Situs, Instagram, WhatsApp dan Total adalah perkiraan: iklan Meta mendorong pembeli ke beberapa kanal. Biaya endorse tidak masuk ROAS.");
  notes.push("Omzet dan HPP dari pesanan yang dibayar dan tidak dibatalkan atau diretur, menurut tanggal pesanan. Biaya dihitung pada tanggal dibayar (biaya yang dibatalkan tidak dihitung).");
  return notes;
}

export const REPORT_DISCLAIMER = "Laporan manajemen, bukan laporan keuangan resmi.";
