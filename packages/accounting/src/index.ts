// @ammari/accounting: the double-entry ledger's posting service (docs/plans/accounting.md §2).
// This entry point is pure (no database): journal validation, the D-14 purchase guard, Jakarta
// period dates, the posting rules and the runner's decision logic. The database runner lives in
// "@ammari/accounting/runner" (server-only).
// Never imported by @ammari/commerce (the ledger is derived; no existing write path calls it).

export { isBalancedJournal, journalLinesProblems, MAX_JOURNAL_MEMO_LENGTH, type JournalLineDraft, type JournalLinesProblem } from "./journal";
export { isExpenseLikeAccountType, isPurchaseSideSource, purchaseGuardViolations, type JournalSourceKey } from "./purchase-guard";
export { POSTING_START_DATE, isCalendarDate, jakartaDateOf, monthEndOf, monthStartOf, nextMonthStart, postingDateFor } from "./dates";
export { decideAction, journalContentHash, planEvent, type KeyAction, type PlannedOutcome } from "./plan";
export {
  negateOutcome,
  type AccountInfo,
  type PostingContext,
  type PostingEvent,
  type PostingKey,
  type PostingOutcome,
  type PostingRule,
} from "./rules/types";
export { EXPENSE_SOURCE_TYPE, expenseRule, expensePaidOutcome, type ExpenseSnapshot } from "./rules/expenses";
export { SUPPLIER_PAYMENT_SOURCE_TYPE, supplierPaymentRule, supplierPaymentPaidOutcome, type SupplierPaymentSnapshot } from "./rules/supplier-payments";
export {
  accountCodeMatchesType,
  accountTypesForCode,
  isAccountCode,
  isCashBankAccountCode,
  isInventoryAccountCode,
  mappingFamily,
  mappingTargetProblem,
  type MappingFamily,
  type MappingTargetAccount,
  type MappingTargetProblem,
} from "./mapping-rules";
