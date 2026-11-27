import { describe, expect, test } from "vitest";
import type { AllowlistedObject } from "@ammari/tiktok-shop";
import { TIKTOK_PACKING_HOLD_MS, decideTikTokOrder, tiktokPackingRefusal, tiktokPackingState, tiktokReadyToShip, type DecideTikTokOrderInput, type TikTokAdminOrderState } from "./apply-rules";

// docs/plans/tiktok-shop-integration.md §4.3, §4.4, §10 T5 "Unit (pure decide, table-driven)". No
// database: every rule of the status table for a new and an existing admin order, both ON_HOLD flows,
// the packing gate's truth table, the amounts (Q7) and every held reason.

const NOW = new Date("2026-12-02T07:00:00.000Z");
const HOUR = 3_600_000;
const PAID = new Date(NOW.getTime() - 2 * HOUR);
const SKU_A = "POKA-FZ-SAGE-M";
const SKU_B = "POKA-FZ-SAGE-L";

function payload(overrides: Partial<AllowlistedObject> = {}): AllowlistedObject {
  return {
    id: "577000000000000001",
    create_time: Math.floor((PAID.getTime() - 60_000) / 1000),
    payment: { currency: "IDR", sub_total: "500000", seller_discount: "0", platform_discount: "0", total_amount: "500000" },
    line_items: [
      { id: "li-1", sku_id: "tt-a", seller_sku: SKU_A, original_price: "259000", sale_price: "259000", seller_discount: "0", platform_discount: "0", currency: "IDR" },
      { id: "li-2", sku_id: "tt-b", seller_sku: SKU_B, original_price: "241000", sale_price: "241000", seller_discount: "0", platform_discount: "0", currency: "IDR" },
    ],
    ...overrides,
  };
}

const MAPPINGS = new Map([
  ["tt-a", SKU_A],
  ["tt-b", SKU_B],
]);

function input(overrides: Partial<DecideTikTokOrderInput> = {}): DecideTikTokOrderInput {
  return {
    status: "AWAITING_SHIPMENT",
    isOnHoldOrder: false,
    paidTime: PAID,
    collectionTime: null,
    cancelTime: null,
    updateTime: new Date(NOW.getTime() - 60_000),
    payload: payload(),
    mappings: MAPPINGS,
    admin: null,
    now: NOW,
    ...overrides,
  };
}

function admin(overrides: Partial<TikTokAdminOrderState> = {}): TikTokAdminOrderState {
  return {
    status: "to_ship",
    lines: [
      { sku: SKU_A, qty: 1 },
      { sku: SKU_B, qty: 1 },
    ],
    needsAttention: [],
    marketplaceShippedAt: null,
    marketplaceCompletedAt: null,
    marketplaceReturnedAt: null,
    ...overrides,
  };
}

describe("tiktokReadyToShip (the packing gate, Q1)", () => {
  // AWAITING_SHIPMENT and (is_on_hold_order or 1 h since paid_time), exactly as decided.
  const cases: { status: string; onHold: boolean | null; paidAgoMs: number | null; ready: boolean }[] = [
    { status: "AWAITING_SHIPMENT", onHold: true, paidAgoMs: 10 * 60_000, ready: true },
    { status: "AWAITING_SHIPMENT", onHold: true, paidAgoMs: 2 * HOUR, ready: true },
    { status: "AWAITING_SHIPMENT", onHold: false, paidAgoMs: 10 * 60_000, ready: false },
    { status: "AWAITING_SHIPMENT", onHold: false, paidAgoMs: HOUR - 1, ready: false },
    { status: "AWAITING_SHIPMENT", onHold: false, paidAgoMs: HOUR, ready: true },
    { status: "AWAITING_SHIPMENT", onHold: false, paidAgoMs: 2 * HOUR, ready: true },
    { status: "AWAITING_SHIPMENT", onHold: null, paidAgoMs: 2 * HOUR, ready: true },
    { status: "AWAITING_SHIPMENT", onHold: false, paidAgoMs: null, ready: false },
    { status: "ON_HOLD", onHold: true, paidAgoMs: 2 * HOUR, ready: false },
    { status: "ON_HOLD", onHold: false, paidAgoMs: 2 * HOUR, ready: false },
    { status: "UNPAID", onHold: false, paidAgoMs: 2 * HOUR, ready: false },
    { status: "AWAITING_COLLECTION", onHold: false, paidAgoMs: 2 * HOUR, ready: false },
  ];
  test.each(cases)("$status, on hold $onHold, paid $paidAgoMs ms ago → $ready", ({ status, onHold, paidAgoMs, ready }) => {
    const paidTime = paidAgoMs === null ? null : new Date(NOW.getTime() - paidAgoMs);
    expect(tiktokReadyToShip({ status, isOnHoldOrder: onHold, paidTime }, NOW)).toBe(ready);
  });

  test("the hold window is one hour", () => {
    expect(TIKTOK_PACKING_HOLD_MS).toBe(HOUR);
  });
});

