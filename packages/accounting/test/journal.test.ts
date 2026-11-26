import { describe, expect, test } from "vitest";
import { isBalancedJournal, journalLinesProblems, MAX_JOURNAL_MEMO_LENGTH, type JournalLineDraft } from "../src";

const dr = (accountCode: string, amount: number): JournalLineDraft => ({ accountCode, debit: amount, credit: 0 });
const cr = (accountCode: string, amount: number): JournalLineDraft => ({ accountCode, debit: 0, credit: amount });

describe("journalLinesProblems", () => {
  test("a balanced journal of two or more lines has no problems", () => {
    expect(journalLinesProblems([dr("1-1201", 1_000_000), cr("3-1001", 1_000_000)])).toEqual([]);
    expect(isBalancedJournal([dr("1-1201", 750_000), dr("1-1101", 250_000), cr("3-1001", 1_000_000)])).toBe(true);
  });

  test("fewer than two lines", () => {
    expect(journalLinesProblems([])).toEqual([{ code: "too_few_lines", lineCount: 0 }]);
    expect(journalLinesProblems([dr("1-1201", 5)])).toEqual([
      { code: "too_few_lines", lineCount: 1 },
      { code: "unbalanced", debitTotal: 5, creditTotal: 0 },
    ]);
  });

  test("unbalanced totals", () => {
    expect(journalLinesProblems([dr("1-1201", 1_000_000), cr("3-1001", 999_999)])).toEqual([
      { code: "unbalanced", debitTotal: 1_000_000, creditTotal: 999_999 },
    ]);
  });

  test("a line with both sides, or neither side, positive", () => {
    expect(journalLinesProblems([{ accountCode: "1-1201", debit: 5, credit: 5 }, cr("3-1001", 0), dr("1-1101", 0)])).toEqual([
      { code: "one_sided_line", lineIndex: 0 },
      { code: "one_sided_line", lineIndex: 1 },
      { code: "one_sided_line", lineIndex: 2 },
    ]);
  });

  test("money is whole, non-negative rupiah (never a float, never negative)", () => {
    for (const bad of [-1, 0.5, 1_000.25, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      // Only the bad amount is reported: totals that skip a line would be a misleading "unbalanced".
      expect(journalLinesProblems([dr("1-1201", bad), cr("3-1001", 10)])).toEqual([{ code: "invalid_amount", lineIndex: 0 }]);
      expect(isBalancedJournal([dr("1-1201", bad), cr("3-1001", bad)])).toBe(false);
    }
  });

  test("account codes have the database's shape", () => {
    for (const bad of ["", "1501", "1-150", "0-1501", "1-15011", "x-1501", " 1-1501"]) {
      expect(journalLinesProblems([dr(bad, 10), cr("3-1001", 10)])).toEqual([{ code: "invalid_account_code", lineIndex: 0 }]);
    }
  });

  test("a memo is absent, or non-blank and at most 500 characters (the database CHECK)", () => {
    const withMemo = (memo: string | null | undefined): JournalLineDraft => ({ ...dr("1-1201", 10), memo });
    for (const ok of [null, undefined, "Top-up Biteship", "x".repeat(MAX_JOURNAL_MEMO_LENGTH)]) {
      expect(journalLinesProblems([withMemo(ok), cr("3-1001", 10)])).toEqual([]);
    }
    for (const bad of ["", "   ", "x".repeat(MAX_JOURNAL_MEMO_LENGTH + 1)]) {
      expect(journalLinesProblems([withMemo(bad), cr("3-1001", 10)])).toEqual([{ code: "invalid_memo", lineIndex: 0 }]);
    }
  });

  test("totals that overflow safe integers are unbalanced, never silently equal", () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(isBalancedJournal([dr("1-1201", big), dr("1-1101", big), cr("3-1001", big), cr("3-1002", big)])).toBe(false);
  });
});
