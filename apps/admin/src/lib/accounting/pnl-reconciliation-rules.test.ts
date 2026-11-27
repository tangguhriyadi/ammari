import { describe, expect, test } from "vitest";
import { componentOfAccount, differenceLabel, reconcileComponent } from "./pnl-reconciliation-rules";

// Rekonsiliasi check 4 (docs/plans/accounting.md §6.3, Session 10), pure half: every P&L account in
// exactly one management figure; each difference split into lines that add up to it exactly.

describe("componentOfAccount", () => {
  const inventoryHeaders = new Set(["6-4000"]);
  const of = (code: string, type: Parameters<typeof componentOfAccount>[0]["type"], systemKey: string | null = null, parentCode: string | null = null) =>
    componentOfAccount({ code, type, systemKey, parentCode }, inventoryHeaders);

  test("sales and their discounts and returns are omzet; HPP barang jadi vs the production variance", () => {
    expect(of("4-1101", "revenue", "revenue.web")).toBe("net_sales");
    expect(of("4-1201", "contra_revenue", "contra_revenue.sales_discount")).toBe("net_sales");
    expect(of("5-1101", "cogs", "cogs.finished_goods")).toBe("cogs");
    expect(of("5-1201", "cogs", "cogs.production_variance")).toBe("production_variance");
  });

  test("system expenses by key; a new sub-account under Beban persediaan is inventory expense; the rest are biaya usaha", () => {
    expect(of("6-1201", "expense", "expense.marketplace_fee")).toBe("platform_fees");
    expect(of("6-1202", "expense", "expense.marketplace_shipping_subsidy")).toBe("platform_fees");
    expect(of("6-1203", "expense", "expense.payment_gateway")).toBe("payment_gateway");
    expect(of("6-1302", "expense", "expense.web_shipping_subsidy")).toBe("shipping");
    expect(of("6-1301", "expense", "expense.sales_shipping")).toBe("courier_cost");
    expect(of("6-4103", "expense", "expense.defect_release", "6-4000")).toBe("inventory_expense");
    expect(of("6-4199", "expense", null, "6-4000")).toBe("inventory_expense");
    expect(of("6-2101", "expense", null, "6-2000")).toBe("operating_expenses");
    expect(of("6-2401", "expense", "expense.depreciation", "6-2000")).toBe("depreciation");
    expect(of("9-1101", "tax", "tax.pph_final")).toBe("tax");
    expect(of("1-1201", "asset", "bank.main")).toBeNull();
  });
});

describe("reconcileComponent", () => {
  test("per key: only in management, only in the ledger, a different amount; plus ledger lines without a key", () => {
    const result = reconcileComponent({
      component: "net_sales",
      management: new Map([
        ["a", 100_000], // ordered this month, shipped next month
        ["b", 200_000], // same on both sides
        ["c", 300_000], // partially refunded: management 300.000, ledger 350.000
      ]),
      ledgerByKey: new Map([
        ["b", 200_000],
        ["c", 350_000],
        ["d", 400_000], // ordered last month, shipped this month
      ]),
      ledgerOutside: -5_000, // a manual correction
    });
    expect(result).toMatchObject({ management: 600_000, ledger: 945_000, difference: 345_000 });
    expect(result.lines).toEqual([
      { cls: "app_only", amount: -100_000, count: 1, sampleKeys: ["a"] },
      { cls: "ledger_only", amount: 400_000, count: 1, sampleKeys: ["d"] },
      { cls: "amount", amount: 50_000, count: 1, sampleKeys: ["c"] },
      { cls: "outside", amount: -5_000, count: 0, sampleKeys: [] },
    ]);
    expect(result.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(result.difference);
  });

  test("nothing to explain: no lines", () => {
    const same = reconcileComponent({ component: "cogs", management: new Map([["a", 5]]), ledgerByKey: new Map([["a", 5]]), ledgerOutside: 0 });
    expect(same).toMatchObject({ difference: 0, lines: [] });
  });

  test("every class has an Indonesian label per key kind", () => {
    for (const kind of ["order", "expense", "none"] as const) for (const cls of ["app_only", "ledger_only", "amount", "outside"] as const) expect(differenceLabel(kind, cls)).toMatch(/\S/);
  });
});