describe("tiktokPackingState", () => {
  test("waiting until paid_time + 1 h; ON_HOLD waits with no known end; PARTIALLY_SHIPPING needs review", () => {
    const paidTime = new Date(NOW.getTime() - 20 * 60_000);
    expect(tiktokPackingState({ status: "AWAITING_SHIPMENT", isOnHoldOrder: false, paidTime }, NOW)).toEqual({ kind: "wait", until: new Date(paidTime.getTime() + HOUR) });
    expect(tiktokPackingState({ status: "ON_HOLD", isOnHoldOrder: true, paidTime }, NOW)).toEqual({ kind: "wait", until: null });
    expect(tiktokPackingState({ status: "AWAITING_SHIPMENT", isOnHoldOrder: false, paidTime: null }, NOW)).toEqual({ kind: "wait", until: null });
    expect(tiktokPackingState({ status: "PARTIALLY_SHIPPING", isOnHoldOrder: false, paidTime }, NOW)).toEqual({ kind: "review" });
    expect(tiktokPackingState({ status: "AWAITING_SHIPMENT", isOnHoldOrder: false, paidTime: PAID }, NOW)).toEqual({ kind: "ready" });
    // The shipment is already arranged in Seller Center: the parcel waits for the courier.
    expect(tiktokPackingState({ status: "AWAITING_COLLECTION", isOnHoldOrder: false, paidTime: PAID }, NOW)).toEqual({ kind: "ready" });
  });
});

describe("tiktokPackingRefusal (staff Tandai dikirim)", () => {
  test("Indonesian reasons with the Jakarta time; null once packable", () => {
    // 06:52 UTC = 13.52 WIB; + 1 h = 14.52.
    const paidTime = new Date("2026-12-02T06:52:00.000Z");
    expect(tiktokPackingRefusal({ status: "AWAITING_SHIPMENT", isOnHoldOrder: false, paidTime }, NOW)).toBe("Pesanan TikTok ini belum boleh dikemas: pembeli masih bisa membatalkan sampai 14.52.");
    expect(tiktokPackingRefusal({ status: "ON_HOLD", isOnHoldOrder: true, paidTime }, NOW)).toBe("Pesanan TikTok ini belum boleh dikemas: pembeli masih bisa membatalkan.");
    expect(tiktokPackingRefusal({ status: "PARTIALLY_SHIPPING", isOnHoldOrder: false, paidTime }, NOW)).toMatch(/beberapa paket/);
    expect(tiktokPackingRefusal({ status: "AWAITING_SHIPMENT", isOnHoldOrder: false, paidTime: PAID }, NOW)).toBeNull();
    // Cancelled on TikTok while the admin order still waits (applying off, or held): never shipped.
    expect(tiktokPackingRefusal({ status: "CANCELLED", isOnHoldOrder: false, paidTime: PAID }, NOW)).toMatch(/sudah dibatalkan di TikTok/);
  });
});

