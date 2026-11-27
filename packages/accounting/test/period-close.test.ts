import { describe, expect, test } from "vitest";
import { isBalancedJournal } from "../src/journal";
import { pphFinalLines, pphFinalWarning, proposePphFinal, taxSettingFor, yearEndClosingLines, type PphTaxSetting } from "../src/period-close";

// D-20 PPh final accrual and §5.7 year-end closing (Session 11).

const setting: PphTaxSetting = { effectiveFrom: "2026-12-01", taxpayerType: "individual", rateBps: 50, annualExemptionAmount: 500_000_000, rateValidUntil: null };
const accounts = { expense: "9-1101", liability: "2-1401" };

describe("PPh final accrual", () => {
  test("below the Rp500 juta exemption: nothing taxable", () => {
    const proposal = proposePphFinal({ month: "2027-01-01", setting, ytdBefore: 0, monthBase: 120_000_000 });
    expect(proposal).toMatchObject({ kind: "accrual", taxable: 0, amount: 0 });
    expect(pphFinalLines(proposal, accounts)).toEqual([]);
  });

  test("crossing the exemption mid-month: only the part above it is taxed", () => {
    const proposal = proposePphFinal({ month: "2027-05-01", setting, ytdBefore: 450_000_000, monthBase: 130_000_000 });
    expect(proposal).toMatchObject({ kind: "accrual", ytdAfter: 580_000_000, taxable: 80_000_000, amount: 400_000 });
    expect(pphFinalLines(proposal, accounts)).toEqual([
      { accountCode: "9-1101", debit: 400_000, credit: 0 },
      { accountCode: "2-1401", debit: 0, credit: 400_000 },
    ]);
  });

  test("after the exemption is used up the whole month is taxed; rounded down to whole rupiah", () => {
    expect(proposePphFinal({ month: "2027-06-01", setting, ytdBefore: 580_000_000, monthBase: 100_000_199 })).toMatchObject({ taxable: 100_000_199, amount: 500_000 });
  });

  test("PPh final is never negative: a month with returns above its sales books 0, no reversal lines", () => {
    const proposal = proposePphFinal({ month: "2027-07-01", setting, ytdBefore: 600_000_000, monthBase: -20_000_000 });
    expect(proposal).toMatchObject({ kind: "accrual", taxable: -20_000_000, amount: 0 });
    expect(pphFinalLines(proposal, accounts)).toEqual([]);
    if (proposal.kind !== "accrual") throw new Error("expected an accrual");
    expect(pphFinalLines({ ...proposal, amount: -100_000 }, accounts)).toEqual([]);
  });

  test("a negative month frees exemption headroom that the next months use before being taxed (net YTD base)", () => {
    const exemption = { ...setting, annualExemptionAmount: 500 };
    let ytd = 0;
    const amounts: number[] = [];
    const taxables: number[] = [];
    for (const [month, base] of [["2027-01-01", 600], ["2027-02-01", -200], ["2027-03-01", 150], ["2027-04-01", 1_000]] as const) {
      const proposal = proposePphFinal({ month, setting: { ...exemption, rateBps: 10_000 }, ytdBefore: ytd, monthBase: base });
      if (proposal.kind !== "accrual") throw new Error("expected an accrual");
      amounts.push(proposal.amount);
      taxables.push(proposal.taxable);
      ytd = proposal.ytdAfter;
    }
    // At a 100% rate the amount equals the taxed base: Jan 100; Feb nothing (YTD 400, never negative);
    // Mar 150 sales fill the freed headroom to 550 → 50 taxed; Apr all 1.000 taxed.
    expect(taxables).toEqual([100, -100, 50, 1_000]);
    expect(amounts).toEqual([100, 0, 50, 1_000]);
  });

  test("a negative month that stays below the exemption is not taxable", () => {
    expect(proposePphFinal({ month: "2027-02-01", setting, ytdBefore: 300_000_000, monthBase: -1_000_000 })).toMatchObject({ taxable: 0, amount: 0 });
  });

  test("no accrual after rate_valid_until, with the warning; never a guess", () => {
    const proposal = proposePphFinal({ month: "2027-01-01", setting: { ...setting, rateValidUntil: "2026-12-31" }, ytdBefore: 0, monthBase: 900_000_000 });
    expect(proposal).toEqual({ kind: "rate_ended", month: "2027-01-01", rateValidUntil: "2026-12-31" });
    expect(pphFinalLines(proposal, accounts)).toEqual([]);
    expect(pphFinalWarning(proposal)).toBe("Tarif PPh final berakhir, periksa pengaturan pajak.");
  });

  test("a rate ending mid-month proposes nothing for that month; ending on its last day still accrues", () => {
    expect(proposePphFinal({ month: "2029-12-01", setting: { ...setting, rateValidUntil: "2029-12-15" }, ytdBefore: 0, monthBase: 1 }).kind).toBe("rate_ended");
    expect(proposePphFinal({ month: "2029-12-01", setting: { ...setting, rateValidUntil: "2029-12-31" }, ytdBefore: 0, monthBase: 1 }).kind).toBe("accrual");
  });

  test("no setting, or a company taxpayer: no accrual, a warning", () => {
    expect(pphFinalWarning(proposePphFinal({ month: "2027-01-01", setting: null, ytdBefore: 0, monthBase: 1 }))).toContain("Belum ada pengaturan pajak");
    expect(pphFinalWarning(proposePphFinal({ month: "2027-01-01", setting: { ...setting, taxpayerType: "company" }, ytdBefore: 0, monthBase: 1 }))).toContain("orang pribadi");
  });

  test("a rate change by a new effective row applies from its month", () => {
    const settings = [setting, { ...setting, effectiveFrom: "2027-07-01", rateBps: 100 }];
    expect(taxSettingFor(settings, "2027-06-01")?.rateBps).toBe(50);
    expect(taxSettingFor(settings, "2027-07-01")?.rateBps).toBe(100);
    expect(taxSettingFor(settings, "2026-11-01")).toBeNull();
    const july = proposePphFinal({ month: "2027-07-01", setting: taxSettingFor(settings, "2027-07-01"), ytdBefore: 600_000_000, monthBase: 10_000_000 });
    expect(july).toMatchObject({ rateBps: 100, amount: 100_000, effectiveFrom: "2027-07-01" });
  });

  test("large amounts stay exact (BigInt)", () => {
    expect(proposePphFinal({ month: "2027-12-01", setting, ytdBefore: 0, monthBase: 9_000_000_000_001 })).toMatchObject({ amount: Math.floor((9_000_000_000_001 - 500_000_000) / 200) });
  });
});

