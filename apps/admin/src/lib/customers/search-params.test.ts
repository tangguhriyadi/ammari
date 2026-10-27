import { describe, expect, test } from "vitest";
import { customerListHref, parseCustomerListParams, parseCustomersTab, parseVoucherTabParams, resolveVoucherPeriod, voucherTabHref } from "./search-params";

// docs/plans/growth.md §8.2, §9.2: unknown values fall back to the defaults, never throw.

const NOW = new Date("2026-10-27T05:00:00Z"); // 12:00 WIB, 27 Oct

describe("customer list params", () => {
  test("defaults: Semua, Terbaru, non-buyers hidden", () => {
    expect(parseCustomerListParams({})).toEqual({ filter: undefined, sort: "newest", q: undefined, includeNonBuyers: false });
    expect(parseCustomerListParams({ filter: "hacker", sort: "price", q: "   ", all: "yes" })).toEqual({ filter: undefined, sort: "newest", q: undefined, includeNonBuyers: false });
  });

  test("valid values are kept; a repeated key takes the first", () => {
    expect(parseCustomerListParams({ filter: ["promo", "account"], sort: "spend", q: "  Sari ", all: "1" })).toEqual({ filter: "promo", sort: "spend", q: "Sari", includeNonBuyers: true });
  });

  test("the href leaves defaults out", () => {
    expect(customerListHref({ sort: "newest", includeNonBuyers: false })).toBe("/customers");
    expect(customerListHref({ filter: "voucher", sort: "last_order", q: "08 12", includeNonBuyers: true })).toBe("/customers?filter=voucher&sort=last_order&q=08+12&all=1");
  });

  test("the tab", () => {
    expect(parseCustomersTab({})).toBe("customers");
    expect(parseCustomersTab({ tab: "voucher" })).toBe("vouchers");
    expect(parseCustomersTab({ tab: "lainnya" })).toBe("customers");
  });
});

describe("voucher period", () => {
  test("this month so far is the default, as half-open Jakarta midnights", () => {
    const { resolved, fellBack } = resolveVoucherPeriod({}, NOW);
    expect(fellBack).toBe(false);
    expect(resolved).toMatchObject({ period: "this_month", fromDate: "2026-10-01", toDate: "2026-10-27" });
    expect(resolved.range.start.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(resolved.range.end.toISOString()).toBe("2026-10-27T17:00:00.000Z");
  });

  test("last month is the whole previous calendar month", () => {
    const { resolved } = resolveVoucherPeriod({ period: "last_month" }, NOW);
    expect(resolved).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-30" });
    expect(resolved.range.end.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(resolveVoucherPeriod({ period: "last_month" }, new Date("2026-01-10T05:00:00Z")).resolved).toMatchObject({ fromDate: "2025-12-01", toDate: "2025-12-31" });
  });

  test("a custom range must be real dates, ordered, not in the future and at most 366 days", () => {
    expect(resolveVoucherPeriod({ period: "custom", from: "2026-08-01", to: "2026-08-31" }, NOW).resolved).toMatchObject({ period: "custom", fromDate: "2026-08-01", toDate: "2026-08-31" });
    for (const range of [
      { from: "2026-08-31", to: "2026-08-01" },
      { from: "2026-10-01", to: "2026-10-28" },
      { from: "2025-01-01", to: "2026-10-01" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: undefined, to: "2026-03-01" },
    ]) {
      const { resolved, fellBack } = resolveVoucherPeriod({ period: "custom", ...range }, NOW);
      expect(fellBack).toBe(true);
      expect(resolved.period).toBe("this_month");
    }
  });

  test("tab params and href", () => {
    expect(parseVoucherTabParams({ tab: "voucher", status: "expiring", q: " Sari " }, NOW)).toMatchObject({ status: "expiring", q: "Sari", periodFellBack: false });
    expect(parseVoucherTabParams({ status: "semua" }, NOW).status).toBeUndefined();
    expect(voucherTabHref({})).toBe("/customers?tab=voucher");
    expect(voucherTabHref({ period: "custom", from: "2026-08-01", to: "2026-08-31", status: "void" })).toBe("/customers?tab=voucher&period=custom&from=2026-08-01&to=2026-08-31&status=void");
    expect(voucherTabHref({ period: "this_month", q: "Sari" })).toBe("/customers?tab=voucher&q=Sari");
  });
});
