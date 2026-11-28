import { describe, expect, test } from "vitest";
import { CHANNEL_FEE_COMPONENTS } from "@ammari/db/schema";
import {
  TIKTOK_FEE_TYPE_COMPONENTS,
  checkTikTokStatementSum,
  checkTikTokTransactionFeeSums,
  decideTikTokOrderFees,
  tiktokFeeComponent,
  type TikTokFeeEvidence,
} from "./finance-rules";

// docs/plans/tiktok-shop-integration.md §5.3, T7 (decided Q8, Q9): the fee-type table, estimate then
// actual, and the sum checks. Pure, table-driven.

const line = (group: "fee" | "tax" | "shipping", type: string, amount: number, skuId = "") => ({ skuId, group, type, amount });

function evidence(overrides: Partial<TikTokFeeEvidence> = {}): TikTokFeeEvidence {
  return { estimate: { lines: [], held: null, transactions: 0 }, actual: { lines: [], held: null, pending: 0, transactions: 0 }, ...overrides };
}

describe("the fee-type table", () => {
  test("every row maps to an order_channel_fees component; only shipping rows go to seller_shipping_subsidy (6-1202), the rest to 6-1201 components", () => {
    for (const [key, component] of Object.entries(TIKTOK_FEE_TYPE_COMPONENTS)) {
      expect(CHANNEL_FEE_COMPONENTS).toContain(component);
      if (component === "seller_shipping_subsidy") expect(key.startsWith("shipping.")).toBe(true);
      else expect(key.startsWith("shipping.")).toBe(false);
    }
  });

  test("never the Midtrans MDR component and never `other` by default", () => {
    const components = new Set(Object.values(TIKTOK_FEE_TYPE_COMPONENTS));
    expect(components.has("payment_gateway_fee" as never)).toBe(false);
    expect(components.has("other")).toBe(false);
  });

  test("covers the fee types the tests' TikTok fixtures use", () => {
    for (const [group, type] of [
      ["fee", "platform_commission_amount"],
      ["fee", "transaction_fee_amount"],
      ["fee", "affiliate_commission_amount"],
      ["shipping", "actual_shipping_fee_amount"],
      ["shipping", "customer_paid_shipping_fee_amount"],
    ] as const) {
      expect(tiktokFeeComponent(group, type)).not.toBeNull();
    }
  });

  test("an unknown type has no component (held, never `other`)", () => {
    expect(tiktokFeeComponent("fee", "brand_new_fee_amount")).toBeNull();
    expect(tiktokFeeComponent("tax", "platform_commission_amount")).toBeNull();
    expect(tiktokFeeComponent("fee", "__proto__")).toBeNull();
  });
});

