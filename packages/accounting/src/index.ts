// @ammari/accounting: the double-entry ledger's posting service (docs/plans/accounting.md §2).
// Session 1 ships only the pure building blocks; the engine, rules and runner arrive in Session 2.
// Never imported by @ammari/commerce (the ledger is derived; no existing write path calls it).
// Modules that touch the database will import "server-only".

export { isBalancedJournal, journalLinesProblems, MAX_JOURNAL_MEMO_LENGTH, type JournalLineDraft, type JournalLinesProblem } from "./journal";
export { isExpenseLikeAccountType, isPurchaseSideSource, purchaseGuardViolations, type JournalSourceKey } from "./purchase-guard";
