import { describe, expect, test } from "vitest";
import { purchaseTagihan } from "@/lib/supplier-payments/status";
import { sumCashOutflow } from "./cash-outflow-sum";
import {
  batchItemLabel,
  batchPayeeOutflowStatus,
  outflowSourceHref,
  paymentOrdinals,
  purchaseItemDetail,
  purchaseOutflowStatus,
  type OrdinalPayment,
} from "./production-outflow-rows";

// docs/plans/expense-master-data.md §3.9/§3.10, session S6: the pure rules of "Pengeluaran
// produksi" and "Arus kas keluar".

describe("purchaseItemDetail (Biaya bahan baku: Kain / Aksesoris / both)", () => {
  test("from the PO's line types, duplicates ignored", () => {
    expect(purchaseItemDetail(["fabric", "fabric"])).toBe("Kain");
    expect(purchaseItemDetail(["accessory"])).toBe("Aksesoris");
    expect(purchaseItemDetail(["accessory", "fabric", "accessory"])).toBe("Kain & aksesoris");
    expect(purchaseItemDetail([])).toBeNull();
  });
});

describe("batchItemLabel", () => {
  test("distinct component names in line order, joined with a comma; a fallback when none", () => {
    expect(batchItemLabel(["Ongkos jahit", "Finishing", "Ongkos jahit"])).toBe("Ongkos jahit, Finishing");
    expect(batchItemLabel([" Finishing "])).toBe("Finishing");
    expect(batchItemLabel([])).toBe("Ongkos produksi");
  });
});

describe("paymentOrdinals (owner answer D9)", () => {
  const at = (iso: string) => new Date(iso);
  const purchase = { type: "purchase", purchaseId: "po-1" } as const;
  const tailor = { type: "production_batch", productionBatchId: "b-1", supplierId: "s-tailor" } as const;
  const finisher = { type: "production_batch", productionBatchId: "b-1", supplierId: "s-finisher" } as const;
  const unattributed = { type: "production_batch", productionBatchId: "b-1", supplierId: null } as const;

  test("counted per PO by paid date, then recording time, then payment number; voided payments get no number and do not count", () => {
    const payments: OrdinalPayment[] = [
      { id: "late", target: purchase, paidAt: "2031-03-20", createdAt: at("2031-03-20T01:00:00Z"), paymentNo: "BYR-203103-009", voided: false },
      { id: "voided", target: purchase, paidAt: "2031-03-01", createdAt: at("2031-03-01T01:00:00Z"), paymentNo: "BYR-203103-001", voided: true },
      // Same day and same recording time: the payment number decides.
      { id: "dp-b", target: purchase, paidAt: "2031-03-05", createdAt: at("2031-03-05T01:00:00Z"), paymentNo: "BYR-203103-004", voided: false },
      { id: "dp-a", target: purchase, paidAt: "2031-03-05", createdAt: at("2031-03-05T01:00:00Z"), paymentNo: "BYR-203103-003", voided: false },
      // Recorded later but paid earlier: the paid date wins.
      { id: "backdated", target: purchase, paidAt: "2031-03-02", createdAt: at("2031-03-25T01:00:00Z"), paymentNo: "BYR-203103-010", voided: false },
    ];
    const ordinals = paymentOrdinals(payments);
    expect(Object.fromEntries(ordinals)).toEqual({ backdated: 1, "dp-a": 2, "dp-b": 3, late: 4 });
    expect(ordinals.has("voided")).toBe(false);
  });

  test("a batch is counted per payee: each payee (and the unattributed lines) starts at 1", () => {
    const ordinals = paymentOrdinals([
      { id: "t1", target: tailor, paidAt: "2031-03-01", createdAt: at("2031-03-01T01:00:00Z"), paymentNo: "BYR-1", voided: false },
      { id: "f1", target: finisher, paidAt: "2031-03-02", createdAt: at("2031-03-02T01:00:00Z"), paymentNo: "BYR-2", voided: false },
      { id: "t-void", target: tailor, paidAt: "2031-03-02", createdAt: at("2031-03-02T02:00:00Z"), paymentNo: "BYR-3", voided: true },
      { id: "t2", target: tailor, paidAt: "2031-03-03", createdAt: at("2031-03-03T01:00:00Z"), paymentNo: "BYR-4", voided: false },
      { id: "n1", target: unattributed, paidAt: "2031-03-04", createdAt: at("2031-03-04T01:00:00Z"), paymentNo: "BYR-5", voided: false },
    ]);
    expect(Object.fromEntries(ordinals)).toEqual({ t1: 1, t2: 2, f1: 1, n1: 1 });
  });
});

