import { describe, expect, test } from "vitest";
import type { OrderStatus } from "@ammari/db/schema";
import { TIKTOK_RESPONSE_WINDOW_MS, decideTikTokAfterSale, tiktokAfterSaleFlags, tiktokAfterSaleResponseDue, type AfterSaleDecideInput } from "./after-sale-rules";

// docs/plans/tiktok-shop-integration.md §4.5, T6: return/cancellation state → decision, pure and
// table-driven. Refund-only and partial returns per §12.1 (Q10, Q11, Q18); anything the rules cannot
// classify goes to a person, never guessed.

const NOW = new Date("2026-12-05T03:00:00.000Z");
const CREATED = new Date("2026-12-04T03:00:00.000Z");
const s = (date: Date) => Math.floor(date.getTime() / 1000);

function input(overrides: Partial<AfterSaleDecideInput> = {}): AfterSaleDecideInput {
  return {
    kind: "return",
    status: "RETURN_OR_REFUND_REQUEST_PENDING",
    requestType: "RETURN_AND_REFUND",
    updateTime: NOW,
    completedAt: null,
    payload: {
      refund_amount: { currency: "IDR", refund_total: "249000" },
      return_line_items: [
        { order_line_item_id: "li-1", sku_id: "a" },
        { order_line_item_id: "li-2", sku_id: "b" },
      ],
    },
    previousState: null,
    orderLineIds: ["li-1", "li-2"],
    admin: { status: "shipped", totalAmount: 480_000 },
    orderSkipped: false,
    ...overrides,
  };
}

describe("tiktokAfterSaleResponseDue", () => {
  test("TikTok's earliest seller deadline wins while the request waits", () => {
    const due = tiktokAfterSaleResponseDue({ kind: "return", status: "BUYER_SHIPPED_ITEM", createTime: CREATED, payload: { seller_next_action_response: [{ action: "X", deadline: s(NOW) + 7200 }, { action: "Y", deadline: s(NOW) + 3600 }] } });
    expect(due?.getTime()).toBe((s(NOW) + 3600) * 1000);
  });

  test("no deadline from TikTok: a pending request is due 48 h after it was made (§0); other states have none", () => {
    expect(tiktokAfterSaleResponseDue({ kind: "return", status: "RETURN_OR_REFUND_REQUEST_PENDING", createTime: CREATED, payload: {} })?.getTime()).toBe(CREATED.getTime() + TIKTOK_RESPONSE_WINDOW_MS);
    expect(tiktokAfterSaleResponseDue({ kind: "cancellation", status: "CANCELLATION_REQUEST_PENDING", createTime: CREATED, payload: {} })?.getTime()).toBe(CREATED.getTime() + TIKTOK_RESPONSE_WINDOW_MS);
    expect(tiktokAfterSaleResponseDue({ kind: "return", status: "AWAITING_BUYER_SHIP", createTime: CREATED, payload: {} })).toBeNull();
    // A pending request without a create time has no known deadline: never invented.
    expect(tiktokAfterSaleResponseDue({ kind: "return", status: "RETURN_OR_REFUND_REQUEST_PENDING", createTime: null, payload: {} })).toBeNull();
  });

  test("a closed or completed request never waits for the seller, whatever TikTok still lists", () => {
    const payload = { seller_next_action_response: [{ action: "X", deadline: s(NOW) + 3600 }] };
    for (const status of ["RETURN_OR_REFUND_REQUEST_COMPLETE", "REFUND_OR_RETURN_REQUEST_REJECT", "RETURN_OR_REFUND_REQUEST_CANCEL"]) {
      expect(tiktokAfterSaleResponseDue({ kind: "return", status, createTime: CREATED, payload })).toBeNull();
    }
    expect(tiktokAfterSaleResponseDue({ kind: "cancellation", status: "CANCELLATION_REQUEST_COMPLETE", createTime: CREATED, payload })).toBeNull();
  });

  test("a malformed deadline is ignored, not read as a date", () => {
    expect(tiktokAfterSaleResponseDue({ kind: "return", status: "BUYER_SHIPPED_ITEM", createTime: CREATED, payload: { seller_next_action_response: [{ deadline: "1764400000" }, { deadline: -1 }] } })).toBeNull();
  });
});