describe("decideTikTokOrderFees", () => {
  test("no estimate and no actual yet → nothing to write (never zero fees)", () => {
    expect(decideTikTokOrderFees(evidence())).toEqual({ kind: "none" });
  });

  test("an estimate only → its components, source estimate; a cost is TikTok's negative amount", () => {
    const decision = decideTikTokOrderFees(
      evidence({ estimate: { lines: [line("fee", "platform_commission_amount", -14940), line("fee", "transaction_fee_amount", -9060), line("shipping", "actual_shipping_fee_amount", -15000), line("shipping", "customer_paid_shipping_fee_amount", 12000)], held: null, transactions: 1 } }),
    );
    expect(decision).toEqual({ kind: "write", source: "estimate", components: { platform_commission: 14940, admin_fee: 9060, seller_shipping_subsidy: 3000 } });
  });

  test("the actual replaces the estimate once every settled transaction of the order has its lines", () => {
    const decision = decideTikTokOrderFees(
      evidence({
        estimate: { lines: [line("fee", "platform_commission_amount", -14940)], held: null, transactions: 1 },
        actual: { lines: [line("fee", "platform_commission_amount", -9000, "a"), line("fee", "platform_commission_amount", -5000, "b")], held: null, pending: 0, transactions: 1 },
      }),
    );
    expect(decision).toEqual({ kind: "write", source: "actual", components: { platform_commission: 14000 } });
  });

  test("an order refund in a later statement nets against the order's fees (actual across transactions)", () => {
    const decision = decideTikTokOrderFees(evidence({ actual: { lines: [line("fee", "platform_commission_amount", -14940), line("fee", "platform_commission_amount", 4940)], held: null, pending: 0, transactions: 2 } }));
    expect(decision).toEqual({ kind: "write", source: "actual", components: { platform_commission: 10000 } });
  });

  test("an actual whose lines are not fetched yet keeps the estimate", () => {
    const decision = decideTikTokOrderFees(evidence({ estimate: { lines: [line("fee", "platform_commission_amount", -100)], held: null, transactions: 1 }, actual: { lines: [], held: null, pending: 1, transactions: 1 } }));
    expect(decision).toEqual({ kind: "write", source: "estimate", components: { platform_commission: 100 } });
  });

  test("a settled order with no estimate and lines not fetched yet → nothing (waits)", () => {
    expect(decideTikTokOrderFees(evidence({ actual: { lines: [], held: null, pending: 1, transactions: 1 } }))).toEqual({ kind: "none" });
  });

  test("an unknown fee type holds the order's fees, naming the types; nothing summed into other", () => {
    const decision = decideTikTokOrderFees(
      evidence({ actual: { lines: [line("fee", "platform_commission_amount", -100), line("fee", "brand_new_fee_amount", -5), line("tax", "vat_amount", -1), line("fee", "brand_new_fee_amount", -5, "b")], held: null, pending: 0, transactions: 1 } }),
    );
    expect(decision).toEqual({ kind: "held", source: "actual", reason: "fee_type_unmapped", unmappedTypes: ["fee.brand_new_fee_amount", "tax.vat_amount"] });
  });

  test("a component whose net is a credit (negative cost) is held, never stored as a negative fee", () => {
    expect(decideTikTokOrderFees(evidence({ estimate: { lines: [line("fee", "platform_commission_amount", 100)], held: null, transactions: 1 } }))).toMatchObject({ kind: "held", reason: "fee_negative", source: "estimate" });
  });

  test("an actual transaction held (money format, sums) holds the fees; it never falls back to the estimate", () => {
    const decision = decideTikTokOrderFees(evidence({ estimate: { lines: [line("fee", "platform_commission_amount", -100)], held: null, transactions: 1 }, actual: { lines: [], held: "fee_sum_mismatch", pending: 0, transactions: 1 } }));
    expect(decision).toEqual({ kind: "held", source: "actual", reason: "fee_sum_mismatch", unmappedTypes: [] });
  });

  test("an estimate held for money format holds the order until an actual arrives", () => {
    expect(decideTikTokOrderFees(evidence({ estimate: { lines: [], held: "money_format", transactions: 1 } }))).toMatchObject({ kind: "held", reason: "money_format", source: "estimate" });
  });

  test("a settled refund whose lines are not fetched yet never sends an order back from actual to estimate", () => {
    const decision = decideTikTokOrderFees(
      evidence({ estimate: { lines: [line("fee", "platform_commission_amount", -999)], held: null, transactions: 1 }, actual: { lines: [line("fee", "platform_commission_amount", -100)], held: null, pending: 1, transactions: 2 } }),
    );
    expect(decision).toEqual({ kind: "none" });
  });

  test("an unknown type with a zero amount does not hold the order", () => {
    expect(decideTikTokOrderFees(evidence({ actual: { lines: [line("fee", "platform_commission_amount", -100), line("tax", "vat_amount", 0)], held: null, pending: 0, transactions: 1 } }))).toEqual({
      kind: "write",
      source: "actual",
      components: { platform_commission: 100 },
    });
  });

  test("zero-cost components are left out", () => {
    expect(decideTikTokOrderFees(evidence({ estimate: { lines: [line("fee", "platform_commission_amount", -100), line("fee", "transaction_fee_amount", 0)], held: null, transactions: 1 } }))).toEqual({
      kind: "write",
      source: "estimate",
      components: { platform_commission: 100 },
    });
  });
});

describe("sum checks", () => {
  test("a transaction's fee lines add up to its fee_tax and shipping totals", () => {
    const lines = [line("fee", "a_amount", -100, "x"), line("tax", "b_amount", -10, "y"), line("shipping", "c_amount", -50)];
    expect(checkTikTokTransactionFeeSums(lines, { feeTax: -110, shippingCost: -50 })).toBe(true);
    expect(checkTikTokTransactionFeeSums(lines, { feeTax: -100, shippingCost: -50 })).toBe(false);
    expect(checkTikTokTransactionFeeSums(lines, { feeTax: -110, shippingCost: -49 })).toBe(false);
  });

  test("an absent total never passes (a renamed total or breakdown is not \"no fees\")", () => {
    expect(checkTikTokTransactionFeeSums([line("fee", "a_amount", -1)], { feeTax: null, shippingCost: -0 })).toBe(false);
    expect(checkTikTokTransactionFeeSums([], { feeTax: null, shippingCost: null })).toBe(false);
    expect(checkTikTokTransactionFeeSums([], { feeTax: 0, shippingCost: 0 })).toBe(true);
    expect(checkTikTokTransactionFeeSums([], { feeTax: -100, shippingCost: 0 })).toBe(false);
  });

  test("a statement's transactions add up to its settlement", () => {
    expect(checkTikTokStatementSum(205000, [225000, -20000])).toBe(true);
    expect(checkTikTokStatementSum(205000, [225000])).toBe(false);
    expect(checkTikTokStatementSum(null, [1])).toBe(false);
  });
});
