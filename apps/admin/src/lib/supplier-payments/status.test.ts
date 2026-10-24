import { describe, expect, test } from "vitest";
import {
  PAYMENT_STATUS_LABELS,
  batchPayeeSummaries,
  batchTagihan,
  paidAmount,
  paymentAmountError,
  purchasePaymentSummary,
  purchaseTagihan,
  summarizePayment,
} from "./status";

describe("summarizePayment", () => {
  test("tagihan 0 and nothing paid is 'Tanpa tagihan', not 'Belum bayar'", () => {
    expect(summarizePayment(0, 0)).toEqual({ tagihan: 0, paid: 0, remaining: 0, overpaid: 0, status: "no_bill" });
  });

  test("nothing paid against a bill is 'Belum bayar'", () => {
    expect(summarizePayment(1_000_000, 0)).toEqual({
      tagihan: 1_000_000,
      paid: 0,
      remaining: 1_000_000,
      overpaid: 0,
      status: "unpaid",
    });
  });

  test("part paid is 'DP'", () => {
    expect(summarizePayment(1_000_000, 300_000)).toMatchObject({ remaining: 700_000, overpaid: 0, status: "partial" });
    expect(summarizePayment(1_000_000, 999_999)).toMatchObject({ remaining: 1, status: "partial" });
  });

  test("paid exactly is 'Lunas'", () => {
    expect(summarizePayment(1_000_000, 1_000_000)).toMatchObject({ remaining: 0, overpaid: 0, status: "paid" });
  });

  test("paid above the bill is 'Lebih bayar' with the excess, never a negative remaining", () => {
    expect(summarizePayment(800_000, 1_000_000)).toEqual({
      tagihan: 800_000,
      paid: 1_000_000,
      remaining: 0,
      overpaid: 200_000,
      status: "overpaid",
    });
    // A purchase cancelled after a DP: due drops to 0 (A4).
    expect(summarizePayment(0, 500_000)).toMatchObject({ remaining: 0, overpaid: 500_000, status: "overpaid" });
  });

  test("rejects non-integer or negative money", () => {
    expect(() => summarizePayment(1.5, 0)).toThrow();
    expect(() => summarizePayment(-1, 0)).toThrow();
    expect(() => summarizePayment(100, -1)).toThrow();
    expect(() => summarizePayment(Number.MAX_SAFE_INTEGER + 1, 0)).toThrow();
  });

  test("every status has an Indonesian label", () => {
    expect(PAYMENT_STATUS_LABELS).toEqual({
      no_bill: "Tanpa tagihan",
      unpaid: "Belum bayar",
      partial: "DP",
      paid: "Lunas",
      overpaid: "Lebih bayar",
    });
  });
});

describe("paidAmount", () => {
  test("sums only non-voided payments", () => {
    expect(
      paidAmount([
        { amount: 300_000, voided: false },
        { amount: 200_000, voided: true },
        { amount: 100_000, voided: false },
      ]),
    ).toBe(400_000);
    expect(paidAmount([])).toBe(0);
  });

  test("rejects a non-positive or fractional payment amount", () => {
    expect(() => paidAmount([{ amount: 0, voided: false }])).toThrow();
    expect(() => paidAmount([{ amount: 10.5, voided: false }])).toThrow();
  });
});

