import { describe, expect, test } from "vitest";
import {
  BREAK_EVEN_ROAS_TENTHS,
  expenseChannelError,
  expenseChannelRule,
  formatRoasTenths,
  buildRoasRows,
  labaBersih,
  monthlyBillsReminderWindow,
  monthRange,
  monthToDate,
  roasStatus,
  roasTenths,
  summarizeMarketing,
  sumExpensesInRange,
  shiftMonth,
  type ExpenseFigureRow,
} from "./figures";

// docs/plans/growth.md §4 (session S1): the pure parts of Laba bersih and ROAS.

describe("expenseChannelRule / expenseChannelError", () => {
  test("Iklan Shopee and Iklan TikTok are tied to their own channel", () => {
    expect(expenseChannelRule("ads_shopee")).toEqual({ kind: "fixed", channelId: "shopee" });
    expect(expenseChannelRule("ads_tiktok")).toEqual({ kind: "fixed", channelId: "tiktok" });
    expect(expenseChannelError("ads_shopee", "shopee")).toBeNull();
    expect(expenseChannelError("ads_shopee", null)).toMatch(/Shopee/);
    expect(expenseChannelError("ads_tiktok", "shopee")).toMatch(/TikTok/);
  });

  test("Meta and Endorse/KOL may name a channel or none", () => {
    for (const category of ["ads_meta", "endorsement"] as const) {
      expect(expenseChannelRule(category).kind).toBe("optional");
      expect(expenseChannelError(category, null)).toBeNull();
      expect(expenseChannelError(category, "instagram")).toBeNull();
      expect(expenseChannelError(category, "web")).toBeNull();
    }
    // Only channels an ad can actually drive buyers to.
    expect(expenseChannelError("ads_meta", "offline")).not.toBeNull();
    expect(expenseChannelError("ads_meta", "reseller")).not.toBeNull();
  });

  test("operating costs never name a channel", () => {
    for (const category of ["material_shipping", "packaging", "salary", "rent", "utilities", "other"] as const) {
      expect(expenseChannelRule(category)).toEqual({ kind: "none" });
      expect(expenseChannelError(category, null)).toBeNull();
      expect(expenseChannelError(category, "web")).not.toBeNull();
    }
  });
});

