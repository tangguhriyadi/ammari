import { describe, expect, test } from "vitest";
import { planEvent } from "../src/plan";
import {
  accumulatedAtDisposal,
  bookValueAt,
  depreciatedMonths,
  depreciationSchedule,
  fixedAssetEvents,
  type FixedAssetSnapshot,
} from "../src/rules/fixed-assets";
import type { PostingEvent } from "../src/rules/types";
import { defaultContext } from "./context";

// D-19: straight line from the acquisition month, tax groups (Kelompok 1 = 48, Kelompok 2 = 96
// months), zero residual; acquisition, monthly depreciation and disposal (plan §5.3, Session 11).

function asset(overrides: Partial<FixedAssetSnapshot> = {}): FixedAssetSnapshot {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "Mesin jahit",
    usefulLifeMonths: 48,
    acquisitionDate: "2027-01-20",
    cost: 10_000_000,
    assetAccountCode: "1-2101",
    accumulatedAccountCode: "1-2191",
    fundingAccountCode: "1-1201",
    disposedOn: null,
    disposalProceeds: null,
    disposalCashAccountCode: null,
    voided: false,
    asOfMonth: "2027-03-01",
    ...overrides,
  };
}

const context = defaultContext();
const journals = (events: PostingEvent[]) => events.filter((event) => event.outcome.kind === "journal");
const byEvent = (events: PostingEvent[], sourceEvent: string) => events.find((event) => event.key.sourceEvent === sourceEvent);
const lines = (event: PostingEvent | undefined) => (event?.outcome.kind === "journal" ? event.outcome.lines : []);

describe("depreciation schedule", () => {
  test("Kelompok 1: 48 months from the acquisition month; the last month absorbs the rounding; sums to cost", () => {
    const schedule = depreciationSchedule(10_000_000, 48, "2027-01-20");
    expect(schedule).toHaveLength(48);
    expect(schedule[0]).toEqual({ month: "2027-01-01", index: 1, amount: 208_333 });
    expect(schedule[46]?.amount).toBe(208_333);
    expect(schedule[47]).toEqual({ month: "2030-12-01", index: 48, amount: 10_000_000 - 208_333 * 47 });
    expect(schedule.reduce((sum, entry) => sum + entry.amount, 0)).toBe(10_000_000);
  });

  test("Kelompok 2: 96 months, zero residual", () => {
    const schedule = depreciationSchedule(1_000_001, 96, "2027-06-30");
    expect(schedule).toHaveLength(96);
    expect(schedule[0]?.month).toBe("2027-06-01");
    expect(schedule[95]?.month).toBe("2035-05-01");
    expect(schedule.reduce((sum, entry) => sum + entry.amount, 0)).toBe(1_000_001);
  });

  test("an exact division has no rounding rest", () => {
    expect(new Set(depreciationSchedule(4_800_000, 48, "2027-01-01").map((entry) => entry.amount))).toEqual(new Set([100_000]));
  });

  test("a disposal stops depreciation before the disposal month", () => {
    const months = depreciatedMonths({ cost: 4_800_000, usefulLifeMonths: 48, acquisitionDate: "2027-01-10", disposedOn: "2027-04-02" });
    expect(months.map((entry) => entry.month)).toEqual(["2027-01-01", "2027-02-01", "2027-03-01"]);
    expect(accumulatedAtDisposal({ cost: 4_800_000, usefulLifeMonths: 48, acquisitionDate: "2027-01-10", disposedOn: "2027-04-02" })).toBe(300_000);
  });

  test("book value at a date", () => {
    const a = { cost: 4_800_000, usefulLifeMonths: 48, acquisitionDate: "2027-01-10", disposedOn: null };
    expect(bookValueAt(a, "2027-01-15")).toBe(4_700_000);
    expect(bookValueAt(a, "2031-01-01")).toBe(0);
    expect(bookValueAt({ ...a, disposedOn: "2027-05-01" }, "2027-05-01")).toBe(0);
  });
});

