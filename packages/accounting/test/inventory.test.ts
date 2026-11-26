import { describe, expect, test } from "vitest";
import { planEvent } from "../src/plan";
import { defectDisposalRule, finishedGoodsAdjustmentRule, type DefectDisposalSnapshot, type FinishedGoodsAdjustmentSnapshot } from "../src/rules/inventory";
import type { PostingOutcome } from "../src/rules/types";
import { defaultContext } from "./context";

// A1 finished-goods adjustments [D-16] and A2 defect releases [D-7] (docs/plans/accounting.md §4.6,
// Session 8): operating expenses (6-4101/6-4102/6-4103), never HPP; auction proceeds are
// Pendapatan lain-lain.

function sides(outcome: PostingOutcome): string[] {
  if (outcome.kind !== "journal") throw new Error(`expected a journal, got ${JSON.stringify(outcome)}`);
  return outcome.lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`));
}

function adjustment(overrides: Partial<FinishedGoodsAdjustmentSnapshot> = {}): FinishedGoodsAdjustmentSnapshot {
  return { id: "sm-1", sku: "HAURA-BEIGE-L", reason: "recount", qty: -1, valueAmount: -87_917, createdAt: new Date("2026-12-09T18:30:00Z"), ...overrides };
}

function disposal(overrides: Partial<DefectDisposalSnapshot> = {}): DefectDisposalSnapshot {
  return { id: "dm-1", type: "dispose", reversesMovementId: null, disposalType: "donation", occurredAt: "2026-12-12", valueAmount: -175_834, proceedsAmount: 0, itemName: "HAURA-BEIGE-L", ...overrides };
}

describe("A1 finished-goods adjustment [D-16]", () => {
  test("a recount loss: Dr 6-4101 Selisih persediaan / Cr 1-1504, dated created_at in Jakarta", () => {
    const [event] = finishedGoodsAdjustmentRule.events(adjustment(), defaultContext());
    expect(event?.key).toEqual({ sourceType: "stock_movement", sourceId: "sm-1", sourceEvent: "adjustment" });
    expect(event?.sourceDate).toBe("2026-12-10");
    expect(sides(event!.outcome)).toEqual(["Dr 6-4101 87917", "Cr 1-1504 87917"]);
  });

  test("damaged and lost go to 6-4102 Kerusakan & kehilangan persediaan", () => {
    for (const reason of ["damaged", "lost"] as const) {
      const [event] = finishedGoodsAdjustmentRule.events(adjustment({ reason }), defaultContext());
      expect(sides(event!.outcome)).toEqual(["Dr 6-4102 87917", "Cr 1-1504 87917"]);
    }
  });

  test("a gain is the other way round; never HPP", () => {
    const context = defaultContext();
    const [event] = finishedGoodsAdjustmentRule.events(adjustment({ qty: 1, valueAmount: 87_917, reason: "other" }), context);
    expect(sides(event!.outcome)).toEqual(["Dr 1-1504 87917", "Cr 6-4101 87917"]);
    if (event!.outcome.kind !== "journal") throw new Error();
    for (const line of event!.outcome.lines) expect(context.accounts.get(line.accountCode)?.type).not.toBe("cogs");
  });

  test("a zero-value row (the pre-0011 backfill) and anything before the start post nothing", () => {
    expect(finishedGoodsAdjustmentRule.events(adjustment({ valueAmount: 0 }), defaultContext())[0]?.outcome.kind).toBe("none");
    expect(finishedGoodsAdjustmentRule.events(adjustment({ createdAt: new Date("2026-11-30T10:00:00Z") }), defaultContext())[0]?.outcome.kind).toBe("none");
  });

  test("an adjustment without a reason is an issue", () => {
    expect(finishedGoodsAdjustmentRule.events(adjustment({ reason: null }), defaultContext())[0]?.outcome).toMatchObject({ kind: "issue", issueCode: "adjustment_reason_missing" });
  });
});

describe("A2 defect released [D-7]", () => {
  test("donation and discarded: Dr 6-4103 Barang cacat dilepas / Cr 1-1506, no cash", () => {
    for (const disposalType of ["donation", "discarded"] as const) {
      const [event] = defectDisposalRule.events(disposal({ disposalType }), defaultContext());
      expect(event?.key).toEqual({ sourceType: "defect_movement", sourceId: "dm-1", sourceEvent: "dispose" });
      expect(sides(event!.outcome)).toEqual(["Dr 6-4103 175834", "Cr 1-1506 175834"]);
    }
  });

  test("auction: the value is 6-4103 and the proceeds are Kas tunai / Pendapatan lain-lain (never netted)", () => {
    const [event] = defectDisposalRule.events(disposal({ disposalType: "auction", proceedsAmount: 60_000 }), defaultContext());
    expect(sides(event!.outcome)).toEqual(["Dr 6-4103 175834", "Dr 1-1101 60000", "Cr 1-1506 175834", "Cr 7-1101 60000"]);
    expect(planEvent(event!, 1, defaultContext()).kind).toBe("journal");
  });

  test("a reversal books its own negated value and proceeds and waits on the original's journal", () => {
    const [event] = defectDisposalRule.events(
      disposal({ id: "dm-2", type: "reversal", reversesMovementId: "dm-1", disposalType: "auction", valueAmount: 175_834, proceedsAmount: -60_000, occurredAt: "2026-12-14" }),
      defaultContext(),
    );
    expect(sides(event!.outcome)).toEqual(["Dr 1-1506 175834", "Dr 7-1101 60000", "Cr 6-4103 175834", "Cr 1-1101 60000"]);
    expect(event?.requiresActiveJournalFor).toEqual({ sourceType: "defect_movement", sourceId: "dm-1", sourceEvent: "dispose" });
  });

  test("a release before the start is not posted", () => {
    expect(defectDisposalRule.events(disposal({ occurredAt: "2026-11-30" }), defaultContext())[0]?.outcome.kind).toBe("none");
  });
});
