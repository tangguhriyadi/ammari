import { describe, expect, test } from "vitest";
import { reconcileMaterial, reconcilePayable } from "./reconciliation-rules";

// Rekonsiliasi checks 1 and 2 (docs/plans/accounting.md §6.3, Session 7): what a difference means.

const material = { ledger: 0, receipts: 0, receiptReversals: 0, adjustments: 0, production: 0, legacy: 0, voidsBeforeBooks: 0, beforeBooks: 0 };
const payable = { tagihan: 0, paid: 0, ledgerPayable: 0, ledgerAdvance: 0, ledgerClaim: 0, netReceived: 0, startsBeforeBooks: false };

describe("check 1: raw materials vs the stock ledger", () => {
  test("receipts, reversals and adjustments all journaled: no difference", () => {
    expect(reconcileMaterial({ ...material, ledger: 850_000, receipts: 1_000_000, receiptReversals: -100_000, adjustments: -50_000 })).toMatchObject({
      stockValue: 850_000,
      difference: 0,
      status: "ok",
    });
  });

  test("production consumption, legacy purchases and voids of pre-books receipts are explained, not a mismatch", () => {
    const result = reconcileMaterial({ ...material, ledger: 1_000_000, receipts: 1_000_000, production: -400_000, legacy: 30_000, voidsBeforeBooks: -20_000 });
    expect(result).toMatchObject({ stockValue: 610_000, notJournaled: -390_000, difference: 0, status: "explained" });
  });

  test("an unposted receipt (an open issue) is a mismatch", () => {
    expect(reconcileMaterial({ ...material, ledger: 0, receipts: 500_000 })).toMatchObject({ difference: -500_000, status: "mismatch" });
  });

  test("official books: the opening balance must carry the stock value before the cut-over", () => {
    expect(reconcileMaterial({ ...material, ledger: 2_300_000, beforeBooks: 2_000_000, receipts: 300_000 }).status).toBe("ok");
    expect(reconcileMaterial({ ...material, ledger: 2_250_000, beforeBooks: 2_000_000, receipts: 300_000 })).toMatchObject({ difference: -50_000, status: "mismatch" });
  });
});

describe("check 2: utang per purchase document vs the app's tagihan", () => {
  test("open document, partly received and partly paid: the difference is exactly what has not arrived", () => {
    // Ordered 1.000.000, received 600.000 (DP 400.000 applied first, 200.000 utang).
    const result = reconcilePayable({ ...payable, tagihan: 1_000_000, paid: 400_000, netReceived: 600_000, ledgerPayable: 200_000 });
    expect(result).toMatchObject({ appBalance: 600_000, ledgerBalance: 200_000, notReceived: 400_000, difference: 0, status: "explained" });
  });

  test("a DP before anything arrived: the app owes the rest, the ledger holds an advance", () => {
    expect(reconcilePayable({ ...payable, tagihan: 1_000_000, paid: 300_000, ledgerAdvance: 300_000 })).toMatchObject({
      ledgerBalance: -300_000,
      notReceived: 1_000_000,
      difference: 0,
    });
  });

  test("closed over-paid (Lebih bayar): the claim explains the negative app balance", () => {
    expect(reconcilePayable({ ...payable, tagihan: 650_000, paid: 1_000_000, netReceived: 650_000, ledgerClaim: 350_000 })).toMatchObject({
      appBalance: -350_000,
      ledgerBalance: -350_000,
      difference: 0,
      status: "ok",
    });
  });

  test("a payment that never reached the ledger is a mismatch; on a document from before the books it needs review, never passes", () => {
    const missing = { ...payable, tagihan: 500_000, paid: 500_000, netReceived: 500_000, ledgerPayable: 500_000 };
    expect(reconcilePayable(missing)).toMatchObject({ difference: -500_000, status: "mismatch" });
    expect(reconcilePayable({ ...missing, startsBeforeBooks: true }).status).toBe("review");
  });
});
