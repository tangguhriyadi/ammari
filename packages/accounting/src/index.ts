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
export { comparableActiveHash, decideAction, journalContentHash, planEvent, type KeyAction, type PlannedOutcome } from "./plan";
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
export {
  PRODUCTION_BATCH_SOURCE_TYPE,
  PRODUCTION_CHAIN_RULE_VERSION,
  batchCost,
  batchEndDate,
  batchWipAsOf,
  batchWipBeforeClose,
  isEndedReceiptStatus,
  productionChainEvents,
  productionChainRule,
  productionStepKey,
  replayProductionChain,
  type PositionChange,
  type ProductionBatchSnapshot,
  type ProductionChainResult,
  type ProductionCostLineSnapshot,
  type ProductionDefectReturnSnapshot,
  type ProductionPaymentSnapshot,
  type ProductionReceiptItemSnapshot,
} from "./rules/production";
export {
  STOCK_MOVEMENT_SOURCE_TYPE,
  defectDisposalOutcome,
  defectDisposalRule,
  finishedGoodsAdjustmentOutcome,
  finishedGoodsAdjustmentRule,
  type DefectDisposalSnapshot,
  type FinishedGoodsAdjustmentSnapshot,
} from "./rules/inventory";
export {
  MARKETPLACE_SHIP_DATE_MISSING_ISSUE,
  ORDER_SOURCE_TYPE,
  PAYMENT_CHARGEBACK_ISSUE,
  PAYMENT_GATEWAY_FEE_COMPONENT,
  PAYMENT_SOURCE_TYPE,
  SALES_RULE_VERSION,
  SHIPMENT_SOURCE_TYPE,
  depositAtCancel,
  gatewayRefundAt,
  isPaidPayment,
  orderKey,
  orderKind,
  orderSaleValue,
  paidAfterCancel,
  recognitionDate,
  refundParts,
  salesEvents,
  salesRule,
  shipmentChargeOutcome,
  type OrderChannelFeeSnapshot,
  type OrderKind,
  type OrderPaymentSnapshot,
  type OrderShipmentSnapshot,
  type OrderSnapshot,
  type OrderStockMovementSnapshot,
} from "./rules/sales";
export {
  ORDER_CHANNEL_FEE_SOURCE_TYPE,
  ORDER_SETTLEMENT_SOURCE_TYPE,
  mdrOutcome,
  mdrRule,
  midtransSettlementRule,
  settlementOutcome,
  type MdrFeeSnapshot,
  type MdrSource,
  type MidtransSettlementSnapshot,
} from "./rules/midtrans";
export { orderAccountMovements, type OrderAccountMovements } from "./sales-balances";
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
