import { CHANNEL_IDS, JOURNAL_ENTRY_KINDS, type ChannelId, type JournalEntryKind } from "@ammari/db/schema";
import { isCalendarDate, monthEndOf, monthStartOf } from "@ammari/accounting";
import { JOURNAL_SOURCE_TYPE_LABELS, type JournalSourceType } from "./labels";

// URL filters of Jurnal umum and Buku besar (docs/plans/accounting.md §6): a plain GET form, so a
// view can be bookmarked. Untrusted input: anything malformed falls back to the default, never an
// error. Dates are Jakarta calendar days; the default range is the current Jakarta month.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_CODE = /^[1-9]-[0-9]{4}$/;

export interface DateRange {
  from: string;
  to: string;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The range in the URL, or the current Jakarta month. A reversed range is swapped. */
export function parseDateRange(raw: { from?: string | string[]; to?: string | string[] }, today: string): DateRange {
  const from = first(raw.from);
  const to = first(raw.to);
  const defaultFrom = monthStartOf(today);
  const defaultTo = monthEndOf(today);
  const parsedFrom = from && isCalendarDate(from) ? from : defaultFrom;
  const parsedTo = to && isCalendarDate(to) ? to : defaultTo;
  return parsedFrom <= parsedTo ? { from: parsedFrom, to: parsedTo } : { from: parsedTo, to: parsedFrom };
}

export interface JournalFilters extends DateRange {
  sourceType: JournalSourceType | null;
  kind: JournalEntryKind | null;
  accountCode: string | null;
}

export interface RawJournalParams {
  from?: string | string[];
  to?: string | string[];
  source?: string | string[];
  kind?: string | string[];
  account?: string | string[];
}

export function parseJournalFilters(raw: RawJournalParams, today: string): JournalFilters {
  const source = first(raw.source);
  const kind = first(raw.kind);
  const account = first(raw.account);
  return {
    ...parseDateRange(raw, today),
    sourceType: source && source in JOURNAL_SOURCE_TYPE_LABELS ? (source as JournalSourceType) : null,
    kind: kind && (JOURNAL_ENTRY_KINDS as readonly string[]).includes(kind) ? (kind as JournalEntryKind) : null,
    accountCode: account && ACCOUNT_CODE.test(account) ? account : null,
  };
}

export interface LedgerFilters extends DateRange {
  accountCode: string | null;
  supplierId: string | null;
  channelId: ChannelId | null;
}

export interface RawLedgerParams {
  from?: string | string[];
  to?: string | string[];
  account?: string | string[];
  supplier?: string | string[];
  channel?: string | string[];
}

export function parseLedgerFilters(raw: RawLedgerParams, today: string): LedgerFilters {
  const account = first(raw.account);
  const supplier = first(raw.supplier);
  const channel = first(raw.channel);
  return {
    ...parseDateRange(raw, today),
    accountCode: account && ACCOUNT_CODE.test(account) ? account : null,
    supplierId: supplier && UUID.test(supplier) ? supplier.toLowerCase() : null,
    channelId: channel && (CHANNEL_IDS as readonly string[]).includes(channel) ? (channel as ChannelId) : null,
  };
}

/** Search params for links that keep the filters (pagination), without empty values. */
export function toSearchParams(values: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
}

/** A single "per tanggal" date in the URL, or today (Jakarta). */
export function parseAsOfDate(raw: { date?: string | string[] }, today: string): string {
  const date = first(raw.date);
  return date && isCalendarDate(date) ? date : today;
}

export const INCOME_STATEMENT_VIEWS = ["total", "month", "channel"] as const;
export type IncomeStatementView = (typeof INCOME_STATEMENT_VIEWS)[number];

/** Laba rugi columns: jumlah saja (default), per bulan, per saluran. */
export function parseIncomeStatementView(raw: { view?: string | string[] }): IncomeStatementView {
  const view = first(raw.view);
  return view && (INCOME_STATEMENT_VIEWS as readonly string[]).includes(view) ? (view as IncomeStatementView) : "total";
}
