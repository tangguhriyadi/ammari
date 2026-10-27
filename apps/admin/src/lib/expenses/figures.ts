import {
  AD_EXPENSE_CATEGORIES,
  FIXED_EXPENSE_CHANNELS,
  MARKETING_EXPENSE_CATEGORIES,
  type BusinessExpenseCategory,
  type ChannelId,
} from "@ammari/db/schema";
import { MARKETING_CHANNEL_LABELS, MARKETING_CHANNEL_OPTIONS, type MarketingChannelId } from "./labels";

// The pure parts of "Iklan & Biaya" figures (docs/plans/growth.md §4, session S1). Money is whole
// rupiah (integers); no floats anywhere a result is compared or stored. Dates are Asia/Jakarta
// calendar dates ("YYYY-MM-DD"), the same strings business_expenses.expense_date holds.

// ---------- Channel rules (mirror business_expenses_channel_check) ----------

export type ExpenseChannelRule = { kind: "fixed"; channelId: ChannelId } | { kind: "optional" } | { kind: "none" };

export function expenseChannelRule(category: BusinessExpenseCategory): ExpenseChannelRule {
  const fixed = (FIXED_EXPENSE_CHANNELS as Partial<Record<BusinessExpenseCategory, ChannelId>>)[category];
  if (fixed) return { kind: "fixed", channelId: fixed };
  if ((MARKETING_EXPENSE_CATEGORIES as readonly BusinessExpenseCategory[]).includes(category)) return { kind: "optional" };
  return { kind: "none" };
}

function isMarketingChannel(channelId: string): channelId is MarketingChannelId {
  return (MARKETING_CHANNEL_OPTIONS as readonly string[]).includes(channelId);
}

/** The Indonesian refusal for a category/channel pair, or null when it is allowed. Stricter than
 * the DB CHECK for optional channels: only channels an ad can drive buyers to. */
export function expenseChannelError(category: BusinessExpenseCategory, channelId: string | null): string | null {
  const rule = expenseChannelRule(category);
  if (rule.kind === "fixed") {
    if (channelId === rule.channelId) return null;
    return `Iklan ini selalu untuk kanal ${MARKETING_CHANNEL_LABELS[rule.channelId as MarketingChannelId]}.`;
  }
  if (rule.kind === "none") return channelId === null ? null : "Biaya operasional tidak memakai kanal.";
  return channelId === null || isMarketingChannel(channelId) ? null : "Pilih kanal Shopee, TikTok Shop, Situs, Instagram, atau WhatsApp.";
}

// ---------- Periods (owner answer Q3: whole calendar months) ----------

export interface DateRange {
  /** Inclusive Jakarta dates. */
  from: string;
  to: string;
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "YYYY-MM" to its first and last calendar day. Throws on anything else. */
export function monthRange(month: string): DateRange {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new Error(`invalid month "${month}"`);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]);
  // Day 0 of the next month is this month's last day (UTC, so no time zone can shift it).
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

const JAKARTA_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });

/** "Bulan ini (s.d. hari ini)": the Jakarta month of `now`, from its first day to today. */
export function monthToDate(now: Date = new Date()): DateRange & { month: string } {
  const today = JAKARTA_DATE.format(now);
  const month = today.slice(0, 7);
  return { month, from: `${month}-01`, to: today };
}