describe("decideTikTokAfterSale: returns with goods (Q10 D-7, Q18)", () => {
  test.each([
    ["RETURN_OR_REFUND_REQUEST_PENDING", "open"],
    ["AWAITING_BUYER_RESPONSE", "open"],
    ["AWAITING_BUYER_SHIP", "approved"],
    ["RETURN_OR_REFUND_REQUEST_SUCCESS", "approved"],
    ["BUYER_SHIPPED_ITEM", "goods_coming"],
    ["REFUND_OR_RETURN_REQUEST_REJECT", "closed"],
    ["RETURN_OR_REFUND_REQUEST_CANCEL", "closed"],
  ] as const)("every item, %s → %s", (status, state) => {
    expect(decideTikTokAfterSale(input({ status }))).toEqual({ state, reviewReason: null, refundAmount: null, returnedAt: null });
  });

  test("complete with every item → completed_goods, dated by the first COMPLETE version, no refund row", () => {
    const completedAt = new Date(NOW.getTime() - 60_000);
    expect(decideTikTokAfterSale(input({ status: "RETURN_OR_REFUND_REQUEST_COMPLETE", completedAt }))).toEqual({ state: "completed_goods", reviewReason: null, refundAmount: null, returnedAt: completedAt });
    expect(decideTikTokAfterSale(input({ status: "RETURN_OR_REFUND_REQUEST_COMPLETE" })).returnedAt).toEqual(NOW);
  });

  test("on a COMPLETED order (a refund in transit, §0) the same path applies: admin shipped or completed", () => {
    for (const status of ["shipped", "completed"] as OrderStatus[]) {
      expect(decideTikTokAfterSale(input({ status: "RETURN_OR_REFUND_REQUEST_COMPLETE", admin: { status, totalAmount: 480_000 } })).state).toBe("completed_goods");
    }
  });

  test("some items only → partial, whatever the stage (nothing moves automatically)", () => {
    const payload = { return_line_items: [{ order_line_item_id: "li-1" }] };
    for (const status of ["RETURN_OR_REFUND_REQUEST_PENDING", "BUYER_SHIPPED_ITEM", "RETURN_OR_REFUND_REQUEST_COMPLETE"]) {
      expect(decideTikTokAfterSale(input({ status, payload }))).toMatchObject({ state: "partial", refundAmount: null, returnedAt: null });
    }
  });

  test("lines that cannot be matched to the order → review lines_unknown, never assumed full", () => {
    expect(decideTikTokAfterSale(input({ payload: { return_line_items: [] } }))).toMatchObject({ state: "review", reviewReason: "lines_unknown" });
    expect(decideTikTokAfterSale(input({ payload: { return_line_items: [{ sku_id: "a" }, { order_line_item_id: "li-2" }] } }))).toMatchObject({ state: "review", reviewReason: "lines_unknown" });
    expect(decideTikTokAfterSale(input({ payload: { return_line_items: [{ order_line_item_id: "li-1" }, { order_line_item_id: "li-9" }] } }))).toMatchObject({ state: "review", reviewReason: "lines_unknown" });
    expect(decideTikTokAfterSale(input({ orderLineIds: null }))).toMatchObject({ state: "review", reviewReason: "lines_unknown" });
  });

  test("closed after the goods were on their way → review (the parcel may still come back)", () => {
    for (const previousState of ["goods_coming", "completed_goods"] as const) {
      expect(decideTikTokAfterSale(input({ status: "RETURN_OR_REFUND_REQUEST_CANCEL", previousState }))).toMatchObject({ state: "review", reviewReason: "closed_after_goods" });
    }
  });

  test("closed after a refund was recorded → review (the refund row stays)", () => {
    expect(decideTikTokAfterSale(input({ requestType: "REFUND", status: "RETURN_OR_REFUND_REQUEST_CANCEL", previousState: "completed_refund" }))).toMatchObject({ state: "review", reviewReason: "unknown_status" });
  });

  test("the seller refused the parcel → review package_rejected", () => {
    expect(decideTikTokAfterSale(input({ status: "REJECT_RECEIVE_PACKAGE" }))).toMatchObject({ state: "review", reviewReason: "package_rejected" });
  });
});

