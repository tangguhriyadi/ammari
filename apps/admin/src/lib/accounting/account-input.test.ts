import { describe, expect, test } from "vitest";
import { FieldError } from "@/lib/errors";
import {
  ACCOUNT_MESSAGES,
  assertValidParent,
  defaultNormalBalance,
  normalizeBankFields,
  resolveCashFlowGroup,
  suggestChildCode,
  validateNewAccount,
  type NewAccountInput,
} from "./account-input";

// Data Master Akun input rules (docs/plans/accounting.md Session 3, §8.1). The database refuses the
// same rows (migration 0051, packages/db/test/migration-0051.test.ts).

function fieldOf(fn: () => unknown): { field: string; message: string } | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof FieldError) return { field: error.field, message: error.message };
    throw error;
  }
}

const base: NewAccountInput = { code: "1-1202", name: "Bank cadangan", type: "asset", normalBalance: "debit", isHeader: false };
const bankHeader = { code: "1-1200", type: "asset" as const, isHeader: true };

describe("validateNewAccount", () => {
  test("a second bank under the Bank header: Kas & Bank gets cash, bank fields allowed", () => {
    expect(validateNewAccount({ ...base, bankName: " BRI ", accountNoLast4: "4321" }, bankHeader)).toEqual({
      code: "1-1202",
      name: "Bank cadangan",
      type: "asset",
      normalBalance: "debit",
      isHeader: false,
      cashFlowGroup: "cash",
      bankName: "BRI",
      accountNoLast4: "4321",
    });
  });

  test("code format and its class: the leading digit fixes the type (no 6-xxxx asset)", () => {
    expect(fieldOf(() => validateNewAccount({ ...base, code: "11202" }, null))?.field).toBe("code");
    expect(fieldOf(() => validateNewAccount({ ...base, code: "6-5101" }, null))).toEqual({ field: "code", message: ACCOUNT_MESSAGES.codeClass("6-5101", "asset") });
    expect(fieldOf(() => validateNewAccount({ ...base, code: "4-1202", type: "contra_revenue", cashFlowGroup: "operating" }, null))).toBeNull();
  });

  test("name is required, trimmed and at most 80 characters", () => {
    expect(fieldOf(() => validateNewAccount({ ...base, name: "   " }, null))?.field).toBe("name");
    expect(fieldOf(() => validateNewAccount({ ...base, name: "x".repeat(81) }, null))?.field).toBe("name");
    expect(validateNewAccount({ ...base, name: "  Bank   cadangan " }, null).name).toBe("Bank cadangan");
  });

  test("a parent is a header of the same type (plan §8.1)", () => {
    expect(fieldOf(() => assertValidParent({ code: "1-1201", type: "asset", isHeader: false }, "asset"))).toEqual({
      field: "parentCode",
      message: ACCOUNT_MESSAGES.parentNotHeader,
    });
    expect(fieldOf(() => assertValidParent({ code: "4-1100", type: "revenue", isHeader: true }, "contra_revenue"))?.message).toBe(ACCOUNT_MESSAGES.parentType);
    expect(fieldOf(() => assertValidParent(null, "asset"))).toBeNull();
  });

  test("bank fields only on a postable Kas & Bank account; last 4 is exactly 4 digits", () => {
    expect(fieldOf(() => normalizeBankFields("1-1301", false, { bankName: "BCA" }))?.message).toBe(ACCOUNT_MESSAGES.bankFieldsNotAllowed);
    expect(fieldOf(() => normalizeBankFields("1-1200", true, { accountNoLast4: "1234" }))?.message).toBe(ACCOUNT_MESSAGES.bankFieldsNotAllowed);
    expect(fieldOf(() => normalizeBankFields("1-1202", false, { accountNoLast4: "12a4" }))?.field).toBe("accountNoLast4");
    expect(normalizeBankFields("6-2101", false, { bankName: " ", accountNoLast4: "" })).toEqual({ bankName: null, accountNoLast4: null });
  });

  test("cash-flow group: headers none, Kas & Bank cash, otherwise chosen (never none)", () => {
    expect(resolveCashFlowGroup("6-5000", true, "operating")).toBe("none");
    expect(resolveCashFlowGroup("1-1102", false, "operating")).toBe("cash");
    expect(resolveCashFlowGroup("6-2102", false, "operating")).toBe("operating");
    expect(fieldOf(() => resolveCashFlowGroup("6-2102", false, "none"))?.field).toBe("cashFlowGroup");
    expect(fieldOf(() => resolveCashFlowGroup("6-2102", false, undefined))?.field).toBe("cashFlowGroup");
  });

  test("default normal balance follows the type", () => {
    expect(defaultNormalBalance("asset")).toBe("debit");
    expect(defaultNormalBalance("liability")).toBe("credit");
    expect(defaultNormalBalance("contra_revenue")).toBe("debit");
    expect(defaultNormalBalance("other_income")).toBe("credit");
  });
});

describe("suggestChildCode", () => {
  test("under x-yz00 the next free x-yzNN; under x-y000 the next free x-yN00", () => {
    expect(suggestChildCode("1-1200", new Set(["1-1200", "1-1201"]))).toBe("1-1202");
    expect(suggestChildCode("1-1100", new Set(["1-1100", "1-1101", "1-1102"]))).toBe("1-1103");
    expect(suggestChildCode("6-4000", new Set(["6-4000", "6-4100"]))).toBe("6-4200");
    expect(suggestChildCode("1-1501", new Set())).toBeNull();
    const full = new Set(Array.from({ length: 100 }, (_, n) => `1-12${String(n).padStart(2, "0")}`));
    expect(suggestChildCode("1-1200", full)).toBeNull();
  });
});