describe("decideTikTokOrder: a new order (not in admin)", () => {
  test("UNPAID is skipped (not a sale yet); CANCELLED is skipped (it never existed for us)", () => {
    expect(decideTikTokOrder(input({ status: "UNPAID", paidTime: null }))).toEqual({ kind: "skip", reason: "unpaid" });
    expect(decideTikTokOrder(input({ status: "CANCELLED" }))).toEqual({ kind: "skip", reason: "cancelled" });
  });

  test("an unknown status is held, never guessed", () => {
    expect(decideTikTokOrder(input({ status: "SOMETHING_NEW" }))).toMatchObject({ kind: "hold", reason: "unknown_status", detail: "SOMETHING_NEW" });
  });

  const created: { status: string; transitions: string[] }[] = [
    { status: "ON_HOLD", transitions: [] },
    { status: "AWAITING_SHIPMENT", transitions: [] },
    { status: "PARTIALLY_SHIPPING", transitions: [] },
    { status: "AWAITING_COLLECTION", transitions: [] },
    { status: "IN_TRANSIT", transitions: ["shipped"] },
    { status: "DELIVERED", transitions: ["shipped"] },
    { status: "COMPLETED", transitions: ["shipped", "completed"] },
  ];
  test.each(created)("$status → created at to_ship (stock leaves), then $transitions", ({ status, transitions }) => {
    const decision = decideTikTokOrder(input({ status, collectionTime: status === "AWAITING_COLLECTION" ? null : PAID }));
    expect(decision.kind).toBe("create");
    if (decision.kind !== "create") return;
    expect(decision.transitions).toEqual(transitions);
  });

  test("ON_HOLD flow 1 (an ON_HOLD status): created, flagged tiktok_on_hold", () => {
    const decision = decideTikTokOrder(input({ status: "ON_HOLD" }));
    expect(decision).toMatchObject({ kind: "create", effects: { addFlags: ["tiktok_on_hold"] } });
  });

  test("ON_HOLD flow 2 (AWAITING_SHIPMENT with is_on_hold_order): the gate decides the flag", () => {
    const early = new Date(NOW.getTime() - 10 * 60_000);
    expect(decideTikTokOrder(input({ isOnHoldOrder: true, paidTime: early }))).toMatchObject({ kind: "create", effects: { addFlags: [], removeFlags: ["tiktok_on_hold"] } });
    expect(decideTikTokOrder(input({ isOnHoldOrder: false, paidTime: early }))).toMatchObject({ kind: "create", effects: { addFlags: ["tiktok_on_hold"] } });
    expect(decideTikTokOrder(input({ isOnHoldOrder: false, paidTime: PAID }))).toMatchObject({ kind: "create", effects: { addFlags: [] } });
  });

  test("PARTIALLY_SHIPPING → marketplace_review, no transition (Q2)", () => {
    const decision = decideTikTokOrder(input({ status: "PARTIALLY_SHIPPING" }));
    expect(decision).toMatchObject({ kind: "create", transitions: [], effects: { addFlags: ["marketplace_review"], reviewFlags: ["tiktok_partial_shipping"] } });
  });

  test("more than one package id → marketplace_review too", () => {
    const multi = payload({ packages: [{ id: "pkg-1" }, { id: "pkg-2" }] });
    expect(decideTikTokOrder(input({ payload: multi }))).toMatchObject({ kind: "create", effects: { addFlags: ["marketplace_review"] } });
    const one = payload({ packages: [{ id: "pkg-1" }] });
    expect(decideTikTokOrder(input({ payload: one }))).toMatchObject({ kind: "create", effects: { addFlags: [] } });
  });

  test("IN_TRANSIT sets marketplace_shipped_at = collection_time; no collection_time → stays null (Q13)", () => {
    const collected = new Date(NOW.getTime() - HOUR);
    expect(decideTikTokOrder(input({ status: "IN_TRANSIT", collectionTime: collected }))).toMatchObject({ kind: "create", effects: { marketplaceShippedAt: collected } });
    expect(decideTikTokOrder(input({ status: "IN_TRANSIT", collectionTime: null }))).toMatchObject({ kind: "create", transitions: ["shipped"], effects: { marketplaceShippedAt: null } });
  });

  test("COMPLETED sets marketplace_completed_at from the version that reported it", () => {
    const updateTime = new Date(NOW.getTime() - 5 * 60_000);
    expect(decideTikTokOrder(input({ status: "COMPLETED", collectionTime: PAID, updateTime }))).toMatchObject({ kind: "create", effects: { marketplaceCompletedAt: updateTime } });
  });

  describe("amounts (Q7)", () => {
    test("unit_price = original price, subtotal = Σ qty × price, seller discounts (items + voucher) → discount, platform ignored, total = subtotal − discount", () => {
      const withDiscounts = payload({
        payment: { currency: "IDR", sub_total: "470000", seller_discount: "25000", platform_discount: "5000", total_amount: "470000" },
        line_items: [
          { id: "li-1", sku_id: "tt-a", original_price: "259000", sale_price: "249000", seller_discount: "10000", platform_discount: "5000", currency: "IDR" },
          { id: "li-2", sku_id: "tt-b", original_price: "241000", sale_price: "241000", seller_discount: "0", platform_discount: "0", currency: "IDR" },
        ],
      });
      const decision = decideTikTokOrder(input({ payload: withDiscounts }));
      expect(decision.kind).toBe("create");
      if (decision.kind !== "create") return;
      expect(decision.order.lines).toEqual([
        { sku: SKU_B, qty: 1, unitPrice: 241_000 },
        { sku: SKU_A, qty: 1, unitPrice: 259_000 },
      ]);
      expect(decision.order.subtotalAmount).toBe(500_000);
      // 10.000 item discount + 15.000 seller voucher = payment.seller_discount; 5.000 platform ignored.
      expect(decision.order.discountAmount).toBe(25_000);
      expect(decision.order.totalAmount).toBe(475_000);
    });

    test("lines of one variant merge (one line item per piece); quantity is honoured when present", () => {
      const merged = payload({
        line_items: [
          { id: "li-1", sku_id: "tt-a", original_price: "259000" },
          { id: "li-2", sku_id: "tt-a", original_price: "259000" },
          { id: "li-3", sku_id: "tt-b", original_price: "241000", quantity: 2 },
        ],
      });
      const decision = decideTikTokOrder(input({ payload: merged }));
      expect(decision).toMatchObject({
        kind: "create",
        order: {
          lines: [
            { sku: SKU_B, qty: 2, unitPrice: 241_000 },
            { sku: SKU_A, qty: 2, unitPrice: 259_000 },
          ],
          subtotalAmount: 1_000_000,
        },
      });
    });

    test("two TikTok SKUs mapped to one variant merge too", () => {
      const twoListings = payload({ line_items: [{ id: "li-1", sku_id: "tt-a", original_price: "259000" }, { id: "li-2", sku_id: "tt-a2", original_price: "259000" }] });
      const mappings = new Map([...MAPPINGS, ["tt-a2", SKU_A]]);
      expect(decideTikTokOrder(input({ payload: twoListings, mappings }))).toMatchObject({ kind: "create", order: { lines: [{ sku: SKU_A, qty: 2, unitPrice: 259_000 }] } });
    });

    test("order date: create_time, else paid_time", () => {
      const created = new Date(Math.floor((PAID.getTime() - 60_000) / 1000) * 1000);
      expect(decideTikTokOrder(input())).toMatchObject({ kind: "create", order: { orderDate: created } });
      const noCreate = payload();
      delete noCreate.create_time;
      expect(decideTikTokOrder(input({ payload: noCreate }))).toMatchObject({ kind: "create", order: { orderDate: PAID } });
    });
  });

  describe("held, never guessed", () => {
    test("an unmapped TikTok SKU → unknown_sku, naming it", () => {
      const mappings = new Map([["tt-a", SKU_A]]);
      expect(decideTikTokOrder(input({ mappings }))).toEqual({ kind: "hold", reason: "unknown_sku", detail: "tt-b" });
    });

    test("a line without a SKU id, or no lines → unknown_sku", () => {
      expect(decideTikTokOrder(input({ payload: payload({ line_items: [{ id: "li-1", original_price: "1000" }] }) }))).toMatchObject({ kind: "hold", reason: "unknown_sku" });
      expect(decideTikTokOrder(input({ payload: payload({ line_items: [] }) }))).toMatchObject({ kind: "hold", reason: "unknown_sku" });
    });

    test.each([
      ["a non-integer price", { line_items: [{ id: "li-1", sku_id: "tt-a", original_price: "259000.50" }] }],
      ["a missing price", { line_items: [{ id: "li-1", sku_id: "tt-a" }] }],
      ["a non-IDR currency", { payment: { currency: "USD", seller_discount: "0" } }],
      ["no payment object", { payment: null }],
      ["no seller_discount", { payment: { currency: "IDR", sub_total: "500000" } }],
      ["a discount above the subtotal", { payment: { currency: "IDR", seller_discount: "600000" } }],
      ["line seller discounts above the order's", { payment: { currency: "IDR", seller_discount: "0" }, line_items: [{ id: "li-1", sku_id: "tt-a", original_price: "259000", seller_discount: "1000" }] }],
    ])("%s → money_format", (_label, overrides) => {
      expect(decideTikTokOrder(input({ payload: payload(overrides as Partial<AllowlistedObject>) }))).toMatchObject({ kind: "hold", reason: "money_format" });
    });

    test.each([
      ["a zero quantity", [{ id: "li-1", sku_id: "tt-a", original_price: "259000", quantity: 0 }]],
      ["a fractional quantity", [{ id: "li-1", sku_id: "tt-a", original_price: "259000", quantity: 1.5 }]],
      ["two prices for one variant", [{ id: "li-1", sku_id: "tt-a", original_price: "259000" }, { id: "li-2", sku_id: "tt-a", original_price: "249000" }]],
    ])("%s → line_format", (_label, lineItems) => {
      expect(decideTikTokOrder(input({ payload: payload({ line_items: lineItems as AllowlistedObject[] }) }))).toMatchObject({ kind: "hold", reason: "line_format" });
    });
  });
});

