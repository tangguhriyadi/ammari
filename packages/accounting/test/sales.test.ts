import { describe, expect, test } from "vitest";
import { comparableActiveHash, planEvent } from "../src/plan";
import { mdrRule, midtransSettlementRule, type MdrFeeSnapshot } from "../src/rules/midtrans";
import { salesEvents, type OrderPaymentSnapshot, type OrderSnapshot } from "../src/rules/sales";
import { orderAccountMovements } from "../src/sales-balances";
import type { PostingEvent, PostingOutcome } from "../src/rules/types";
import { defaultContext } from "./context";

// Sales, Session 9 (docs/plans/accounting.md §4.1-§4.3): S1-S6, W1, W3, W4, W6-W10, M1, M2, and the
// W2/W5 rule code against fixture rows shaped like fee work A/B. Per channel × status path.

const at = (iso: string) => new Date(iso);

function sides(outcome: PostingOutcome | undefined): string[] {
  if (!outcome || outcome.kind !== "journal") throw new Error(`expected a journal, got ${JSON.stringify(outcome)}`);
  return outcome.lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`));
}

function find(events: PostingEvent[], sourceType: string, sourceEvent: string, sourceId?: string): PostingEvent {
  const event = events.find((e) => e.key.sourceType === sourceType && e.key.sourceEvent === sourceEvent && (sourceId === undefined || e.key.sourceId === sourceId));
  if (!event) throw new Error(`no ${sourceType}/${sourceEvent} in ${JSON.stringify(events.map((e) => e.key))}`);
  return event;
}

const keys = (events: PostingEvent[]) => events.map((e) => `${e.key.sourceType}:${e.key.sourceEvent}`);

/** Every journal must pass the runner's validation (balanced, postable accounts, no guard hit). */
function expectAllPostable(events: PostingEvent[]) {
  const context = defaultContext();
  for (const event of events) {
    if (event.outcome.kind !== "journal") continue;
    const planned = planEvent(event, 1, context);
    expect(planned.kind, JSON.stringify({ key: event.key, planned })).toBe("journal");
  }
}

/** Σ (debit − credit) per account over the journal outcomes. */
function net(events: PostingEvent[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const event of events) {
    if (event.outcome.kind !== "journal") continue;
    for (const line of event.outcome.lines) totals.set(line.accountCode, (totals.get(line.accountCode) ?? 0) + line.debit - line.credit);
  }
  return totals;
}

function payment(overrides: Partial<OrderPaymentSnapshot> = {}): OrderPaymentSnapshot {
  return {
    id: "pay-1",
    providerOrderId: "AMR-ORD-1-1",
    status: "paid",
    grossAmount: 264_000,
    paidAt: at("2026-12-03T02:00:00Z"),
    refundedAmount: 0,
    updatedAt: at("2026-12-03T02:00:00Z"),
    gatewayRefundSeenAt: null,
    chargebackSeenAt: null,
    manualRefund: null,
    ...overrides,
  };
}

/** A web checkout order: 2 pcs at 135.000 less a 20.000 voucher, quoted courier 24.000 of which
 * Ammari subsidises 10.000, so the buyer pays 14.000. HPP 87.917 + 87.917 at to_ship. */
function webOrder(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: "ord-web",
    orderNo: "ORD-202612-0001",
    channelId: "web",
    status: "completed",
    paymentStatus: "paid",
    subtotalAmount: 270_000,
    shippingAmount: 14_000,
    discountAmount: 20_000,
    totalAmount: 264_000,
    shippingSubsidyAmount: 10_000,
    shippedAt: at("2026-12-05T04:00:00Z"),
    cancelledAt: null,
    returnedAt: null,
    marketplaceShippedAt: null,
    manualPayment: null,
    movements: [
      { id: "sm-1", type: "sale", sku: "HAURA-M", valueAmount: -87_917, createdAt: at("2026-12-03T02:00:01Z") },
      { id: "sm-2", type: "sale", sku: "HAURA-L", valueAmount: -87_917, createdAt: at("2026-12-03T02:00:01Z") },
    ],
    payments: [payment()],
    shipments: [{ id: "shp-1", attempt: 1, status: "delivered", costAmount: 25_000, bookedAt: at("2026-12-04T09:00:00Z"), cancelledAt: null }],
    fees: [],
    ...overrides,
  };
}

function manualOrder(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    ...webOrder(),
    id: "ord-wa",
    orderNo: "ORD-202612-0002",
    channelId: "whatsapp",
    paymentStatus: null,
    shippingAmount: 15_000,
    discountAmount: 0,
    totalAmount: 285_000,
    shippingSubsidyAmount: null,
    payments: [],
    shipments: [],
    manualPayment: { method: "transfer", cashAccountCode: "1-1201", paidOn: "2026-12-02" },
    ...overrides,
  };
}

function shopeeOrder(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    ...webOrder(),
    id: "ord-shopee",
    orderNo: "ORD-202612-0003",
    channelId: "shopee",
    paymentStatus: null,
    shippingAmount: 0,
    discountAmount: 5_000,
    totalAmount: 265_000,
    shippingSubsidyAmount: null,
    payments: [],
    shipments: [],
    marketplaceShippedAt: at("2026-12-04T08:00:00Z"),
    fees: [
      { component: "admin_fee", amount: 21_600 },
      { component: "service_fee", amount: 10_800 },
      { component: "seller_shipping_subsidy", amount: 3_000 },
    ],
    ...overrides,
  };
}

describe("web checkout: paid → to_ship → shipped → completed", () => {
  const events = salesEvents(webOrder(), defaultContext());

  test("W1 on paid_at: Dr 1-1301 Piutang Midtrans / Cr 2-1201 Uang muka pelanggan", () => {
    const w1 = find(events, "payment", "paid");
    expect(w1.sourceDate).toBe("2026-12-03");
    expect(sides(w1.outcome)).toEqual(["Dr 1-1301 264000", "Cr 2-1201 264000"]);
  });

  test("S1 on the sale movement: Dr 1-1505 / Cr 1-1504 per movement", () => {
    expect(sides(find(events, "stock_movement", "sale", "sm-1").outcome)).toEqual(["Dr 1-1505 87917", "Cr 1-1504 87917"]);
  });

  test("S3 on shipped_at [D-1]: voucher is Potongan penjualan [D-4], buyer ongkir is Titipan [D-6], HPP out of 1-1505", () => {
    const s3 = find(events, "order", "recognised");
    expect(s3.sourceDate).toBe("2026-12-05");
    expect(sides(s3.outcome)).toEqual(["Dr 2-1201 264000", "Dr 4-1201 20000", "Dr 5-1101 175834", "Cr 4-1101 270000", "Cr 2-1203 14000", "Cr 1-1505 175834"]);
  });

  test("W9 on booked_at [D-10]: titipan used up, subsidy to 6-1302, the courier above the quote to 6-1301, Cr 1-1603", () => {
    const w9 = find(events, "shipment", "charged");
    expect(w9.sourceDate).toBe("2026-12-04");
    expect(sides(w9.outcome)).toEqual(["Dr 2-1203 14000", "Dr 6-1302 10000", "Dr 6-1301 1000", "Cr 1-1603 25000"]);
  });

  test("W9: a courier cheaper than the quote credits 6-1301", () => {
    const cheaper = salesEvents(webOrder({ shipments: [{ id: "shp-1", attempt: 1, status: "delivered", costAmount: 22_000, bookedAt: at("2026-12-04T09:00:00Z"), cancelledAt: null }] }), defaultContext());
    expect(sides(find(cheaper, "shipment", "charged").outcome)).toEqual(["Dr 2-1203 14000", "Dr 6-1302 10000", "Cr 6-1301 2000", "Cr 1-1603 22000"]);
  });

  test("after the whole path 1-1505, 2-1201 and 2-1203 are 0, every line carries the order", () => {
    const totals = net(events);
    expect(totals.get("1-1505")).toBe(0);
    expect(totals.get("2-1201")).toBe(0);
    expect(totals.get("2-1203")).toBe(0);
    expect(totals.get("1-1301")).toBe(264_000);
    expectAllPostable(events);
    for (const event of events) if (event.outcome.kind === "journal") for (const line of event.outcome.lines) expect(line.orderId).toBe("ord-web");
  });

  test("HPP is the sale movements' exact value, never Σ qty × rounded unit_cost", () => {
    const odd = salesEvents(webOrder({ movements: [{ id: "sm-1", type: "sale", sku: "X", valueAmount: -100_001, createdAt: at("2026-12-03T02:00:01Z") }] }), defaultContext());
    expect(sides(find(odd, "order", "recognised").outcome)).toContain("Cr 1-1505 100001");
    expect(net(odd).get("1-1505")).toBe(0);
  });

  test("W10: a charged booking cancelled is the exact negation, posted only while W9 is active", () => {
    const order = webOrder({
      shipments: [
        { id: "shp-1", attempt: 1, status: "cancelled", costAmount: 25_000, bookedAt: at("2026-12-04T09:00:00Z"), cancelledAt: at("2026-12-04T10:00:00Z") },
        { id: "shp-2", attempt: 2, status: "delivered", costAmount: 24_000, bookedAt: at("2026-12-04T11:00:00Z"), cancelledAt: null },
      ],
    });
    const all = salesEvents(order, defaultContext());
    const w10 = find(all, "shipment", "cancelled", "shp-1");
    // The exact negation, line for line.
    expect(sides(w10.outcome)).toEqual(["Cr 2-1203 14000", "Cr 6-1302 10000", "Cr 6-1301 1000", "Dr 1-1603 25000"]);
    expect(w10.requiresActiveJournalFor).toEqual({ sourceType: "shipment", sourceId: "shp-1", sourceEvent: "charged" });
    expect(w10.requiresActiveJournalAcrossBooks).toBeUndefined();
    expect(net(all).get("1-1603")).toBe(-24_000);
    expect(net(all).get("2-1203")).toBe(0);
  });

  test("a booking without a known cost posts nothing", () => {
    const unknown = salesEvents(webOrder({ shipments: [{ id: "shp-1", attempt: 1, status: "booking", costAmount: null, bookedAt: at("2026-12-04T09:00:00Z"), cancelledAt: null }] }), defaultContext());
    expect(keys(unknown)).not.toContain("shipment:charged");
  });
});

describe("web checkout: paid → cancelled → refunded [D-9]", () => {
  const cancelled = webOrder({
    status: "cancelled",
    paymentStatus: "refunded",
    shippedAt: null,
    cancelledAt: at("2026-12-04T03:00:00Z"),
    movements: [
      ...webOrder().movements,
      { id: "sm-3", type: "return", sku: "HAURA-M", valueAmount: 87_917, createdAt: at("2026-12-04T03:00:00Z") },
      { id: "sm-4", type: "return", sku: "HAURA-L", valueAmount: 87_917, createdAt: at("2026-12-04T03:00:00Z") },
    ],
    payments: [payment({ status: "refunded", refundedAmount: 264_000, updatedAt: at("2026-12-06T05:00:00Z"), manualRefund: { amount: 264_000, recordedAt: at("2026-12-06T05:00:00Z") } })],
    shipments: [],
  });
  const events = salesEvents(cancelled, defaultContext());

  test("S2 before shipping: Dr 1-1504 / Cr 1-1505", () => {
    expect(sides(find(events, "stock_movement", "return", "sm-3").outcome)).toEqual(["Dr 1-1504 87917", "Cr 1-1505 87917"]);
  });

  test("W3 on cancelled_at: the deposit moves to Utang pengembalian dana", () => {
    const w3 = find(events, "order", "cancelled_paid");
    expect(w3.sourceDate).toBe("2026-12-04");
    expect(sides(w3.outcome)).toEqual(["Dr 2-1201 264000", "Cr 2-1202 264000"]);
  });

  test("W4 manual refund on the audit row's date: Dr 2-1202 / Cr 1-1201 Bank utama", () => {
    const w4 = find(events, "payment", "refunded");
    expect(w4.sourceDate).toBe("2026-12-06");
    expect(sides(w4.outcome)).toEqual(["Dr 2-1202 264000", "Cr 1-1201 264000"]);
  });

  test("no recognition, no gateway refund; every customer account ends at 0", () => {
    expect(keys(events)).not.toContain("order:recognised");
    // Emitted as "none" (no gateway refund), so a stale journal for it would be reversed.
    expect(find(events, "payment", "gateway_refunded").outcome.kind).toBe("none");
    const totals = net(events);
    for (const code of ["1-1505", "2-1201", "2-1202"]) expect(totals.get(code) ?? 0).toBe(0);
    expect(totals.get("1-1504")).toBe(0);
    expectAllPostable(events);
  });

  test("a payment that arrives after the cancel is owed back from the start (Cr 2-1202), and not in W3", () => {
    const late = webOrder({
      status: "cancelled",
      paymentStatus: "paid",
      shippedAt: null,
      cancelledAt: at("2026-12-02T03:00:00Z"),
      movements: [],
      payments: [payment({ paidAt: at("2026-12-02T05:00:00Z") })],
      shipments: [],
    });
    const lateEvents = salesEvents(late, defaultContext());
    expect(sides(find(lateEvents, "payment", "paid").outcome)).toEqual(["Dr 1-1301 264000", "Cr 2-1202 264000"]);
    expect(find(lateEvents, "order", "cancelled_paid").outcome.kind).toBe("none");
  });

  test("a gateway partial refund then the rest by hand: two keys, Cr 1-1301 and Cr 1-1201, the date of the gateway part follows its journal", () => {
    const split = webOrder({
      ...cancelled,
      payments: [payment({ status: "refunded", refundedAmount: 264_000, updatedAt: at("2026-12-07T05:00:00Z"), manualRefund: { amount: 164_000, recordedAt: at("2026-12-07T05:00:00Z") } })],
    });
    const splitEvents = salesEvents(split, defaultContext());
    expect(sides(find(splitEvents, "payment", "gateway_refunded").outcome)).toEqual(["Dr 2-1202 100000", "Cr 1-1301 100000"]);
    expect(find(splitEvents, "payment", "gateway_refunded").dateFollowsActive).toBe(true);
    expect(sides(find(splitEvents, "payment", "refunded").outcome)).toEqual(["Dr 2-1202 164000", "Cr 1-1201 164000"]);
  });

  test("a refunded duplicate payment of an order going ahead comes out of the deposit", () => {
    const duplicate = webOrder({
      payments: [payment(), payment({ id: "pay-2", providerOrderId: "AMR-ORD-1-2", status: "refunded", refundedAmount: 264_000, manualRefund: { amount: 264_000, recordedAt: at("2026-12-04T01:00:00Z") } })],
    });
    const dupEvents = salesEvents(duplicate, defaultContext());
    expect(sides(find(dupEvents, "payment", "refunded", "pay-2").outcome)).toEqual(["Dr 2-1201 264000", "Cr 1-1201 264000"]);
    expect(net(dupEvents).get("2-1201")).toBe(0);
  });

  test("the gateway part is dated by its first verified notification, not by updated_at (which later reads bump)", () => {
    const refunded = (updatedAt: string, seen: string | null) =>
      webOrder({
        ...cancelled,
        payments: [payment({ status: "refunded", refundedAmount: 264_000, updatedAt: at(updatedAt), gatewayRefundSeenAt: seen ? at(seen) : null })],
      });
    const event = find(salesEvents(refunded("2026-12-20T00:00:00Z", "2026-12-06T05:00:00Z"), defaultContext()), "payment", "gateway_refunded");
    expect(event.sourceDate).toBe("2026-12-06");
    expect(event.dateFollowsActive).toBeUndefined();
    // Refunded before the cut-over, polled again in December: still nothing (opening balances).
    const old = webOrder({
      ...cancelled,
      cancelledAt: at("2026-11-10T00:00:00Z"),
      payments: [payment({ paidAt: at("2026-11-05T00:00:00Z"), status: "refunded", refundedAmount: 264_000, updatedAt: at("2026-12-05T00:00:00Z"), gatewayRefundSeenAt: at("2026-11-20T00:00:00Z") })],
    });
    expect(find(salesEvents(old, defaultContext()), "payment", "gateway_refunded").outcome.kind).toBe("none");
  });

  test("a cancel whose deposit is gone (refunded before the cancel) emits none, so an earlier W3 is reversed", () => {
    const refundedFirst = webOrder({
      ...cancelled,
      payments: [payment({ status: "refunded", refundedAmount: 264_000, manualRefund: { amount: 264_000, recordedAt: at("2026-12-04T01:00:00Z") } })],
    });
    expect(find(salesEvents(refundedFirst, defaultContext()), "order", "cancelled_paid").outcome.kind).toBe("none");
  });

  test("a chargeback carries no amount: the issue payment_chargeback", () => {
    const charged = salesEvents(webOrder({ payments: [payment({ status: "chargeback", updatedAt: at("2026-12-09T00:00:00Z") })] }), defaultContext());
    expect(find(charged, "payment", "chargeback").outcome).toMatchObject({ kind: "issue", issueCode: "payment_chargeback" });
  });
});

describe("shipped → returned [D-7]", () => {
  const returned = webOrder({
    status: "returned",
    returnedAt: at("2026-12-10T03:00:00Z"),
    movements: [
      ...webOrder().movements,
      { id: "sm-3", type: "return", sku: "HAURA-M", valueAmount: 87_917, createdAt: at("2026-12-10T03:00:00Z") },
      { id: "sm-4", type: "return", sku: "HAURA-L", valueAmount: 87_917, createdAt: at("2026-12-10T03:00:00Z") },
    ],
  });
  const events = salesEvents(returned, defaultContext());

  test("S2 after shipping: goods back at the original cost, Dr 1-1504 / Cr 5-1101 HPP", () => {
    expect(sides(find(events, "stock_movement", "return", "sm-3").outcome)).toEqual(["Dr 1-1504 87917", "Cr 5-1101 87917"]);
  });

  test("S4 on returned_at: Retur penjualan, refunded ongkir to Beban ongkos kirim, voucher reversed, refund liability", () => {
    const s4 = find(events, "order", "returned");
    expect(s4.sourceDate).toBe("2026-12-10");
    expect(sides(s4.outcome)).toEqual(["Dr 4-1301 270000", "Dr 6-1301 14000", "Cr 4-1201 20000", "Cr 2-1202 264000"]);
    expect(s4.requiresActiveJournalFor).toBeUndefined();
  });

  test("HPP nets to 0 and the stock is back", () => {
    const totals = net(events);
    expect(totals.get("5-1101")).toBe(0);
    expect(totals.get("1-1504")).toBe(0);
    expectAllPostable(events);
  });

  test("a return of an order shipped before the cut-over still posts (a real event of its own)", () => {
    const old = webOrder({
      ...returned,
      shippedAt: at("2026-11-20T03:00:00Z"),
      payments: [payment({ paidAt: at("2026-11-18T02:00:00Z") })],
      movements: returned.movements.map((m) => (m.type === "sale" ? { ...m, createdAt: at("2026-11-18T02:00:00Z") } : m)),
      shipments: [],
    });
    const oldEvents = salesEvents(old, defaultContext());
    expect(find(oldEvents, "order", "recognised").outcome.kind).toBe("none");
    expect(sides(find(oldEvents, "order", "returned").outcome)).toContain("Cr 2-1202 264000");
    expect(sides(find(oldEvents, "stock_movement", "return", "sm-3").outcome)).toEqual(["Dr 1-1504 87917", "Cr 5-1101 87917"]);
  });
});

describe("manual order (S6) [D-3]", () => {
  test("S6 on paid_on into the account staff picked, then S3 on the ship date: two journals through 2-1201", () => {
    const events = salesEvents(manualOrder(), defaultContext());
    const s6 = find(events, "order", "collected");
    expect(s6.sourceDate).toBe("2026-12-02");
    expect(sides(s6.outcome)).toEqual(["Dr 1-1201 285000", "Cr 2-1201 285000"]);
    expect(s6.outcome.kind === "journal" && s6.outcome.lines[0]?.cashAccountCode).toBe("1-1201");
    const s3 = find(events, "order", "recognised");
    expect(s3.sourceDate).toBe("2026-12-05");
    expect(sides(s3.outcome)).toEqual(["Dr 2-1201 285000", "Dr 5-1101 175834", "Cr 4-1105 270000", "Cr 2-1203 15000", "Cr 1-1505 175834"]);
    expect(net(events).get("2-1201")).toBe(0);
    expectAllPostable(events);
  });

  test("cash paid straight into the bank: the account choice is free; card (debit) recorded as Bank utama [D-18]", () => {
    const cash = salesEvents(manualOrder({ manualPayment: { method: "cash", cashAccountCode: "1-1201", paidOn: "2026-12-02" } }), defaultContext());
    expect(sides(find(cash, "order", "collected").outcome)[0]).toBe("Dr 1-1201 285000");
    const kas = salesEvents(manualOrder({ manualPayment: { method: "cash", cashAccountCode: "1-1101", paidOn: "2026-12-02" } }), defaultContext());
    expect(sides(find(kas, "order", "collected").outcome)[0]).toBe("Dr 1-1101 285000");
  });

  test("no payment record → manual_payment_missing, never a default account", () => {
    const events = salesEvents(manualOrder({ manualPayment: null }), defaultContext());
    expect(find(events, "order", "collected").outcome).toMatchObject({ kind: "issue", issueCode: "manual_payment_missing", details: { orderNo: "ORD-202612-0002" } });
  });

  test("no record on an order whose stock left before the cut-over: nothing (opening balances)", () => {
    const old = manualOrder({ manualPayment: null, shippedAt: null, status: "to_ship", movements: manualOrder().movements.map((m) => ({ ...m, createdAt: at("2026-11-20T02:00:00Z") })) });
    expect(find(salesEvents(old, defaultContext()), "order", "collected").outcome.kind).toBe("none");
  });

  test("a corrected record (account or date) changes the journal's content, so the engine reverses and re-posts", () => {
    const context = defaultContext();
    const before = planEvent(find(salesEvents(manualOrder(), context), "order", "collected"), 1, context);
    const account = planEvent(find(salesEvents(manualOrder({ manualPayment: { method: "cash", cashAccountCode: "1-1101", paidOn: "2026-12-02" } }), context), "order", "collected"), 1, context);
    const date = planEvent(find(salesEvents(manualOrder({ manualPayment: { method: "transfer", cashAccountCode: "1-1201", paidOn: "2026-12-03" } }), context), "order", "collected"), 1, context);
    expect(before.kind === "journal" && account.kind === "journal" && before.contentHash !== account.contentHash).toBe(true);
    expect(before.kind === "journal" && date.kind === "journal" && before.contentHash !== date.contentHash).toBe(true);
  });

  test("cancelled after payment: S6 still posts (the money came in), the cancel moves it to 2-1202", () => {
    const order = manualOrder({
      status: "cancelled",
      shippedAt: null,
      cancelledAt: at("2026-12-04T03:00:00Z"),
      movements: [...manualOrder().movements, { id: "sm-3", type: "return", sku: "HAURA-M", valueAmount: 87_917, createdAt: at("2026-12-04T03:00:00Z") }, { id: "sm-4", type: "return", sku: "HAURA-L", valueAmount: 87_917, createdAt: at("2026-12-04T03:00:00Z") }],
    });
    const events = salesEvents(order, defaultContext());
    expect(sides(find(events, "order", "cancelled_paid").outcome)).toEqual(["Dr 2-1201 285000", "Cr 2-1202 285000"]);
    expect(net(events).get("2-1201")).toBe(0);
    expect(net(events).get("2-1202")).toBe(-285_000);
  });

  test("the cancel is held behind S6 while S6 is blocked by manual_payment_missing (across the books)", () => {
    const order = manualOrder({ manualPayment: null, status: "cancelled", shippedAt: null, cancelledAt: at("2026-12-04T03:00:00Z") });
    const cancel = find(salesEvents(order, defaultContext()), "order", "cancelled_paid");
    expect(cancel.requiresActiveJournalFor).toEqual({ sourceType: "order", sourceId: "ord-wa", sourceEvent: "collected" });
    expect(cancel.requiresActiveJournalAcrossBooks).toBe(true);
  });

  test("returned after shipping: S4 credits 2-1202", () => {
    const order = manualOrder({ status: "returned", returnedAt: at("2026-12-10T03:00:00Z") });
    expect(sides(find(salesEvents(order, defaultContext()), "order", "returned").outcome)).toEqual(["Dr 4-1301 270000", "Dr 6-1301 15000", "Cr 2-1202 285000"]);
  });

  test("booked through Biteship: no subsidy, everything above the buyer's ongkir is 6-1301 [D-10]", () => {
    const order = manualOrder({ shipments: [{ id: "shp-9", attempt: 1, status: "delivered", costAmount: 21_000, bookedAt: at("2026-12-04T09:00:00Z"), cancelledAt: null }] });
    expect(sides(find(salesEvents(order, defaultContext()), "shipment", "charged").outcome)).toEqual(["Dr 2-1203 15000", "Dr 6-1301 6000", "Cr 1-1603 21000"]);
  });
});

describe("marketplace (M1, M2) [D-2, D-5, D-11]", () => {
  test("with the real ship time: M1 into Saldo Penjual gross of fees, M2 fees on the same date", () => {
    const events = salesEvents(shopeeOrder(), defaultContext());
    const m1 = find(events, "order", "recognised");
    expect(m1.sourceDate).toBe("2026-12-04");
    expect(sides(m1.outcome)).toEqual(["Dr 1-1302 265000", "Dr 4-1201 5000", "Dr 5-1101 175834", "Cr 4-1102 270000", "Cr 1-1505 175834"]);
    const m2 = find(events, "order", "channel_fees");
    expect(m2.sourceDate).toBe("2026-12-04");
    expect(sides(m2.outcome)).toEqual(["Dr 6-1201 32400", "Dr 6-1202 3000", "Cr 1-1302 35400"]);
    expect(m2.requiresActiveJournalFor).toBeUndefined();
    expectAllPostable(events);
  });

  test("TikTok goes to its own accounts", () => {
    const events = salesEvents(shopeeOrder({ channelId: "tiktok" }), defaultContext());
    expect(sides(find(events, "order", "recognised").outcome)[0]).toBe("Dr 1-1303 265000");
    expect(sides(find(events, "order", "recognised").outcome)).toContain("Cr 4-1103 270000");
  });

  test("a payment_gateway_fee row is never M2 (it is W2)", () => {
    const events = salesEvents(shopeeOrder({ fees: [{ component: "payment_gateway_fee", amount: 999 }, { component: "admin_fee", amount: 100 }] }), defaultContext());
    expect(sides(find(events, "order", "channel_fees").outcome)).toEqual(["Dr 6-1201 100", "Cr 1-1302 100"]);
  });

  test("no real ship time (Session 5 pending): an issue, never the import time; M2, the after-ship return and S4 wait behind it", () => {
    const order = shopeeOrder({
      marketplaceShippedAt: null,
      status: "returned",
      returnedAt: at("2026-12-12T03:00:00Z"),
      movements: [...shopeeOrder().movements, { id: "sm-3", type: "return", sku: "HAURA-M", valueAmount: 87_917, createdAt: at("2026-12-12T03:00:00Z") }],
    });
    const events = salesEvents(order, defaultContext());
    expect(find(events, "order", "recognised").outcome).toMatchObject({ kind: "issue", issueCode: "marketplace_ship_date_missing" });
    const hold = { requiresActiveJournalFor: { sourceType: "order", sourceId: "ord-shopee", sourceEvent: "recognised" }, requiresActiveJournalAcrossBooks: true };
    expect(find(events, "order", "channel_fees")).toMatchObject(hold);
    expect(find(events, "order", "returned")).toMatchObject(hold);
    expect(find(events, "stock_movement", "return", "sm-3")).toMatchObject(hold);
    expect(sides(find(events, "order", "returned").outcome)).toEqual(["Dr 4-1301 270000", "Cr 4-1201 5000", "Cr 1-1302 265000"]);
    // S1 is a real event at import: the goods left the shelf.
    expect(sides(find(events, "stock_movement", "sale", "sm-1").outcome)).toEqual(["Dr 1-1505 87917", "Cr 1-1504 87917"]);
  });

  test("imported as shipped before the cut-over: nothing, no issue", () => {
    const old = shopeeOrder({ marketplaceShippedAt: null, shippedAt: at("2026-11-25T03:00:00Z") });
    const events = salesEvents(old, defaultContext());
    expect(find(events, "order", "recognised").outcome.kind).toBe("none");
    expect(find(events, "order", "channel_fees").outcome.kind).toBe("none");
  });

  test("a re-import changing a fee or the voucher changes the content hash (reverse + repost) [D-5, S5]", () => {
    const context = defaultContext();
    const hash = (order: OrderSnapshot, event: string) => {
      const planned = planEvent(find(salesEvents(order, context), "order", event), 1, context);
      return planned.kind === "journal" ? planned.contentHash : null;
    };
    expect(hash(shopeeOrder(), "channel_fees")).not.toBe(hash(shopeeOrder({ fees: [{ component: "admin_fee", amount: 25_000 }] }), "channel_fees"));
    expect(hash(shopeeOrder(), "recognised")).not.toBe(hash(shopeeOrder({ discountAmount: 7_000, totalAmount: 263_000 }), "recognised"));
  });

  test("marketplace money never touches Uang muka pelanggan", () => {
    const totals = net(salesEvents(shopeeOrder(), defaultContext()));
    expect(totals.has("2-1201")).toBe(false);
    expect(totals.get("1-1302")).toBe(265_000 - 35_400);
  });
});

describe("cut-over and dates", () => {
  test("events dated before the posting start are none; Jakarta date of 31 Dec 17:30Z is 1 Jan", () => {
    const order = webOrder({ payments: [payment({ paidAt: at("2026-11-30T16:59:00Z") })] });
    expect(find(salesEvents(order, defaultContext()), "payment", "paid").outcome.kind).toBe("none");
    const nyd = webOrder({ shippedAt: at("2026-12-31T17:30:00Z") });
    expect(find(salesEvents(nyd, defaultContext()), "order", "recognised").sourceDate).toBe("2027-01-01");
  });

  test("an unmapped sales channel is an issue", () => {
    const events = salesEvents(webOrder(), defaultContext({ mappings: { "revenue.channel.web": null } }));
    expect(find(events, "order", "recognised").outcome).toMatchObject({ kind: "issue", issueCode: "unmapped_sales_channel" });
  });

  test("dateFollowsActive: the same lines on the active journal's older date count as unchanged", () => {
    const context = defaultContext();
    const make = (updatedAt: string) =>
      planEvent(
        find(
          salesEvents(
            webOrder({ status: "cancelled", shippedAt: null, cancelledAt: at("2026-12-04T00:00:00Z"), payments: [payment({ status: "refunded", refundedAmount: 264_000, updatedAt: at(updatedAt) })], shipments: [] }),
            context,
          ),
          "payment",
          "gateway_refunded",
        ),
        1,
        context,
      );
    const first = make("2026-12-06T00:00:00Z");
    const bumped = make("2026-12-20T00:00:00Z");
    if (first.kind !== "journal" || bumped.kind !== "journal") throw new Error("expected journals");
    expect(bumped.contentHash).not.toBe(first.contentHash);
    expect(comparableActiveHash(bumped, { contentHash: first.contentHash, sourceDate: first.sourceDate })).toBe(bumped.contentHash);
    // A real change of amount is not hidden.
    const changed = { ...bumped, lines: bumped.lines.map((line) => ({ ...line, debit: line.debit ? 1 : 0, credit: line.credit ? 1 : 0 })) };
    expect(comparableActiveHash(changed, { contentHash: first.contentHash, sourceDate: first.sourceDate })).toBe(first.contentHash);
  });
});

describe("W2 / W5 (fee work A/B fixtures) [D-8]", () => {
  const fee = (overrides: Partial<MdrFeeSnapshot> = {}): MdrFeeSnapshot => ({
    id: "fee-1",
    orderId: "ord-web",
    orderNo: "ORD-202612-0001",
    component: "payment_gateway_fee",
    amount: 4_440,
    source: "estimate",
    paidAt: at("2026-12-03T02:00:00Z"),
    ...overrides,
  });

  test("W2 on the order's paid_at: Dr 6-1203 / Cr 1-1301", () => {
    const [event] = mdrRule.events(fee(), defaultContext());
    expect(event?.key).toEqual({ sourceType: "order_channel_fee", sourceId: "fee-1", sourceEvent: "mdr" });
    expect(event?.sourceDate).toBe("2026-12-03");
    expect(sides(event?.outcome)).toEqual(["Dr 6-1203 4440", "Cr 1-1301 4440"]);
  });

  test("actual replacing the estimate with a different amount re-posts; the same amount does not", () => {
    const context = defaultContext();
    const plan = (snapshot: MdrFeeSnapshot) => planEvent(mdrRule.events(snapshot, context)[0]!, 1, context);
    const estimate = plan(fee());
    const actualSame = plan(fee({ source: "actual" }));
    const actualDiff = plan(fee({ source: "actual", amount: 4_000 }));
    if (estimate.kind !== "journal" || actualSame.kind !== "journal" || actualDiff.kind !== "journal") throw new Error("journals");
    expect(actualSame.contentHash).toBe(estimate.contentHash);
    expect(actualDiff.contentHash).not.toBe(estimate.contentHash);
  });

  test("any other component is not W2", () => {
    expect(mdrRule.events(fee({ component: "admin_fee" }), defaultContext())).toEqual([]);
  });

  test("W5 books only the net payout: Dr Bank (cash.midtrans_payout) / Cr 1-1301", () => {
    const [event] = midtransSettlementRule.events({ id: "set-1", orderId: "ord-web", orderNo: "ORD-202612-0001", settledAt: at("2026-12-05T10:00:00Z"), netAmount: 259_560 }, defaultContext());
    expect(event?.sourceDate).toBe("2026-12-05");
    expect(sides(event?.outcome)).toEqual(["Dr 1-1201 259560", "Cr 1-1301 259560"]);
  });

  test("W1 + W2 + W5 leave 1-1301 at 0 for the order", () => {
    const context = defaultContext();
    const w1 = find(salesEvents(webOrder(), context), "payment", "paid");
    const w2 = mdrRule.events(fee({ amount: 4_440 }), context)[0]!;
    const w5 = midtransSettlementRule.events({ id: "set-1", orderId: "ord-web", orderNo: "x", settledAt: at("2026-12-05T10:00:00Z"), netAmount: 264_000 - 4_440 }, context)[0]!;
    expect(net([w1, w2, w5]).get("1-1301")).toBe(0);
  });
});

describe("records-based balances for Rekonsiliasi checks 1, 3 and 3c", () => {
  test("agree with the journals for every path, within the trial books", () => {
    const orders = [
      webOrder(),
      manualOrder(),
      shopeeOrder(),
      manualOrder({ status: "to_ship", shippedAt: null }),
      webOrder({ status: "to_ship", shippedAt: null, shipments: [] }),
    ];
    for (const order of orders) {
      const totals = net(salesEvents(order, defaultContext()));
      const app = orderAccountMovements(order, "2026-12-01", "2026-12-31");
      expect(app.soldNotShipped, order.orderNo).toBe(totals.get("1-1505") ?? 0);
      expect(app.deposit, order.orderNo).toBe(0 - (totals.get("2-1201") ?? 0) || 0);
      expect(app.buyerShipping, order.orderNo).toBe(0 - (totals.get("2-1203") ?? 0) || 0);
      expect(app.startsBeforeBooks).toBe(false);
    }
  });

  test("an order paid before the window and shipped in it starts before the books", () => {
    const app = orderAccountMovements(webOrder({ payments: [payment({ paidAt: at("2026-11-29T00:00:00Z") })] }), "2026-12-01", "2026-12-31");
    expect(app.startsBeforeBooks).toBe(true);
    expect(app.deposit).toBe(-264_000);
  });

  test("a marketplace sale without a ship time, and a manual order without a record, are pending", () => {
    expect(orderAccountMovements(shopeeOrder({ marketplaceShippedAt: null }), "2026-12-01", "2026-12-31").pending).toBe(true);
    expect(orderAccountMovements(manualOrder({ manualPayment: null }), "2026-12-01", "2026-12-31").pending).toBe(true);
  });
});
