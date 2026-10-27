import { addCalendarDays, calendarDaysBetween, isCalendarDate, jakartaDate, jakartaMidnight } from "@ammari/commerce/jakarta-day";
import { MAX_CUSTOM_PERIOD_DAYS, type TimeRange } from "@/lib/overview/period";

// "Pelanggan & Voucher" query parameters (docs/plans/growth.md §8.2, §9.2). Pure: the page passes
// its searchParams; anything unknown falls back to the default, never throws.

type SearchParamValue = string | string[] | undefined;
type RawSearchParams = Record<string, SearchParamValue>;

function first(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((option) => option === value);
}

/** Search text, trimmed and capped (a query is never longer than a name or an email). */
function query(value: string | undefined): string | undefined {
  const trimmed = value?.trim().slice(0, 100);
  return trimmed ? trimmed : undefined;
}

export type CustomersTab = "customers" | "vouchers";

export function parseCustomersTab(raw: RawSearchParams): CustomersTab {
  return first(raw.tab) === "voucher" ? "vouchers" : "customers";
}

// ---------- Tab "Pelanggan" ----------

export const CUSTOMER_FILTERS = ["account", "buyer", "promo", "voucher"] as const;
export type CustomerFilter = (typeof CUSTOMER_FILTERS)[number];

export const CUSTOMER_FILTER_LABELS: Record<CustomerFilter | "all", string> = {
  all: "Semua",
  account: "Punya akun",
  buyer: "Pernah belanja",
  promo: "Setuju promo",
  voucher: "Voucher aktif",
};

export const CUSTOMER_SORTS = ["newest", "spend", "last_order"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export const CUSTOMER_SORT_LABELS: Record<CustomerSort, string> = {
  newest: "Terbaru",
  spend: "Belanja terbesar",
  last_order: "Pesanan terakhir",
};

export interface CustomerListParams {
  filter?: CustomerFilter;
  sort: CustomerSort;
  q?: string;
  /** "Termasuk yang belum pernah belanja" (owner answer A13): by default a customer with no
   * counted order and no account (an unpaid guest checkout, an abandoned staff entry) is hidden. */
  includeNonBuyers: boolean;
}

export function parseCustomerListParams(raw: RawSearchParams): CustomerListParams {
  return {
    filter: pick(first(raw.filter), CUSTOMER_FILTERS),
    sort: pick(first(raw.sort), CUSTOMER_SORTS) ?? "newest",
    q: query(first(raw.q)),
    includeNonBuyers: first(raw.all) === "1",
  };
}

/** The list URL for `params`, defaults left out. */
export function customerListHref(params: CustomerListParams): string {
  const search = new URLSearchParams();
  if (params.filter) search.set("filter", params.filter);
  if (params.sort !== "newest") search.set("sort", params.sort);
  if (params.q) search.set("q", params.q);
  if (params.includeNonBuyers) search.set("all", "1");
  const text = search.toString();
  return text ? `/customers?${text}` : "/customers";
}

// ---------- Tab "Voucher" ----------

export const VOUCHER_FILTERS = ["active", "expiring", "used", "expired", "void"] as const;
export type VoucherFilter = (typeof VOUCHER_FILTERS)[number];

export const VOUCHER_FILTER_LABELS: Record<VoucherFilter | "all", string> = {
  all: "Semua",
  active: "Aktif",
  expiring: "Segera berakhir",
  used: "Terpakai",
  expired: "Kedaluwarsa",
  void: "Dibatalkan",
};

export const VOUCHER_PERIODS = ["this_month", "last_month", "custom"] as const;
export type VoucherPeriod = (typeof VOUCHER_PERIODS)[number];

export interface ResolvedVoucherPeriod {
  period: VoucherPeriod;
  /** Jakarta calendar dates, inclusive. */
  fromDate: string;
  toDate: string;
  range: TimeRange;
}

export interface VoucherTabParams {
  status?: VoucherFilter;
  q?: string;
  period: ResolvedVoucherPeriod;
  /** A custom range was asked for but was not valid (shown as an alert; this month is used). */
  periodFellBack: boolean;
}

function firstOfMonth(date: string): string {
  return `${date.slice(0, 8)}01`;
}

/** The voucher period (Ringkasan vocabulary, plan §9.2): this month so far (default), last month,
 * or a custom range of real dates `from <= to <= today`, at most 366 days. */
export function resolveVoucherPeriod(raw: { period?: string; from?: string; to?: string }, now: Date = new Date()): { resolved: ResolvedVoucherPeriod; fellBack: boolean } {
  const today = jakartaDate(now);
  const thisMonth = firstOfMonth(today);
  const requested = pick(raw.period, VOUCHER_PERIODS) ?? "this_month";
  if (requested === "last_month") {
    const from = firstOfMonth(addCalendarDays(thisMonth, -1));
    const to = addCalendarDays(thisMonth, -1);
    return { resolved: { period: "last_month", fromDate: from, toDate: to, range: { start: jakartaMidnight(from), end: jakartaMidnight(thisMonth) } }, fellBack: false };
  }
  if (requested === "custom") {
    const { from, to } = raw;
    if (isCalendarDate(from) && isCalendarDate(to)) {
      const span = calendarDaysBetween(from, to) + 1;
      if (span >= 1 && span <= MAX_CUSTOM_PERIOD_DAYS && calendarDaysBetween(to, today) >= 0) {
        return { resolved: { period: "custom", fromDate: from, toDate: to, range: { start: jakartaMidnight(from), end: jakartaMidnight(addCalendarDays(to, 1)) } }, fellBack: false };
      }
    }
  }
  return {
    resolved: { period: "this_month", fromDate: thisMonth, toDate: today, range: { start: jakartaMidnight(thisMonth), end: jakartaMidnight(addCalendarDays(today, 1)) } },
    fellBack: requested === "custom",
  };
}

export function parseVoucherTabParams(raw: RawSearchParams, now: Date = new Date()): VoucherTabParams {
  const { resolved, fellBack } = resolveVoucherPeriod({ period: first(raw.period), from: first(raw.from), to: first(raw.to) }, now);
  return { status: pick(first(raw.status), VOUCHER_FILTERS), q: query(first(raw.q)), period: resolved, periodFellBack: fellBack };
}

/** The Voucher tab URL, defaults left out. */
export function voucherTabHref(params: { status?: VoucherFilter; q?: string; period?: VoucherPeriod; from?: string; to?: string }): string {
  const search = new URLSearchParams({ tab: "voucher" });
  if (params.period && params.period !== "this_month") search.set("period", params.period);
  if (params.period === "custom" && params.from && params.to) {
    search.set("from", params.from);
    search.set("to", params.to);
  }
  if (params.status) search.set("status", params.status);
  if (params.q) search.set("q", params.q);
  return `/customers?${search.toString()}`;
}
