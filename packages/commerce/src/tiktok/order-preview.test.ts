import { describe, expect, test } from "vitest";
import { previewTikTokOrder, tiktokMoneyProblem } from "./order-preview";

// docs/plans/tiktok-shop-integration.md T4: the dry run ("Akan dibuat / ditahan"). Pure.

const line = (skuId: string, extra: Record<string, unknown> = {}) => ({ sku_id: skuId, seller_sku: "X", original_price: "259000", seller_discount: "0", ...extra });
const payload = (extra: Record<string, unknown> = {}) => ({ payment: { currency: "IDR", sub_total: "259000", total_amount: "259000" }, line_items: [line("s1")], ...extra });
const mapped = new Set(["s1", "s2"]);

describe("previewTikTokOrder", () => {
  test("a paid order with every SKU mapped would be created; one already typed in admin would be matched", () => {
    expect(previewTikTokOrder({ status: "AWAITING_SHIPMENT", payload: payload(), mappedSkuIds: mapped, inAdmin: false })).toEqual({ kind: "create", reviewPartialShipping: false });
    expect(previewTikTokOrder({ status: "ON_HOLD", payload: payload(), mappedSkuIds: mapped, inAdmin: true })).toEqual({ kind: "update", reviewPartialShipping: false });
  });

  test("an unknown SKU, or a line without a SKU id, is held as unknown_sku", () => {
    expect(previewTikTokOrder({ status: "AWAITING_SHIPMENT", payload: payload({ line_items: [line("s1"), line("zz")] }), mappedSkuIds: mapped, inAdmin: false })).toEqual({ kind: "held", reason: "unknown_sku", detail: "zz" });
    expect(previewTikTokOrder({ status: "AWAITING_SHIPMENT", payload: payload({ line_items: [{ seller_sku: "X" }] }), mappedSkuIds: mapped, inAdmin: false })).toMatchObject({ kind: "held", reason: "unknown_sku" });
  });

  test("UNPAID and CANCELLED-before-admin are skipped; an unknown status is held, never guessed", () => {
    expect(previewTikTokOrder({ status: "UNPAID", payload: payload(), mappedSkuIds: mapped, inAdmin: false })).toEqual({ kind: "skip", reason: "unpaid" });
    expect(previewTikTokOrder({ status: "CANCELLED", payload: payload(), mappedSkuIds: mapped, inAdmin: false })).toEqual({ kind: "skip", reason: "cancelled" });
    expect(previewTikTokOrder({ status: "SOMETHING_NEW", payload: payload(), mappedSkuIds: mapped, inAdmin: false })).toEqual({ kind: "held", reason: "unknown_status", detail: "SOMETHING_NEW" });
  });

  test("money that is not whole rupiah is held as money_format, never rounded", () => {
    expect(tiktokMoneyProblem(payload({ payment: { total_amount: "125000.50" } }))).toBe("payment.total_amount");
    expect(tiktokMoneyProblem(payload({ line_items: [line("s1", { original_price: 259000 })] }))).toBe("line_items.original_price");
    expect(tiktokMoneyProblem(payload({ payment: { currency: "USD" } }))).toBe("payment.currency");
    // No amounts at all is held, never read as zero.
    expect(tiktokMoneyProblem(payload({ payment: undefined }))).toBe("payment");
    expect(previewTikTokOrder({ status: "AWAITING_SHIPMENT", payload: payload({ payment: { sub_total: "1e5" } }), mappedSkuIds: mapped, inAdmin: false })).toEqual({ kind: "held", reason: "money_format", detail: "payment.sub_total" });
  });

  test("PARTIALLY_SHIPPING or more than one package is created with a review note (Q2)", () => {
    expect(previewTikTokOrder({ status: "PARTIALLY_SHIPPING", payload: payload(), mappedSkuIds: mapped, inAdmin: false })).toEqual({ kind: "create", reviewPartialShipping: true });
    const twoPackages = payload({ line_items: [line("s1", { package_id: "p1" }), line("s2", { package_id: "p2" })] });
    expect(previewTikTokOrder({ status: "AWAITING_COLLECTION", payload: twoPackages, mappedSkuIds: mapped, inAdmin: false })).toEqual({ kind: "create", reviewPartialShipping: true });
  });
});
