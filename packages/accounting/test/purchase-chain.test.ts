import { describe, expect, test } from "vitest";
import { planEvent } from "../src/plan";
import { purchaseGuardViolations } from "../src/purchase-guard";
import {
  purchaseChainEvents,
  replayPurchaseChain,
  stepKey,
  type ChainResult,
  type PurchaseDefectReturnSnapshot,
  type PurchaseDocumentSnapshot,
  type PurchasePaymentSnapshot,
  type PurchaseReceiptItemSnapshot,
} from "../src/rules/purchases";
import type { PostingEvent, PostingOutcome } from "../src/rules/types";
import { defaultContext } from "./context";

// The purchase document chain (docs/plans/accounting.md §4.4 P1-P6, Session 7): utang at receipt
// [D-13], DP → 1-1601 and auto-applied, receipt reversal returns the advance it used, overpaid close
// → 1-1402, debit note on a return to the supplier. Pure: snapshot → events.

const SUPPLIER = "00000000-0000-4000-8000-0000000000aa";
const at = (iso: string) => new Date(iso);

function documentOf(overrides: Partial<PurchaseDocumentSnapshot> = {}): PurchaseDocumentSnapshot {
  return {
    id: "purchase-1",
    purchaseNo: "PO-202612-001",
    supplierId: SUPPLIER,
    supplierName: "Toko Kain Laksmi",
    status: "partially_received",
    closedAt: null,
    receiptItems: [],
    payments: [],
    defectReturns: [],
    ...overrides,
  };
}

function receipt(id: string, receivedAt: string, value: number, extra: Partial<PurchaseReceiptItemSnapshot> = {}): PurchaseReceiptItemSnapshot {
  return {
    id,
    receiptNo: `GR-${id}`,
    kind: "receipt",
    receivedAt,
    createdAt: at(`${receivedAt}T03:00:00Z`),
    reversesItemId: null,
    itemType: "fabric",
    itemName: "Katun Jepang Hitam",
    qtyAccepted: 10,
    qtyRejected: 0,
    acceptedValue: value,
    rejectValue: null,
    ...extra,
  };
}

