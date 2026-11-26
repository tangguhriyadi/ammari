import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { accountMappings, auditLog, journalEntries, journalLines, taxSettings } from "@ammari/db/schema";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { ActionError, FieldError } from "@/lib/errors";
import { createExpenseCategory, createExpenseItem } from "@/lib/expense-categories/queries";
import { ACCOUNT_MESSAGES } from "./account-input";
import { createAccount, deleteAccount, getAccount, listAccounts, cashBankAccounts, setAccountActive, updateAccount } from "./accounts";
import { clearItemMapping, eligibleAccounts, getExpenseMappingWarnings, getMappingPage, MAPPING_MESSAGES, setAccountMapping } from "./mappings";
import { createTaxSetting, updateTaxSetting } from "./tax-settings";

// Data Master Akun, Pemetaan akun and Pengaturan pajak writes (docs/plans/accounting.md Session 3)
// against the real triggers in ammari_test; every test rolls back. Codes 7-19xx/6-59xx are used
// only here.

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as Error,
  );
}

async function auditRows(tx: TestTx, entityType: string, entityId: string) {
  return tx
    .select({ action: auditLog.action, actor: auditLog.actorStaffUserId, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)));
}

async function postLine(tx: TestTx, accountCode: string) {
  const [entry] = await tx
    .insert(journalEntries)
    .values({ entryNo: "JU-203105-9901", entryDate: "2031-05-02", kind: "system", sourceType: "business_expense", sourceId: "uji", sourceEvent: "paid", ruleVersion: 1, description: "Uji" })
    .returning({ id: journalEntries.id });
  await tx.insert(journalLines).values([
    { entryId: entry!.id, lineNo: 1, accountCode, debit: 1_000, credit: 0 },
    { entryId: entry!.id, lineNo: 2, accountCode: "1-1201", debit: 0, credit: 1_000 },
  ]);
}

