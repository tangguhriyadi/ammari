import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStaffSession: vi.fn(),
  postManualJournal: vi.fn(),
  prevalidateManualJournal: vi.fn(),
  reverseStaffJournal: vi.fn(),
  closePeriod: vi.fn(),
  reopenPeriod: vi.fn(),
  postOpeningBalance: vi.fn(),
  prevalidateOpeningBalance: vi.fn(),
  storeJournalAttachment: vi.fn(),
}));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: mocks.getStaffSession }));
vi.mock("@/lib/admin-revalidate", () => ({ revalidateAdmin: vi.fn() }));
// The writes are covered against a real database (lib/accounting/session4.test.ts); here only the
// server-side permission gate in front of them (CLAUDE.md: never only by hiding UI).
vi.mock("@/lib/accounting/manual-journals", () => ({
  postManualJournal: mocks.postManualJournal,
  prevalidateManualJournal: mocks.prevalidateManualJournal,
  reverseStaffJournal: mocks.reverseStaffJournal,
}));
vi.mock("@/lib/accounting/periods", () => ({ closePeriod: mocks.closePeriod, reopenPeriod: mocks.reopenPeriod }));
vi.mock("@/lib/accounting/opening-balance", () => ({ postOpeningBalance: mocks.postOpeningBalance, prevalidateOpeningBalance: mocks.prevalidateOpeningBalance }));
vi.mock("@/lib/accounting/journal-form-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accounting/journal-form-data")>()),
  storeJournalAttachment: mocks.storeJournalAttachment,
}));

const { postManualJournalAction, reverseJournalAction } = await import("./journal/actions");
const { closePeriodAction, reopenPeriodAction } = await import("./periods/actions");
const { postOpeningBalanceAction } = await import("./opening-balance/actions");

// docs/plans/accounting.md §7: manual and opening journals need accounting.manage, closing and
// reopening a month accounting.close; every one also accounting.view (the pages).

function session(permissionKeys: string[]) {
  return { staffUser: { id: "staff-1", name: "Uji", email: "uji@example.test", roleId: "r" }, role: { id: "r", key: "x", name: "X" }, permissionKeys };
}

const MONTH = "2027-01-01";
const ENTRY_ID = "0b6f3c2e-8e1a-4e8f-9a39-7f3a1c2d4e5f";

function journalForm(): FormData {
  const form = new FormData();
  form.set("entryDate", "2027-01-15");
  form.set("description", "Top-up Saldo Biteship");
  form.set("lines", JSON.stringify([{ accountCode: "1-1603", debit: "1000", credit: "" }, { accountCode: "1-1201", debit: "", credit: "1000" }]));
  return form;
}

function openingForm(): FormData {
  const form = new FormData();
  form.set("proposals", JSON.stringify([{ key: "inventory.fabric", confirmed: true, amount: "1000", proposedAmount: 1000 }]));
  form.set("lines", JSON.stringify([]));
  return form;
}

const calls = {
  postManualJournal: () => postManualJournalAction(journalForm()),
  reverseJournal: () => reverseJournalAction({ id: ENTRY_ID, reason: "Salah" }),
  postOpeningBalance: () => postOpeningBalanceAction(openingForm()),
  closePeriod: () => closePeriodAction({ month: MONTH }),
  reopenPeriod: () => reopenPeriodAction({ month: MONTH, reason: "Koreksi" }),
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.postManualJournal.mockResolvedValue({ entryNo: "JU-202701-0001" });
  mocks.reverseStaffJournal.mockResolvedValue({ entryNo: "JU-202701-0002" });
  mocks.postOpeningBalance.mockResolvedValue({ entryNo: "JU-202701-0003" });
  mocks.storeJournalAttachment.mockResolvedValue(null);
});

describe("Session 4 actions: permission gate", () => {
  const manageCalls = ["postManualJournal", "reverseJournal", "postOpeningBalance"] as const;
  const closeCalls = ["closePeriod", "reopenPeriod"] as const;

  for (const name of manageCalls) {
    test(`${name}: refused for view-only, for close-only and for manage without view; allowed with view + manage`, async () => {
      for (const keys of [["accounting.view"], ["accounting.view", "accounting.close"], ["accounting.manage"], ["finance.view_profit"]]) {
        mocks.getStaffSession.mockResolvedValue(session(keys));
        await expect(calls[name]()).rejects.toThrow();
      }
      expect(mocks.postManualJournal).not.toHaveBeenCalled();
      expect(mocks.reverseStaffJournal).not.toHaveBeenCalled();
      expect(mocks.postOpeningBalance).not.toHaveBeenCalled();
      mocks.getStaffSession.mockResolvedValue(session(["accounting.view", "accounting.manage"]));
      expect(await calls[name]()).toMatchObject({ ok: true });
    });
  }

  for (const name of closeCalls) {
    test(`${name}: refused for view-only and for manage (close is its own key); allowed with view + close`, async () => {
      for (const keys of [["accounting.view"], ["accounting.view", "accounting.manage"], ["accounting.close"]]) {
        mocks.getStaffSession.mockResolvedValue(session(keys));
        await expect(calls[name]()).rejects.toThrow();
      }
      expect(mocks.closePeriod).not.toHaveBeenCalled();
      expect(mocks.reopenPeriod).not.toHaveBeenCalled();
      mocks.getStaffSession.mockResolvedValue(session(["accounting.view", "accounting.close"]));
      expect(await calls[name]()).toEqual({ ok: true, data: undefined });
    });
  }

  test("the actor is always the session's staff member, never the client's", async () => {
    mocks.getStaffSession.mockResolvedValue(session(["accounting.view", "accounting.manage", "accounting.close"]));
    await calls.postManualJournal();
    await calls.reverseJournal();
    await calls.closePeriod();
    expect(mocks.postManualJournal).toHaveBeenCalledWith(expect.anything(), null, "staff-1");
    expect(mocks.reverseStaffJournal).toHaveBeenCalledWith(ENTRY_ID, "Salah", "staff-1");
    expect(mocks.closePeriod).toHaveBeenCalledWith(MONTH, null, "staff-1");
  });

  test("malformed input is refused before any write", async () => {
    mocks.getStaffSession.mockResolvedValue(session(["accounting.view", "accounting.manage", "accounting.close"]));
    const form = journalForm();
    form.set("lines", "not json");
    expect(await postManualJournalAction(form)).toMatchObject({ ok: false });
    expect(await reverseJournalAction({ id: "not-a-uuid", reason: "x" })).toMatchObject({ ok: false });
    expect(await closePeriodAction({ month: "2027-01-15" })).toMatchObject({ ok: false });
    expect(mocks.postManualJournal).not.toHaveBeenCalled();
    expect(mocks.reverseStaffJournal).not.toHaveBeenCalled();
    expect(mocks.closePeriod).not.toHaveBeenCalled();
  });
});
