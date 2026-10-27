import { describe, expect, test } from "vitest";
import { MAX_ADJUSTMENT_REASON_LENGTH } from "@ammari/commerce/voucher-adjustments";
import { MAX_VOUCHER_REASON_LENGTH, isPromoWithdrawalSource } from "./consent-options";

// The dialogs' limits are a client-safe copy of the server's (docs/plans/growth.md §8.3, §9.3).

describe("consent options", () => {
  test("the voucher reason limit matches the server's", () => {
    expect(MAX_VOUCHER_REASON_LENGTH).toBe(MAX_ADJUSTMENT_REASON_LENGTH);
  });

  test("only the known sources pass", () => {
    expect(isPromoWithdrawalSource("whatsapp")).toBe(true);
    expect(isPromoWithdrawalSource("sms")).toBe(false);
  });
});