describe("the bill's current status (the PO and batch pages' badge)", () => {
  test("purchase: DP while partly paid, Lunas when paid, Lebih bayar after it is closed short under the DP", () => {
    const line = { qtyOrdered: 10, totalAmount: 1_000_000, qtySettled: 2 };
    expect(purchaseOutflowStatus(purchaseTagihan("ordered", [line]), 300_000)).toBe("partial");
    expect(purchaseOutflowStatus(purchaseTagihan("received", [line]), 1_000_000)).toBe("paid");
    // Closed with 2 of 10 yards: due 200.000, 500.000 already paid.
    expect(purchaseOutflowStatus(purchaseTagihan("closed", [line]), 500_000)).toBe("overpaid");
  });

  test("batch: per payee, never the batch as a whole", () => {
    const lines = [
      { supplierId: "s-tailor", supplierName: "Penjahit", total: 200_000 },
      { supplierId: "s-finisher", supplierName: "Finishing", total: 50_000 },
      { supplierId: null, supplierName: null, total: 10_000 },
    ];
    expect(batchPayeeOutflowStatus("posted", lines, "s-tailor", 200_000)).toBe("paid");
    expect(batchPayeeOutflowStatus("posted", lines, "s-finisher", 20_000)).toBe("partial");
    expect(batchPayeeOutflowStatus("posted", lines, null, 10_000)).toBe("paid");
    // Not a payee of the batch: nothing is due to them.
    expect(batchPayeeOutflowStatus("posted", lines, "s-stranger", 1_000)).toBe("overpaid");
  });
});

describe("outflowSourceHref (permission-aware source links)", () => {
  const purchase = { type: "purchase", purchaseId: "po-1" } as const;
  const batch = { type: "production_batch", productionBatchId: "b-1", supplierId: null } as const;

  test("a PO links with inventory.view, a batch with production.manage; otherwise plain text (null)", () => {
    const owner = ["inventory.view", "production.manage", "ads_expenses.manage", "finance.view_profit"];
    const keuangan = ["inventory.view", "ads_expenses.manage", "finance.view_profit"];
    expect(outflowSourceHref(purchase, owner)).toBe("/purchases/po-1");
    expect(outflowSourceHref(batch, owner)).toBe("/production/b-1");
    expect(outflowSourceHref(purchase, keuangan)).toBe("/purchases/po-1");
    expect(outflowSourceHref(batch, keuangan)).toBeNull();
    expect(outflowSourceHref(purchase, ["ads_expenses.manage", "finance.view_profit"])).toBeNull();
  });
});

describe("sumCashOutflow (Total uang keluar)", () => {
  test("operating + production + ads", () => {
    expect(sumCashOutflow({ operating: 400_000, production: 5_200_000, ads: 300_000 })).toEqual({
      operating: 400_000,
      production: 5_200_000,
      ads: 300_000,
      total: 5_900_000,
    });
    expect(sumCashOutflow({ operating: 0, production: 0, ads: 0 }).total).toBe(0);
  });

  test("refuses a negative, fractional or unsafe part instead of showing a wrong total", () => {
    expect(() => sumCashOutflow({ operating: -1, production: 0, ads: 0 })).toThrow("invalid operating amount");
    expect(() => sumCashOutflow({ operating: 0, production: 1.5, ads: 0 })).toThrow("invalid production amount");
    expect(() => sumCashOutflow({ operating: Number.MAX_SAFE_INTEGER, production: 1, ads: 0 })).toThrow("overflow");
  });
});
