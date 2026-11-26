import { describe, expect, test } from "vitest";
import { planEvent } from "../src/plan";
import { purchaseGuardViolations } from "../src/purchase-guard";
import {
  batchWipAsOf,
  productionChainEvents,
  productionChainRule,
  type ProductionBatchSnapshot,
  type ProductionDefectReturnSnapshot,
  type ProductionPaymentSnapshot,
  type ProductionReceiptItemSnapshot,
} from "../src/rules/production";
import type { PostingEvent, PostingOutcome } from "../src/rules/types";
import { defaultContext } from "./context";

// The production chain (docs/plans/accounting.md §4.5 R1-R5, Session 8): batch cost into WIP at
// posting, output out of WIP at receipt, the automatic WIP close [D-15] (normal rounding residue →
// 5-1201, a short-closed batch's rest → 6-4102), batch payments on the Session 7 position rule, and
// defects returned to the tailor. Pure: snapshot → events.

const TAILOR = "00000000-0000-4000-8000-0000000000bb";
const at = (iso: string) => new Date(iso);

// Haura, beige: M 12 pcs and L 12 pcs planned (24). Fabric 1.000.003 (an odd value, so rounding
// shows), accessories 50.000, jahit 24 × 40.000 by the tailor, finishing 100.000 without a payee.
// Total 2.110.003; HPP/pcs = ceil(2.110.003 / 24) = 87.917; 24 × 87.917 = 2.110.008 (5 over).
const FABRIC = 1_000_003;
const ACCESSORY = 50_000;
const JAHIT = 960_000;
const FINISHING = 100_000;
const TOTAL = FABRIC + ACCESSORY + JAHIT + FINISHING;
const UNIT = Math.ceil(TOTAL / 24);

function batchOf(overrides: Partial<ProductionBatchSnapshot> = {}): ProductionBatchSnapshot {
  return {
    id: "batch-1",
    batchNo: "BTC-202612-001",
    status: "posted",
    postedAt: at("2026-12-02T03:00:00Z"),
    receiptStatus: "pending",
    closedAt: null,
    fabricConsumed: FABRIC,
    accessoryConsumed: ACCESSORY,
    costLines: [
      { supplierId: TAILOR, supplierName: "Penjahit Bu Ani", total: JAHIT },
      { supplierId: null, supplierName: null, total: FINISHING },
    ],
    hasLegacyStock: false,
    receiptItems: [],
    payments: [],
    defectReturns: [],
    ...overrides,
  };
}

function receipt(id: string, receivedAt: string, sku: string, qty: number, extra: Partial<ProductionReceiptItemSnapshot> = {}): ProductionReceiptItemSnapshot {
  return {
    id,
    receiptNo: `GR-${id}`,
    kind: "receipt",
    receivedAt,
    createdAt: at(`${receivedAt}T04:00:00Z`),
    reversesItemId: null,
    sku,
    qtyAccepted: qty,
    qtyRejected: 0,
    acceptedValue: qty * UNIT,
    rejectValue: null,
    ...extra,
  };
}

function reversalOf(original: ProductionReceiptItemSnapshot, id: string, receivedAt: string): ProductionReceiptItemSnapshot {
  return {
    ...original,
    id,
    receiptNo: `GR-${id}`,
    kind: "reversal",
    receivedAt,
    createdAt: at(`${receivedAt}T09:00:00Z`),
    reversesItemId: original.id,
    qtyAccepted: -original.qtyAccepted,
    qtyRejected: -original.qtyRejected,
    acceptedValue: original.acceptedValue === null ? null : -original.acceptedValue,
    rejectValue: original.rejectValue === null ? null : -original.rejectValue,
  };
}

function payment(id: string, paidAt: string, amount: number, extra: Partial<ProductionPaymentSnapshot> = {}): ProductionPaymentSnapshot {
  return {
    id,
    paymentNo: `BYR-${id}`,
    supplierId: TAILOR,
    supplierName: "Penjahit Bu Ani",
    paidAt,
    createdAt: at(`${paidAt}T05:00:00Z`),
    amount,
    method: "transfer",
    voidedAt: null,
    ...extra,
  };
}

