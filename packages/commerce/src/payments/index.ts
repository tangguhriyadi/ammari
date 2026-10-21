// @ammari/commerce/payments (docs/plans/cart-checkout.md D5 to D8, §6): the payment provider seam
// (Midtrans Snap, or the fake in tests and e2e), payment pages per attempt, the notification
// handler and the one payment state machine.
import "server-only";

export {
  PAYMENT_STATUS_TIMEOUT_MS,
  PaymentProviderError,
  type CreatePaymentInput,
  type CreatedPayment,
  type GetPaymentStatusOptions,
  type NotificationSignatureFields,
  type PaymentLine,
  type PaymentProvider,
  type PaymentProviderErrorReason,
  type PaymentStatusReport,
} from "./provider";
export { PAYMENT_ORDER_ID_PREFIX_PATTERN, buildPaymentLines, providerOrderId, type PaymentProductLine } from "./lines";
export {
  FAKE_PAYMENT_PAGE_PATH,
  FAKE_PAYMENT_SERVER_KEY,
  createFakePaymentProvider,
  recordFakeTransaction,
  type FakePaymentProviderOptions,
  type FakeTransactionInput,
} from "./fake";
export { MIDTRANS_ENABLED_PAYMENTS, createMidtransPaymentProvider, type MidtransProviderOptions } from "./midtrans";
export { midtransSignature, parsePaymentStatusBody, verifyMidtransSignature } from "./status";
export {
  DEFAULT_PAYMENT_EXPIRY_MINUTES,
  paymentProviderFromEnv,
  paymentRuntimeFromEnv,
  type PaymentEnv,
  type PaymentRuntime,
  type PaymentRuntimeResult,
} from "./config";
export { applyPaymentStatus, expireOrderWithoutLiveTransaction, type ApplyOutcome, type ApplyResult } from "./apply-status";
export {
  PAYMENT_NOTIFICATION_MAX_BYTES,
  handlePaymentNotification,
  logRefusedNotificationBody,
  type NotificationHandled,
  type NotificationResult,
} from "./notification";
export { MAX_PAYMENT_ATTEMPTS, PAYMENT_PAGE_TIMEOUT_MS, reopenPaymentPage, type ReopenPaymentPageResult } from "./attempts";
export { syncLatestPaymentStatus, type SyncPaymentResult } from "./sync";
export { SWEEP_BATCH_SIZE, SWEEP_TIME_BUDGET_MS, sweepExpiredPayments, type SweepOptions, type SweepOrderResult, type SweepSummary } from "./sweep";