describe("decideTikTokOrder: an existing admin order (hand-typed or applied earlier)", () => {
  test("UNPAID → no change", () => {
    expect(decideTikTokOrder(input({ status: "UNPAID", admin: admin({ status: "awaiting_payment" }) }))).toMatchObject({ kind: "update", transitions: [] });
  });

  test("a hand-typed awaiting_payment order paid on TikTok → to_ship (stock leaves through the transition)", () => {
    expect(decideTikTokOrder(input({ admin: admin({ status: "awaiting_payment" }) }))).toMatchObject({ kind: "update", transitions: ["to_ship"] });
  });

  test("ON_HOLD → no status change, flag set", () => {
    expect(decideTikTokOrder(input({ status: "ON_HOLD", admin: admin() }))).toMatchObject({ kind: "update", transitions: [], effects: { addFlags: ["tiktok_on_hold"] } });
  });

  test("the gate passing clears tiktok_on_hold", () => {
    expect(decideTikTokOrder(input({ admin: admin({ needsAttention: ["tiktok_on_hold"] }) }))).toMatchObject({ kind: "update", transitions: [], effects: { addFlags: [], removeFlags: ["tiktok_on_hold"] } });
  });

  test("AWAITING_SHIPMENT / AWAITING_COLLECTION → no change when already to_ship or later (forward only)", () => {
    expect(decideTikTokOrder(input({ admin: admin() }))).toMatchObject({ kind: "update", transitions: [] });
    expect(decideTikTokOrder(input({ status: "AWAITING_COLLECTION", admin: admin({ status: "shipped" }) }))).toMatchObject({ kind: "update", transitions: [] });
  });

  test("PARTIALLY_SHIPPING → marketplace_review, no transition", () => {
    expect(decideTikTokOrder(input({ status: "PARTIALLY_SHIPPING", admin: admin() }))).toMatchObject({ kind: "update", transitions: [], effects: { addFlags: ["marketplace_review"] } });
  });

  test("IN_TRANSIT: to_ship → shipped and marketplace_shipped_at = collection_time", () => {
    const collected = new Date(NOW.getTime() - HOUR);
    expect(decideTikTokOrder(input({ status: "IN_TRANSIT", collectionTime: collected, admin: admin() }))).toMatchObject({
      kind: "update",
      transitions: ["shipped"],
      effects: { marketplaceShippedAt: collected, removeFlags: ["tiktok_on_hold"] },
    });
  });

  test("IN_TRANSIT on an order staff already shipped: no transition, the TikTok ship time still recorded", () => {
    const collected = new Date(NOW.getTime() - HOUR);
    expect(decideTikTokOrder(input({ status: "IN_TRANSIT", collectionTime: collected, admin: admin({ status: "shipped" }) }))).toMatchObject({ kind: "update", transitions: [], effects: { marketplaceShippedAt: collected } });
  });

  test("the ship time is written once; a different later collection_time is flagged, not overwritten", () => {
    const first = new Date(NOW.getTime() - 3 * HOUR);
    const later = new Date(NOW.getTime() - HOUR);
    expect(decideTikTokOrder(input({ status: "DELIVERED", collectionTime: later, admin: admin({ status: "shipped", marketplaceShippedAt: first }) }))).toMatchObject({
      kind: "update",
      effects: { marketplaceShippedAt: null, reviewFlags: ["tiktok_ship_time_changed"] },
    });
    expect(decideTikTokOrder(input({ status: "DELIVERED", collectionTime: first, admin: admin({ status: "shipped", marketplaceShippedAt: first }) }))).toMatchObject({
      kind: "update",
      effects: { marketplaceShippedAt: null, reviewFlags: [] },
    });
  });

  test("DELIVERED stays shipped", () => {
    expect(decideTikTokOrder(input({ status: "DELIVERED", collectionTime: PAID, admin: admin({ status: "shipped" }) }))).toMatchObject({ kind: "update", transitions: [] });
    expect(decideTikTokOrder(input({ status: "DELIVERED", collectionTime: PAID, admin: admin() }))).toMatchObject({ kind: "update", transitions: ["shipped"] });
  });

  test("COMPLETED → completed (through shipped when needed)", () => {
    expect(decideTikTokOrder(input({ status: "COMPLETED", collectionTime: PAID, admin: admin() }))).toMatchObject({ kind: "update", transitions: ["shipped", "completed"] });
    expect(decideTikTokOrder(input({ status: "COMPLETED", collectionTime: PAID, admin: admin({ status: "shipped" }) }))).toMatchObject({ kind: "update", transitions: ["completed"] });
  });

  test("COMPLETED never clears a return (a refund in transit ends as COMPLETED)", () => {
    const decision = decideTikTokOrder(input({ status: "COMPLETED", collectionTime: PAID, admin: admin({ status: "shipped", needsAttention: ["marketplace_return_pending", "marketplace_return_in_transit"] }) }));
    expect(decision.kind).toBe("update");
    if (decision.kind !== "update") return;
    expect(decision.effects.removeFlags).not.toContain("marketplace_return_pending");
    expect(decision.effects.removeFlags).not.toContain("marketplace_return_in_transit");
  });

  test("CANCELLED before shipping → cancelled (stock restored by the transition)", () => {
    expect(decideTikTokOrder(input({ status: "CANCELLED", cancelTime: NOW, admin: admin() }))).toMatchObject({ kind: "update", transitions: ["cancelled"] });
    expect(decideTikTokOrder(input({ status: "CANCELLED", cancelTime: NOW, admin: admin({ status: "awaiting_payment" }) }))).toMatchObject({ kind: "update", transitions: ["cancelled"] });
  });

  test("CANCELLED after shipping (failed delivery, Q11) → flags and marketplace_returned_at only, never returned", () => {
    const cancelTime = new Date(NOW.getTime() - HOUR);
    for (const status of ["shipped", "completed"] as const) {
      const decision = decideTikTokOrder(input({ status: "CANCELLED", cancelTime, admin: admin({ status }) }));
      expect(decision).toMatchObject({ kind: "update", transitions: [], effects: { addFlags: ["marketplace_return_pending", "marketplace_return_in_transit"], marketplaceReturnedAt: cancelTime } });
    }
  });

  test("CANCELLED with a collection_time while admin still says to_ship (IN_TRANSIT never applied): the parcel left, so flags only, never a stock return", () => {
    const cancelTime = new Date(NOW.getTime() - HOUR);
    const decision = decideTikTokOrder(input({ status: "CANCELLED", cancelTime, collectionTime: new Date(NOW.getTime() - 5 * HOUR), admin: admin() }));
    expect(decision).toMatchObject({ kind: "update", transitions: [], effects: { addFlags: ["marketplace_return_pending", "marketplace_return_in_transit", "marketplace_review"], marketplaceReturnedAt: cancelTime } });
  });

  test("terminal stays terminal: a returned order never moves; a cancelled one never revives", () => {
    expect(decideTikTokOrder(input({ status: "COMPLETED", collectionTime: PAID, admin: admin({ status: "returned" }) }))).toMatchObject({ kind: "update", transitions: [] });
    expect(decideTikTokOrder(input({ status: "CANCELLED", admin: admin({ status: "cancelled" }) }))).toMatchObject({ kind: "update", transitions: [] });
    expect(decideTikTokOrder(input({ status: "IN_TRANSIT", collectionTime: PAID, admin: admin({ status: "cancelled" }) }))).toMatchObject({ kind: "hold", reason: "final_in_admin" });
  });

  test("lines that differ from the hand-typed order are held (lines_differ); prices typed by hand are not compared", () => {
    expect(decideTikTokOrder(input({ admin: admin({ lines: [{ sku: SKU_A, qty: 1 }] }) }))).toMatchObject({ kind: "hold", reason: "lines_differ" });
    expect(decideTikTokOrder(input({ admin: admin({ lines: [{ sku: SKU_A, qty: 2 }, { sku: SKU_B, qty: 1 }] }) }))).toMatchObject({ kind: "hold", reason: "lines_differ" });
    expect(decideTikTokOrder(input({ admin: admin() }))).toMatchObject({ kind: "update" });
  });

  test("an unmapped SKU holds an existing order too; a cancel goes through anyway", () => {
    const mappings = new Map([["tt-a", SKU_A]]);
    expect(decideTikTokOrder(input({ mappings, admin: admin() }))).toMatchObject({ kind: "hold", reason: "unknown_sku" });
    expect(decideTikTokOrder(input({ status: "CANCELLED", mappings, admin: admin() }))).toMatchObject({ kind: "update", transitions: ["cancelled"] });
  });

  test("an existing order's amounts are never re-read: a money problem does not hold it", () => {
    const bad = payload({ payment: { currency: "IDR", seller_discount: "1.5" } });
    expect(decideTikTokOrder(input({ payload: bad, admin: admin() }))).toMatchObject({ kind: "update" });
  });
});
