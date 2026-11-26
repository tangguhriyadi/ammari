import { describe, expect, test } from "vitest";
import { MANUAL_ORDER_PAYMENT_METHODS } from "@ammari/db/schema";
import { isCashBankAccountCode } from "../src/mapping-rules";
import {
  MANUAL_PAYMENT_MISSING_ISSUE,
  isManualPaymentOrder,
  manualOrderMoneyIn,
  suggestedCashAccountFor,
} from "../src/rules/manual-orders";
import { resolveOrIssue, type PostingOutcome } from "../src/rules/types";
import { defaultContext } from "./context";

// Session 6, D-3 (docs/plans/accounting.md §4.1 S6): manual-order payment method + account.

describe("isManualPaymentOrder", () => {
  test.each(["whatsapp", "instagram", "offline", "web", "reseller"])("a staff-entered %s order needs a payment record", (channelId) => {
    expect(isManualPaymentOrder({ channelId, paymentStatus: null })).toBe(true);
  });

  test.each(["shopee", "tiktok"])("a %s order never does (its money is Saldo Penjual, D-11)", (channelId) => {
    expect(isManualPaymentOrder({ channelId, paymentStatus: null })).toBe(false);
  });

  test("a web checkout order never does (Midtrans, W1)", () => {
    expect(isManualPaymentOrder({ channelId: "web", paymentStatus: "paid" })).toBe(false);
    expect(isManualPaymentOrder({ channelId: "web", paymentStatus: "pending" })).toBe(false);
  });
});

describe("suggestedCashAccountFor (the shipped mappings, D-17, D-18)", () => {
  const { mappings } = defaultContext();

  test("cash -> 1-1101 Kas tunai", () => {
    expect(suggestedCashAccountFor("cash", mappings)).toBe("1-1101");
  });

  test("transfer -> 1-1201 Bank utama", () => {
    expect(suggestedCashAccountFor("transfer", mappings)).toBe("1-1201");
  });

  test("card is a debit card -> 1-1201 Bank utama", () => {
    expect(suggestedCashAccountFor("card", mappings)).toBe("1-1201");
  });

  test("every method's suggestion is a Kas & Bank account", () => {
    for (const method of MANUAL_ORDER_PAYMENT_METHODS) expect(isCashBankAccountCode(suggestedCashAccountFor(method, mappings) ?? "")).toBe(true);
  });

  test("follows the accountant's re-mapping", () => {
    const remapped = defaultContext({ mappings: { "cash.method.transfer": "1-1202" } }).mappings;
    expect(suggestedCashAccountFor("transfer", remapped)).toBe("1-1202");
  });

  test("an unmapped method suggests nothing (staff pick), never a fallback account", () => {
    const unmapped = defaultContext({ mappings: { "cash.method.card": null } }).mappings;
    expect(suggestedCashAccountFor("card", unmapped)).toBeNull();
  });
});

describe("manualOrderMoneyIn (S6's money side)", () => {
  const order = { orderId: "33333333-3333-4333-8333-333333333333", orderNo: "ORD-20261205-0001" };

  test("uses exactly the recorded account and day", () => {
    const payment = { method: "card" as const, cashAccountCode: "1-1201", paidOn: "2026-12-05" };
    expect(manualOrderMoneyIn({ ...order, payment })).toEqual(payment);
  });

  test("a staff-picked account wins over the method's mapping", () => {
    const payment = { method: "transfer" as const, cashAccountCode: "1-1101", paidOn: "2026-12-05" };
    expect(manualOrderMoneyIn({ ...order, payment }).cashAccountCode).toBe("1-1101");
  });

  test("an order without a record is a posting issue, never a default account", () => {
    const outcome: PostingOutcome = resolveOrIssue(() => {
      manualOrderMoneyIn({ ...order, payment: null });
      return { kind: "none" };
    });
    expect(outcome).toEqual({ kind: "issue", issueCode: MANUAL_PAYMENT_MISSING_ISSUE, details: order });
  });
});