describe("fixed asset events", () => {
  test("acquisition: Dr the asset account / Cr the funding account, on the acquisition date", () => {
    const events = fixedAssetEvents(asset(), context);
    const acquired = byEvent(events, "acquired");
    expect(acquired?.sourceDate).toBe("2027-01-20");
    expect(lines(acquired)).toEqual([
      { accountCode: "1-2101", debit: 10_000_000, credit: 0 },
      { accountCode: "1-1201", debit: 0, credit: 10_000_000, cashAccountCode: "1-1201" },
    ]);
  });

  test("bought on credit credits the liability (no cash dimension)", () => {
    expect(lines(byEvent(fixedAssetEvents(asset({ fundingAccountCode: "2-2101" }), context), "acquired"))[1]).toEqual({ accountCode: "2-2101", debit: 0, credit: 10_000_000 });
  });

  test("no funding account: the purchase is already in the books, no acquisition journal", () => {
    expect(byEvent(fixedAssetEvents(asset({ fundingAccountCode: null }), context), "acquired")?.outcome).toEqual({ kind: "none" });
  });

  test("monthly depreciation from the acquisition month through the current month, dated the month's last day, kind depreciation", () => {
    const events = fixedAssetEvents(asset(), context);
    const posted = journals(events).filter((event) => event.key.sourceEvent.startsWith("dep:"));
    expect(posted.map((event) => [event.key.sourceEvent, event.sourceDate, event.entryKind])).toEqual([
      ["dep:2027-01", "2027-01-31", "depreciation"],
      ["dep:2027-02", "2027-02-28", "depreciation"],
      ["dep:2027-03", "2027-03-31", "depreciation"],
    ]);
    expect(lines(posted[0])).toEqual([
      { accountCode: "6-2401", debit: 208_333, credit: 0 },
      { accountCode: "1-2191", debit: 0, credit: 208_333 },
    ]);
    // Later months are emitted as "none" (nothing posted yet).
    expect(byEvent(events, "dep:2027-04")?.outcome).toEqual({ kind: "none" });
    expect(byEvent(events, "dep:2030-12")?.outcome).toEqual({ kind: "none" });
  });

  test("the last month of the life absorbs the rounding", () => {
    const events = fixedAssetEvents(asset({ asOfMonth: "2031-06-01" }), context);
    const posted = journals(events).filter((event) => event.key.sourceEvent.startsWith("dep:"));
    expect(posted).toHaveLength(48);
    expect(lines(byEvent(events, "dep:2030-12"))[0]?.debit).toBe(10_000_000 - 208_333 * 47);
    expect(byEvent(events, "dep:2031-01")?.outcome).toEqual({ kind: "none" });
  });

  test("an asset bought before the books: no acquisition, depreciation only from the posting start", () => {
    const events = fixedAssetEvents(asset({ acquisitionDate: "2026-06-15", asOfMonth: "2027-01-01" }), context);
    expect(byEvent(events, "acquired")?.outcome).toEqual({ kind: "none" });
    expect(byEvent(events, "dep:2026-11")?.outcome).toEqual({ kind: "none" });
    expect(journals(events).map((event) => event.key.sourceEvent)).toEqual(["dep:2026-12", "dep:2027-01"]);
    // The 7th month of its life: the schedule counts from June 2026.
    expect(byEvent(events, "dep:2026-12")?.outcome.kind === "journal" && byEvent(events, "dep:2026-12")?.outcome).toMatchObject({ description: expect.stringContaining("bulan ke-7") });
  });

  test("disposal with proceeds and a loss: Dr cash, Dr accumulated, Dr 8-1102 / Cr the asset", () => {
    const events = fixedAssetEvents(asset({ acquisitionDate: "2027-01-10", cost: 4_800_000, disposedOn: "2027-04-02", disposalProceeds: 4_000_000, disposalCashAccountCode: "1-1101", asOfMonth: "2027-05-01" }), context);
    expect(journals(events).map((event) => event.key.sourceEvent)).toEqual(["acquired", "dep:2027-01", "dep:2027-02", "dep:2027-03", "disposed"]);
    const disposed = byEvent(events, "disposed");
    expect(disposed?.sourceDate).toBe("2027-04-02");
    expect(lines(disposed)).toEqual([
      { accountCode: "1-1101", debit: 4_000_000, credit: 0, cashAccountCode: "1-1101" },
      { accountCode: "1-2191", debit: 300_000, credit: 0 },
      { accountCode: "8-1102", debit: 500_000, credit: 0, memo: "Rugi pelepasan" },
      { accountCode: "1-2101", debit: 0, credit: 4_800_000 },
    ]);
  });

  test("disposal with a gain credits the disposal result; a scrapped asset has no cash line", () => {
    const gain = lines(byEvent(fixedAssetEvents(asset({ acquisitionDate: "2027-01-10", cost: 4_800_000, disposedOn: "2027-04-02", disposalProceeds: 4_600_000, disposalCashAccountCode: "1-1201" }), context), "disposed"));
    expect(gain.at(-1)).toEqual({ accountCode: "8-1102", debit: 0, credit: 100_000, memo: "Laba pelepasan" });
    const scrapped = lines(byEvent(fixedAssetEvents(asset({ acquisitionDate: "2027-01-10", cost: 4_800_000, disposedOn: "2027-04-02", disposalProceeds: 0 }), context), "disposed"));
    expect(scrapped.map((line) => line.accountCode)).toEqual(["1-2191", "8-1102", "1-2101"]);
  });

  test("a missing disposal-result mapping is a posting issue, never a guess", () => {
    const noMapping = defaultContext({ mappings: { "fixed_asset.disposal_result": null } });
    const disposed = byEvent(fixedAssetEvents(asset({ disposedOn: "2027-02-01", disposalProceeds: 0 }), noMapping), "disposed");
    expect(disposed?.outcome).toMatchObject({ kind: "issue", issueCode: "unmapped_fixed_asset_disposal" });
  });

  test("a void makes every key none (the runner reverses what was posted)", () => {
    const events = fixedAssetEvents(asset({ voided: true, disposedOn: "2027-02-10", disposalProceeds: 0 }), context);
    expect(journals(events)).toEqual([]);
    expect(events.some((event) => event.key.sourceEvent === "dep:2027-01")).toBe(true);
  });

  test("a later acquisition date still emits the earlier posted months as none", () => {
    const events = fixedAssetEvents(asset({ acquisitionDate: "2027-03-05" }), context);
    expect(byEvent(events, "dep:2027-01")?.outcome).toEqual({ kind: "none" });
    expect(byEvent(events, "dep:2026-12")?.outcome).toEqual({ kind: "none" });
    expect(journals(events).map((event) => event.key.sourceEvent)).toEqual(["acquired", "dep:2027-03"]);
  });

  test("every journal balances and plans as a journal", () => {
    const events = fixedAssetEvents(asset({ disposedOn: "2027-03-15", disposalProceeds: 9_000_000, disposalCashAccountCode: "1-1201", asOfMonth: "2027-04-01" }), context);
    for (const event of journals(events)) expect(planEvent(event, 1, context).kind).toBe("journal");
    const planned = planEvent(byEvent(events, "dep:2027-01") as PostingEvent, 1, context);
    expect(planned.kind === "journal" && planned.entryKind).toBe("depreciation");
  });
});