describe("decideTikTokAfterSale: refund-only (Q10)", () => {
  const refund = (overrides: Partial<AfterSaleDecideInput> = {}) => input({ requestType: "REFUND", ...overrides });

  test("open and approved like any return; complete → completed_refund with TikTok's refund_total", () => {
    expect(decideTikTokAfterSale(refund()).state).toBe("open");
    expect(decideTikTokAfterSale(refund({ status: "RETURN_OR_REFUND_REQUEST_SUCCESS" })).state).toBe("approved");
    expect(decideTikTokAfterSale(refund({ status: "RETURN_OR_REFUND_REQUEST_COMPLETE" }))).toEqual({ state: "completed_refund", reviewReason: null, refundAmount: 249_000, returnedAt: null });
  });

  test("a partial refund-only is still refund-only (money only, goods stay with the buyer)", () => {
    expect(decideTikTokAfterSale(refund({ status: "RETURN_OR_REFUND_REQUEST_COMPLETE", payload: { refund_amount: { refund_total: "50000" }, return_line_items: [{ order_line_item_id: "li-1" }] } }))).toMatchObject({ state: "completed_refund", refundAmount: 50_000 });
  });

  test("money that is not whole rupiah, absent, zero or above the order total → review, never rounded", () => {
    for (const total of ["249000.50", "1e5", "", undefined, "0", "-1"]) {
      expect(decideTikTokAfterSale(refund({ status: "RETURN_OR_REFUND_REQUEST_COMPLETE", payload: { refund_amount: { refund_total: total ?? null } } }))).toMatchObject({ state: "review", reviewReason: "money_format", refundAmount: null });
    }
    expect(decideTikTokAfterSale(refund({ status: "RETURN_OR_REFUND_REQUEST_COMPLETE", payload: { refund_amount: { refund_total: "480001" } } }))).toMatchObject({ state: "review", reviewReason: "refund_over_total" });
  });

  test("a refund-only on an order already returned in admin → review (stock already back)", () => {
    expect(decideTikTokAfterSale(refund({ status: "RETURN_OR_REFUND_REQUEST_COMPLETE", admin: { status: "returned", totalAmount: 480_000 } }))).toMatchObject({ state: "review", reviewReason: "after_return" });
  });

  test("the buyer shipping goods on a refund-only request does not fit → review", () => {
    expect(decideTikTokAfterSale(refund({ status: "BUYER_SHIPPED_ITEM" }))).toMatchObject({ state: "review", reviewReason: "unknown_status" });
  });
});

describe("decideTikTokAfterSale: what the rules cannot classify", () => {
  test("replacement, an unknown or missing type, an unknown status → review", () => {
    expect(decideTikTokAfterSale(input({ requestType: "REPLACEMENT" }))).toMatchObject({ state: "review", reviewReason: "replacement" });
    expect(decideTikTokAfterSale(input({ requestType: null }))).toMatchObject({ state: "review", reviewReason: "unknown_type" });
    expect(decideTikTokAfterSale(input({ requestType: "SOMETHING_NEW" }))).toMatchObject({ state: "review", reviewReason: "unknown_type" });
    expect(decideTikTokAfterSale(input({ status: "SOMETHING_NEW" }))).toMatchObject({ state: "review", reviewReason: "unknown_status" });
  });

  test("a return on an order admin never shipped → review before_shipping; a closed one is just closed", () => {
    for (const status of ["awaiting_payment", "to_ship", "cancelled"] as OrderStatus[]) {
      expect(decideTikTokAfterSale(input({ admin: { status, totalAmount: 480_000 } }))).toMatchObject({ state: "review", reviewReason: "before_shipping" });
    }
    expect(decideTikTokAfterSale(input({ status: "REFUND_OR_RETURN_REQUEST_REJECT", admin: { status: "to_ship", totalAmount: 480_000 } })).state).toBe("closed");
  });

  test("no admin order: waiting_order; an order the sync skipped (never existed for us) → closed", () => {
    expect(decideTikTokAfterSale(input({ admin: null }))).toMatchObject({ state: "waiting_order" });
    expect(decideTikTokAfterSale(input({ admin: null, orderSkipped: true }))).toMatchObject({ state: "closed" });
  });
});

