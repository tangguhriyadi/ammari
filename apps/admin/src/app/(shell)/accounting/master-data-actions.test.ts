import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStaffSession: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  setAccountActive: vi.fn(),
  deleteAccount: vi.fn(),
  setAccountMapping: vi.fn(),
  clearItemMapping: vi.fn(),
  createTaxSetting: vi.fn(),
  updateTaxSetting: vi.fn(),
}));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: mocks.getStaffSession }));
vi.mock("@/lib/admin-revalidate", () => ({ revalidateAdmin: vi.fn() }));
// The writes themselves run against a real database in lib/accounting/master-data.test.ts; here
// only the permission gate in front of them and the input shaping.
vi.mock("@/lib/accounting/accounts", () => ({
  createAccount: mocks.createAccount,
  updateAccount: mocks.updateAccount,
  setAccountActive: mocks.setAccountActive,
  deleteAccount: mocks.deleteAccount,
}));
vi.mock("@/lib/accounting/mappings", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setAccountMapping: mocks.setAccountMapping,
  clearItemMapping: mocks.clearItemMapping,
}));
vi.mock("@/lib/accounting/tax-settings", () => ({ createTaxSetting: mocks.createTaxSetting, updateTaxSetting: mocks.updateTaxSetting }));

const accountActions = await import("./accounts/actions");
const mappingActions = await import("./mappings/actions");
const taxActions = await import("./tax-settings/actions");

// docs/plans/accounting.md §7: the Chart of Accounts, mappings and tax settings are
// accounting.manage; the pages are accounting.view, so every action needs both.

function session(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test", email: "t@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "r", name: "R" },
    permissionKeys,
  };
}

const TAX_INPUT = { taxpayerType: "individual", taxpayerLabel: "x", ratePercent: "0,5", annualExemptionAmount: "0" };

const calls: { name: string; run: () => Promise<unknown>; mock: ReturnType<typeof vi.fn> }[] = [
  {
    name: "createAccountAction",
    run: () => accountActions.createAccountAction({ code: "1-1202", name: "Bank", type: "asset", normalBalance: "debit", isHeader: false, parentCode: "1-1200" }),
    mock: mocks.createAccount,
  },
  { name: "updateAccountAction", run: () => accountActions.updateAccountAction("1-1202", { name: "Bank", parentCode: null }), mock: mocks.updateAccount },
  { name: "setAccountActiveAction", run: () => accountActions.setAccountActiveAction({ code: "1-1202", isActive: false }), mock: mocks.setAccountActive },
  { name: "deleteAccountAction", run: () => accountActions.deleteAccountAction("1-1202"), mock: mocks.deleteAccount },
  { name: "setAccountMappingAction", run: () => mappingActions.setAccountMappingAction({ mappingKey: "expense.category.salary", accountCode: "6-2101" }), mock: mocks.setAccountMapping },
  { name: "clearItemMappingAction", run: () => mappingActions.clearItemMappingAction("0b9d3c2e-1111-4222-8333-444455556666"), mock: mocks.clearItemMapping },
  { name: "createTaxSettingAction", run: () => taxActions.createTaxSettingAction({ ...TAX_INPUT, effectiveFrom: "2027-01" }), mock: mocks.createTaxSetting },
  { name: "updateTaxSettingAction", run: () => taxActions.updateTaxSettingAction("2026-12-01", TAX_INPUT), mock: mocks.updateTaxSetting },
];

describe("master-data actions need accounting.view AND accounting.manage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.createAccount.mockResolvedValue({ code: "1-1202" });
    mocks.createTaxSetting.mockResolvedValue({ effectiveFrom: "2027-01-01" });
  });

  for (const call of calls) {
    test(`${call.name}: a view-only role and a manage-only role are refused; both keys write`, async () => {
      mocks.getStaffSession.mockResolvedValue(session(["accounting.view"]));
      await expect(call.run()).rejects.toThrow();
      mocks.getStaffSession.mockResolvedValue(session(["accounting.manage"]));
      await expect(call.run()).rejects.toThrow();
      expect(call.mock).not.toHaveBeenCalled();

      mocks.getStaffSession.mockResolvedValue(session(["accounting.view", "accounting.manage"]));
      await expect(call.run()).resolves.toMatchObject({ ok: true });
      expect(call.mock).toHaveBeenCalledTimes(1);
    });
  }

  test("a mapping to a malformed account code is refused before the query", async () => {
    mocks.getStaffSession.mockResolvedValue(session(["accounting.view", "accounting.manage"]));
    expect(await mappingActions.setAccountMappingAction({ mappingKey: "expense.category.salary", accountCode: "x" })).toMatchObject({ ok: false });
    expect(mocks.setAccountMapping).not.toHaveBeenCalled();
  });
});
