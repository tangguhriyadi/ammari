import { describe, expect, test } from "vitest";
import { resolveCardBuyerName } from "./card-copy";

describe("resolveCardBuyerName", () => {
  test("uses the customer name when present and unmasked", () => {
    expect(resolveCardBuyerName({ customerName: "Ibu Sari", buyerUsername: "sari_shop99" })).toBe("Ibu Sari");
  });

  test("falls back to buyerUsername when customerName contains a marketplace mask ('*')", () => {
    expect(resolveCardBuyerName({ customerName: "Bu S***i", buyerUsername: "sari_shop99" })).toBe("sari_shop99");
  });

  test("falls back to 'Kakak' when both customerName is masked and buyerUsername is null", () => {
    expect(resolveCardBuyerName({ customerName: "S***", buyerUsername: null })).toBe("Kakak");
  });

  test("falls back to buyerUsername when customerName is null", () => {
    expect(resolveCardBuyerName({ customerName: null, buyerUsername: "sari_shop99" })).toBe("sari_shop99");
  });

  test("falls back to 'Kakak' when both are null", () => {
    expect(resolveCardBuyerName({ customerName: null, buyerUsername: null })).toBe("Kakak");
  });
});
