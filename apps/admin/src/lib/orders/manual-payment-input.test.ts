import { describe, expect, test } from "vitest";
import {
  accountAfterMethodChange,
  MANUAL_PAYMENT_MESSAGES,
  manualPaymentDateProblem,
  manualPaymentSchema,
  preselectedAccount,
  type ManualPaymentOptions,
} from "./manual-payment-input";

// Session 6, D-3: the shared input rules of the manual-order payment fields.

const OPTIONS: ManualPaymentOptions = {
  accounts: [
    { code: "1-1101", name: "Kas tunai" },
    { code: "1-1201", name: "Bank utama" },
  ],
  suggestedAccount: { cash: "1-1101", transfer: "1-1201", card: "1-1201" },
};

function firstError(input: unknown): string | undefined {
  const parsed = manualPaymentSchema.safeParse(input);
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

describe("manualPaymentSchema", () => {
  test("accepts cash, transfer and card (debit) with a Kas & Bank account and a date", () => {
    for (const method of ["cash", "transfer", "card"]) {
      expect(manualPaymentSchema.safeParse({ method, cashAccountCode: "1-1201", paidOn: "2026-12-05" }).success).toBe(true);
    }
  });

  test("no credit option and no other method (D-3: always paid before shipping)", () => {
    expect(firstError({ method: "credit", cashAccountCode: "1-1201", paidOn: "2026-12-05" })).toBe(MANUAL_PAYMENT_MESSAGES.method);
    expect(firstError({ method: "platform_balance", cashAccountCode: "1-1201", paidOn: "2026-12-05" })).toBe(MANUAL_PAYMENT_MESSAGES.method);
    expect(firstError({ cashAccountCode: "1-1201", paidOn: "2026-12-05" })).toBe(MANUAL_PAYMENT_MESSAGES.method);
  });

  test("the account must be a Kas & Bank code (1-11xx, 1-12xx)", () => {
    expect(firstError({ method: "cash", cashAccountCode: "", paidOn: "2026-12-05" })).toBe(MANUAL_PAYMENT_MESSAGES.account);
    expect(firstError({ method: "cash", cashAccountCode: "1-1302", paidOn: "2026-12-05" })).toBe(MANUAL_PAYMENT_MESSAGES.account);
    expect(firstError({ method: "cash", cashAccountCode: "4-1101", paidOn: "2026-12-05" })).toBe(MANUAL_PAYMENT_MESSAGES.account);
  });

  test("the payment date is a real calendar date", () => {
    expect(firstError({ method: "cash", cashAccountCode: "1-1101", paidOn: "" })).toBe(MANUAL_PAYMENT_MESSAGES.paidOn);
    expect(firstError({ method: "cash", cashAccountCode: "1-1101", paidOn: "2026-02-30" })).toBe(MANUAL_PAYMENT_MESSAGES.paidOn);
  });
});

describe("manualPaymentDateProblem", () => {
  test("today and earlier are fine; a later day is refused", () => {
    expect(manualPaymentDateProblem("2026-12-05", "2026-12-05")).toBeNull();
    expect(manualPaymentDateProblem("2026-11-30", "2026-12-05")).toBeNull();
    expect(manualPaymentDateProblem("2026-12-06", "2026-12-05")).toBe(MANUAL_PAYMENT_MESSAGES.paidOnFuture);
  });
});

describe("preselectedAccount", () => {
  test("method -> its mapped account; card -> Bank utama (D-18)", () => {
    expect(preselectedAccount("cash", OPTIONS)).toBe("1-1101");
    expect(preselectedAccount("transfer", OPTIONS)).toBe("1-1201");
    expect(preselectedAccount("card", OPTIONS)).toBe("1-1201");
  });

  test("nothing preselected when unmapped or the mapped account is no longer offered", () => {
    expect(preselectedAccount("card", { ...OPTIONS, suggestedAccount: { ...OPTIONS.suggestedAccount, card: null } })).toBe("");
    expect(preselectedAccount("cash", { ...OPTIONS, accounts: OPTIONS.accounts.filter((account) => account.code !== "1-1101") })).toBe("");
  });
});

describe("accountAfterMethodChange", () => {
  test("an empty or still-suggested account follows the new method", () => {
    expect(accountAfterMethodChange({ method: "", cashAccountCode: "" }, "cash", OPTIONS)).toBe("1-1101");
    expect(accountAfterMethodChange({ method: "cash", cashAccountCode: "1-1101" }, "card", OPTIONS)).toBe("1-1201");
  });

  test("an account staff chose themselves is never overwritten", () => {
    // Bank picked for a cash payment (e.g. cash deposited straight to the bank), then the method changed.
    expect(accountAfterMethodChange({ method: "cash", cashAccountCode: "1-1201" }, "transfer", OPTIONS)).toBe("1-1201");
    expect(accountAfterMethodChange({ method: "", cashAccountCode: "1-1101" }, "card", OPTIONS)).toBe("1-1101");
  });

  test("an auto-filled account is cleared when the new method has no mapping", () => {
    const unmappedCard = { ...OPTIONS, suggestedAccount: { ...OPTIONS.suggestedAccount, card: null } };
    expect(accountAfterMethodChange({ method: "cash", cashAccountCode: "1-1101" }, "card", unmappedCard)).toBe("");
    expect(accountAfterMethodChange({ method: "cash", cashAccountCode: "1-1101" }, "", OPTIONS)).toBe("");
  });
});
