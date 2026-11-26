// A journal's lines before they are written (docs/plans/accounting.md §2, §4.8). Posting rules
// (Session 2 onward) are pure functions `snapshot → JournalLineDraft[]`; the runner validates the
// result here before inserting, so a rule that cannot balance becomes a posting issue instead of a
// database error. The database enforces the same rules again (migration 0049 triggers) as the
// backstop.

export interface JournalLineDraft {
  accountCode: string;
  /** Whole rupiah. Exactly one of debit/credit is positive; the other is 0. */
  debit: number;
  credit: number;
  memo?: string | null;
  channelId?: string | null;
  supplierId?: string | null;
  orderId?: string | null;
  cashAccountCode?: string | null;
}

export type JournalLinesProblem =
  | { code: "too_few_lines"; lineCount: number }
  | { code: "invalid_account_code"; lineIndex: number }
  | { code: "invalid_amount"; lineIndex: number }
  | { code: "one_sided_line"; lineIndex: number }
  | { code: "invalid_memo"; lineIndex: number }
  | { code: "unbalanced"; debitTotal: number; creditTotal: number };

/** Same rules as the database (accounts_code_check, journal_lines_memo_check in migration 0049),
 * so every line this accepts is one the insert accepts too. */
const ACCOUNT_CODE_PATTERN = /^[1-9]-[0-9]{4}$/;
export const MAX_JOURNAL_MEMO_LENGTH = 500;

function isWholeRupiah(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidMemo(memo: string | null | undefined): boolean {
  if (memo === null || memo === undefined) return true;
  return memo.trim() !== "" && memo.length <= MAX_JOURNAL_MEMO_LENGTH;
}

/** Every problem with a set of lines, in line order then totals; empty when the lines can be
 * posted as one journal: at least two lines, a well-formed account code, whole non-negative
 * rupiah, exactly one positive side per line, a memo that is absent or non-blank and at most 500
 * characters, and Σ debit = Σ credit. When any amount is invalid the totals are not checked (they
 * would be partial and the "unbalanced" report misleading); fix the amounts first. */
export function journalLinesProblems(lines: readonly JournalLineDraft[]): JournalLinesProblem[] {
  const problems: JournalLinesProblem[] = [];
  if (lines.length < 2) problems.push({ code: "too_few_lines", lineCount: lines.length });
  let debitTotal = 0;
  let creditTotal = 0;
  let amountsValid = true;
  lines.forEach((line, lineIndex) => {
    if (!ACCOUNT_CODE_PATTERN.test(line.accountCode)) problems.push({ code: "invalid_account_code", lineIndex });
    if (!isWholeRupiah(line.debit) || !isWholeRupiah(line.credit)) {
      problems.push({ code: "invalid_amount", lineIndex });
      amountsValid = false;
    } else {
      if ((line.debit > 0) === (line.credit > 0)) problems.push({ code: "one_sided_line", lineIndex });
      debitTotal += line.debit;
      creditTotal += line.credit;
    }
    if (!isValidMemo(line.memo)) problems.push({ code: "invalid_memo", lineIndex });
  });
  if (amountsValid && (!Number.isSafeInteger(debitTotal) || !Number.isSafeInteger(creditTotal) || debitTotal !== creditTotal)) {
    problems.push({ code: "unbalanced", debitTotal, creditTotal });
  }
  return problems;
}

export function isBalancedJournal(lines: readonly JournalLineDraft[]): boolean {
  return journalLinesProblems(lines).length === 0;
}
