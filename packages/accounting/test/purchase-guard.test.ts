import { describe, expect, test } from "vitest";
import { CHART_OF_ACCOUNTS } from "@ammari/db/accounting";
import { EXPENSE_LIKE_ACCOUNT_TYPES, PURCHASE_SIDE_JOURNAL_SOURCES, type AccountType } from "@ammari/db/schema";
import { isExpenseLikeAccountType, isPurchaseSideSource, purchaseGuardViolations, type JournalLineDraft } from "../src";

// D-14: fabric and material purchases never post to an expense account (the TS side of the
// journal_line_purchase_guard trigger, which packages/db/test/accounting-ledger.test.ts covers).

const typeOf = new Map<string, AccountType>(CHART_OF_ACCOUNTS.map((account) => [account.code, account.type]));
const accountTypeOf = (code: string) => typeOf.get(code);
const dr = (accountCode: string, amount: number): JournalLineDraft => ({ accountCode, debit: amount, credit: 0 });
const cr = (accountCode: string, amount: number): JournalLineDraft => ({ accountCode, debit: 0, credit: amount });

describe("purchase-side sources", () => {
  test("goods receipts, supplier payments and purchases are guarded on every event; batches only when posted; defects only when returned", () => {
    for (const sourceEvent of ["received", "reversal", "paid", "void", "closed_overpaid"]) {
      expect(isPurchaseSideSource({ sourceType: "goods_receipt_item", sourceEvent })).toBe(true);
      expect(isPurchaseSideSource({ sourceType: "supplier_payment", sourceEvent })).toBe(true);
      expect(isPurchaseSideSource({ sourceType: "purchase", sourceEvent })).toBe(true);
    }
    expect(isPurchaseSideSource({ sourceType: "production_batch", sourceEvent: "posted" })).toBe(true);
    expect(isPurchaseSideSource({ sourceType: "production_batch", sourceEvent: "wip_close" })).toBe(false);
    expect(isPurchaseSideSource({ sourceType: "defect_movement", sourceEvent: "return_out" })).toBe(true);
    expect(isPurchaseSideSource({ sourceType: "defect_movement", sourceEvent: "dispose" })).toBe(false);
    expect(isPurchaseSideSource({ sourceType: "fabric_stock_movement", sourceEvent: "adjustment" })).toBe(false);
    expect(isPurchaseSideSource({ sourceType: "business_expense", sourceEvent: "paid" })).toBe(false);
  });

  test("expense-like types are exactly expense, HPP, other expense and tax", () => {
    expect([...EXPENSE_LIKE_ACCOUNT_TYPES].sort()).toEqual(["cogs", "expense", "other_expense", "tax"]);
    for (const type of ["asset", "liability", "equity", "revenue", "contra_revenue", "other_income"] as const) {
      expect(isExpenseLikeAccountType(type)).toBe(false);
    }
  });
});

describe("purchaseGuardViolations", () => {
  test("P1 fabric receipt to inventory, advance and utang passes", () => {
    const lines = [dr("1-1501", 3_000_000), dr("1-1506", 150_000), cr("1-1601", 1_000_000), cr("2-1101", 2_150_000)];
    expect(purchaseGuardViolations({ sourceType: "goods_receipt_item", sourceEvent: "received" }, lines, accountTypeOf)).toEqual([]);
  });

  test("P3/R4 supplier payment to utang or advance passes", () => {
    const lines = [dr("2-1101", 900_000), dr("1-1601", 100_000), cr("1-1201", 1_000_000)];
    expect(purchaseGuardViolations({ sourceType: "supplier_payment", sourceEvent: "paid" }, lines, accountTypeOf)).toEqual([]);
  });

  test("every guarded source refuses every expense-like account, on either side", () => {
    const expenseAccounts = CHART_OF_ACCOUNTS.filter((account) => !account.isHeader && isExpenseLikeAccountType(account.type));
    expect(expenseAccounts.length).toBeGreaterThan(20);
    for (const guarded of PURCHASE_SIDE_JOURNAL_SOURCES) {
      const source = { sourceType: guarded.sourceType, sourceEvent: guarded.event ?? "received" };
      for (const account of expenseAccounts) {
        const debitSide = [dr(account.code, 500_000), cr("2-1101", 500_000)];
        expect(purchaseGuardViolations(source, debitSide, accountTypeOf)).toEqual([debitSide[0]]);
        const creditSide = [dr("1-1501", 500_000), cr(account.code, 500_000)];
        expect(purchaseGuardViolations(source, creditSide, accountTypeOf)).toEqual([creditSide[1]]);
      }
    }
  });

  test("a fabric purchase booked to Ongkir bahan (6-3101) is the case D-14 names", () => {
    const lines = [dr("6-3101", 250_000), cr("2-1101", 250_000)];
    expect(purchaseGuardViolations({ sourceType: "goods_receipt_item", sourceEvent: "received" }, lines, accountTypeOf)).toEqual([lines[0]]);
  });

  test("an account the guard cannot classify is treated as a violation", () => {
    const lines = [dr("1-9999", 10), cr("2-1101", 10)];
    expect(purchaseGuardViolations({ sourceType: "purchase", sourceEvent: "closed_overpaid" }, lines, accountTypeOf)).toEqual([lines[0]]);
  });

  test("decided expense postings outside the purchase side are not the guard's business", () => {
    expect(purchaseGuardViolations({ sourceType: "production_batch", sourceEvent: "wip_close" }, [dr("6-4102", 1), cr("1-1503", 1)], accountTypeOf)).toEqual([]);
    expect(purchaseGuardViolations({ sourceType: "business_expense", sourceEvent: "paid" }, [dr("6-3101", 1), cr("1-1101", 1)], accountTypeOf)).toEqual([]);
  });
});
