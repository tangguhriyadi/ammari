import { describe, expect, test } from "vitest";
import {
  TIKTOK_MAX_STOCK_QUANTITY,
  classifyTikTokListingSku,
  computeTikTokTargetQuantity,
  tiktokHeldOrderQuantities,
  type TikTokHeldOrderInput,
  type TikTokOwnWarehouses,
} from "./stock-sync-rules";

// docs/plans/tiktok-stock-sync.md §2, §5 (S1): the pure rules behind the stock preview and, in S2,
// the push. Nothing here touches a database or TikTok.

const NOW = new Date("2026-12-02T03:00:00.000Z");
const MIN = 60_000;

const hold = (qty: number, expiresInMin: number, status: "active" | "consumed" | "released" = "active") => ({ qty, status, expiresAt: new Date(NOW.getTime() + expiresInMin * MIN) });

describe("computeTikTokTargetQuantity (decision 1, R2, R3)", () => {
  test("physical stock with nothing held is pushed as is (no buffer, decision 2)", () => {
    expect(computeTikTokTargetQuantity({ physicalQty: 7, holds: [], heldTikTokQty: 0, now: NOW })).toEqual({ kind: "push", quantity: 7, breakdown: { physical: 7, checkoutHolds: 0, heldTikTokOrders: 0 } });
  });

  test("active, unexpired checkout holds are subtracted", () => {
    const result = computeTikTokTargetQuantity({ physicalQty: 7, holds: [hold(2, 30), hold(1, 74)], heldTikTokQty: 0, now: NOW });
    expect(result).toMatchObject({ kind: "push", quantity: 4, breakdown: { checkoutHolds: 3 } });
  });

  test("an expired hold the sweep has not released yet no longer counts: TikTok goes back up", () => {
    const result = computeTikTokTargetQuantity({ physicalQty: 7, holds: [hold(2, -1), hold(1, 0)], heldTikTokQty: 0, now: NOW });
    // expires_at = now is expired too (the rule is expires_at > now).
    expect(result).toMatchObject({ kind: "push", quantity: 7, breakdown: { checkoutHolds: 0 } });
  });

  test("released and consumed holds never count (consumed pieces are already a sale in the ledger)", () => {
    const result = computeTikTokTargetQuantity({ physicalQty: 5, holds: [hold(2, 30, "released"), hold(3, 30, "consumed")], heldTikTokQty: 0, now: NOW });
    expect(result).toMatchObject({ kind: "push", quantity: 5 });
  });

  test("paid TikTok orders not applied in admin are subtracted (R2)", () => {
    const result = computeTikTokTargetQuantity({ physicalQty: 5, holds: [hold(1, 10)], heldTikTokQty: 2, now: NOW });
    expect(result).toEqual({ kind: "push", quantity: 2, breakdown: { physical: 5, checkoutHolds: 1, heldTikTokOrders: 2 } });
  });

  test("never below 0", () => {
    expect(computeTikTokTargetQuantity({ physicalQty: 1, holds: [hold(2, 10)], heldTikTokQty: 3, now: NOW })).toMatchObject({ kind: "push", quantity: 0 });
    expect(computeTikTokTargetQuantity({ physicalQty: -4, holds: [], heldTikTokQty: 0, now: NOW })).toMatchObject({ kind: "push", quantity: 0 });
  });

  test("never above 999,999 (TikTok's maximum)", () => {
    expect(TIKTOK_MAX_STOCK_QUANTITY).toBe(999_999);
    expect(computeTikTokTargetQuantity({ physicalQty: 1_500_000, holds: [], heldTikTokQty: 0, now: NOW })).toMatchObject({ kind: "push", quantity: 999_999 });
    expect(computeTikTokTargetQuantity({ physicalQty: 999_999, holds: [], heldTikTokQty: 0, now: NOW })).toMatchObject({ kind: "push", quantity: 999_999 });
  });

  test("an unreadable held TikTok order holds the variant: an unknown quantity is never treated as 0", () => {
    expect(computeTikTokTargetQuantity({ physicalQty: 5, holds: [], heldTikTokQty: 1, heldTikTokUnclear: true, now: NOW })).toEqual({ kind: "hold", reason: "tiktok_order_unclear" });
  });

  test.each([
    ["physical fraction", { physicalQty: 1.5 }],
    ["physical NaN", { physicalQty: Number.NaN }],
    ["held TikTok negative", { heldTikTokQty: -1 }],
    ["hold qty fraction", { holds: [hold(0.5, 10)] }],
    ["hold qty zero", { holds: [hold(0, 10)] }],
    ["hold without a valid date", { holds: [{ qty: 1, status: "active" as const, expiresAt: new Date(Number.NaN) }] }],
  ])("refuses a broken input (%s) instead of computing a number", (_, override) => {
    expect(computeTikTokTargetQuantity({ physicalQty: 5, holds: [], heldTikTokQty: 0, now: NOW, ...override })).toEqual({ kind: "hold", reason: "invalid_input" });
  });
});