describe("purchaseTagihan", () => {
  const lines = [
    { qtyOrdered: 10, totalAmount: 1_000_000, qtySettled: 0 },
    { qtyOrdered: 3, totalAmount: 100_000, qtySettled: 0 },
  ];

  test("open and received documents are due their full order total", () => {
    expect(purchaseTagihan("ordered", lines)).toBe(1_100_000);
    expect(purchaseTagihan("partially_received", lines)).toBe(1_100_000);
    expect(purchaseTagihan("received", lines)).toBe(1_100_000);
  });

  test("a cancelled document (nothing arrived) is due nothing", () => {
    expect(purchaseTagihan("cancelled", lines)).toBe(0);
  });

  test("a short-closed document is due only the value of what was settled (A1)", () => {
    // 8 of 10 yards settled: 800.000; 1 of 3 pcs settled: round(100.000 / 3) = 33.333.
    expect(
      purchaseTagihan("closed", [
        { qtyOrdered: 10, totalAmount: 1_000_000, qtySettled: 8 },
        { qtyOrdered: 3, totalAmount: 100_000, qtySettled: 1 },
      ]),
    ).toBe(833_333);
  });

  test("closed valuation rounds half up per line in integer arithmetic (no float drift)", () => {
    // 0.35 of 1 yard at Rp 10: 3.5 -> 4 (float 0.35 * 10 would be 3.4999...).
    expect(purchaseTagihan("closed", [{ qtyOrdered: 1, totalAmount: 10, qtySettled: 0.35 }])).toBe(4);
    // 2 of 3 at Rp 100: 66.67 -> 67.
    expect(purchaseTagihan("closed", [{ qtyOrdered: 3, totalAmount: 100, qtySettled: 2 }])).toBe(67);
  });

  test("a closed line that settled fully is due its whole total, and one that settled nothing is due 0", () => {
    expect(
      purchaseTagihan("closed", [
        { qtyOrdered: 10, totalAmount: 1_000_000, qtySettled: 10 },
        { qtyOrdered: 5, totalAmount: 250_000, qtySettled: 0 },
      ]),
    ).toBe(1_000_000);
  });

  test("an empty document is due 0", () => {
    expect(purchaseTagihan("ordered", [])).toBe(0);
  });

  test("refuses a settled quantity outside 0..ordered on a closed document (corrupt data is never silently priced)", () => {
    expect(() => purchaseTagihan("closed", [{ qtyOrdered: 2, totalAmount: 100, qtySettled: 3 }])).toThrow();
    expect(() => purchaseTagihan("closed", [{ qtyOrdered: 2, totalAmount: 100, qtySettled: -1 }])).toThrow();
  });

  test("fractional yards are valued in hundredths across several closed lines", () => {
    // 1.25 of 2.5 yd at Rp 333.333: exactly half, 166.666,5 -> 166.667. 0.5 of 1.5 yd at Rp 100: 33,33 -> 33.
    expect(
      purchaseTagihan("closed", [
        { qtyOrdered: 2.5, totalAmount: 333_333, qtySettled: 1.25 },
        { qtyOrdered: 1.5, totalAmount: 100, qtySettled: 0.5 },
      ]),
    ).toBe(166_700);
  });

  test("open statuses ignore the settled quantity entirely", () => {
    expect(purchaseTagihan("partially_received", [{ qtyOrdered: 10, totalAmount: 500, qtySettled: 4 }])).toBe(500);
  });
});

describe("purchasePaymentSummary", () => {
  test("composes tagihan and non-voided payments", () => {
    const lines = [{ qtyOrdered: 10, totalAmount: 1_000_000, qtySettled: 8 }];
    expect(purchasePaymentSummary("received", lines, [{ amount: 400_000, voided: false }])).toMatchObject({
      tagihan: 1_000_000,
      paid: 400_000,
      remaining: 600_000,
      status: "partial",
    });
    // The same DP on the document short-closed at 8 of 10: still a DP against 800.000.
    expect(purchasePaymentSummary("closed", lines, [{ amount: 400_000, voided: false }])).toMatchObject({
      tagihan: 800_000,
      remaining: 400_000,
      status: "partial",
    });
    // Cancelled under a DP: overpaid (A4); a voided payment never counts.
    expect(
      purchasePaymentSummary("cancelled", lines, [
        { amount: 400_000, voided: false },
        { amount: 100_000, voided: true },
      ]),
    ).toMatchObject({ tagihan: 0, paid: 400_000, overpaid: 400_000, status: "overpaid" });
  });
});

