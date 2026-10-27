import { describe, expect, test } from "vitest";
import { breakEvenRoas, buildRoasRows, summarizeMarketing } from "./figures";
import { breakEvenText, channelReportRows, formatSignedRupiah, profitAndLossLines, reportFileName, reportNotes, reportTitle } from "./report-content";
import type { ExpenseSummaryParams } from "./search-params";
import type { ExpenseSummary } from "./summary";

// docs/plans/growth.md session S6 (owner addition A): what the monthly report says, from the
// Ringkasan's own figures.

const FEB: ExpenseSummaryParams = { period: "month", fromMonth: "2026-02", toMonth: "2026-02", range: { from: "2026-02-01", to: "2026-02-28" }, invalid: false };
const Q1: ExpenseSummaryParams = { period: "range", fromMonth: "2026-01", toMonth: "2026-03", range: { from: "2026-01-01", to: "2026-03-31" }, invalid: false };

function fixture(overrides: { linesWithoutCost?: number; ordersWithoutFees?: number } = {}): ExpenseSummary {
  const marketing = summarizeMarketing([
    { category: "ads_shopee", channelId: "shopee", amount: 100_000, voided: false },
    { category: "ads_meta", channelId: "instagram", amount: 40_000, voided: false },
    { category: "ads_meta", channelId: null, amount: 30_000, voided: false },
    { category: "salary", channelId: null, amount: 400_000, voided: false },
  ]);
  const money = {
    omzet: 2_000_000,
    hpp: 780_000,
    labaKotor: 1_220_000,
    marginBps: 6_100,
    averageOrderAmount: 500_000,
    linesWithoutCost: overrides.linesWithoutCost ?? 0,
    platformFee: 50_000,
    labaSetelahBiayaPlatform: 1_170_000,
    platformFees: { marketplaceOrders: 2, ordersWithoutFees: overrides.ordersWithoutFees ?? 0, byChannel: [] },
    webShippingSubsidy: 20_000,
  };
  const channels = [
    { channelId: "shopee", channelName: "Shopee", orders: 1, pcs: 1, omzet: 1_000_000 },
    { channelId: "web", channelName: "Website", orders: 1, pcs: 1, omzet: 600_000 },
    { channelId: "offline", channelName: "Offline", orders: 2, pcs: 2, omzet: 400_000 },
  ];
  const breakEven = breakEvenRoas(money);
  return {
    totals: { orders: 4, pcs: 4, cancelledOrders: 0, returnedOrders: 0, money },
    money,
    channels,
    expenses: { total: 570_000, byCategory: [{ category: "salary", amount: 400_000 }, { category: "ads_shopee", amount: 100_000 }, { category: "ads_meta", amount: 70_000 }], marketing },
    net: 1_170_000 - 20_000 - 570_000,
    incomplete: (overrides.linesWithoutCost ?? 0) > 0 || (overrides.ordersWithoutFees ?? 0) > 0,
    breakEven,
    roasRows: buildRoasRows(marketing, new Map(channels.map((channel) => [channel.channelId, channel.omzet])), breakEven),
  };
}

describe("titles and file names", () => {
  test("one month, a range, and this month up to today", () => {
    expect(reportTitle(FEB, "2026-10-27")).toBe("Laporan Keuangan Februari 2026");
    expect(reportTitle(Q1, "2026-10-27")).toBe("Laporan Keuangan Januari 2026 s.d. Maret 2026");
    const oct = { ...FEB, fromMonth: "2026-10", toMonth: "2026-10", range: { from: "2026-10-01", to: "2026-10-27" } };
    expect(reportTitle(oct, "2026-10-27")).toBe("Laporan Keuangan Oktober 2026 (s.d. 27 Okt 2026)");
    expect(reportFileName(FEB, "pdf")).toBe("laporan-keuangan-2026-02.pdf");
    expect(reportFileName(Q1, "xlsx")).toBe("laporan-keuangan-2026-01-sd-2026-03.xlsx");
  });
});