describe("accounts", () => {
  test("Kas & Bank today is exactly Kas tunai and Bank utama (D-17)", async () => {
    await withRollback(async (tx) => {
      expect(cashBankAccounts(await listAccounts(tx)).map((row) => `${row.code} ${row.name}`)).toEqual(
        expect.arrayContaining(["1-1101 Kas tunai", "1-1201 Bank utama"]),
      );
      const codes = cashBankAccounts(await listAccounts(tx)).map((row) => row.code);
      expect(codes.every((code) => /^1-1[12]/.test(code))).toBe(true);
    });
  });

  test("a sub-account under a header: created, sorted after its predecessor, audited; it then lists as Kas & Bank", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const created = await createAccount(
        { code: "1-1209", name: "Bank uji sesi tiga", type: "asset", normalBalance: "debit", isHeader: false, parentCode: "1-1200", bankName: "BRI", accountNoLast4: "4321" },
        staff.id,
        tx,
      );
      expect(created).toMatchObject({ code: "1-1209", parentCode: "1-1200", isSystem: false, cashFlowGroup: "cash", bankName: "BRI", accountNoLast4: "4321" });
      expect(cashBankAccounts(await listAccounts(tx)).map((row) => row.code)).toContain("1-1209");
      const [audit] = await auditRows(tx, "account", "1-1209");
      expect(audit).toMatchObject({ action: "create", actor: staff.id });
    });
  });

  test("refusals: a postable parent, the wrong class, a taken code or name, bank fields off Kas & Bank", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const make = (overrides: Partial<Parameters<typeof createAccount>[0]>) =>
        rejection(createAccount({ code: "6-5901", name: "Beban uji", type: "expense", normalBalance: "debit", isHeader: false, parentCode: null, cashFlowGroup: "operating", ...overrides }, staff.id, tx));
      expect(await make({ parentCode: "6-2101" })).toMatchObject({ field: "parentCode", message: ACCOUNT_MESSAGES.parentNotHeader });
      expect(await make({ code: "1-1901", type: "expense" })).toMatchObject({ field: "code" });
      expect(await make({ code: "6-2101" })).toMatchObject({ field: "code", message: ACCOUNT_MESSAGES.codeTaken });
      expect(await make({ name: "gaji" })).toMatchObject({ field: "name", message: ACCOUNT_MESSAGES.nameTaken });
      expect(await make({ bankName: "BCA" })).toMatchObject({ field: "bankName" });
    });
  });

  test("rename and move under another header of the same type; never under a postable one", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await createAccount({ code: "6-5900", name: "Kelompok uji", type: "expense", normalBalance: "debit", isHeader: true, parentCode: null }, staff.id, tx);
      await createAccount({ code: "6-5901", name: "Beban uji", type: "expense", normalBalance: "debit", isHeader: false, parentCode: null, cashFlowGroup: "operating" }, staff.id, tx);
      const moved = await updateAccount("6-5901", { name: "Beban uji baru", parentCode: "6-5900", cashFlowGroup: "investing" }, staff.id, tx);
      expect(moved).toMatchObject({ name: "Beban uji baru", parentCode: "6-5900", cashFlowGroup: "investing" });
      expect(await rejection(updateAccount("6-5901", { name: "Beban uji", parentCode: "6-2101" }, staff.id, tx))).toMatchObject({ field: "parentCode" });
      // A system account keeps its cash-flow group whatever the form sends.
      expect(await updateAccount("6-2401", { name: "Beban penyusutan", parentCode: "6-2000", cashFlowGroup: "investing" }, staff.id, tx)).toMatchObject({ cashFlowGroup: "operating" });
    });
  });

  test("nothing goes under an inactive header; a child is reactivated only under an active parent", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await createAccount({ code: "6-5920", name: "Kelompok nonaktif", type: "expense", normalBalance: "debit", isHeader: true, parentCode: null }, staff.id, tx);
      await createAccount({ code: "6-5921", name: "Isi nonaktif", type: "expense", normalBalance: "debit", isHeader: false, parentCode: "6-5920", cashFlowGroup: "operating" }, staff.id, tx);
      await setAccountActive("6-5921", false, staff.id, tx);
      await setAccountActive("6-5920", false, staff.id, tx);
      const create = createAccount({ code: "6-5922", name: "Baru", type: "expense", normalBalance: "debit", isHeader: false, parentCode: "6-5920", cashFlowGroup: "operating" }, staff.id, tx);
      expect(await rejection(create)).toMatchObject({ field: "parentCode", message: ACCOUNT_MESSAGES.parentInactive });
      expect(await rejection(setAccountActive("6-5921", true, staff.id, tx))).toMatchObject({ message: ACCOUNT_MESSAGES.parentInactive });
    });
  });

  test("an update that omits the bank fields keeps them; an empty one clears them", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await createAccount({ code: "1-1208", name: "Bank simpan", type: "asset", normalBalance: "debit", isHeader: false, parentCode: "1-1200", bankName: "BNI", accountNoLast4: "1111" }, staff.id, tx);
      expect(await updateAccount("1-1208", { name: "Bank simpan baru", parentCode: "1-1200" }, staff.id, tx)).toMatchObject({ bankName: "BNI", accountNoLast4: "1111" });
      expect(await updateAccount("1-1208", { name: "Bank simpan baru", parentCode: "1-1200", bankName: "", accountNoLast4: "" }, staff.id, tx)).toMatchObject({ bankName: null, accountNoLast4: null });
    });
  });

  test("deactivate: refused for a system account and a mapped one; allowed otherwise and audited", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      expect(await rejection(setAccountActive("1-1501", false, staff.id, tx))).toMatchObject({ message: ACCOUNT_MESSAGES.systemCannotDeactivate });
      const mapped = await rejection(setAccountActive("6-2101", false, staff.id, tx));
      expect(mapped).toBeInstanceOf(ActionError);
      expect(mapped.message).toBe(ACCOUNT_MESSAGES.mappedCannotDeactivate);
      await createAccount({ code: "7-1901", name: "Pendapatan uji", type: "other_income", normalBalance: "credit", isHeader: false, parentCode: null, cashFlowGroup: "operating" }, staff.id, tx);
      await setAccountActive("7-1901", false, staff.id, tx);
      expect((await getAccount("7-1901", tx))?.isActive).toBe(false);
      expect((await auditRows(tx, "account", "7-1901")).map((row) => row.action).sort()).toEqual(["create", "deactivate"]);
    });
  });

  test("delete-once-used refused: a system account, one with journal lines, one with sub-accounts; an unused one goes", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      expect(await rejection(deleteAccount("1-1101", staff.id, tx))).toMatchObject({ message: ACCOUNT_MESSAGES.systemCannotDelete });
      await createAccount({ code: "6-5902", name: "Beban terpakai", type: "expense", normalBalance: "debit", isHeader: false, parentCode: null, cashFlowGroup: "operating" }, staff.id, tx);
      await postLine(tx, "6-5902");
      expect(await rejection(deleteAccount("6-5902", staff.id, tx))).toMatchObject({ message: ACCOUNT_MESSAGES.usedCannotDelete });
      await createAccount({ code: "6-5910", name: "Kelompok berisi", type: "expense", normalBalance: "debit", isHeader: true, parentCode: null }, staff.id, tx);
      await createAccount({ code: "6-5911", name: "Isi kelompok", type: "expense", normalBalance: "debit", isHeader: false, parentCode: "6-5910", cashFlowGroup: "operating" }, staff.id, tx);
      expect(await rejection(deleteAccount("6-5910", staff.id, tx))).toMatchObject({ message: ACCOUNT_MESSAGES.childrenCannotDelete });
      await deleteAccount("6-5911", staff.id, tx);
      expect(await getAccount("6-5911", tx)).toBeNull();
      expect((await auditRows(tx, "account", "6-5911")).map((row) => row.action).sort()).toEqual(["create", "delete"]);
    });
  });
});

