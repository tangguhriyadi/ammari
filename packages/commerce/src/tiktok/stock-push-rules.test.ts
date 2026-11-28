import { describe, expect, test } from "vitest";
import {
  TIKTOK_STOCK_LISTING_MAX_AGE_MS,
  TIKTOK_STOCK_PUSH_MAX_BACKOFF_MS,
  decideTikTokSkuPush,
  planTikTokProductPush,
  tiktokStockPushBackoffMs,
  tiktokStockPushErrorAction,
  type TikTokPushCandidate,
} from "./stock-push-rules";

// docs/plans/tiktok-stock-sync.md §7 (S2): the pure rules of the push. What is sent for one product,
// what is skipped as unchanged, what is held (and why), how a TikTok error is handled, and the retry
// backoff. No database, no TikTok.

const NOW = new Date("2026-12-02T03:00:00.000Z");
const MIN = 60_000;

function candidate(overrides: Partial<TikTokPushCandidate> = {}): TikTokPushCandidate {
  return {
    skuId: "s-a",
    mappedVariantSku: "SKU-A",
    listingVariantSku: "SKU-A",
    listingHoldReason: null,
    warehouseId: "wh-own",
    tiktokQuantity: 2,
    readAt: new Date(NOW.getTime() - 10 * MIN),
    lastPushedQuantity: null,
    lastPushedAt: null,
    lastPushErrorCode: null,
    lastPushErrorAt: null,
    listingsForVariant: 1,
    target: { kind: "push", quantity: 6, breakdown: { physical: 6, checkoutHolds: 0, heldTikTokOrders: 0 } },
    ...overrides,
  };
}

const push = (quantity: number) => ({ kind: "push" as const, quantity, breakdown: { physical: quantity, checkoutHolds: 0, heldTikTokOrders: 0 } });

describe("decideTikTokSkuPush: what to send (diff)", () => {
  test("the first push compares with TikTok's read quantity: different → send (decision 3: Ammari overwrites)", () => {
    expect(decideTikTokSkuPush(candidate(), NOW)).toEqual({ kind: "send", quantity: 6 });
  });

  test("the first push when TikTok already shows the target → unchanged, no call", () => {
    expect(decideTikTokSkuPush(candidate({ tiktokQuantity: 6 }), NOW)).toEqual({ kind: "unchanged", quantity: 6 });
  });

  test("target = last pushed, and TikTok's read (newer than the push) agrees → unchanged", () => {
    const c = candidate({ tiktokQuantity: 6, lastPushedQuantity: 6, lastPushedAt: new Date(NOW.getTime() - 20 * MIN) });
    expect(decideTikTokSkuPush(c, NOW)).toEqual({ kind: "unchanged", quantity: 6 });
  });

  test("target = last pushed, the read predates that push (it is no evidence of drift) → unchanged", () => {
    const c = candidate({ tiktokQuantity: 9, lastPushedQuantity: 6, lastPushedAt: new Date(NOW.getTime() - 5 * MIN) });
    expect(decideTikTokSkuPush(c, NOW)).toEqual({ kind: "unchanged", quantity: 6 });
  });

  test("target = last pushed but a read AFTER the push shows something else (a Seller Center edit) → send again", () => {
    const c = candidate({ tiktokQuantity: 9, lastPushedQuantity: 6, lastPushedAt: new Date(NOW.getTime() - 30 * MIN) });
    expect(decideTikTokSkuPush(c, NOW)).toEqual({ kind: "send", quantity: 6 });
  });

  test("target differs from the last push → send, whatever TikTok showed", () => {
    const c = candidate({ tiktokQuantity: 6, lastPushedQuantity: 6, lastPushedAt: new Date(NOW.getTime() - 30 * MIN), target: push(4) });
    expect(decideTikTokSkuPush(c, NOW)).toEqual({ kind: "send", quantity: 4 });
  });

  test("a target of 0 is sent (sold out), never skipped as falsy", () => {
    expect(decideTikTokSkuPush(candidate({ target: push(0), tiktokQuantity: 3 }), NOW)).toEqual({ kind: "send", quantity: 0 });
  });
});

