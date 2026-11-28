import { describe, expect, test } from "vitest";
import { pairAdsLines, reconcileSellerBalance, reconcileTikTokOrder, reconcileTotal } from "./tiktok-reconciliation-rules";

describe("Rekonsiliasi TikTok Shop, the pure checks (T8)", () => {
  test("(a) per order: equal once settled, waiting before, a difference is red unless the sale is before the books", () => {
    expect(reconcileTikTokOrder({ ledger: 220_400, settlement: 220_400, startsBeforeBooks: false }).status).toBe("ok");
    expect(reconcileTikTokOrder({ ledger: 220_400, settlement: null, startsBeforeBooks: false })).toMatchObject({ status: "explained", difference: 0 });
    expect(reconcileTikTokOrder({ ledger: 220_400, settlement: 220_000, startsBeforeBooks: false })).toMatchObject({ status: "mismatch", difference: 400 });
    expect(reconcileTikTokOrder({ ledger: 0, settlement: 220_000, startsBeforeBooks: true }).status).toBe("review");
  });

  test("(b)/(c) a total against its parts; unknown is never equal", () => {
    expect(reconcileTotal(100, 100)).toEqual({ difference: 0, status: "ok" });
    expect(reconcileTotal(100, 90)).toEqual({ difference: 10, status: "mismatch" });
    expect(reconcileTotal(null, 90).status).toBe("mismatch");
    expect(reconcileTotal(100, null)).toEqual({ difference: null, status: "review" });
    expect(reconcileTotal(0, null)).toEqual({ difference: 0, status: "ok" });
  });

  test("(d) the balance against unsettled + settled-not-paid-out is a review item when it differs", () => {
    expect(reconcileSellerBalance(300, 100, 200)).toEqual({ expected: 300, difference: 0, status: "ok" });
    expect(reconcileSellerBalance(350, 100, 200)).toEqual({ expected: 300, difference: 50, status: "review" });
  });

  test("ads pairs: same month and amount, one to one", () => {
    const pairs = pairAdsLines(
      [
        { id: "j1", month: "2027-01", amount: 75_000, label: "ADS_PAYMENT" },
        { id: "j2", month: "2027-01", amount: 75_000, label: "ADS_PAYMENT" },
        { id: "j3", month: "2027-02", amount: 75_000, label: "ADS_PAYMENT" },
      ],
      [
        { id: "e1", month: "2027-01", amount: 75_000, label: "BYA-1" },
        { id: "e2", month: "2027-01", amount: 50_000, label: "BYA-2" },
      ],
    );
    expect(pairs.map((pair) => [pair.adjustment.id, pair.expense.id])).toEqual([["j1", "e1"]]);
  });
});