describe("profitAndLossLines", () => {
  test("costs negative, each result line is the sum of the lines above it, categories under the expense line", () => {
    const summary = fixture();
    const lines = profitAndLossLines(summary);
    expect(lines.map((line) => line.label)).toEqual([
      "Omzet",
      "HPP",
      "Laba kotor",
      "Biaya platform",
      "Laba setelah biaya platform",
      "Subsidi ongkir situs",
      "Biaya operasional & iklan",
      "Gaji",
      "Iklan Shopee",
      "Iklan Meta",
      "Laba bersih",
    ]);
    const amount = (label: string) => lines.find((line) => line.label === label)!.amount;
    expect(amount("Omzet") + amount("HPP")).toBe(amount("Laba kotor"));
    expect(amount("Laba kotor") + amount("Biaya platform")).toBe(amount("Laba setelah biaya platform"));
    expect(amount("Laba setelah biaya platform") + amount("Subsidi ongkir situs") + amount("Biaya operasional & iklan")).toBe(amount("Laba bersih"));
    expect(amount("Gaji") + amount("Iklan Shopee") + amount("Iklan Meta")).toBe(amount("Biaya operasional & iklan"));
    expect(amount("Laba bersih")).toBe(summary.net);
    expect(formatSignedRupiah(-1_500)).toBe("-Rp 1.500");
    expect(formatSignedRupiah(1_500)).toBe("Rp 1.500");
    expect(formatSignedRupiah(-0)).toBe("Rp 0");
    const empty = { ...summary, money: { ...summary.money, hpp: 0 } };
    expect(Object.is(profitAndLossLines(empty).find((line) => line.label === "HPP")!.amount, -0)).toBe(false);
  });
});

describe("channelReportRows", () => {
  test("channels with orders, an ad channel with spend but no order, Tanpa kanal, Total", () => {
    const rows = channelReportRows(fixture());
    expect(rows.map((row) => row.key)).toEqual(["shopee", "web", "offline", "instagram", "untagged", "total"]);
    const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
    // Break-even: 2.000.000 / (1.170.000 - 20.000) = 1,7.
    expect(byKey.shopee).toMatchObject({ label: "Shopee", omzet: 1_000_000, orders: 1, adSpend: 100_000, roas: "10,0", status: "Di atas titik impas" });
    expect(byKey.web).toMatchObject({ label: "Situs", adSpend: 0, roas: "-", status: "Belum ada iklan" });
    expect(byKey.offline).toMatchObject({ label: "Offline", omzet: 400_000, adSpend: 0, roas: "-" });
    expect(byKey.instagram).toMatchObject({ omzet: 0, orders: 0, adSpend: 40_000, roas: "0,0 (perkiraan)", status: "Di bawah titik impas" });
    expect(byKey.untagged).toMatchObject({ label: "Tanpa kanal", omzet: null, orders: null, adSpend: 30_000 });
    expect(byKey.total).toMatchObject({ omzet: 2_000_000, orders: 4, adSpend: 170_000, roas: "11,8 (perkiraan)" });
  });
});

describe("notes", () => {
  test("incomplete inputs are named first and Laba bersih is flagged; the break-even formula is always stated", () => {
    expect(breakEvenText(fixture().breakEven)).toBe("1,7 (margin kontribusi 57,5%)");
    const clean = reportNotes(fixture());
    expect(clean.some((note) => note.includes("belum lengkap"))).toBe(false);
    expect(clean.some((note) => note.startsWith("Titik impas ROAS: 1,7"))).toBe(true);
    const notes = reportNotes(fixture({ linesWithoutCost: 2, ordersWithoutFees: 3 }));
    expect(notes[0]).toContain("HPP belum lengkap untuk 2 item");
    expect(notes[1]).toContain("Biaya platform belum lengkap untuk 3 pesanan");
    expect(notes[2]).toContain("Laba bersih belum lengkap");
    expect(notes.join(" ")).not.toMatch(/—/);
  });
});
