import { describe, expect, test } from "vitest";
import { ORDER_ATTENTION_FLAGS } from "@ammari/db/schema";
import { ATTENTION_FLAG_COPY, attentionFlagCopy, isKnownAttentionFlag } from "./checkout-labels";

// docs/plans/cart-checkout.md §3 (Phase K2 rollback note): the order page must render any flag,
// including one a newer release wrote before this build was rolled back to.
describe("attention flag copy", () => {
  test("every flag the database allows has its own copy", () => {
    expect(Object.keys(ATTENTION_FLAG_COPY).sort()).toEqual([...ORDER_ATTENTION_FLAGS].sort());
  });

  test("an unknown flag gets a generic copy and is not offered for clearing", () => {
    expect(attentionFlagCopy("from_a_newer_release")).toEqual({ label: "Tanda lain (from_a_newer_release)", meaning: expect.any(String) });
    expect(isKnownAttentionFlag("from_a_newer_release")).toBe(false);
    expect(isKnownAttentionFlag("toString")).toBe(false);
    expect(isKnownAttentionFlag("shipping_cost_over_quote")).toBe(true);
    expect(attentionFlagCopy("tracking_number_mismatch").label).toBe("Resi beda dengan pesanan kurir");
  });
});
