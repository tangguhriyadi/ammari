import { describe, expect, test } from "vitest";
import { planEvent } from "../src/plan";
import { markReclassifications, rawMaterialAdjustmentRule, type RawMaterialMovementSnapshot } from "../src/rules/raw-materials";
import { defaultContext } from "./context";

// P7 (docs/plans/accounting.md §4.4, Session 7): raw-material adjustments go to operating expenses
// 6-4101 Selisih persediaan (recount/other) or 6-4102 Kerusakan & kehilangan (damaged/lost), never
// HPP [D-16]; a fabric colour reclassification nets to zero inside 1-1501 (no journal).

const context = defaultContext();

function movement(overrides: Partial<RawMaterialMovementSnapshot> = {}): RawMaterialMovementSnapshot {
  return {
    id: "m1",
    material: "fabric",
    itemName: "Katun Jepang Hitam",
    kind: "adjustment",
    reason: "damaged",
    qty: -2,
    valueAmount: -90_000,
    createdAt: new Date("2026-12-04T20:00:00Z"), // 5 Dec in Jakarta
    isReclassification: false,
    voided: false,
    ...overrides,
  };
}

function only(m: RawMaterialMovementSnapshot) {
  const events = rawMaterialAdjustmentRule.events(m, context);
  expect(events).toHaveLength(1);
  return events[0]!;
}

function net(m: RawMaterialMovementSnapshot): Record<string, number> {
  const outcome = only(m).outcome;
  if (outcome.kind !== "journal") throw new Error(`expected a journal, got ${outcome.kind}`);
  const totals: Record<string, number> = {};
  for (const line of outcome.lines) totals[line.accountCode] = (totals[line.accountCode] ?? 0) + line.debit - line.credit;
  return totals;
}

describe("P7 raw-material adjustments", () => {
  test("damaged fabric: Dr 6-4102 / Cr 1-1501, keyed and dated by the movement (Jakarta)", () => {
    const event = only(movement());
    expect(event.key).toEqual({ sourceType: "fabric_stock_movement", sourceId: "m1", sourceEvent: "adjustment" });
    expect(event.sourceDate).toBe("2026-12-05");
    expect(net(movement())).toEqual({ "6-4102": 90_000, "1-1501": -90_000 });
  });

  test("lost accessories → 6-4102 / 1-1502", () => {
    const m = movement({ material: "accessory", reason: "lost", valueAmount: -15_000 });
    expect(only(m).key.sourceType).toBe("accessory_movement");
    expect(net(m)).toEqual({ "6-4102": 15_000, "1-1502": -15_000 });
  });

  test("a recount gain: Dr 1-1501 / Cr 6-4101; a recount loss and 'other' go to 6-4101 too", () => {
    expect(net(movement({ reason: "recount", qty: 1, valueAmount: 45_000 }))).toEqual({ "1-1501": 45_000, "6-4101": -45_000 });
    expect(net(movement({ reason: "recount" }))).toEqual({ "6-4101": 90_000, "1-1501": -90_000 });
    expect(net(movement({ reason: "other", material: "accessory" }))).toEqual({ "6-4101": 90_000, "1-1502": -90_000 });
  });

  test("never HPP: every P7 line is inventory or 6-41xx", () => {
    for (const reason of ["recount", "damaged", "lost", "other"] as const) {
      for (const sign of [1, -1]) {
        const outcome = only(movement({ reason, valueAmount: sign * 1000 })).outcome;
        if (outcome.kind !== "journal") throw new Error();
        for (const line of outcome.lines) expect(line.accountCode).toMatch(/^(1-150[12]|6-410[12])$/);
        expect(planEvent(only(movement({ reason, valueAmount: sign * 1000 })), 1, context).kind).toBe("journal");
      }
    }
  });

  test("a colour reclassification leg, a zero-value adjustment and one before the posting start post nothing", () => {
    expect(only(movement({ isReclassification: true })).outcome).toEqual({ kind: "none" });
    expect(only(movement({ valueAmount: 0 })).outcome).toEqual({ kind: "none" });
    expect(only(movement({ createdAt: new Date("2026-11-30T10:00:00Z") })).outcome).toEqual({ kind: "none" });
  });

  test("a legacy manual purchase after the posting start is an issue, never a journal (D-14: only receipts)", () => {
    const event = only(movement({ kind: "legacy_purchase", reason: null, qty: 5, valueAmount: 500_000 }));
    expect(event.key.sourceEvent).toBe("legacy_purchase");
    expect(event.outcome).toMatchObject({ kind: "issue", issueCode: "legacy_raw_purchase" });
    expect(only(movement({ kind: "legacy_purchase", reason: null, createdAt: new Date("2026-10-01T00:00:00Z") })).outcome).toEqual({ kind: "none" });
    // Voiding it is the fix: the issue goes away (the runner resolves it on "none").
    expect(only(movement({ kind: "legacy_purchase", reason: null, qty: 5, valueAmount: 500_000, voided: true })).outcome).toEqual({ kind: "none" });
  });

  test("markReclassifications: two legs of one fabric at the same instant netting to zero; nothing else", () => {
    const when = new Date("2026-12-05T03:00:00Z");
    const rows = [
      { id: "out", material: "fabric" as const, kind: "adjustment" as const, createdAt: when, qty: -3, valueAmount: -150_000, groupKey: "f1" },
      { id: "in", material: "fabric" as const, kind: "adjustment" as const, createdAt: when, qty: 3, valueAmount: 150_000, groupKey: "f1" },
      { id: "solo", material: "fabric" as const, kind: "adjustment" as const, createdAt: when, qty: -1, valueAmount: -50_000, groupKey: "f2" },
      { id: "other-fabric", material: "fabric" as const, kind: "adjustment" as const, createdAt: when, qty: 1, valueAmount: 50_000, groupKey: "f3" },
      { id: "acc", material: "accessory" as const, kind: "adjustment" as const, createdAt: when, qty: 1, valueAmount: 50_000, groupKey: "f2" },
    ];
    expect(Object.fromEntries(markReclassifications(rows).map((row) => [row.id, row.isReclassification]))).toEqual({
      out: true,
      in: true,
      solo: false,
      "other-fabric": false,
      acc: false,
    });
  });
});
