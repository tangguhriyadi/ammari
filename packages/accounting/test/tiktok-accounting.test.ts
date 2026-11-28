import { describe, expect, test } from "vitest";
import { mappingTargetProblem } from "../src/mapping-rules";
import { planEvent } from "../src/plan";
import { marketplaceRefundEvents, type MarketplaceRefundSnapshot } from "../src/rules/marketplace-refunds";
import { salesEvents, type OrderSnapshot } from "../src/rules/sales";
import {
  TIKTOK_ADJUSTMENT_UNMAPPED_ISSUE,
  isTikTokAdsAdjustmentType,
  tiktokAdjustmentEvents,
  tiktokAdjustmentMappingKey,
  tiktokPayoutEvents,
  type TikTokAdjustmentSnapshot,
  type TikTokPayoutSnapshot,
} from "../src/rules/tiktok-finance";
import type { PostingEvent, PostingOutcome } from "../src/rules/types";
import { defaultContext } from "./context";

// TikTok T8 (docs/plans/tiktok-shop-integration.md §5): M1/M2 on the real ship time (collection_time),
// S4 dated by TikTok's return time, S7 refund-only, M3 payouts and M5 statement adjustments.

const at = (iso: string) => new Date(iso);

function sides(outcome: PostingOutcome | undefined): string[] {
  if (!outcome || outcome.kind !== "journal") throw new Error(`expected a journal, got ${JSON.stringify(outcome)}`);
  return outcome.lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`));
}

function find(events: PostingEvent[], sourceType: string, sourceEvent: string): PostingEvent {
  const event = events.find((e) => e.key.sourceType === sourceType && e.key.sourceEvent === sourceEvent);
  if (!event) throw new Error(`no ${sourceType}/${sourceEvent} in ${JSON.stringify(events.map((e) => e.key))}`);
  return event;
}

function expectPostable(event: PostingEvent) {
  expect(planEvent(event, 1, defaultContext()).kind).toBe("journal");
}

/** A TikTok order: 1 pcs at 270.000, a seller discount of 20.000, shipped (collection_time) at
 * 23:30 UTC on 4 Dec = 06:30 on 5 Dec in Jakarta. */
function tiktokOrder(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: "ord-tt",
    orderNo: "ORD-202612-0010",
    channelId: "tiktok",
    status: "shipped",
    paymentStatus: null,
    subtotalAmount: 270_000,
    shippingAmount: 0,
    discountAmount: 20_000,
    totalAmount: 250_000,
    shippingSubsidyAmount: null,
    shippedAt: at("2026-12-07T03:00:00Z"),
    cancelledAt: null,
    returnedAt: null,
    marketplaceShippedAt: at("2026-12-04T23:30:00Z"),
    marketplaceReturnedAt: null,
    manualPayment: null,
    movements: [{ id: "sm-tt", type: "sale", sku: "HAURA-M", valueAmount: -87_917, createdAt: at("2026-12-04T02:00:00Z") }],
    payments: [],
    shipments: [],
    fees: [
      { component: "platform_commission", amount: 21_600 },
      { component: "admin_fee", amount: 5_000 },
      { component: "seller_shipping_subsidy", amount: 3_000 },
    ],
    ...overrides,
  };
}

describe("M1 / M2 on TikTok's collection_time (T8, D-1, D-2)", () => {
  const events = salesEvents(tiktokOrder(), defaultContext());

  test("M1 is dated by the Jakarta date of collection_time (23:30 UTC → the next Jakarta day)", () => {
    const m1 = find(events, "order", "recognised");
    expect(m1.sourceDate).toBe("2026-12-05");
    // Dr Saldo Penjual TikTok total · Dr Potongan penjualan the seller discount (Q7) · HPP / Cr Penjualan TikTok subtotal.
    expect(sides(m1.outcome)).toEqual(["Dr 1-1303 250000", "Dr 4-1201 20000", "Dr 5-1101 87917", "Cr 4-1103 270000", "Cr 1-1505 87917"]);
    expectPostable(m1);
  });

  test("M2 on the same date: fees → 6-1201, the seller shipping subsidy → 6-1202, against 1-1303", () => {
    const m2 = find(events, "order", "channel_fees");
    expect(m2.sourceDate).toBe("2026-12-05");
    expect(m2.requiresActiveJournalFor).toBeUndefined();
    expect(sides(m2.outcome)).toEqual(["Dr 6-1201 26600", "Dr 6-1202 3000", "Cr 1-1303 29600"]);
  });

  test("without collection_time M1 stays the issue marketplace_ship_date_missing, never the app's shipped_at", () => {
    const blocked = salesEvents(tiktokOrder({ marketplaceShippedAt: null }), defaultContext());
    expect(find(blocked, "order", "recognised").outcome).toMatchObject({ kind: "issue", issueCode: "marketplace_ship_date_missing" });
  });

  test("S4 of a TikTok return is dated by marketplace_returned_at, not by Retur diterima", () => {
    const returned = salesEvents(
      tiktokOrder({
        status: "returned",
        returnedAt: at("2026-12-20T05:00:00Z"),
        marketplaceReturnedAt: at("2026-12-15T18:00:00Z"),
        movements: [
          { id: "sm-tt", type: "sale", sku: "HAURA-M", valueAmount: -87_917, createdAt: at("2026-12-04T02:00:00Z") },
          { id: "sm-tt-r", type: "return", sku: "HAURA-M", valueAmount: 87_917, createdAt: at("2026-12-20T05:00:00Z") },
        ],
      }),
      defaultContext(),
    );
    const s4 = find(returned, "order", "returned");
    expect(s4.sourceDate).toBe("2026-12-16");
    expect(sides(s4.outcome)).toEqual(["Dr 4-1301 270000", "Cr 4-1201 20000", "Cr 1-1303 250000"]);
    // S2 (HPP back) follows the physical receipt (the return movement).
    expect(find(returned, "stock_movement", "return").sourceDate).toBe("2026-12-20");
  });

  test("a web order's S4 keeps returned_at (the column is per order, not per channel)", () => {
    const web = salesEvents(
      tiktokOrder({ channelId: "web", paymentStatus: "paid", status: "returned", returnedAt: at("2026-12-20T05:00:00Z"), marketplaceReturnedAt: at("2026-12-15T05:00:00Z"), marketplaceShippedAt: null }),
      defaultContext(),
    );
    expect(find(web, "order", "returned").sourceDate).toBe("2026-12-20");
  });
});

function refund(overrides: Partial<MarketplaceRefundSnapshot> = {}, order: Partial<MarketplaceRefundSnapshot["order"]> = {}): MarketplaceRefundSnapshot {
  return {
    id: "mr-1",
    channelRefundId: "RET-1",
    amount: 50_000,
    refundedAt: at("2026-12-10T17:30:00Z"),
    order: {
      id: "ord-tt",
      orderNo: "ORD-202612-0010",
      channelId: "tiktok",
      status: "completed",
      shippedAt: at("2026-12-07T03:00:00Z"),
      marketplaceShippedAt: at("2026-12-04T23:30:00Z"),
      ...order,
    },
    ...overrides,
  };
}

describe("S7 marketplace_refund (refund-only, Q10)", () => {
  test("Dr 4-1301 Retur penjualan / Cr 1-1303 on the Jakarta date of refunded_at, no HPP line", () => {
    const [event] = marketplaceRefundEvents(refund(), defaultContext());
    expect(event?.key).toEqual({ sourceType: "marketplace_refund", sourceId: "mr-1", sourceEvent: "refunded" });
    expect(event?.sourceDate).toBe("2026-12-11");
    expect(sides(event?.outcome)).toEqual(["Dr 4-1301 50000", "Cr 1-1303 50000"]);
    // Always behind M1 while M1 is due, so a blocked M1 (any cause) holds the refund too.
    expect(event?.requiresActiveJournalFor).toEqual({ sourceType: "order", sourceId: "ord-tt", sourceEvent: "recognised" });
    if (event?.outcome.kind === "journal") {
      expect(event.outcome.lines.every((line) => line.orderId === "ord-tt" && line.channelId === "tiktok")).toBe(true);
      expect(event.outcome.lines.some((line) => line.accountCode.startsWith("5-") || line.accountCode.startsWith("1-15"))).toBe(false);
    }
    expectPostable(event!);
  });

  test("held behind M1 while M1 is a posting issue (no collection_time), across the books", () => {
    const [event] = marketplaceRefundEvents(refund({}, { marketplaceShippedAt: null }), defaultContext());
    expect(event?.requiresActiveJournalFor).toEqual({ sourceType: "order", sourceId: "ord-tt", sourceEvent: "recognised" });
    expect(event?.requiresActiveJournalAcrossBooks).toBe(true);
    expect(event?.outcome.kind).toBe("journal");
  });

  test("a sale recognised before the books (in the opening balance) does not hold the refund", () => {
    const [event] = marketplaceRefundEvents(refund({}, { marketplaceShippedAt: null, shippedAt: at("2026-11-25T03:00:00Z") }), defaultContext());
    expect(event?.requiresActiveJournalFor).toBeUndefined();
    expect(event?.outcome.kind).toBe("journal");
    const real = marketplaceRefundEvents(refund({}, { marketplaceShippedAt: at("2026-11-29T03:00:00Z"), shippedAt: at("2026-12-02T03:00:00Z") }), defaultContext());
    expect(real[0]?.requiresActiveJournalFor).toBeUndefined();
  });

  test("a refund dated before the posting start posts nothing", () => {
    const [event] = marketplaceRefundEvents(refund({ refundedAt: at("2026-11-20T03:00:00Z") }), defaultContext());
    expect(event?.outcome).toEqual({ kind: "none" });
  });

  test("never guessed: an order not shipped, or returned / cancelled since, is an issue", () => {
    expect(marketplaceRefundEvents(refund({}, { shippedAt: null }), defaultContext())[0]?.outcome).toMatchObject({ kind: "issue", issueCode: "marketplace_refund_not_shipped" });
    expect(marketplaceRefundEvents(refund({}, { status: "returned" }), defaultContext())[0]?.outcome).toMatchObject({ kind: "issue", issueCode: "marketplace_refund_order_undone" });
  });
});

function payout(overrides: Partial<TikTokPayoutSnapshot> = {}): TikTokPayoutSnapshot {
  return { paymentId: "pay-tt-1", amount: 1_250_000, status: "PAID", paidTime: at("2026-12-14T17:10:00Z"), createTime: at("2026-12-13T02:00:00Z"), heldReason: null, bankAccountLast4: "9876", ...overrides };
}

describe("M3 tiktok_payout (Q17)", () => {
  test("Dr Bank utama (cash.tiktok_payout) / Cr 1-1303 on the Jakarta date of paid_time", () => {
    const context = defaultContext({ mappings: { "cash.tiktok_payout": "1-1201" } });
    const [event] = tiktokPayoutEvents(payout(), context);
    expect(event?.key).toEqual({ sourceType: "tiktok_payout", sourceId: "pay-tt-1", sourceEvent: "paid_out" });
    expect(event?.sourceDate).toBe("2026-12-15");
    expect(sides(event?.outcome)).toEqual(["Dr 1-1201 1250000", "Cr 1-1303 1250000"]);
    expect(planEvent(event!, 1, context).kind).toBe("journal");
  });

  test("the accountant may point cash.tiktok_payout at a sub-account", () => {
    const [event] = tiktokPayoutEvents(payout(), defaultContext({ mappings: { "cash.tiktok_payout": "1-1101" } }));
    expect(sides(event?.outcome)).toEqual(["Dr 1-1101 1250000", "Cr 1-1303 1250000"]);
  });

  test("unmapped → issue; not PAID → nothing; PAID without a time or an amount → issue", () => {
    expect(tiktokPayoutEvents(payout(), defaultContext({ mappings: { "cash.tiktok_payout": null } }))[0]?.outcome).toMatchObject({ kind: "issue", issueCode: "unmapped_tiktok_payout" });
    const context = defaultContext({ mappings: { "cash.tiktok_payout": "1-1201" } });
    expect(tiktokPayoutEvents(payout({ status: "PROCESSING" }), context)[0]?.outcome).toEqual({ kind: "none" });
    expect(tiktokPayoutEvents(payout({ status: "FAILED" }), context)[0]?.outcome).toEqual({ kind: "none" });
    expect(tiktokPayoutEvents(payout({ paidTime: null }), context)[0]?.outcome).toMatchObject({ kind: "issue", issueCode: "tiktok_payout_unreadable" });
    expect(tiktokPayoutEvents(payout({ amount: null, heldReason: "money_format" }), context)[0]?.outcome).toMatchObject({ kind: "issue", issueCode: "tiktok_payout_unreadable" });
  });

  test("a payout before the posting start is in the opening balance (cut-over filter)", () => {
    const [event] = tiktokPayoutEvents(payout({ paidTime: at("2026-11-29T03:00:00Z") }), defaultContext({ mappings: { "cash.tiktok_payout": "1-1201" } }));
    expect(event?.outcome).toEqual({ kind: "none" });
  });
});

function adjustment(overrides: Partial<TikTokAdjustmentSnapshot> = {}): TikTokAdjustmentSnapshot {
  return {
    transactionId: "tx-adj-1",
    statementId: "st-1",
    type: "ADS_PAYMENT",
    settlementAmount: -75_000,
    heldReason: null,
    statementTime: at("2026-12-09T20:00:00Z"),
    statementHeldReason: null,
    ...overrides,
  };
}

describe("M5 tiktok_adjustment (Q8)", () => {
  test("the mapping key is tiktok.adjustment.<type in lower case>", () => {
    expect(tiktokAdjustmentMappingKey("ADS_PAYMENT")).toBe("tiktok.adjustment.ads_payment");
  });

  test("unmapped type → the issue tiktok_adjustment_unmapped, never guessed", () => {
    const [event] = tiktokAdjustmentEvents(adjustment(), defaultContext());
    expect(event?.key).toEqual({ sourceType: "tiktok_statement_transaction", sourceId: "tx-adj-1", sourceEvent: "adjustment" });
    expect(event?.outcome).toMatchObject({ kind: "issue", issueCode: TIKTOK_ADJUSTMENT_UNMAPPED_ISSUE, details: { type: "ADS_PAYMENT", mappingKey: "tiktok.adjustment.ads_payment" } });
  });

  test("an ads type mapped to 6-1101 Iklan: a deduction is Dr 6-1101 / Cr 1-1303 on the statement's Jakarta date", () => {
    const context = defaultContext({ mappings: { "tiktok.adjustment.ads_payment": "6-1101" } });
    const [event] = tiktokAdjustmentEvents(adjustment(), context);
    expect(event?.sourceDate).toBe("2026-12-10");
    expect(sides(event?.outcome)).toEqual(["Dr 6-1101 75000", "Cr 1-1303 75000"]);
    expect(planEvent(event!, 1, context).kind).toBe("journal");
  });

  test("a credit (compensation) is Dr 1-1303 / Cr the mapped account", () => {
    const context = defaultContext({ mappings: { "tiktok.adjustment.platform_compensation": "7-1103" } });
    const [event] = tiktokAdjustmentEvents(adjustment({ type: "PLATFORM_COMPENSATION", settlementAmount: 12_500 }), context);
    expect(sides(event?.outcome)).toEqual(["Dr 1-1303 12500", "Cr 7-1103 12500"]);
  });

  test("held money (transaction or statement) → issue; zero → nothing; before the books → nothing", () => {
    const context = defaultContext({ mappings: { "tiktok.adjustment.ads_payment": "6-1101" } });
    expect(tiktokAdjustmentEvents(adjustment({ settlementAmount: null, heldReason: "money_format" }), context)[0]?.outcome).toMatchObject({ kind: "issue", issueCode: "tiktok_statement_held" });
    expect(tiktokAdjustmentEvents(adjustment({ statementHeldReason: "sum_mismatch" }), context)[0]?.outcome).toMatchObject({ kind: "issue", issueCode: "tiktok_statement_held" });
    expect(tiktokAdjustmentEvents(adjustment({ settlementAmount: 0 }), context)[0]?.outcome).toEqual({ kind: "none" });
    expect(tiktokAdjustmentEvents(adjustment({ statementTime: at("2026-11-20T00:00:00Z") }), context)[0]?.outcome).toEqual({ kind: "none" });
  });

  test("ads types are only a suggestion for the editor (6-1101), matched by name", () => {
    expect(isTikTokAdsAdjustmentType("ADS_PAYMENT")).toBe(true);
    expect(isTikTokAdsAdjustmentType("GMV_MAX_ADS_FEE")).toBe(true);
    expect(isTikTokAdsAdjustmentType("ADVERTISING_DEDUCTION")).toBe(true);
    expect(isTikTokAdsAdjustmentType("LOGISTICS_REIMBURSEMENT")).toBe(false);
    expect(isTikTokAdsAdjustmentType("SHADOW_FEE")).toBe(false);
  });
});

describe("mapping targets for the TikTok keys", () => {
  const account = (code: string, type: "asset" | "expense" | "revenue", systemKey: string | null = null) => ({ code, type, isHeader: false, isActive: true, systemKey });

  test("cash.tiktok_payout: Kas & Bank only", () => {
    expect(mappingTargetProblem("cash.tiktok_payout", account("1-1201", "asset"))).toBeNull();
    expect(mappingTargetProblem("cash.tiktok_payout", account("6-1101", "expense"))).toBe("not_cash_bank");
  });

  test("tiktok.adjustment.*: never inventory, never Saldo Penjual TikTok itself", () => {
    expect(mappingTargetProblem("tiktok.adjustment.ads_payment", account("6-1101", "expense"))).toBeNull();
    expect(mappingTargetProblem("tiktok.adjustment.ads_payment", account("1-1504", "asset"))).toBe("inventory");
    expect(mappingTargetProblem("tiktok.adjustment.ads_payment", account("1-1303", "asset", "seller_balance.tiktok"))).toBe("seller_balance");
  });
});
