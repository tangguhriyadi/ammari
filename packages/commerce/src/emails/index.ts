// @ammari/commerce/emails (docs/plans/cart-checkout.md D14, §8; session 13): the transactional
// order emails, their templates and the at-most-once dispatcher over `order_notifications`.
import "server-only";

export {
  NOTIFICATION_LEASE_MINUTES,
  NOTIFICATION_RETRY_HOURS,
  NOTIFICATION_SCAN_HOURS,
  dispatchOrderEmails,
  dispatchPendingOrderEmails,
  dueOrderEmails,
  type DueOrderEmail,
  type OrderEmailDeps,
  type OrderEmailDispatch,
  type OrderEmailLoginLinks,
  type LoginLinkIssueOutcome,
  type OrderEmailOutcome,
  type OrderEmailState,
  type OrderEmailTransport,
  type PendingEmailSummary,
} from "./dispatch";
export { deriveOrderEmailAccessToken, deriveOrderEmailLoginToken } from "./token";
export {
  renderCancelledEmail,
  renderCreatedEmail,
  renderOwnerPaidEmail,
  renderPaidEmail,
  renderShippedEmail,
  subsidyNote,
  type CancelledEmailReason,
  type RenderedEmail,
} from "./templates";