describe("mappings", () => {
  test("the mapping editor refuses an expense category or item onto an inventory account 1-15xx (D-14), and never offers one", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const category = await createExpenseCategory({ name: "Uji pemetaan sesi tiga", kind: "operating", sortOrder: 0 }, staff.id, tx);
      const item = await createExpenseItem(category.code, { name: "Item uji", sortOrder: 0 }, staff.id, tx);
      for (const code of ["1-1501", "1-1502", "1-1503", "1-1504", "1-1505", "1-1506"]) {
        for (const key of [`expense.category.${category.code}`, `expense.item.${item.id}`, "expense.category.material_shipping"]) {
          const error = await rejection(setAccountMapping(key, code, staff.id, tx));
          expect(error).toBeInstanceOf(FieldError);
          expect(error.message).toBe(MAPPING_MESSAGES.targetProblem.inventory);
        }
      }
      const page = await getMappingPage(tx);
      expect(eligibleAccounts(`expense.category.${category.code}`, page.accounts).some((account) => account.code.startsWith("1-15"))).toBe(false);
      // Ongkir bahan still maps to 6-3101 (an expense, D-14), untouched by the refusals.
      const [shipping] = await tx.select().from(accountMappings).where(eq(accountMappings.mappingKey, "expense.category.material_shipping"));
      expect(shipping?.accountCode).toBe("6-3101");
    });
  });

  test("a new category is unmapped (warned, D-25) until mapped; the change is audited", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const category = await createExpenseCategory({ name: "Langganan uji sesi tiga", kind: "operating", sortOrder: 0 }, staff.id, tx);
      expect((await getExpenseMappingWarnings(tx)).unmapped.map((row) => row.code)).toContain(category.code);
      await setAccountMapping(`expense.category.${category.code}`, "6-2501", staff.id, tx);
      const warnings = await getExpenseMappingWarnings(tx);
      expect(warnings.unmapped.map((row) => row.code)).not.toContain(category.code);
      expect(warnings.accountByCategory.get(category.code)).toEqual({ code: "6-2501", name: "Beban langganan aplikasi" });
      const [audit] = await auditRows(tx, "account_mapping", `expense.category.${category.code}`);
      expect(audit).toMatchObject({ action: "set", actor: staff.id, before: null });
    });
  });

  test("an item override (to a liability or prepaid is fine) and clearing it back to its category", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const item = await createExpenseItem("other", { name: "Top-up Biteship uji", sortOrder: 0 }, staff.id, tx);
      await setAccountMapping(`expense.item.${item.id}`, "1-1603", staff.id, tx);
      expect((await getMappingPage(tx)).categories.find((row) => row.categoryCode === "other")?.items.find((row) => row.itemId === item.id)?.accountCode).toBe("1-1603");
      await clearItemMapping(item.id, staff.id, tx);
      const [row] = await tx.select().from(accountMappings).where(eq(accountMappings.mappingKey, `expense.item.${item.id}`));
      expect(row).toBeUndefined();
      expect((await auditRows(tx, "account_mapping", `expense.item.${item.id}`)).map((audit) => audit.action).sort()).toEqual(["clear", "set"]);
    });
  });

  test("methods only to Kas & Bank, channels only to revenue; headers, inactive and unknown keys refused", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      expect((await rejection(setAccountMapping("cash.method.transfer", "1-1301", staff.id, tx))).message).toBe(MAPPING_MESSAGES.targetProblem.not_cash_bank);
      expect((await rejection(setAccountMapping("revenue.channel.web", "4-1201", staff.id, tx))).message).toBe(MAPPING_MESSAGES.targetProblem.not_revenue);
      expect((await rejection(setAccountMapping("expense.category.salary", "6-2000", staff.id, tx))).message).toBe(MAPPING_MESSAGES.targetProblem.not_postable);
      expect((await rejection(setAccountMapping("expense.category.tidak_ada", "6-2101", staff.id, tx))).message).toBe(MAPPING_MESSAGES.unknownKey);
      expect((await rejection(setAccountMapping("supplier_payable.kind.material", "2-1101", staff.id, tx))).message).toBe(MAPPING_MESSAGES.unknownKey);
      await setAccountMapping("cash.method.card", "1-1101", staff.id, tx);
      const [card] = await tx.select().from(accountMappings).where(eq(accountMappings.mappingKey, "cash.method.card"));
      expect(card?.accountCode).toBe("1-1101");
    });
  });
});