describe("decideTikTokAfterSale: cancellations", () => {
  const cancel = (status: string, overrides: Partial<AfterSaleDecideInput> = {}) => input({ kind: "cancellation", status, requestType: "BUYER_CANCEL", admin: { status: "to_ship", totalAmount: 480_000 }, ...overrides });

  test.each([
    ["CANCELLATION_REQUEST_PENDING", "open"],
    ["CANCELLATION_REQUEST_SUCCESS", "cancel_completed"],
    ["CANCELLATION_REQUEST_COMPLETE", "cancel_completed"],
    ["CANCELLATION_REQUEST_CANCEL", "closed"],
  ] as const)("%s → %s (the order's own status path cancels it, not this)", (status, state) => {
    expect(decideTikTokAfterSale(cancel(status))).toEqual({ state, reviewReason: null, refundAmount: null, returnedAt: null });
  });

  test("an unknown cancellation status → review", () => {
    expect(decideTikTokAfterSale(cancel("CANCELLATION_SOMETHING"))).toMatchObject({ state: "review", reviewReason: "unknown_status" });
  });
});

describe("tiktokAfterSaleFlags", () => {
  const row = (kind: "return" | "cancellation", state: NonNullable<ReturnType<typeof decideTikTokAfterSale>["state"]>, responseDueAt: Date | null = null) => ({ kind, state, responseDueAt });
  const base = { adminStatus: "shipped" as OrderStatus, tiktokStatus: "DELIVERED", now: NOW };

  test("a request due later sets tiktok_return_response_due; once past its deadline or answered it is removed", () => {
    const due = new Date(NOW.getTime() + 3600_000);
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("cancellation", "open", due)], changed: null }).add).toContain("tiktok_return_response_due");
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("cancellation", "open", new Date(NOW.getTime() - 1))], changed: null }).remove).toContain("tiktok_return_response_due");
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("cancellation", "closed")], changed: null }).remove).toContain("tiktok_return_response_due");
  });

  test("an open return sets marketplace_return_pending; a cancellation request never does", () => {
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("return", "open")], changed: { kind: "return", from: null, to: "open" } }).add).toEqual(["marketplace_return_pending"]);
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("cancellation", "open")], changed: { kind: "cancellation", from: null, to: "open" } }).add).toEqual([]);
  });

  test("goods on their way or complete → pending + in transit; in transit is never removed here", () => {
    const flags = tiktokAfterSaleFlags({ ...base, rows: [row("return", "completed_goods")], changed: { kind: "return", from: "goods_coming", to: "completed_goods" } });
    expect(flags.add).toEqual(["marketplace_return_pending", "marketplace_return_in_transit"]);
    expect(flags.remove).not.toContain("marketplace_return_in_transit");
  });

  test("refund-only completed or a closed return clears pending; not while TikTok reports the order cancelled (a failed delivery)", () => {
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("return", "completed_refund")], changed: { kind: "return", from: "approved", to: "completed_refund" } }).remove).toContain("marketplace_return_pending");
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("return", "closed")], changed: { kind: "return", from: "open", to: "closed" } }).remove).toContain("marketplace_return_pending");
    expect(tiktokAfterSaleFlags({ ...base, tiktokStatus: "CANCELLED", rows: [row("return", "closed")], changed: { kind: "return", from: "open", to: "closed" } }).remove).not.toContain("marketplace_return_pending");
    // Another return of the same order still open keeps it.
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("return", "closed"), row("return", "open")], changed: { kind: "return", from: "open", to: "closed" } }).remove).not.toContain("marketplace_return_pending");
  });

  test("partial and review are added once, when a request enters them (a person may clear them)", () => {
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("return", "partial")], changed: { kind: "return", from: "open", to: "partial" } }).add).toContain("marketplace_partial_return");
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("return", "partial")], changed: { kind: "return", from: "partial", to: "partial" } }).add).not.toContain("marketplace_partial_return");
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("return", "review")], changed: { kind: "return", from: null, to: "review" } }).add).toContain("marketplace_review");
    expect(tiktokAfterSaleFlags({ ...base, rows: [row("return", "review")], changed: null }).add).not.toContain("marketplace_review");
  });

  test("an order already returned or cancelled in admin gets no return flags (the deadline still counts)", () => {
    const due = new Date(NOW.getTime() + 3600_000);
    const flags = tiktokAfterSaleFlags({ ...base, adminStatus: "returned", rows: [row("return", "goods_coming", due)], changed: { kind: "return", from: "approved", to: "goods_coming" } });
    expect(flags.add).toEqual(["tiktok_return_response_due"]);
  });
});
