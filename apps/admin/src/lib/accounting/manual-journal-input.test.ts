import { describe, expect, test } from "vitest";
import { CHART_OF_ACCOUNTS } from "@ammari/db/accounting";
import { FieldError } from "@/lib/errors";
import { defaultManualJournalDate, findTemplate, MANUAL_JOURNAL_MESSAGES, MANUAL_JOURNAL_TEMPLATES, normalizeReversalReason, validateManualJournal, type ManualJournalLineInput } from "./manual-journal-input";

// Manual journal validation (docs/plans/accounting.md §5, Session 4): every refusal is a field
// message before anything is stored; what passes is a balanced journal the database accepts.

const accounts = new Map(CHART_OF_ACCOUNTS.map((row) => [row.code, { isActive: true, isHeader: row.isHeader }]));
accounts.set("1-1209", { isActive: false, isHeader: false });
const TODAY = "2027-01-20";

function line(accountCode: string, debit = "", credit = "", memo = ""): ManualJournalLineInput {
  return { accountCode, debit, credit, memo };
}

function fieldOf(fn: () => unknown): { field: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof FieldError) return { field: error.field, message: error.message };
    throw error;
  }
  throw new Error("expected a FieldError");
}

const valid = { entryDate: "2027-01-15", description: "Top-up Saldo Biteship", lines: [line("1-1603", "1.500.000"), line("1-1201", "", "Rp 1.500.000", "Mutasi BCA 15/1")] };

describe("validateManualJournal", () => {
  test("a balanced two-line journal: amounts parsed as whole rupiah, memo kept, blank spare rows ignored", () => {
    const result = validateManualJournal({ ...valid, lines: [...valid.lines, line(""), line("")] }, { today: TODAY, accounts });
    expect(result).toEqual({
      entryDate: "2027-01-15",
      description: "Top-up Saldo Biteship",
      lines: [
        { accountCode: "1-1603", debit: 1_500_000, credit: 0, memo: null },
        { accountCode: "1-1201", debit: 0, credit: 1_500_000, memo: "Mutasi BCA 15/1" },
      ],
    });
  });

  test("date: a real calendar day, from the trial month (1 Dec 2026), not after the current month, not in a closed month", () => {
    expect(fieldOf(() => validateManualJournal({ ...valid, entryDate: "2027-02-30" }, { today: TODAY, accounts }))).toEqual({ field: "entryDate", message: MANUAL_JOURNAL_MESSAGES.invalidDate });
    expect(fieldOf(() => validateManualJournal({ ...valid, entryDate: "2026-11-30" }, { today: TODAY, accounts }))).toEqual({ field: "entryDate", message: MANUAL_JOURNAL_MESSAGES.beforeBooks });
    expect(fieldOf(() => validateManualJournal({ ...valid, entryDate: "2027-02-01" }, { today: TODAY, accounts }))).toEqual({ field: "entryDate", message: MANUAL_JOURNAL_MESSAGES.futureMonth });
    // An accrual dated the last day of the current month is fine.
    expect(validateManualJournal({ ...valid, entryDate: "2027-01-31" }, { today: TODAY, accounts }).entryDate).toBe("2027-01-31");
    // Before December 2026 the trial month can already be practised; never the official books.
    expect(validateManualJournal({ ...valid, entryDate: "2026-12-31" }, { today: "2026-11-26", accounts }).entryDate).toBe("2026-12-31");
    expect(fieldOf(() => validateManualJournal({ ...valid, entryDate: "2027-01-01" }, { today: "2026-11-26", accounts })).message).toBe(MANUAL_JOURNAL_MESSAGES.futureMonth);
    expect(defaultManualJournalDate("2026-11-26")).toBe("2026-12-01");
    expect(defaultManualJournalDate("2027-01-20")).toBe("2027-01-20");
    expect(fieldOf(() => validateManualJournal(valid, { today: TODAY, accounts, closedMonths: new Set(["2027-01-01"]) }))).toEqual({
      field: "entryDate",
      message: MANUAL_JOURNAL_MESSAGES.closedMonth,
    });
  });

  test("description required, at most 500 characters", () => {
    expect(fieldOf(() => validateManualJournal({ ...valid, description: "  " }, { today: TODAY, accounts })).field).toBe("description");
    expect(fieldOf(() => validateManualJournal({ ...valid, description: "x".repeat(501) }, { today: TODAY, accounts })).field).toBe("description");
  });

  test("lines: at least two; each a postable active account; exactly one side, whole rupiah", () => {
    expect(fieldOf(() => validateManualJournal({ ...valid, lines: [valid.lines[0]!] }, { today: TODAY, accounts })).message).toBe(MANUAL_JOURNAL_MESSAGES.tooFewLines);
    expect(fieldOf(() => validateManualJournal({ ...valid, lines: [line("", "100"), line("1-1201", "", "100")] }, { today: TODAY, accounts }))).toEqual({
      field: "lines.0.accountCode",
      message: MANUAL_JOURNAL_MESSAGES.accountRequired,
    });
    // A header, an inactive account and an unknown code are all refused.
    for (const code of ["1-1000", "1-1209", "1-9999"]) {
      expect(fieldOf(() => validateManualJournal({ ...valid, lines: [line(code, "100"), line("1-1201", "", "100")] }, { today: TODAY, accounts })).field).toBe("lines.0.accountCode");
    }
    for (const [debit, credit] of [["100", "100"], ["", ""], ["1,5", ""], ["-100", ""], ["0", ""]]) {
      expect(fieldOf(() => validateManualJournal({ ...valid, lines: [line("1-1603", debit, credit), line("1-1201", "", "100")] }, { today: TODAY, accounts })).field).toBe("lines.0.debit");
    }
  });

  test("debit total must equal credit total", () => {
    expect(fieldOf(() => validateManualJournal({ ...valid, lines: [line("1-1603", "1.500.000"), line("1-1201", "", "1.400.000")] }, { today: TODAY, accounts }))).toEqual({
      field: "lines",
      message: MANUAL_JOURNAL_MESSAGES.unbalanced,
    });
  });

  test("a reversal reason is required and at most 300 characters", () => {
    expect(normalizeReversalReason("  Salah nominal  ")).toBe("Salah nominal");
    expect(fieldOf(() => normalizeReversalReason(" ")).field).toBe("reason");
    expect(fieldOf(() => normalizeReversalReason("x".repeat(301))).field).toBe("reason");
  });
});