function reversalOf(original: PurchaseReceiptItemSnapshot, id: string, receivedAt: string): PurchaseReceiptItemSnapshot {
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

function payment(id: string, paidAt: string, amount: number, extra: Partial<PurchasePaymentSnapshot> = {}): PurchasePaymentSnapshot {
  return { id, paymentNo: `BYR-${id}`, paidAt, createdAt: at(`${paidAt}T05:00:00Z`), amount, method: "transfer", voidedAt: null, ...extra };
}

function returnOut(id: string, occurredAt: string, value: number): PurchaseDefectReturnSnapshot {
  return { id, type: "return_out", reversesMovementId: null, occurredAt, createdAt: at(`${occurredAt}T06:00:00Z`), valueAmount: -value, itemName: "Katun Jepang Hitam" };
}

const context = defaultContext();

function delta(chain: ChainResult, kind: Parameters<typeof stepKey>[0], id: string) {
  const step = chain.steps.get(stepKey(kind, id));
  if (!step) throw new Error(`no step ${kind}:${id}`);
  return step.delta;
}

function events(document: PurchaseDocumentSnapshot, ctx = context): PostingEvent[] {
  return purchaseChainEvents(document, ctx);
}

function find(list: PostingEvent[], sourceType: string, sourceId: string, sourceEvent: string): PostingEvent {
  const event = list.find((candidate) => candidate.key.sourceType === sourceType && candidate.key.sourceId === sourceId && candidate.key.sourceEvent === sourceEvent);
  if (!event) throw new Error(`no event ${sourceType}/${sourceId}/${sourceEvent}`);
  return event;
}

/** account → signed amount (debit positive). */
function net(outcome: PostingOutcome): Record<string, number> {
  if (outcome.kind !== "journal") throw new Error(`expected a journal, got ${outcome.kind}`);
  const totals: Record<string, number> = {};
  for (const line of outcome.lines) totals[line.accountCode] = (totals[line.accountCode] ?? 0) + line.debit - line.credit;
  return totals;
}

describe("purchase chain (P1-P6)", () => {
  test("P1 without any payment: Dr kain + Dr cacat / Cr utang for the whole value", () => {
    const item = receipt("r1", "2026-12-03", 600_000, { qtyRejected: 1, rejectValue: 60_000 });
    const list = events(documentOf({ receiptItems: [item] }));
    const p1 = find(list, "goods_receipt_item", "r1", "received");
    expect(p1.sourceDate).toBe("2026-12-03");
    expect(net(p1.outcome)).toEqual({ "1-1501": 600_000, "1-1506": 60_000, "2-1101": -660_000 });
    if (p1.outcome.kind !== "journal") throw new Error();
    expect(p1.outcome.lines.every((line) => line.supplierId === SUPPLIER)).toBe(true);
  });

  test("an accessory line debits 1-1502", () => {
    const list = events(documentOf({ receiptItems: [receipt("r1", "2026-12-03", 120_000, { itemType: "accessory", itemName: "Kancing" })] }));
    expect(net(find(list, "goods_receipt_item", "r1", "received").outcome)).toEqual({ "1-1502": 120_000, "2-1101": -120_000 });
  });

  test("a DP before the receipt builds 1-1601, which the receipt then uses first", () => {
    const list = events(
      documentOf({
        payments: [payment("p1", "2026-12-01", 400_000)],
        receiptItems: [receipt("r1", "2026-12-05", 1_000_000)],
      }),
    );
    expect(net(find(list, "supplier_payment", "p1", "paid").outcome)).toEqual({ "1-1601": 400_000, "1-1201": -400_000 });
    expect(net(find(list, "goods_receipt_item", "r1", "received").outcome)).toEqual({ "1-1501": 1_000_000, "1-1601": -400_000, "2-1101": -600_000 });
  });

  test("a payment after the receipt clears utang; more than is owed becomes an advance", () => {
    const list = events(
      documentOf({
        receiptItems: [receipt("r1", "2026-12-03", 600_000)],
        payments: [payment("p1", "2026-12-04", 500_000, { method: "cash" }), payment("p2", "2026-12-06", 300_000)],
      }),
    );
    expect(net(find(list, "supplier_payment", "p1", "paid").outcome)).toEqual({ "2-1101": 500_000, "1-1101": -500_000 });
    expect(net(find(list, "supplier_payment", "p2", "paid").outcome)).toEqual({ "2-1101": 100_000, "1-1601": 200_000, "1-1201": -300_000 });
  });

  test("partial receipts: the DP covers the first receipt in part, the second goes fully to utang", () => {
    const chain = replayPurchaseChain(
      documentOf({
        payments: [payment("p1", "2026-12-01", 500_000)],
        receiptItems: [receipt("r1", "2026-12-03", 300_000), receipt("r2", "2026-12-08", 700_000)],
      }),
    );
    expect(delta(chain, "receipt", "r1")).toEqual({ payable: 0, advance: -300_000, claim: 0 });
    expect(delta(chain, "receipt", "r2")).toEqual({ payable: 500_000, advance: -200_000, claim: 0 });
    expect(chain.state).toEqual({ net: 500_000, closed: false, advance: 0, payable: 500_000, claim: 0 });
  });

  test("same-day events are ordered by their own timestamp (DP recorded before the receipt vs after)", () => {
    const paymentFirst = replayPurchaseChain(
      documentOf({
        payments: [payment("p1", "2026-12-03", 200_000, { createdAt: at("2026-12-03T01:00:00Z") })],
        receiptItems: [receipt("r1", "2026-12-03", 500_000, { createdAt: at("2026-12-03T02:00:00Z") })],
      }),
    );
    expect(delta(paymentFirst, "payment", "p1")).toEqual({ payable: 0, advance: 200_000, claim: 0 });
    const receiptFirst = replayPurchaseChain(
      documentOf({
        payments: [payment("p1", "2026-12-03", 200_000, { createdAt: at("2026-12-03T04:00:00Z") })],
        receiptItems: [receipt("r1", "2026-12-03", 500_000, { createdAt: at("2026-12-03T02:00:00Z") })],
      }),
    );
    expect(delta(receiptFirst, "payment", "p1")).toEqual({ payable: -200_000, advance: 0, claim: 0 });
  });

  test("P2: a receipt reversal is the exact negation of P1 and returns the advance it used", () => {
    const original = receipt("r1", "2026-12-05", 1_000_000, { qtyRejected: 1, rejectValue: 100_000 });
    const document = documentOf({
      payments: [payment("p1", "2026-12-01", 400_000)],
      receiptItems: [original, reversalOf(original, "r1x", "2026-12-07")],
    });
    const list = events(document);
    const p1 = find(list, "goods_receipt_item", "r1", "received");
    const p2 = find(list, "goods_receipt_item", "r1x", "reversed");
    expect(p2.sourceDate).toBe("2026-12-07");
    expect(p2.requiresActiveJournalFor).toEqual({ sourceType: "goods_receipt_item", sourceId: "r1", sourceEvent: "received" });
    const negated = Object.fromEntries(Object.entries(net(p1.outcome)).map(([code, amount]) => [code, -amount]));
    expect(net(p2.outcome)).toEqual(negated);
    expect(replayPurchaseChain(document).state).toMatchObject({ advance: 400_000, payable: 0, claim: 0 });
    // Negations are emitted after every original (the runner needs the original active first).
    expect(list.indexOf(p2)).toBeGreaterThan(list.indexOf(p1));
  });

  test("P5: a purchase closed with advance left moves it to Piutang klaim pemasok; reopened → none", () => {
    const base = documentOf({
      payments: [payment("p1", "2026-12-01", 1_000_000)],
      receiptItems: [receipt("r1", "2026-12-05", 650_000)],
    });
    const closed = { ...base, status: "closed" as const, closedAt: at("2026-12-10T08:00:00Z") };
    const p5 = find(events(closed), "purchase", "purchase-1", "closed_overpaid");
    expect(p5.sourceDate).toBe("2026-12-10");
    expect(net(p5.outcome)).toEqual({ "1-1402": 350_000, "1-1601": -350_000 });
    expect(replayPurchaseChain(closed).state).toMatchObject({ advance: 0, payable: 0, claim: 350_000 });

    const reopened = { ...closed, status: "partially_received" as const };
    expect(find(events(reopened), "purchase", "purchase-1", "closed_overpaid").outcome).toEqual({ kind: "none" });
  });

  test("P5: a cancelled purchase with a DP and nothing received claims the whole DP; a closed purchase with no advance posts nothing", () => {
    const cancelled = documentOf({ status: "cancelled", closedAt: at("2026-12-09T08:00:00Z"), payments: [payment("p1", "2026-12-01", 250_000)] });
    expect(net(find(events(cancelled), "purchase", "purchase-1", "closed_overpaid").outcome)).toEqual({ "1-1402": 250_000, "1-1601": -250_000 });
    const settled = documentOf({ status: "closed", closedAt: at("2026-12-09T08:00:00Z"), receiptItems: [receipt("r1", "2026-12-03", 100_000)], payments: [payment("p1", "2026-12-04", 100_000)] });
    expect(find(events(settled), "purchase", "purchase-1", "closed_overpaid").outcome).toEqual({ kind: "none" });
  });

  test("a document never closed emits no P5 key at all", () => {
    expect(events(documentOf({ receiptItems: [receipt("r1", "2026-12-03", 100_000)] })).some((event) => event.key.sourceType === "purchase")).toBe(false);
  });

  test("P4: a voided payment posts the exact negation of P3, only while P3 is active", () => {
    const list = events(
      documentOf({
        receiptItems: [receipt("r1", "2026-12-03", 300_000)],
        payments: [payment("p1", "2026-12-04", 500_000, { voidedAt: at("2026-12-06T02:00:00Z") })],
      }),
    );
    const p3 = find(list, "supplier_payment", "p1", "paid");
    const p4 = find(list, "supplier_payment", "p1", "void");
    expect(net(p3.outcome)).toEqual({ "2-1101": 300_000, "1-1601": 200_000, "1-1201": -500_000 });
    expect(net(p4.outcome)).toEqual({ "2-1101": -300_000, "1-1601": -200_000, "1-1201": 500_000 });
    expect(p4.sourceDate).toBe("2026-12-06");
    expect(p4.requiresActiveJournalFor).toEqual({ sourceType: "supplier_payment", sourceId: "p1", sourceEvent: "paid" });
  });

  test("a voided payment no longer counts for later events", () => {
    const chain = replayPurchaseChain(
      documentOf({
        payments: [payment("p1", "2026-12-01", 500_000, { voidedAt: at("2026-12-02T02:00:00Z") })],
        receiptItems: [receipt("r1", "2026-12-03", 300_000)],
      }),
    );
    expect(delta(chain, "receipt", "r1")).toEqual({ payable: 300_000, advance: 0, claim: 0 });
  });

  test("P6: a return to the supplier is a debit note on utang; beyond the open utang it is an advance; its reversal negates it", () => {
    const back = returnOut("d1", "2026-12-08", 120_000);
    const reversal: PurchaseDefectReturnSnapshot = { ...back, id: "d1x", type: "reversal", reversesMovementId: "d1", occurredAt: "2026-12-09", createdAt: at("2026-12-09T06:00:00Z"), valueAmount: 120_000 };
    const list = events(
      documentOf({
        receiptItems: [receipt("r1", "2026-12-03", 500_000, { qtyRejected: 2, rejectValue: 120_000 })],
        payments: [payment("p1", "2026-12-04", 450_000)],
        defectReturns: [back, reversal],
      }),
    );
    const p6 = find(list, "defect_movement", "d1", "return_out");
    expect(net(p6.outcome)).toEqual({ "2-1101": 120_000, "1-1506": -120_000 });
    const p6x = find(list, "defect_movement", "d1x", "return_out");
    expect(net(p6x.outcome)).toEqual({ "2-1101": -120_000, "1-1506": 120_000 });
    expect(p6x.requiresActiveJournalFor).toEqual({ sourceType: "defect_movement", sourceId: "d1", sourceEvent: "return_out" });

    const paidUp = events(
      documentOf({
        receiptItems: [receipt("r1", "2026-12-03", 500_000, { qtyRejected: 2, rejectValue: 120_000 })],
        payments: [payment("p1", "2026-12-04", 620_000)],
        defectReturns: [back],
      }),
    );
    expect(net(find(paidUp, "defect_movement", "d1", "return_out").outcome)).toEqual({ "1-1601": 120_000, "1-1506": -120_000 });
  });

  test("a backdated receipt recorded later re-allocates an earlier payment (re-derived on the next run)", () => {
    const before = replayPurchaseChain(documentOf({ payments: [payment("p1", "2026-12-05", 300_000)] }));
    expect(delta(before, "payment", "p1")).toEqual({ payable: 0, advance: 300_000, claim: 0 });
    const after = replayPurchaseChain(
      documentOf({
        payments: [payment("p1", "2026-12-05", 300_000)],
        receiptItems: [receipt("r1", "2026-12-02", 300_000, { createdAt: at("2026-12-07T01:00:00Z") })],
      }),
    );
    expect(delta(after, "payment", "p1")).toEqual({ payable: -300_000, advance: 0, claim: 0 });
  });

  test("cut-over: a receipt before the posting start is not posted but its utang is still cleared by a later payment", () => {
    const list = events(
      documentOf({
        receiptItems: [receipt("r1", "2026-11-20", 800_000)],
        payments: [payment("p1", "2026-12-02", 800_000)],
      }),
    );
    expect(find(list, "goods_receipt_item", "r1", "received").outcome).toEqual({ kind: "none" });
    expect(net(find(list, "supplier_payment", "p1", "paid").outcome)).toEqual({ "2-1101": 800_000, "1-1201": -800_000 });
  });

  test("a receipt item with no value in the stock ledger blocks the chain: it and every later event become issues", () => {
    const list = events(
      documentOf({
        payments: [payment("p0", "2026-12-01", 100_000), payment("p1", "2026-12-04", 100_000)],
        receiptItems: [receipt("r1", "2026-12-03", 0, { acceptedValue: null })],
      }),
    );
    expect(find(list, "supplier_payment", "p0", "paid").outcome.kind).toBe("journal");
    expect(find(list, "goods_receipt_item", "r1", "received").outcome).toMatchObject({ kind: "issue", issueCode: "receipt_value_missing" });
    expect(find(list, "supplier_payment", "p1", "paid").outcome).toMatchObject({ kind: "issue", issueCode: "receipt_value_missing" });
  });

  test("a zero-value receipt (a free line) posts nothing", () => {
    expect(find(events(documentOf({ receiptItems: [receipt("r1", "2026-12-03", 0)] })), "goods_receipt_item", "r1", "received").outcome).toEqual({ kind: "none" });
  });

  test("an unmapped utang account is a posting issue, never a guess", () => {
    const ctx = defaultContext({ mappings: { "supplier_payable.kind.material": null } });
    const list = events(documentOf({ receiptItems: [receipt("r1", "2026-12-03", 100_000)] }), ctx);
    expect(find(list, "goods_receipt_item", "r1", "received").outcome).toMatchObject({ kind: "issue", issueCode: "unmapped_supplier_payable" });
  });

  describe("position rule (owner, 26 Nov 2026): each document's balance sits on one account, never a wrong side", () => {
    /** The document's running balance per position account after each posted journal, in chain
     * order (normal side positive: 2-1101 credit, 1-1601 and 1-1402 debit). */
    function runningBalances(document: PurchaseDocumentSnapshot): { payable: number; advance: number; claim: number }[] {
      const list = events(document);
      const chain = replayPurchaseChain(document);
      // Order the posted journals the way the chain replayed them.
      const order = [...chain.steps.keys()];
      const keyOf = (event: PostingEvent): string => {
        const { sourceType, sourceId, sourceEvent } = event.key;
        if (sourceType === "goods_receipt_item") return stepKey(sourceEvent === "received" ? "receipt" : "receipt_reversal", sourceId);
        if (sourceType === "supplier_payment") return stepKey(sourceEvent === "paid" ? "payment" : "payment_void", sourceId);
        if (sourceType === "purchase") return stepKey("close", sourceId);
        const movement = document.defectReturns.find((candidate) => candidate.id === sourceId)!;
        return stepKey(movement.type === "return_out" ? "return" : "return_reversal", sourceId);
      };
      const sorted = list.filter((event) => event.outcome.kind === "journal").sort((a, b) => order.indexOf(keyOf(a)) - order.indexOf(keyOf(b)));
      const balance = { payable: 0, advance: 0, claim: 0 };
      const history: (typeof balance)[] = [];
      for (const event of sorted) {
        const totals = net(event.outcome);
        balance.payable -= totals["2-1101"] ?? 0;
        balance.advance += totals["1-1601"] ?? 0;
        balance.claim += totals["1-1402"] ?? 0;
        history.push({ ...balance });
      }
      return history;
    }

    function expectNeverWrongSide(document: PurchaseDocumentSnapshot) {
      for (const balance of runningBalances(document)) {
        expect(balance.payable).toBeGreaterThanOrEqual(0);
        expect(balance.advance).toBeGreaterThanOrEqual(0);
        expect(balance.claim).toBeGreaterThanOrEqual(0);
        // At most one of them is non-zero.
        expect([balance.payable, balance.advance, balance.claim].filter((amount) => amount !== 0).length).toBeLessThanOrEqual(1);
      }
    }

    test("a DP voided after a receipt used it: the used part becomes utang, never a negative advance", () => {
      const document = documentOf({
        payments: [payment("p1", "2026-12-01", 500_000, { voidedAt: at("2026-12-05T03:00:00Z") })],
        receiptItems: [receipt("r1", "2026-12-03", 300_000)],
      });
      const list = events(document);
      expect(net(find(list, "supplier_payment", "p1", "paid").outcome)).toEqual({ "1-1601": 500_000, "1-1201": -500_000 });
      expect(net(find(list, "goods_receipt_item", "r1", "received").outcome)).toEqual({ "1-1501": 300_000, "1-1601": -300_000 });
      // The void: the cash comes back, the 200.000 advance left is cleared, the 300.000 the receipt used is now owed.
      expect(net(find(list, "supplier_payment", "p1", "void").outcome)).toEqual({ "1-1201": 500_000, "1-1601": -200_000, "2-1101": -300_000 });
      expect(replayPurchaseChain(document).state).toMatchObject({ payable: 300_000, advance: 0, claim: 0 });
      expectNeverWrongSide(document);
    });

    test("a receipt reversed after it was paid: the payment becomes an advance, never a debit balance on utang", () => {
      const original = receipt("r1", "2026-12-03", 300_000);
      const document = documentOf({
        receiptItems: [original, reversalOf(original, "r1x", "2026-12-08")],
        payments: [payment("p1", "2026-12-05", 300_000)],
      });
      const list = events(document);
      expect(net(find(list, "supplier_payment", "p1", "paid").outcome)).toEqual({ "2-1101": 300_000, "1-1201": -300_000 });
      expect(net(find(list, "goods_receipt_item", "r1x", "reversed").outcome)).toEqual({ "1-1501": -300_000, "1-1601": 300_000 });
      expect(replayPurchaseChain(document).state).toMatchObject({ payable: 0, advance: 300_000 });
      expectNeverWrongSide(document);
    });

    test("a return on paid goods is an advance; the replacement receipt uses it; reversing the return takes it back", () => {
      const back = returnOut("d1", "2026-12-08", 100_000);
      const document = documentOf({
        receiptItems: [receipt("r1", "2026-12-03", 400_000, { qtyRejected: 2, rejectValue: 100_000 }), receipt("r2", "2026-12-12", 100_000)],
        payments: [payment("p1", "2026-12-04", 500_000)],
        defectReturns: [back],
      });
      const list = events(document);
      expect(net(find(list, "defect_movement", "d1", "return_out").outcome)).toEqual({ "1-1601": 100_000, "1-1506": -100_000 });
      expect(net(find(list, "goods_receipt_item", "r2", "received").outcome)).toEqual({ "1-1501": 100_000, "1-1601": -100_000 });
      expect(replayPurchaseChain(document).state).toMatchObject({ net: 0, payable: 0, advance: 0, claim: 0 });
      expectNeverWrongSide(document);

      const undone = documentOf({
        ...document,
        receiptItems: [document.receiptItems[0]!],
        defectReturns: [back, { ...back, id: "d1x", type: "reversal", reversesMovementId: "d1", occurredAt: "2026-12-09", createdAt: at("2026-12-09T06:00:00Z"), valueAmount: 100_000 }],
      });
      expect(net(find(events(undone), "defect_movement", "d1x", "return_out").outcome)).toEqual({ "1-1506": 100_000, "1-1601": -100_000 });
      expectNeverWrongSide(undone);
    });

    test("close and reopen with an over-payment: 1-1601 → 1-1402 at the close; reopened, later events stay on 1-1601", () => {
      const base = documentOf({
        payments: [payment("p1", "2026-12-01", 1_000_000)],
        receiptItems: [receipt("r1", "2026-12-04", 600_000)],
      });
      const closed = { ...base, status: "closed" as const, closedAt: at("2026-12-10T03:00:00Z") };
      const closedEvents = events(closed);
      expect(net(find(closedEvents, "purchase", "purchase-1", "closed_overpaid").outcome)).toEqual({ "1-1402": 400_000, "1-1601": -400_000 });
      expectNeverWrongSide(closed);

      // A payment voided after the close: the claim shrinks; past it, utang. Never a negative claim.
      const voidedAfterClose = {
        ...closed,
        payments: [payment("p1", "2026-12-01", 1_000_000), payment("p2", "2026-12-02", 100_000, { voidedAt: at("2026-12-12T03:00:00Z") })],
      };
      expect(net(find(events(voidedAfterClose), "supplier_payment", "p2", "void").outcome)).toEqual({ "1-1201": 100_000, "1-1402": -100_000 });
      expectNeverWrongSide(voidedAfterClose);

      // Reopened (a return to the supplier re-opens it): P5 is un-posted, the advance stays on 1-1601.
      const reopened = { ...closed, status: "partially_received" as const, defectReturns: [] };
      expect(find(events(reopened), "purchase", "purchase-1", "closed_overpaid").outcome).toEqual({ kind: "none" });
      expect(replayPurchaseChain(reopened).state).toMatchObject({ advance: 400_000, claim: 0 });
      expectNeverWrongSide(reopened);
    });

    test("random-ish sequences never leave a wrong-side balance", () => {
      const original = receipt("r1", "2026-12-03", 700_000, { qtyRejected: 1, rejectValue: 70_000 });
      const sequences: PurchaseDocumentSnapshot[] = [
        documentOf({ payments: [payment("p1", "2026-12-01", 300_000), payment("p2", "2026-12-06", 800_000, { voidedAt: at("2026-12-09T00:00:00Z") })], receiptItems: [original, reversalOf(original, "r1x", "2026-12-07")] }),
        documentOf({ status: "cancelled", closedAt: at("2026-12-15T00:00:00Z"), payments: [payment("p1", "2026-12-01", 250_000, { voidedAt: at("2026-12-20T00:00:00Z") })] }),
        documentOf({ payments: [payment("p1", "2026-12-02", 770_000)], receiptItems: [original], defectReturns: [returnOut("d1", "2026-12-05", 70_000)] }),
      ];
      for (const document of sequences) expectNeverWrongSide(document);
    });
  });

  describe("ledger-side D-14 guard: purchase-side journals never touch an expense", () => {
    const original = receipt("r1", "2026-12-05", 1_000_000, { qtyRejected: 1, rejectValue: 100_000 });
    const scenarios: PurchaseDocumentSnapshot[] = [
      documentOf({ receiptItems: [original] }),
      documentOf({ payments: [payment("p1", "2026-12-01", 2_000_000, { voidedAt: at("2026-12-20T00:00:00Z") })], receiptItems: [original] }),
      documentOf({ payments: [payment("p1", "2026-12-01", 400_000, { method: "cash" })], receiptItems: [original, reversalOf(original, "r1x", "2026-12-07")] }),
      documentOf({
        status: "closed",
        closedAt: at("2026-12-15T00:00:00Z"),
        payments: [payment("p1", "2026-12-01", 2_000_000)],
        receiptItems: [original, receipt("r2", "2026-12-06", 50_000, { itemType: "accessory" })],
        defectReturns: [returnOut("d1", "2026-12-08", 100_000)],
      }),
    ];
    // Allowed: cash & bank (1-11xx/1-12xx), receivables (1-14xx), inventory (1-15xx), advances
    // (1-16xx), supplier payables (2-11xx).
    const allowed = /^(1-1[12456]\d{2}|2-11\d{2})$/;
    test.each(scenarios.map((scenario, index) => [index, scenario] as const))("scenario %i", (_index, scenario) => {
      for (const event of events(scenario)) {
        if (event.outcome.kind !== "journal") continue;
        for (const line of event.outcome.lines) expect(line.accountCode).toMatch(allowed);
        expect(purchaseGuardViolations(event.key, event.outcome.lines, (code) => context.accounts.get(code)?.type)).toEqual([]);
        // Every journal is balanced and postable as planned.
        expect(planEvent(event, 2, context).kind).toBe("journal");
      }
    });
  });
});