describe("tiktokHeldOrderQuantities (R2)", () => {
  const mappings = new Map([
    ["tt-a", "SKU-A"],
    ["tt-a2", "SKU-A"],
    ["tt-b", "SKU-B"],
  ]);
  const order = (id: string, lines: unknown[] | undefined, extra: Partial<TikTokHeldOrderInput> = {}): TikTokHeldOrderInput => ({
    tiktokOrderId: id,
    status: "AWAITING_SHIPMENT",
    paid: true,
    applied: false,
    applyState: "held",
    payload: lines === undefined ? {} : { line_items: lines as never },
    ...extra,
  });

  test("sums pieces per mapped variant across orders and listings; a line without quantity is one piece", () => {
    const result = tiktokHeldOrderQuantities(
      [order("1", [{ sku_id: "tt-a" }, { sku_id: "tt-a" }, { sku_id: "tt-b", quantity: 3 }]), order("2", [{ sku_id: "tt-a2", quantity: 2 }], { applyState: null })],
      mappings,
    );
    expect(Object.fromEntries(result.byVariant)).toEqual({ "SKU-A": 4, "SKU-B": 3 });
    expect([...result.unclearVariants]).toEqual([]);
    expect(result.unattributedOrders).toEqual([]);
    expect(result.unreadableOrders).toEqual([]);
  });

  test("applied, unpaid, cancelled and skipped orders are not held sales", () => {
    const result = tiktokHeldOrderQuantities(
      [
        order("applied", [{ sku_id: "tt-a" }], { applied: true }),
        order("unpaid", [{ sku_id: "tt-a" }], { paid: false }),
        order("unpaid-status", [{ sku_id: "tt-a" }], { status: "UNPAID" }),
        order("cancelled", [{ sku_id: "tt-a" }], { status: "CANCELLED" }),
        order("skip-1", [{ sku_id: "tt-a" }], { applyState: "skipped_unpaid" }),
        order("skip-2", [{ sku_id: "tt-a" }], { applyState: "skipped_undone" }),
      ],
      mappings,
    );
    expect(result.byVariant.size).toBe(0);
  });

  test("short_stock, duplicate and waiting-for-backfill orders count (paid, not in admin)", () => {
    const result = tiktokHeldOrderQuantities([order("s", [{ sku_id: "tt-b" }]), order("d", [{ sku_id: "tt-b" }]), order("w", [{ sku_id: "tt-b" }], { applyState: null })], mappings);
    expect(result.byVariant.get("SKU-B")).toBe(3);
  });

  test("a held order whose lines cannot be read at all (no list, empty, or a non-object line) is unreadable: every push holds", () => {
    const result = tiktokHeldOrderQuantities([order("none", undefined as never), order("empty", []), order("odd", [{ sku_id: "tt-a" }, "junk"])], mappings);
    expect(result.unreadableOrders).toEqual(["empty", "none", "odd"]);
    expect(result.byVariant.get("SKU-A")).toBe(1);
    // An applied or cancelled order with no lines is not a held sale.
    expect(tiktokHeldOrderQuantities([order("x", [], { applied: true }), order("y", [], { status: "CANCELLED" })], mappings).unreadableOrders).toEqual([]);
  });

  test("an unreadable quantity marks the variant unclear; an unmapped line marks the order unattributed", () => {
    const result = tiktokHeldOrderQuantities([order("1", [{ sku_id: "tt-a", quantity: 1.5 }, { sku_id: "tt-b", quantity: 1 }]), order("2", [{ sku_id: "tt-unknown" }, { quantity: 1 }])], mappings);
    expect([...result.unclearVariants]).toEqual(["SKU-A"]);
    expect(result.byVariant.get("SKU-B")).toBe(1);
    expect(result.unattributedOrders).toEqual(["2"]);
  });
});