describe("templates (plan §5.5)", () => {
  test("the three plan templates plus closing opening equity into capital, each balanced Dr/Cr on system accounts", () => {
    const systemKeys = new Set(CHART_OF_ACCOUNTS.map((row) => row.systemKey).filter(Boolean));
    expect(MANUAL_JOURNAL_TEMPLATES.map((template) => template.key)).toEqual(["biteship_topup", "shopee_withdrawal", "tiktok_withdrawal", "refund_via_midtrans", "opening_equity_to_capital"]);
    for (const template of MANUAL_JOURNAL_TEMPLATES) {
      expect(template.lines.map((line) => line.side).sort()).toEqual(["credit", "debit"]);
      for (const line of template.lines) expect(systemKeys.has(line.systemKey)).toBe(true);
    }
    expect(findTemplate("biteship_topup")?.lines).toEqual([
      { systemKey: "prepaid.biteship", side: "debit" },
      { systemKey: "bank.main", side: "credit" },
    ]);
    expect(findTemplate("refund_via_midtrans")?.lines).toEqual([
      { systemKey: "bank.main", side: "debit" },
      { systemKey: "receivable.midtrans", side: "credit" },
    ]);
    expect(findTemplate("nope")).toBeNull();
  });

  test("no template ever posts to an inventory account (D-14: raw materials reach inventory only through goods receipts)", () => {
    const codeBySystemKey = new Map(CHART_OF_ACCOUNTS.filter((row) => row.systemKey).map((row) => [row.systemKey, row.code]));
    for (const template of MANUAL_JOURNAL_TEMPLATES) {
      for (const line of template.lines) expect(codeBySystemKey.get(line.systemKey)).not.toMatch(/^1-15/);
    }
  });
});