describe("monthRange / monthToDate (Jakarta calendar dates, owner answer Q3)", () => {
  test("a whole month, inclusive, leap years and 30/31-day months", () => {
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(monthRange("2026-11")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2027-02")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  test("rejects anything that is not YYYY-MM", () => {
    expect(() => monthRange("2026-13")).toThrow();
    expect(() => monthRange("2026-1")).toThrow();
    expect(() => monthRange("abc")).toThrow();
  });

  test("this month so far, by the Jakarta day (23:30 WIB on the 31st is still that month)", () => {
    expect(monthToDate(new Date("2026-10-31T16:30:00Z"))).toEqual({ month: "2026-10", from: "2026-10-01", to: "2026-10-31" });
    // 00:30 WIB on 1 Nov is already November.
    expect(monthToDate(new Date("2026-10-31T17:30:00Z"))).toEqual({ month: "2026-11", from: "2026-11-01", to: "2026-11-01" });
  });
});

const row = (overrides: Partial<ExpenseFigureRow>): ExpenseFigureRow => ({
  expenseDate: "2026-10-05",
  category: "salary",
  channelId: null,
  amount: 1_000_000,
  voided: false,
  ...overrides,
});

describe("sumExpensesInRange (cash basis: the payment date decides, voided rows never count)", () => {
  test("counts each expense once, in full, on its own date", () => {
    const rows = [
      row({ expenseDate: "2026-09-30", amount: 7 }),
      row({ expenseDate: "2026-10-01", amount: 100 }),
      row({ expenseDate: "2026-10-31", amount: 200 }),
      row({ expenseDate: "2026-11-01", amount: 9 }),
      row({ expenseDate: "2026-10-15", amount: 5_000, voided: true }),
    ];
    expect(sumExpensesInRange(rows, monthRange("2026-10"))).toBe(300);
    expect(sumExpensesInRange([], monthRange("2026-10"))).toBe(0);
  });
});

describe("labaBersih", () => {
  test("laba setelah biaya platform minus the web shipping subsidy minus expenses", () => {
    expect(labaBersih({ labaSetelahBiayaPlatform: 10_000_000, webShippingSubsidy: 150_000, expenses: 4_000_000 })).toBe(5_850_000);
  });

  test("can be negative (a loss month)", () => {
    expect(labaBersih({ labaSetelahBiayaPlatform: 1_000_000, webShippingSubsidy: 0, expenses: 3_000_000 })).toBe(-2_000_000);
  });
});

describe("summarizeMarketing", () => {
  test("ad spend per channel, untagged Meta only in the total, endorse apart, voided and operating rows ignored", () => {
    const summary = summarizeMarketing([
      row({ category: "ads_shopee", channelId: "shopee", amount: 1_000 }),
      row({ category: "ads_shopee", channelId: "shopee", amount: 500 }),
      row({ category: "ads_tiktok", channelId: "tiktok", amount: 700 }),
      row({ category: "ads_meta", channelId: "instagram", amount: 300 }),
      row({ category: "ads_meta", channelId: null, amount: 200 }),
      row({ category: "ads_meta", channelId: null, amount: 999, voided: true }),
      row({ category: "endorsement", channelId: "tiktok", amount: 400 }),
      row({ category: "salary", amount: 9_000 }),
    ]);
    expect(summary.adSpendByChannel).toEqual({ shopee: 1_500, tiktok: 700, instagram: 300 });
    expect(summary.untaggedAdSpend).toBe(200);
    expect(summary.adSpendTotal).toBe(2_700);
    expect(summary.endorsement).toBe(400);
    expect(summary.marketingTotal).toBe(3_100);
  });
});

describe("ROAS vs the 8.3 break-even (integer maths, SPEC §6)", () => {
  test("ROAS in tenths, rounded half up; null without ad spend", () => {
    expect(BREAK_EVEN_ROAS_TENTHS).toBe(83);
    expect(roasTenths(8_300_000, 1_000_000)).toBe(83);
    expect(roasTenths(10_000_000, 3_000_000)).toBe(33); // 3.333...
    expect(roasTenths(1_250, 1_000)).toBe(13); // 1.25 -> 1.3
    expect(roasTenths(0, 1_000)).toBe(0);
    expect(roasTenths(5_000, 0)).toBeNull();
  });

  test("formatted with one decimal, Indonesian style", () => {
    expect(formatRoasTenths(83)).toBe("8,3");
    expect(formatRoasTenths(100)).toBe("10,0");
    expect(formatRoasTenths(0)).toBe("0,0");
    expect(formatRoasTenths(12_345)).toBe("1.234,5");
  });

  test("at or above break-even is 'above', under it 'below', no spend is null", () => {
    expect(roasStatus(8_300_000, 1_000_000)).toBe("above");
    expect(roasStatus(8_299_999, 1_000_000)).toBe("below");
    expect(roasStatus(20_000_000, 1_000_000)).toBe("above");
    expect(roasStatus(0, 1_000_000)).toBe("below");
    expect(roasStatus(1_000_000, 0)).toBeNull();
  });
});

describe("shiftMonth", () => {
  test("moves across year ends both ways", () => {
    expect(shiftMonth("2026-10", -1)).toBe("2026-09");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-03", -11)).toBe("2025-04");
    expect(() => shiftMonth("2026-13", 1)).toThrow();
  });
});

describe("monthlyBillsReminderWindow (owner answer A6: from the 6th, last month, paid 6th to 5th)", () => {
  test("null on the 1st to the 5th (Jakarta); from the 6th, last month with the 6th-to-5th window", () => {
    // 23:30 WIB on the 5th is still the 5th.
    expect(monthlyBillsReminderWindow(new Date("2026-03-05T16:30:00Z"))).toBeNull();
    expect(monthlyBillsReminderWindow(new Date("2026-03-01T05:00:00Z"))).toBeNull();
    // 00:30 WIB on 6 Mar: the plan's example, 6 Feb to 5 Mar.
    expect(monthlyBillsReminderWindow(new Date("2026-03-05T17:30:00Z"))).toEqual({ month: "2026-02", from: "2026-02-06", to: "2026-03-05" });
    expect(monthlyBillsReminderWindow(new Date("2026-03-31T05:00:00Z"))).toEqual({ month: "2026-02", from: "2026-02-06", to: "2026-03-05" });
    // Across a year end.
    expect(monthlyBillsReminderWindow(new Date("2027-01-06T05:00:00Z"))).toEqual({ month: "2026-12", from: "2026-12-06", to: "2027-01-05" });
  });
});

describe("buildRoasRows (plan §4.1, §6 'Iklan vs omzet')", () => {
  const marketing = summarizeMarketing([
    row({ category: "ads_shopee", channelId: "shopee", amount: 100_000 }),
    row({ category: "ads_tiktok", channelId: "tiktok", amount: 100_000 }),
    row({ category: "ads_meta", channelId: "web", amount: 50_000 }),
    row({ category: "ads_meta", channelId: null, amount: 30_000 }),
    row({ category: "endorsement", channelId: "instagram", amount: 150_000 }),
  ]);
  const omzet = new Map<string, number>([
    ["shopee", 1_000_000],
    ["tiktok", 500_000],
    ["web", 300_000],
    ["whatsapp", 200_000],
    ["offline", 90_000],
  ]);

  test("one row per marketing channel, Tanpa kanal, and a Total over every channel's omzet", () => {
    const rows = buildRoasRows(marketing, omzet);
    expect(rows.map((entry) => entry.key)).toEqual(["shopee", "tiktok", "web", "instagram", "whatsapp", "untagged", "total"]);
    const byKey = Object.fromEntries(rows.map((entry) => [entry.key, entry]));
    expect(byKey.shopee).toMatchObject({ label: "Shopee", adSpend: 100_000, omzet: 1_000_000, roasTenths: 100, status: "above" });
    expect(byKey.tiktok).toMatchObject({ label: "TikTok Shop", adSpend: 100_000, omzet: 500_000, roasTenths: 50, status: "below" });
    expect(byKey.web).toMatchObject({ label: "Situs", adSpend: 50_000, omzet: 300_000, roasTenths: 60, status: "below" });
    // Endorse/KOL tagged Instagram is not ad spend: no ROAS for Instagram.
    expect(byKey.instagram).toMatchObject({ adSpend: 0, omzet: 0, roasTenths: null, status: null });
    expect(byKey.whatsapp).toMatchObject({ adSpend: 0, omzet: 200_000, roasTenths: null, status: null });
    // Untagged Meta has no omzet of its own; it only enters the total.
    expect(byKey.untagged).toMatchObject({ label: "Tanpa kanal", adSpend: 30_000, omzet: null, roasTenths: null, status: null });
    // Total omzet includes channels that are never advertised (offline).
    expect(byKey.total).toMatchObject({ label: "Total", adSpend: 280_000, omzet: 2_090_000, roasTenths: 75, status: "below" });
  });

  test("no spend anywhere: every ROAS is null, Tanpa kanal is left out", () => {
    const rows = buildRoasRows(summarizeMarketing([]), omzet);
    expect(rows.every((entry) => entry.roasTenths === null && entry.status === null)).toBe(true);
    expect(rows.map((entry) => entry.key)).not.toContain("untagged");
  });
});