/** "YYYY-MM" moved by `delta` calendar months. Throws on a malformed month. */
export function shiftMonth(month: string, delta: number): string {
  const match = MONTH_PATTERN.exec(month);
  if (!match) throw new Error(`invalid month "${month}"`);
  const index = Number(match[1]) * 12 + Number(match[2]) - 1 + delta;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Owner answer A6 (window as decided on 2026-10-27): from this Jakarta day of the month,
 * "Perlu tindakan" checks LAST month's monthly bills (the categories chosen on /settings). Each is
 * paid around the turn of the month, so the window runs from this day of last month through the
 * day before it this month. */
export const MONTHLY_BILLS_REMINDER_DAY = 6;

export interface MonthlyBillsWindow extends DateRange {
  /** The month the bills are for ("YYYY-MM"): last month. */
  month: string;
}

/** On `now`'s Jakarta day, from the 6th: last month and its payment window (6 Feb to 5 Mar on
 * 6 Mar). Null on the 1st to the 5th. */
export function monthlyBillsReminderWindow(now: Date = new Date()): MonthlyBillsWindow | null {
  const { month, to: today } = monthToDate(now);
  if (Number(today.slice(8, 10)) < MONTHLY_BILLS_REMINDER_DAY) return null;
  const day = String(MONTHLY_BILLS_REMINDER_DAY).padStart(2, "0");
  const dayBefore = String(MONTHLY_BILLS_REMINDER_DAY - 1).padStart(2, "0");
  const lastMonth = shiftMonth(month, -1);
  return { month: lastMonth, from: `${lastMonth}-${day}`, to: `${month}-${dayBefore}` };
}

// ---------- Sums ----------

export interface ExpenseFigureRow {
  expenseDate: string;
  category: BusinessExpenseCategory;
  channelId: ChannelId | null;
  amount: number;
  voided: boolean;
}

/** Cash basis: an expense counts once, in full, in the range holding its payment date. */
export function sumExpensesInRange(rows: readonly ExpenseFigureRow[], range: DateRange): number {
  let total = 0;
  for (const row of rows) {
    if (!row.voided && row.expenseDate >= range.from && row.expenseDate <= range.to) total += row.amount;
  }
  return total;
}

/** Plan §4.1: laba setelah biaya platform - web shipping subsidy (owner answer Q4) - expenses. */
export function labaBersih(input: { labaSetelahBiayaPlatform: number; webShippingSubsidy: number; expenses: number }): number {
  return input.labaSetelahBiayaPlatform - input.webShippingSubsidy - input.expenses;
}

export interface MarketingSummary {
  /** Biaya iklan per tagged channel (only channels with spend). */
  adSpendByChannel: Partial<Record<ChannelId, number>>;
  /** Meta ads with no channel: only in the total ROAS (owner answer Q14). */
  untaggedAdSpend: number;
  adSpendTotal: number;
  /** Endorse/KOL: shown apart, never in ROAS. */
  endorsement: number;
  /** Biaya pemasaran = iklan + endorse. */
  marketingTotal: number;
}

/** Rows already limited to the period by the caller; voided and operating rows are ignored. */
export function summarizeMarketing(rows: readonly Omit<ExpenseFigureRow, "expenseDate">[]): MarketingSummary {
  const adSpendByChannel: Partial<Record<ChannelId, number>> = {};
  let untaggedAdSpend = 0;
  let endorsement = 0;
  for (const row of rows) {
    if (row.voided) continue;
    if (row.category === "endorsement") {
      endorsement += row.amount;
    } else if ((AD_EXPENSE_CATEGORIES as readonly BusinessExpenseCategory[]).includes(row.category)) {
      if (row.channelId === null) untaggedAdSpend += row.amount;
      else adSpendByChannel[row.channelId] = (adSpendByChannel[row.channelId] ?? 0) + row.amount;
    }
  }
  const tagged = Object.values(adSpendByChannel).reduce((sum, amount) => sum + amount, 0);
  const adSpendTotal = tagged + untaggedAdSpend;
  return { adSpendByChannel, untaggedAdSpend, adSpendTotal, endorsement, marketingTotal: adSpendTotal + endorsement };
}

// ---------- ROAS (SPEC §6: break-even 8.3) ----------

/** 8.3 in tenths, so every comparison stays in integers. */
export const BREAK_EVEN_ROAS_TENTHS = 83;

/** omzet / ad spend in tenths, rounded half up (83 = 8.3); null without ad spend. For display. */
export function roasTenths(omzet: number, adSpend: number): number | null {
  if (adSpend <= 0) return null;
  return Math.floor((omzet * 20 + adSpend) / (adSpend * 2));
}

/** 83 -> "8,3", 100 -> "10,0" (Indonesian decimal comma, always one decimal). */
export function formatRoasTenths(tenths: number): string {
  return `${Math.floor(tenths / 10).toLocaleString("id-ID")},${tenths % 10}`;
}

/** At or above break-even is "above" (olive), under it "below" (brick), no spend null. Exact:
 * omzet / adSpend >= 8.3  <=>  omzet * 10 >= adSpend * 83. */
export function roasStatus(omzet: number, adSpend: number): "above" | "below" | null {
  if (adSpend <= 0) return null;
  return omzet * 10 >= adSpend * BREAK_EVEN_ROAS_TENTHS ? "above" : "below";
}

// ---------- "Iklan vs omzet" (plan §6) ----------

export type RoasRowKey = MarketingChannelId | "untagged" | "total";

export interface RoasRow {
  key: RoasRowKey;
  label: string;
  adSpend: number;
  /** Null on "Tanpa kanal": untagged Meta spend has no omzet of its own. */
  omzet: number | null;
  roasTenths: number | null;
  status: "above" | "below" | null;
}

/**
 * One row per channel an ad can be tagged with (Shopee, TikTok Shop, Situs, Instagram, WhatsApp),
 * "Tanpa kanal" when untagged Meta spend exists, and "Total": every ad rupiah against every
 * channel's omzet (offline and reseller included, owner answer A14). Endorse/KOL is never here.
 * `omzetByChannel` is the counted omzet per channel id of the same period.
 */
export function buildRoasRows(marketing: MarketingSummary, omzetByChannel: ReadonlyMap<string, number>): RoasRow[] {
  const row = (key: RoasRowKey, label: string, adSpend: number, omzet: number | null): RoasRow => ({
    key,
    label,
    adSpend,
    omzet,
    roasTenths: omzet === null ? null : roasTenths(omzet, adSpend),
    status: omzet === null ? null : roasStatus(omzet, adSpend),
  });
  const rows = MARKETING_CHANNEL_OPTIONS.map((channelId) =>
    row(channelId, MARKETING_CHANNEL_LABELS[channelId], marketing.adSpendByChannel[channelId] ?? 0, omzetByChannel.get(channelId) ?? 0),
  );
  if (marketing.untaggedAdSpend > 0) rows.push(row("untagged", "Tanpa kanal", marketing.untaggedAdSpend, null));
  const totalOmzet = [...omzetByChannel.values()].reduce((sum, amount) => sum + amount, 0);
  rows.push(row("total", "Total", marketing.adSpendTotal, totalOmzet));
  return rows;
}
