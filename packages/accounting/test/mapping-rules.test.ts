import { describe, expect, test } from "vitest";
import { CHART_OF_ACCOUNTS, DEFAULT_ACCOUNT_MAPPINGS } from "@ammari/db/accounting";
import {
  accountCodeMatchesType,
  isCashBankAccountCode,
  isInventoryAccountCode,
  mappingFamily,
  mappingTargetProblem,
  type MappingTargetAccount,
} from "../src/mapping-rules";

// docs/plans/accounting.md Session 3: what an account code and a mapping target may be. The same
// cases run against migration 0051's triggers in packages/db/test/migration-0051.test.ts.

const account = (code: string, type: MappingTargetAccount["type"], extra: Partial<MappingTargetAccount> = {}): MappingTargetAccount => ({
  code,
  type,
  isHeader: false,
  isActive: true,
  ...extra,
});

describe("account codes", () => {
  test("the leading digit fixes the type: 1 asset ... 9 tax; contra revenue lives in class 4", () => {
    expect(accountCodeMatchesType("1-1501", "asset")).toBe(true);
    expect(accountCodeMatchesType("4-1201", "contra_revenue")).toBe(true);
    expect(accountCodeMatchesType("4-1101", "revenue")).toBe(true);
    expect(accountCodeMatchesType("9-1101", "tax")).toBe(true);
    expect(accountCodeMatchesType("6-2101", "asset")).toBe(false);
    expect(accountCodeMatchesType("1-1501", "expense")).toBe(false);
    expect(accountCodeMatchesType("5-1101", "expense")).toBe(false);
    expect(accountCodeMatchesType("61501", "expense")).toBe(false);
  });

  test("every account in the initial Chart of Accounts already satisfies it", () => {
    for (const row of CHART_OF_ACCOUNTS) expect(accountCodeMatchesType(row.code, row.type), row.code).toBe(true);
  });

  test("Kas & Bank is 1-11xx and 1-12xx; inventory is 1-15xx", () => {
    expect(isCashBankAccountCode("1-1101")).toBe(true);
    expect(isCashBankAccountCode("1-1201")).toBe(true);
    expect(isCashBankAccountCode("1-1202")).toBe(true);
    expect(isCashBankAccountCode("1-1301")).toBe(false);
    expect(isCashBankAccountCode("2-1101")).toBe(false);
    expect(isInventoryAccountCode("1-1501")).toBe(true);
    expect(isInventoryAccountCode("1-1599")).toBe(true);
    expect(isInventoryAccountCode("1-1500")).toBe(true);
    expect(isInventoryAccountCode("1-1601")).toBe(false);
    expect(isInventoryAccountCode("6-1501")).toBe(false);
  });
});

describe("mapping targets", () => {
  test("mapping keys fall into families", () => {
    expect(mappingFamily("expense.category.salary")).toBe("expense_category");
    expect(mappingFamily("expense.item.0b9d3c2e-1111-4222-8333-444455556666")).toBe("expense_item");
    expect(mappingFamily("cash.method.card")).toBe("cash_method");
    expect(mappingFamily("cash.midtrans_payout")).toBe("midtrans_payout");
    expect(mappingFamily("revenue.channel.shopee")).toBe("revenue_channel");
    expect(mappingFamily("supplier_payable.kind.service")).toBe("supplier_payable");
    expect(mappingFamily("something.else")).toBeNull();
  });

  test("D-14: an expense category or item is never mapped to an inventory account (fabric, accessories, WIP, finished goods)", () => {
    for (const code of ["1-1501", "1-1502", "1-1503", "1-1504", "1-1505", "1-1506"]) {
      expect(mappingTargetProblem("expense.category.material_shipping", account(code, "asset"))).toBe("inventory");
      expect(mappingTargetProblem("expense.item.0b9d3c2e-1111-4222-8333-444455556666", account(code, "asset"))).toBe("inventory");
    }
    // Ongkir bahan stays an expense (D-14); a liability (D-25 "Setor pajak") and a prepaid asset
    // (a Biteship top-up item, plan §3) are fine.
    expect(mappingTargetProblem("expense.category.material_shipping", account("6-3101", "expense"))).toBeNull();
    expect(mappingTargetProblem("expense.category.tax_payment", account("2-1401", "liability"))).toBeNull();
    expect(mappingTargetProblem("expense.item.0b9d3c2e-1111-4222-8333-444455556666", account("1-1603", "asset"))).toBeNull();
  });

  test("a header or an inactive account is never a target; a missing one is not_found", () => {
    expect(mappingTargetProblem("expense.category.salary", account("6-2000", "expense", { isHeader: true }))).toBe("not_postable");
    expect(mappingTargetProblem("expense.category.salary", account("6-2102", "expense", { isActive: false }))).toBe("not_postable");
    expect(mappingTargetProblem("expense.category.salary", null)).toBe("not_found");
  });

  test("payment methods and the Midtrans payout go to Kas & Bank only (D-17, D-18)", () => {
    expect(mappingTargetProblem("cash.method.card", account("1-1201", "asset"))).toBeNull();
    expect(mappingTargetProblem("cash.method.cash", account("1-1101", "asset"))).toBeNull();
    expect(mappingTargetProblem("cash.method.transfer", account("1-1301", "asset"))).toBe("not_cash_bank");
    expect(mappingTargetProblem("cash.midtrans_payout", account("1-1501", "asset"))).toBe("not_cash_bank");
  });

  test("a channel's sales go to a revenue account, a supplier payable to a liability", () => {
    expect(mappingTargetProblem("revenue.channel.web", account("4-1101", "revenue"))).toBeNull();
    expect(mappingTargetProblem("revenue.channel.web", account("4-1201", "contra_revenue"))).toBe("not_revenue");
    expect(mappingTargetProblem("supplier_payable.kind.material", account("2-1101", "liability"))).toBeNull();
    expect(mappingTargetProblem("supplier_payable.kind.material", account("6-3101", "expense"))).toBe("not_liability");
  });

  test("every initial mapping already satisfies the rules", () => {
    const byCode = new Map(CHART_OF_ACCOUNTS.map((row) => [row.code, row]));
    for (const mapping of DEFAULT_ACCOUNT_MAPPINGS) {
      const target = byCode.get(mapping.accountCode)!;
      expect(mappingTargetProblem(mapping.mappingKey, account(target.code, target.type, { isHeader: target.isHeader })), mapping.mappingKey).toBeNull();
    }
  });
});