describe("batchTagihan", () => {
  const tailorA = { supplierId: "a", supplierName: "Penjahit A" };
  const finisherB = { supplierId: "b", supplierName: "Finishing B" };

  test("a draft batch has no tagihan yet", () => {
    expect(batchTagihan("draft", [{ ...tailorA, total: 500_000 }])).toBeNull();
  });

  test("a posted batch is due its service lines, grouped per payee, unattributed lines together", () => {
    expect(
      batchTagihan("posted", [
        { ...tailorA, total: 400_000 },
        { ...finisherB, total: 150_000 },
        { ...tailorA, total: 100_000 },
        { supplierId: null, supplierName: null, total: 25_000 },
      ]),
    ).toEqual({
      total: 675_000,
      payees: [
        { supplierId: "a", supplierName: "Penjahit A", tagihan: 500_000 },
        { supplierId: "b", supplierName: "Finishing B", tagihan: 150_000 },
        { supplierId: null, supplierName: null, tagihan: 25_000 },
      ],
    });
  });

  test("a posted batch with no service lines is due 0 with no payees", () => {
    expect(batchTagihan("posted", [])).toEqual({ total: 0, payees: [] });
  });
});

describe("batchPayeeSummaries", () => {
  const payees = [
    { supplierId: "a", supplierName: "Penjahit A", tagihan: 500_000 },
    { supplierId: null, supplierName: null, tagihan: 25_000 },
  ];

  test("each payee's paid counts only its own non-voided payments", () => {
    const result = batchPayeeSummaries(payees, [
      { supplierId: "a", amount: 200_000, voided: false },
      { supplierId: "a", amount: 300_000, voided: true },
      { supplierId: null, amount: 25_000, voided: false },
    ]);
    expect(result).toEqual([
      { supplierId: "a", supplierName: "Penjahit A", tagihan: 500_000, paid: 200_000, remaining: 300_000, overpaid: 0, status: "partial" },
      { supplierId: null, supplierName: null, tagihan: 25_000, paid: 25_000, remaining: 0, overpaid: 0, status: "paid" },
    ]);
  });

  test("a payment to someone who is not a payee of the batch is surfaced, never silently dropped", () => {
    expect(() => batchPayeeSummaries(payees, [{ supplierId: "z", amount: 1, voided: false }])).toThrow(/payee/);
  });
});

describe("paymentAmountError", () => {
  test("accepts an amount up to and including the remaining balance", () => {
    expect(paymentAmountError(1, summarizePayment(1_000_000, 300_000))).toBeNull();
    expect(paymentAmountError(700_000, summarizePayment(1_000_000, 300_000))).toBeNull();
  });

  test("refuses an amount above the remaining balance, naming the remaining in rupiah", () => {
    expect(paymentAmountError(700_001, summarizePayment(1_000_000, 300_000))).toBe(
      "Jumlah melebihi sisa tagihan (Rp 700.000).",
    );
  });

  test("refuses any payment when nothing remains", () => {
    expect(paymentAmountError(1, summarizePayment(1_000_000, 1_000_000))).toBe("Tagihan ini sudah lunas.");
    expect(paymentAmountError(1, summarizePayment(0, 0))).toBe("Tidak ada tagihan untuk dibayar.");
    expect(paymentAmountError(1, summarizePayment(0, 500_000))).toBe("Pembayaran sudah melebihi tagihan.");
    expect(paymentAmountError(1, summarizePayment(800_000, 1_000_000))).toBe("Pembayaran sudah melebihi tagihan.");
  });

  test("refuses a zero, negative or fractional amount", () => {
    const summary = summarizePayment(1_000_000, 0);
    expect(paymentAmountError(0, summary)).toBe("Jumlah harus bilangan bulat lebih dari 0.");
    expect(paymentAmountError(-5, summary)).toBe("Jumlah harus bilangan bulat lebih dari 0.");
    expect(paymentAmountError(10.5, summary)).toBe("Jumlah harus bilangan bulat lebih dari 0.");
  });
});