describe("classifyTikTokListingSku (R4, R5, R10)", () => {
  const own: TikTokOwnWarehouses = new Set(["wh-own"]);
  const sku = (inventory: unknown, status = "ACTIVATE") => classifyTikTokListingSku({ productStatus: status, inventory, ownWarehouses: own });

  test.each(["DRAFT", "PENDING", "FAILED", "ACTIVATE", "SELLER_DEACTIVATED"])("status %s is updatable", (status) => {
    expect(sku([{ warehouse_id: "wh-own", quantity: 3 }], status)).toEqual({ holdReason: null, warehouseId: "wh-own", quantity: 3 });
  });

  test.each(["PLATFORM_DEACTIVATED", "FREEZE", "DELETED", "SOMETHING_NEW", ""])("status %s is held, never pushed", (status) => {
    expect(sku([{ warehouse_id: "wh-own", quantity: 3 }], status)).toMatchObject({ holdReason: "status_not_updatable" });
  });

  test("other (FBT or unknown) warehouses are left alone: exactly one own warehouse is enough", () => {
    expect(sku([{ warehouse_id: "wh-fbt", quantity: 40 }, { warehouse_id: "wh-own", quantity: 2 }])).toEqual({ holdReason: null, warehouseId: "wh-own", quantity: 2 });
  });

  test("an inventory entry without a usable warehouse id makes the warehouse unclear (it could be a second own one)", () => {
    expect(sku([{ warehouse_id: "wh-own", quantity: 2 }, { warehouse_id: null, quantity: 1 }])).toEqual({ holdReason: "warehouse_unclear", warehouseId: null, quantity: null });
  });

  test("zero own warehouses → gudang tidak jelas", () => {
    expect(sku([{ warehouse_id: "wh-fbt", quantity: 4 }])).toEqual({ holdReason: "warehouse_unclear", warehouseId: null, quantity: null });
    expect(sku([])).toMatchObject({ holdReason: "warehouse_unclear" });
    expect(sku(undefined)).toMatchObject({ holdReason: "warehouse_unclear" });
  });

  test("the own warehouse listed twice, or two own warehouses → gudang tidak jelas, never guessed", () => {
    const two = classifyTikTokListingSku({ productStatus: "ACTIVATE", inventory: [{ warehouse_id: "a", quantity: 1 }, { warehouse_id: "b", quantity: 1 }], ownWarehouses: new Set(["a", "b"]) });
    expect(two).toMatchObject({ holdReason: "warehouse_unclear" });
    expect(sku([{ warehouse_id: "wh-own", quantity: 1 }, { warehouse_id: "wh-own", quantity: 2 }])).toMatchObject({ holdReason: "warehouse_unclear" });
  });

  test.each([["3"], [1.5], [-1], [1_000_000], [null], [undefined]])("a TikTok quantity of %j is held as unreadable", (quantity) => {
    expect(sku([{ warehouse_id: "wh-own", quantity }])).toEqual({ holdReason: "quantity_unreadable", warehouseId: "wh-own", quantity: null });
  });

  test("status is checked before the warehouse", () => {
    expect(sku([], "FREEZE")).toMatchObject({ holdReason: "status_not_updatable" });
  });
});
