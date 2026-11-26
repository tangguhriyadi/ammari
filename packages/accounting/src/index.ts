// @ammari/accounting: the double-entry ledger's posting service (docs/plans/accounting.md §2).
// This entry point is pure (no database): journal validation, the D-14 purchase guard, Jakarta
// period dates, the posting rules and the runner's decision logic. The database runner lives in
// "@ammari/accounting/runner" (server-only).
// Never imported by @ammari/commerce (the ledger is derived; no existing write path calls it).

export { isBalancedJournal, journalLinesProblems, MAX_JOURNAL_MEMO_LENGTH, type JournalLineDraft, type JournalLinesProblem } from "./journal";
export { isExpenseLikeAccountType, isPurchaseSideSource, purchaseGuardViolations, type JournalSourceKey } from "./purchase-guard";
export {
  OFFICIAL_BOOKS_START,
  TRIAL_BOOKS_END,
  TRIAL_BOOKS_START,
  bookSegmentOf,
  crossesCutover,
  resolveReportRange,
  segmentStartOf,
  type BookSegment,
  type ReportRange,
} from "./books";
export { POSTING_START_DATE, isCalendarDate, jakartaDateOf, monthEndOf, monthStartOf, nextMonthStart, postingDateFor } from "./dates";
export { decideAction, journalContentHash, planEvent, type KeyAction, type PlannedOutcome } from "./plan";
export {
  PostingIssueError,
  negateOutcome,
  resolveOrIssue,
  type AccountInfo,
  type PostingContext,
  type PostingEvent,
  type PostingKey,
  type PostingOutcome,
  type PostingRule,
} from "./rules/types";
export { EXPENSE_SOURCE_TYPE, expenseRule, expensePaidOutcome, type ExpenseSnapshot } from "./rules/expenses";
export {
  DEFECT_MOVEMENT_SOURCE_TYPE,
  GOODS_RECEIPT_ITEM_SOURCE_TYPE,
  PURCHASE_CHAIN_RULE_VERSION,
  PURCHASE_SOURCE_TYPE,
  isTerminalPurchaseStatus,
  positionFor,
  purchaseChainEvents,
  purchaseChainRule,
  replayPurchaseChain,
  stepKey,
  type ChainResult,
  type ChainState,
  type PositionDelta,
  type StepResult,
  type PurchaseDefectReturnSnapshot,
  type PurchaseDocumentSnapshot,
  type PurchasePaymentSnapshot,
  type PurchaseReceiptItemSnapshot,
} from "./rules/purchases";
export {
  ACCESSORY_MOVEMENT_SOURCE_TYPE,
  FABRIC_MOVEMENT_SOURCE_TYPE,
  adjustmentExpenseKey,
  markReclassifications,
  rawMaterialAdjustmentOutcome,
  rawMaterialAdjustmentRule,
  type RawMaterialKind,
  type RawMaterialMovementSnapshot,
} from "./rules/raw-materials";
export { SUPPLIER_PAYMENT_SOURCE_TYPE, supplierPaymentRule, supplierPaymentPaidOutcome, type SupplierPaymentSnapshot } from "./rules/supplier-payments";
export {
  MANUAL_PAYMENT_MISSING_ISSUE,
  cashMethodMappingKey,
  isManualPaymentOrder,
  manualOrderMoneyIn,
  suggestedCashAccountFor,
  type ManualPaymentRecord,
} from "./rules/manual-orders";
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