describe("decideTikTokSkuPush: holds (every rule only holds, never guesses)", () => {
  test.each([
    ["unmapped at push time (mapping removed since the read)", { mappedVariantSku: null }, "unmapped"],
    ["mapping now names another variant than the read stored", { mappedVariantSku: "SKU-B" }, "mapping_changed"],
    ["listing hold from the read (status)", { listingHoldReason: "status_not_updatable" }, "status_not_updatable"],
    ["listing hold from the read (not listed)", { listingHoldReason: "not_listed" }, "not_listed"],
    ["an unknown stored hold (a newer release's) fails closed", { listingHoldReason: "something_new" }, "invalid_input"],
    ["no own warehouse", { warehouseId: null }, "warehouse_unclear"],
    ["TikTok quantity unknown", { tiktokQuantity: null }, "quantity_unreadable"],
    ["R7 recomputed at push time: two pushable listings for the variant", { listingsForVariant: 2 }, "variant_on_several_listings"],
    ["R11: the row's read is older than 2 h", { readAt: new Date(NOW.getTime() - TIKTOK_STOCK_LISTING_MAX_AGE_MS - 1) }, "listing_stale"],
    ["the target is held (unreadable held TikTok order)", { target: { kind: "hold", reason: "tiktok_order_unclear" } }, "tiktok_order_unclear"],
    ["a promotion lock refused the last push: held until a person acts", { lastPushErrorCode: "12052393", lastPushErrorAt: new Date(NOW.getTime() - MIN) }, "push_refused"],
    ["a status error refused the last push, no newer read yet", { lastPushErrorCode: "12052901", lastPushErrorAt: new Date(NOW.getTime() - MIN) }, "awaiting_reread"],
  ] as const)("%s", (_name, overrides, reason) => {
    expect(decideTikTokSkuPush(candidate(overrides as Partial<TikTokPushCandidate>), NOW)).toEqual({ kind: "held", reason });
  });

  test("R7 hold stored by the read is ignored when the tables say there is only one listing now", () => {
    expect(decideTikTokSkuPush(candidate({ listingHoldReason: "variant_on_several_listings", listingsForVariant: 1 }), NOW)).toEqual({ kind: "send", quantity: 6 });
  });

  test("a status error is retried once a NEWER read saw the listing again", () => {
    const c = candidate({ lastPushErrorCode: "12052901", lastPushErrorAt: new Date(NOW.getTime() - 20 * MIN), readAt: new Date(NOW.getTime() - 5 * MIN) });
    expect(decideTikTokSkuPush(c, NOW)).toEqual({ kind: "send", quantity: 6 });
  });

  test("a retryable error code on the row does not hold it (the outbox backoff decides when)", () => {
    expect(decideTikTokSkuPush(candidate({ lastPushErrorCode: "rate_limited", lastPushErrorAt: new Date(NOW.getTime() - MIN) }), NOW)).toEqual({ kind: "send", quantity: 6 });
  });
});

describe("planTikTokProductPush: one call per product", () => {
  test("every dirty, pushable SKU of the product goes into one body with its own warehouse only", () => {
    const plan = planTikTokProductPush(
      [
        candidate({ skuId: "s-a", target: push(6) }),
        candidate({ skuId: "s-b", mappedVariantSku: "SKU-B", listingVariantSku: "SKU-B", target: push(1) }),
        candidate({ skuId: "s-c", mappedVariantSku: null, listingVariantSku: null, listingHoldReason: "unmapped" }),
        candidate({ skuId: "s-d", mappedVariantSku: "SKU-D", listingVariantSku: "SKU-D", tiktokQuantity: 4, target: push(4) }),
      ],
      NOW,
    );
    expect(plan.send).toEqual([
      { skuId: "s-a", warehouseId: "wh-own", quantity: 6 },
      { skuId: "s-b", warehouseId: "wh-own", quantity: 1 },
    ]);
    expect(plan.decisions.get("s-c")).toEqual({ kind: "held", reason: "unmapped" });
    expect(plan.decisions.get("s-d")).toEqual({ kind: "unchanged", quantity: 4 });
  });

  test("more than 100 SKUs to send in one product: nothing is sent, all held (R8)", () => {
    const many = Array.from({ length: 101 }, (_, i) => candidate({ skuId: `s-${i}`, mappedVariantSku: `V-${i}`, listingVariantSku: `V-${i}` }));
    const plan = planTikTokProductPush(many, NOW);
    expect(plan.send).toEqual([]);
    expect([...plan.decisions.values()].every((d) => d.kind === "held" && d.reason === "product_too_many_skus")).toBe(true);
  });

  test("the same TikTok SKU twice in the input is refused (a programming error, never two entries in a body)", () => {
    expect(() => planTikTokProductPush([candidate(), candidate()], NOW)).toThrow(/twice/);
  });
});

describe("tiktokStockPushErrorAction: the §0 error codes", () => {
  test.each([
    ["12052393", "promotion_locked"],
    ["12052141", "global_product"],
    ["12052921", "shared_inventory"],
  ])("%s is held until a person acts, never retried in a loop", (code, reason) => {
    expect(tiktokStockPushErrorAction(code)).toEqual({ action: "hold", reason, reread: false });
  });

  test.each([
    ["12052901", "status"],
    ["12052556", "sku"],
    ["12052036", "sku"],
    ["12052097", "warehouse"],
    ["12052530", "warehouse"],
    ["12052531", "warehouse"],
  ])("%s holds the SKU and asks for a re-read of the listings", (code, reason) => {
    expect(tiktokStockPushErrorAction(code)).toEqual({ action: "hold", reason, reread: true });
  });

  test.each(["rate_limited", "unavailable", "network", "budget_exhausted", "refresh_failed", "invalid_response", "reauth_required", "clock_skew", "36009002", "12345678", "api"])("%s is retried with backoff", (code) => {
    expect(tiktokStockPushErrorAction(code)).toEqual({ action: "retry" });
  });
});

describe("tiktokStockPushBackoffMs: 1, 2, 4 ... minutes, at most an hour", () => {
  test("doubles per failure from one minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(tiktokStockPushBackoffMs)).toEqual([1, 2, 4, 8, 16, 32, 60].map((m) => m * MIN));
  });

  test("capped at one hour, also for a huge count", () => {
    expect(tiktokStockPushBackoffMs(50)).toBe(TIKTOK_STOCK_PUSH_MAX_BACKOFF_MS);
    expect(tiktokStockPushBackoffMs(10_000)).toBe(TIKTOK_STOCK_PUSH_MAX_BACKOFF_MS);
  });

  test("a count below 1 or not whole is treated as the first failure", () => {
    expect(tiktokStockPushBackoffMs(0)).toBe(MIN);
    expect(tiktokStockPushBackoffMs(Number.NaN)).toBe(MIN);
  });
});