describe("tax settings (D-20)", () => {
  test("editing the rate's end date is audited with before and after", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const updated = await updateTaxSetting(
        "2026-12-01",
        {
          taxpayerType: "individual",
          taxpayerLabel: "Istri pemilik, orang pribadi",
          npwpRegisteredYear: "2020",
          ratePercent: "0,5",
          annualExemptionAmount: "500.000.000",
          rateValidUntil: "2029-12-31",
          note: "Diperpanjang revisi PP 55",
        },
        staff.id,
        tx,
      );
      expect(updated).toMatchObject({ rateBps: 50, rateValidUntil: "2029-12-31", updatedByStaffUserId: staff.id });
      const [audit] = await auditRows(tx, "tax_setting", "2026-12-01");
      expect(audit?.action).toBe("update");
      expect((audit?.before as { rateValidUntil: string }).rateValidUntil).toBe("2026-12-31");
      expect((audit?.after as { rateValidUntil: string }).rateValidUntil).toBe("2029-12-31");
    });
  });

  test("a new effective month is added and audited; the same month twice is refused", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const input = { effectiveFrom: "2031-01", taxpayerType: "company", taxpayerLabel: "PT Ammari", ratePercent: "0,5", annualExemptionAmount: "0", rateValidUntil: "" };
      const created = await createTaxSetting(input, staff.id, tx);
      expect(created).toMatchObject({ effectiveFrom: "2031-01-01", taxpayerType: "company", annualExemptionAmount: 0, rateValidUntil: null });
      expect((await auditRows(tx, "tax_setting", "2031-01-01"))[0]?.action).toBe("create");
      expect(await rejection(createTaxSetting(input, staff.id, tx))).toMatchObject({ field: "effectiveFrom" });
      const rows = await tx.select().from(taxSettings).where(eq(taxSettings.effectiveFrom, "2031-01-01"));
      expect(rows).toHaveLength(1);
    });
  });

  test("an unknown month is not found", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      expect(await rejection(updateTaxSetting("2030-07-01", { taxpayerType: "individual", taxpayerLabel: "x", ratePercent: "1", annualExemptionAmount: "0" }, staff.id, tx))).toBeInstanceOf(ActionError);
    });
  });
});