describe("year-end closing", () => {
  const closingAccounts = { retainedEarnings: "3-2001", drawings: "3-1002", ownerCapital: "3-1001" };

  test("every P&L balance is zeroed against Saldo laba; Prive into Modal pemilik; balanced", () => {
    const lines = yearEndClosingLines(
      [
        { code: "4-1101", type: "revenue", net: -1_000_000 },
        { code: "4-1201", type: "contra_revenue", net: 50_000 },
        { code: "5-1101", type: "cogs", net: 400_000 },
        { code: "6-2401", type: "expense", net: 100_000 },
        { code: "7-1101", type: "other_income", net: -20_000 },
        { code: "9-1101", type: "tax", net: 5_000 },
        { code: "3-1002", type: "equity", net: 200_000 },
        { code: "1-1201", type: "asset", net: 999 },
        { code: "6-2101", type: "expense", net: 0 },
      ],
      closingAccounts,
    );
    expect(lines).toEqual([
      { accountCode: "4-1101", debit: 1_000_000, credit: 0 },
      { accountCode: "4-1201", debit: 0, credit: 50_000 },
      { accountCode: "5-1101", debit: 0, credit: 400_000 },
      { accountCode: "6-2401", debit: 0, credit: 100_000 },
      { accountCode: "7-1101", debit: 20_000, credit: 0 },
      { accountCode: "9-1101", debit: 0, credit: 5_000 },
      { accountCode: "3-2001", debit: 0, credit: 465_000, memo: "Laba tahun berjalan" },
      { accountCode: "3-1002", debit: 0, credit: 200_000 },
      { accountCode: "3-1001", debit: 200_000, credit: 0, memo: "Prive ditutup ke modal" },
    ]);
    expect(isBalancedJournal(lines)).toBe(true);
  });

  test("a loss debits Saldo laba; nothing to close gives no lines", () => {
    const lines = yearEndClosingLines([{ code: "6-2101", type: "expense", net: 300 }], closingAccounts);
    expect(lines.at(-1)).toEqual({ accountCode: "3-2001", debit: 300, credit: 0, memo: "Rugi tahun berjalan" });
    expect(yearEndClosingLines([{ code: "1-1201", type: "asset", net: 5 }], closingAccounts)).toEqual([]);
  });
});