const fullReceipts = () => [receipt("m", "2026-12-10", "HAURA-BEIGE-M", 12), receipt("l", "2026-12-10", "HAURA-BEIGE-L", 12)];

function eventFor(events: PostingEvent[], sourceType: string, sourceId: string, sourceEvent: string): PostingEvent {
  const event = events.find((candidate) => candidate.key.sourceType === sourceType && candidate.key.sourceId === sourceId && candidate.key.sourceEvent === sourceEvent);
  if (!event) throw new Error(`no event ${sourceType}/${sourceId}/${sourceEvent}`);
  return event;
}

function sides(outcome: PostingOutcome): string[] {
  if (outcome.kind !== "journal") throw new Error(`expected a journal, got ${JSON.stringify(outcome)}`);
  return outcome.lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`));
}

const events = (batch: ProductionBatchSnapshot, start?: string) => productionChainEvents(batch, defaultContext(start ? { postingStartDate: start } : {}));

describe("R1 batch posted", () => {
  test("fabric, accessories and service lines into WIP; utang per payee (no payee → 2-1103); balanced", () => {
    const r1 = eventFor(events(batchOf()), "production_batch", "batch-1", "posted");
    expect(r1.sourceDate).toBe("2026-12-02");
    expect(sides(r1.outcome)).toEqual([`Dr 1-1503 ${TOTAL}`, `Cr 1-1501 ${FABRIC}`, `Cr 1-1502 ${ACCESSORY}`, `Cr 2-1102 ${JAHIT}`, `Cr 2-1103 ${FINISHING}`]);
    if (r1.outcome.kind !== "journal") throw new Error();
    expect(r1.outcome.lines.find((line) => line.accountCode === "2-1102")?.supplierId).toBe(TAILOR);
    expect(planEvent(r1, 2, defaultContext()).kind).toBe("journal");
  });

  test("the cost lines' order (as the database returns them) never changes R1's lines, so its content hash is stable", () => {
    const shuffled = batchOf({ costLines: [...batchOf().costLines].reverse() });
    expect(sides(eventFor(events(shuffled), "production_batch", "batch-1", "posted").outcome)).toEqual(sides(eventFor(events(batchOf()), "production_batch", "batch-1", "posted").outcome));
  });

  test("a batch without accessories posts no 1-1502 line", () => {
    const r1 = eventFor(events(batchOf({ accessoryConsumed: 0 })), "production_batch", "batch-1", "posted");
    expect(sides(r1.outcome)).not.toContain("Cr 1-1502 0");
    expect(sides(r1.outcome).some((side) => side.includes("1-1502"))).toBe(false);
  });

  test("a posted batch without fabric consumption rows is an issue, and blocks its payments and R3", () => {
    const all = events(batchOf({ fabricConsumed: null, payments: [payment("p1", "2026-12-05", 100_000)], receiptItems: fullReceipts(), receiptStatus: "received" }));
    expect(eventFor(all, "production_batch", "batch-1", "posted").outcome).toMatchObject({ kind: "issue", issueCode: "batch_consumption_missing" });
    expect(eventFor(all, "supplier_payment", "p1", "paid").outcome).toMatchObject({ kind: "issue", issueCode: "batch_consumption_missing" });
    expect(eventFor(all, "production_batch", "batch-1", "wip_close").outcome).toMatchObject({ kind: "issue", issueCode: "batch_consumption_missing" });
  });

  test("a batch posted before the start is not posted; its December payment still clears the replayed utang", () => {
    const all = events(batchOf({ postedAt: at("2026-11-20T03:00:00Z"), payments: [payment("p1", "2026-12-05", 400_000)] }));
    expect(eventFor(all, "production_batch", "batch-1", "posted").outcome.kind).toBe("none");
    expect(sides(eventFor(all, "supplier_payment", "p1", "paid").outcome)).toEqual(["Dr 2-1102 400000", "Cr 1-1201 400000"]);
  });

  test("a legacy batch (stock added at posting, before goods receipts) is never guessed", () => {
    const all = events(batchOf({ hasLegacyStock: true, receiptStatus: "received" }));
    expect(eventFor(all, "production_batch", "batch-1", "posted").outcome).toMatchObject({ kind: "issue", issueCode: "legacy_batch_stock" });
    expect(all.some((event) => event.key.sourceEvent === "wip_close")).toBe(false);
  });
});

describe("R2 output received", () => {
  test("accepted pcs to 1-1504 and rejects to 1-1506 at the frozen HPP, out of WIP", () => {
    const item = receipt("l", "2026-12-10", "HAURA-BEIGE-L", 5, { qtyRejected: 1, rejectValue: UNIT });
    const r2 = eventFor(events(batchOf({ receiptItems: [item], receiptStatus: "partially_received" })), "goods_receipt_item", "l", "received");
    expect(r2.sourceDate).toBe("2026-12-10");
    expect(sides(r2.outcome)).toEqual([`Dr 1-1504 ${5 * UNIT}`, `Dr 1-1506 ${UNIT}`, `Cr 1-1503 ${6 * UNIT}`]);
  });

  test("a reversal is the exact negation and waits on its original's active journal", () => {
    const item = receipt("l", "2026-12-10", "HAURA-BEIGE-L", 6);
    const reversal = reversalOf(item, "l-rev", "2026-12-12");
    const all = events(batchOf({ receiptItems: [item, reversal], receiptStatus: "pending" }));
    const event = eventFor(all, "goods_receipt_item", "l-rev", "reversed");
    expect(sides(event.outcome)).toEqual([`Dr 1-1503 ${6 * UNIT}`, `Cr 1-1504 ${6 * UNIT}`]);
    expect(event.requiresActiveJournalFor).toEqual({ sourceType: "goods_receipt_item", sourceId: "l", sourceEvent: "received" });
  });

  test("an item without its stock-ledger value is an issue (never guessed)", () => {
    const item = receipt("l", "2026-12-10", "HAURA-BEIGE-L", 6, { acceptedValue: null });
    const event = eventFor(events(batchOf({ receiptItems: [item] })), "goods_receipt_item", "l", "received");
    expect(event.outcome).toMatchObject({ kind: "issue", issueCode: "receipt_value_missing" });
  });
});

describe("R3 WIP close [D-15]", () => {
  test("normal completion: the ceil-rounding residue goes to 5-1201 Selisih biaya produksi (HPP)", () => {
    const all = events(batchOf({ receiptItems: fullReceipts(), receiptStatus: "received" }));
    const r3 = eventFor(all, "production_batch", "batch-1", "wip_close");
    expect(r3.sourceDate).toBe("2026-12-10");
    expect(24 * UNIT - TOTAL).toBe(5);
    expect(sides(r3.outcome)).toEqual(["Dr 1-1503 5", "Cr 5-1201 5"]);
  });

  test("Haura beige L: 12 planned, 6 made, batch short-closed → the missing pieces' cost goes to 6-4102", () => {
    const batch = batchOf({
      receiptItems: [receipt("m", "2026-12-10", "HAURA-BEIGE-M", 12), receipt("l", "2026-12-10", "HAURA-BEIGE-L", 6)],
      receiptStatus: "closed",
      closedAt: at("2026-12-15T07:00:00Z"),
    });
    const r3 = eventFor(events(batch), "production_batch", "batch-1", "wip_close");
    const rest = TOTAL - 18 * UNIT;
    expect(r3.sourceDate).toBe("2026-12-15");
    expect(sides(r3.outcome)).toEqual([`Dr 6-4102 ${rest}`, `Cr 1-1503 ${rest}`]);
    // The rest is the 6 missing pieces less the rounding on those received.
    expect(rest).toBe(6 * UNIT - 5);
    expect(planEvent(r3, 2, defaultContext()).kind).toBe("journal");
  });

  test("while the batch is still running there is no R3 (and a reopen un-posts it: outcome none)", () => {
    const running = events(batchOf({ receiptItems: [receipt("m", "2026-12-10", "HAURA-BEIGE-M", 12)], receiptStatus: "partially_received", closedAt: at("2026-12-15T07:00:00Z") }));
    expect(eventFor(running, "production_batch", "batch-1", "wip_close").outcome.kind).toBe("none");
  });

  test("a reversal after the close moves R3 to the reversal's date with the larger rest", () => {
    const item = receipt("l", "2026-12-10", "HAURA-BEIGE-L", 6);
    const batch = batchOf({
      receiptItems: [receipt("m", "2026-12-10", "HAURA-BEIGE-M", 12), item, reversalOf(item, "l-rev", "2026-12-20")],
      receiptStatus: "closed",
      closedAt: at("2026-12-15T07:00:00Z"),
    });
    const r3 = eventFor(events(batch), "production_batch", "batch-1", "wip_close");
    expect(r3.sourceDate).toBe("2026-12-20");
    expect(sides(r3.outcome)).toEqual([`Dr 6-4102 ${TOTAL - 12 * UNIT}`, `Cr 1-1503 ${TOTAL - 12 * UNIT}`]);
  });

  test("a batch that ended before the start posts no R3", () => {
    const all = events(batchOf({ postedAt: at("2026-11-01T03:00:00Z"), receiptItems: fullReceipts().map((item) => ({ ...item, receivedAt: "2026-11-10" })), receiptStatus: "received" }));
    expect(eventFor(all, "production_batch", "batch-1", "wip_close").outcome.kind).toBe("none");
  });

  test("a batch posted in November and closed in December settles its whole rest (the opening carries the November part)", () => {
    const batch = batchOf({ postedAt: at("2026-11-20T03:00:00Z"), receiptItems: fullReceipts(), receiptStatus: "received" });
    expect(sides(eventFor(events(batch), "production_batch", "batch-1", "wip_close").outcome)).toEqual(["Dr 1-1503 5", "Cr 5-1201 5"]);
  });

  test("WIP close is not a purchase-side source, so 5-1201/6-4102 pass the D-14 guard there", () => {
    const r3 = eventFor(events(batchOf({ receiptItems: fullReceipts(), receiptStatus: "received" })), "production_batch", "batch-1", "wip_close");
    expect(planEvent(r3, 2, defaultContext()).kind).toBe("journal");
  });
});

describe("R4 batch payments on the position rule", () => {
  test("a payment clears utang jasa produksi; cash credits Kas tunai for cash (D-17)", () => {
    const all = events(batchOf({ payments: [payment("p1", "2026-12-05", 500_000, { method: "cash" })] }));
    expect(sides(eventFor(all, "supplier_payment", "p1", "paid").outcome)).toEqual(["Dr 2-1102 500000", "Cr 1-1101 500000"]);
  });

  test("a payment without a payee clears 2-1103", () => {
    const all = events(batchOf({ payments: [payment("p1", "2026-12-05", 100_000, { supplierId: null, supplierName: null })] }));
    expect(sides(eventFor(all, "supplier_payment", "p1", "paid").outcome)).toEqual(["Dr 2-1103 100000", "Cr 1-1201 100000"]);
  });

  test("a DP dated before the batch was posted is an advance (1-1601), which R1 then uses before any utang", () => {
    const all = events(batchOf({ payments: [payment("dp", "2026-12-01", 300_000)] }));
    expect(sides(eventFor(all, "supplier_payment", "dp", "paid").outcome)).toEqual(["Dr 1-1601 300000", "Cr 1-1201 300000"]);
    expect(sides(eventFor(all, "production_batch", "batch-1", "posted").outcome)).toEqual([
      `Dr 1-1503 ${TOTAL}`,
      `Cr 1-1501 ${FABRIC}`,
      `Cr 1-1502 ${ACCESSORY}`,
      `Cr 2-1102 ${JAHIT - 300_000}`,
      "Cr 1-1601 300000",
      `Cr 2-1103 ${FINISHING}`,
    ]);
  });

  test("a void of a DP the batch already used turns the used part into utang (never a wrong-side balance)", () => {
    const dp = payment("dp", "2026-12-01", 300_000, { voidedAt: at("2026-12-06T03:00:00Z") });
    const all = events(batchOf({ payments: [dp] }));
    expect(sides(eventFor(all, "supplier_payment", "dp", "void").outcome)).toEqual(["Dr 1-1201 300000", "Cr 2-1102 300000"]);
  });

  test("a plain void is the exact negation of its payment", () => {
    const all = events(batchOf({ payments: [payment("p1", "2026-12-05", 200_000, { voidedAt: at("2026-12-06T03:00:00Z") })] }));
    expect(sides(eventFor(all, "supplier_payment", "p1", "void").outcome)).toEqual(["Dr 1-1201 200000", "Cr 2-1102 200000"]);
    expect(eventFor(all, "supplier_payment", "p1", "void").requiresActiveJournalFor).toEqual({ sourceType: "supplier_payment", sourceId: "p1", sourceEvent: "paid" });
  });

  test("an over-payment while the batch runs is an advance; when production ends it becomes a supplier claim (R3)", () => {
    const batch = batchOf({ payments: [payment("p1", "2026-12-05", JAHIT + 40_000)], receiptItems: fullReceipts(), receiptStatus: "received" });
    const all = events(batch);
    expect(sides(eventFor(all, "supplier_payment", "p1", "paid").outcome)).toEqual([`Dr 2-1102 ${JAHIT}`, "Dr 1-1601 40000", `Cr 1-1201 ${JAHIT + 40_000}`]);
    expect(sides(eventFor(all, "production_batch", "batch-1", "wip_close").outcome)).toEqual(["Dr 1-1503 5", "Dr 1-1402 40000", "Cr 5-1201 5", "Cr 1-1601 40000"]);
  });

  test("after every step no payee's balance sits on a wrong side, and the end balance equals bill − paid", () => {
    const dp = payment("dp", "2026-12-01", 300_000, { voidedAt: at("2026-12-06T03:00:00Z") });
    const batch = batchOf({
      payments: [dp, payment("p2", "2026-12-08", 700_000), payment("p3", "2026-12-20", 300_000), payment("p4", "2026-12-21", 50_000, { supplierId: null, supplierName: null })],
      receiptItems: fullReceipts(),
      receiptStatus: "received",
    });
    const all = events(batch).filter((event) => event.outcome.kind === "journal");
    const order = [...all].sort((a, b) => (a.sourceDate < b.sourceDate ? -1 : a.sourceDate > b.sourceDate ? 1 : 0));
    const balance: Record<string, number> = {};
    for (const event of order) {
      if (event.outcome.kind !== "journal") continue;
      for (const line of event.outcome.lines) {
        const key = `${line.accountCode}:${line.supplierId ?? ""}`;
        balance[key] = (balance[key] ?? 0) + line.debit - line.credit;
      }
      for (const [key, value] of Object.entries(balance)) {
        if (key.startsWith("2-110")) expect(value).toBeLessThanOrEqual(0);
        if (key.startsWith("1-1601") || key.startsWith("1-1402")) expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    // Tailor: 960.000 billed, 1.000.000 paid → claim 40.000 after the end. No payee: 100.000 − 50.000.
    expect(balance[`1-1402:${TAILOR}`]).toBe(40_000);
    expect(balance[`2-1102:${TAILOR}`] ?? 0).toBe(0);
    expect(balance["2-1103:"]).toBe(-50_000);
    expect(balance["1-1503:"]).toBe(0);
  });
});

describe("R5 defect returned to the tailor", () => {
  test("back into process (Dr 1-1503 / Cr 1-1506); its reversal mirrors it", () => {
    const out: ProductionDefectReturnSnapshot = { id: "d1", type: "return_out", reversesMovementId: null, occurredAt: "2026-12-11", createdAt: at("2026-12-11T03:00:00Z"), valueAmount: -UNIT, sku: "HAURA-BEIGE-L" };
    const back: ProductionDefectReturnSnapshot = { ...out, id: "d2", type: "reversal", reversesMovementId: "d1", occurredAt: "2026-12-12", valueAmount: UNIT };
    const all = events(batchOf({ defectReturns: [out, back] }));
    expect(sides(eventFor(all, "defect_movement", "d1", "return_out").outcome)).toEqual([`Dr 1-1503 ${UNIT}`, `Cr 1-1506 ${UNIT}`]);
    const reversal = eventFor(all, "defect_movement", "d2", "return_out");
    expect(sides(reversal.outcome)).toEqual([`Dr 1-1506 ${UNIT}`, `Cr 1-1503 ${UNIT}`]);
    expect(reversal.requiresActiveJournalFor).toEqual({ sourceType: "defect_movement", sourceId: "d1", sourceEvent: "return_out" });
  });

  test("a reject returned and replaced: WIP nets to the normal rounding residue", () => {
    const first = receipt("l1", "2026-12-10", "HAURA-BEIGE-L", 11, { qtyRejected: 1, rejectValue: UNIT });
    const out: ProductionDefectReturnSnapshot = { id: "d1", type: "return_out", reversesMovementId: null, occurredAt: "2026-12-11", createdAt: at("2026-12-11T03:00:00Z"), valueAmount: -UNIT, sku: "HAURA-BEIGE-L" };
    const batch = batchOf({
      receiptItems: [receipt("m", "2026-12-10", "HAURA-BEIGE-M", 12), first, receipt("l2", "2026-12-14", "HAURA-BEIGE-L", 1)],
      defectReturns: [out],
      receiptStatus: "received",
    });
    const r3 = eventFor(events(batch), "production_batch", "batch-1", "wip_close");
    expect(r3.sourceDate).toBe("2026-12-14");
    expect(sides(r3.outcome)).toEqual(["Dr 1-1503 5", "Cr 5-1201 5"]);
  });
});

describe("D-14 guard and WIP as of a date", () => {
  test("every R1, R2, R4 and R5 line is on a balance-sheet account; the guard finds nothing", () => {
    const context = defaultContext();
    const item = receipt("l", "2026-12-10", "HAURA-BEIGE-L", 5, { qtyRejected: 1, rejectValue: UNIT });
    const batch = batchOf({
      payments: [payment("dp", "2026-12-01", 300_000, { voidedAt: at("2026-12-06T03:00:00Z") }), payment("p2", "2026-12-08", 700_000)],
      receiptItems: [item, reversalOf(item, "l-rev", "2026-12-12")],
      defectReturns: [{ id: "d1", type: "return_out", reversesMovementId: null, occurredAt: "2026-12-11", createdAt: at("2026-12-11T03:00:00Z"), valueAmount: -UNIT, sku: "HAURA-BEIGE-L" }],
    });
    for (const event of productionChainEvents(batch, context)) {
      if (event.outcome.kind !== "journal" || event.key.sourceEvent === "wip_close") continue;
      expect(purchaseGuardViolations(event.key, event.outcome.lines, (code) => context.accounts.get(code)?.type)).toEqual([]);
      for (const line of event.outcome.lines) expect(["asset", "liability"]).toContain(context.accounts.get(line.accountCode)?.type);
    }
  });

  test("batchWipAsOf: cost until received, the rest before the end, 0 after it", () => {
    const batch = batchOf({ receiptItems: [receipt("m", "2026-12-10", "HAURA-BEIGE-M", 12), receipt("l", "2026-12-10", "HAURA-BEIGE-L", 6)], receiptStatus: "closed", closedAt: at("2026-12-15T07:00:00Z") });
    expect(batchWipAsOf(batch, "2026-12-01")).toBe(0);
    expect(batchWipAsOf(batch, "2026-12-05")).toBe(TOTAL);
    expect(batchWipAsOf(batch, "2026-12-12")).toBe(TOTAL - 18 * UNIT);
    expect(batchWipAsOf(batch, "2026-12-15")).toBe(0);
  });

  test("the rule is version 2 (supersedes the Session 2 batch-payment journals)", () => {
    expect(productionChainRule.ruleVersion).toBe(2);
    expect(productionChainRule.name).toBe("production_chain");
  });
});
