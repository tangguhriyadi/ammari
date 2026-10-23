import "server-only";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import {
  customers,
  fabricColors,
  orderAccessTokens,
  orderItems,
  orderNotifications,
  orders,
  payments,
  products,
  productVariants,
  shipments,
  storeSettings,
  type OrderAttentionFlag,
  type OrderCancelReason,
  type OrderNotificationKind,
  type OrderPaymentStatus,
  type OrderStatus,
} from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import type { Database } from "../db";
import { errorLogFields } from "../errors";
import { ORDER_ACCESS_TOKEN_DAYS, hashOrderAccessToken } from "../checkout/access-token";
import {
  renderCancelledEmail,
  renderCreatedEmail,
  renderDeliveredEmail,
  renderOwnerPaidEmail,
  renderPaidEmail,
  renderShippedEmail,
  type CancelledEmailReason,
  type CustomerOrderEmailView,
  type OrderEmailAddress,
  type OrderEmailLine,
  type OrderEmailTotals,
  type RenderedEmail,
} from "./templates";
import { deriveOrderEmailAccessToken, deriveOrderEmailLoginToken } from "./token";
import { sizeLabel } from "../size-label";

// Transactional order emails (docs/plans/cart-checkout.md D14, §8; session 13).
//
// Which emails an order needs is read from the order's own state (dueOrderEmails), never passed in
// by the caller, so every hook (checkout, the payment notification, the finish page's status check,
// the expiry sweep, the courier tracking webhook and poller, and the cron pass that also covers
// staff's "Tandai dikirim") calls the same
// dispatchOrderEmails and a duplicate or late call can only send what is still due.
//
// At most once per (order, kind): the `order_notifications` row is claimed before sending with one
// atomic INSERT ... ON CONFLICT (order_id, kind) DO UPDATE ... WHERE ... RETURNING. A new row is
// claimed by inserting it; an existing row only when it was never sent, its last attempt is older
// than NOTIFICATION_LEASE_MINUTES (a send in progress elsewhere is never doubled) and it is younger
// than NOTIFICATION_RETRY_HOURS. Every send carries an idempotency key made of the row id only
// (idempotencyKey below), and a retry renders the same payload (the view token is derived from
// the row id, ./token.ts), so a send that reached the provider but whose answer was lost is not
// delivered twice. The provider keeps keys for 24 hours; retries stop at 23.
//
// Never throws and never runs inside the caller's transaction: callers run it after their commit
// (Next's `after()`), so an email can never block or roll back a payment, an expiry or an order. A
// failed send is recorded in `error` (status and provider error name only, never the address) and
// retried by the cron pass (dispatchPendingOrderEmails).

/** The email provider, structurally (apps pass @ammari/auth's EmailSender). */
export interface OrderEmailTransport {
  send(message: { to: string; subject: string; body: string; html?: string; idempotencyKey?: string }): Promise<void>;
}

/** Issues the "Masuk ke akun" login links (apps pass @ammari/auth's issueOrReuseCustomerLoginLink,
 * which hashes the token, supersedes the customer's live link and applies the per-customer cap).
 * The email carries the link only for "issued" or "existing". */
export interface OrderEmailLoginLinks {
  issueOrReuse(input: { token: string; customerId: string; email: string; orderId: string; mayIssue: boolean }): Promise<LoginLinkIssueOutcome>;
}

/** Structurally the same as @ammari/auth's IssueLoginLinkResult (commerce never imports auth). */
export type LoginLinkIssueOutcome = "issued" | "existing" | "not_issued" | "email_mismatch" | "limited";

export interface OrderEmailDeps {
  transport: OrderEmailTransport;
  /** The storefront origin, no trailing slash (links in customer emails). */
  siteOrigin: string;
  /** The admin origin, no trailing slash, or null (the owner email then has no admin link). */
  adminOrigin: string | null;
  /** The secret the "Lihat pesanan" and "Masuk ke akun" tokens are derived from (./token.ts). */
  linkSecret: string;
  /** Without it, guest emails carry no "Masuk ke akun" link. */
  loginLinks?: OrderEmailLoginLinks | null;
}

/** A failed or crashed send is retried after this long (also how long a send in progress is left
 * alone). */
export const NOTIFICATION_LEASE_MINUTES = 10;
/** Retries stop after this many hours: below the provider's 24-hour idempotency window, so a late
 * retry can never deliver a second copy. */
export const NOTIFICATION_RETRY_HOURS = 23;
/** The cron pass looks at checkout orders changed in this window. */
export const NOTIFICATION_SCAN_HOURS = 48;
/** The cron pass stops starting orders after this long; with at most two 10-second sends per order it
 * ends well before the cron's 240-second curl limit (EMAILS_MAX_TIME in both cron.sh copies), so it
 * never overlaps the next payment sweep on the shared cron lock. */
const PENDING_PASS_TIME_BUDGET_MS = 150_000;
const CANDIDATE_SCAN_LIMIT = 2_000;
/** `order_notifications.error` of a row that is never retried: the email is no longer due (the order
 * moved on before a retry), or the provider refused it for good. */
const SUPERSEDED = "superseded";
const PERMANENT_PREFIX = "permanent: ";

export type DueOrderEmail =
  | { kind: "created" }
  | { kind: "paid"; variant: "confirmed" | "review" }
  | { kind: "owner_paid"; variant: "paid" | "stock_short" | "after_cancel" }
  | { kind: "cancelled"; reason: CancelledEmailReason }
  | { kind: "shipped" }
  | { kind: "delivered" };

export interface OrderEmailState {
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus | null;
  paymentExpiresAt: Date | null;
  paidAt: Date | null;
  /** Tells a staff cancel of a paid order from a payment that arrived after the cancel. */
  cancelledAt: Date | null;
  cancelReason: OrderCancelReason | null;
  needsAttention: OrderAttentionFlag[];
  /** The "sudah dikirim" email waits for it (a resi added later on the admin order page). */
  trackingNumber: string | null;
  /** A courier booking of the order reported the parcel delivered (Phase K3): only then does a
   * completed order get "sudah sampai" (staff's own "Selesai" sends nothing). */
  deliveredByCourier?: boolean;
}

/** The emails a checkout order needs in its current state (plan §8; owner decisions 2026-10-21,
 * session 13). Orders without `payment_status` (manual and marketplace orders) never get any. */
export function dueOrderEmails(order: OrderEmailState, now: Date): DueOrderEmail[] {
  if (order.paymentStatus === null) return [];
  const paidAfterCancel = order.needsAttention.includes("paid_after_cancel");
  switch (order.status) {
    case "awaiting_payment":
      if (order.paymentStatus === "pending") return order.paymentExpiresAt !== null && order.paymentExpiresAt > now ? [{ kind: "created" }] : [];
      // Paid while physical stock was short (§6.2): the order waits for staff.
      if (order.paymentStatus === "paid") return [{ kind: "paid", variant: "review" }, { kind: "owner_paid", variant: "stock_short" }];
      return [];
    case "to_ship":
      return order.paidAt !== null ? [{ kind: "paid", variant: "confirmed" }, { kind: "owner_paid", variant: "paid" }] : [];
    case "shipped":
      // Never "sudah dikirim" without a resi to track (owner, 2026-10-21 sandbox run). Staff must
      // enter one to ship a checkout order; an order that shipped without one (before that rule)
      // gets the email once staff add it on the order page.
      return order.trackingNumber?.trim() ? [{ kind: "shipped" }] : [];
    case "completed":
      // "Pesanan sudah sampai" (plan §8, K3): the courier reported it delivered. An order that went
      // from to_ship straight to completed in one read gets only this one (its unsent "sudah
      // dikirim" is superseded).
      return order.deliveredByCourier ? [{ kind: "delivered" }] : [];
    case "cancelled":
      if (paidAfterCancel) return [{ kind: "paid", variant: "review" }, { kind: "owner_paid", variant: "after_cancel" }];
      if (order.paidAt === null && (order.cancelReason === "payment_expired" || order.cancelReason === "payment_cancelled")) {
        return [{ kind: "cancelled", reason: order.cancelReason }];
      }
      // Staff cancels (session 16, owner decision 45): the wording says whether money comes back.
      // Only a payment made BEFORE the cancel makes it a paid cancel: a payment that arrived after
      // it got the review note instead, and once its refund is recorded (flags cleared) the order
      // must not turn into a "dana akan dikembalikan" email (the unpaid one was due all along).
      if (order.cancelReason === "admin") {
        const paidBeforeCancel = order.paidAt !== null && (order.cancelledAt === null || order.paidAt <= order.cancelledAt);
        return [{ kind: "cancelled", reason: paidBeforeCancel ? "admin_paid" : "admin_unpaid" }];
      }
      return [];
    default:
      return [];
  }
}

/** `failed`: retried after the lease. `permanent`: given up at once (logged as an error).
 * `no_recipient`: retried, so the email still goes out once the address is set. */
export type OrderEmailOutcome = "sent" | "failed" | "permanent" | "no_recipient";

export interface OrderEmailDispatch {
  orderNo: string | null;
  results: { kind: OrderNotificationKind; outcome: OrderEmailOutcome }[];
}

type OrderRef = { orderId: string } | { orderNo: string };

const orderColumns = {
  id: orders.id,
  orderNo: orders.orderNo,
  status: orders.status,
  paymentStatus: orders.paymentStatus,
  paymentExpiresAt: orders.paymentExpiresAt,
  paidAt: orders.paidAt,
  cancelledAt: orders.cancelledAt,
  cancelReason: orders.cancelReason,
  needsAttention: orders.needsAttention,
  trackingNumber: orders.trackingNumber,
  // Qualified on both sides (packages/db/src/sql-helpers.ts): the pass queries orders alone.
  deliveredByCourier: sql<boolean>`exists (select 1 from ${shipments} where ${qualifiedColumn(shipments, shipments.orderId)} = ${qualifiedColumn(orders, orders.id)} and ${qualifiedColumn(shipments, shipments.status)} = 'delivered')`,
};

interface ClaimedNotification {
  id: string;
  /** True when this claim inserted the row: the email's first attempt. A retry may already have
   * reached the provider, so it must render exactly what the first attempt rendered. */
  firstAttempt: boolean;
}

/** Claims the notification row for sending, or returns null when it is sent, being sent, or past
 * its retries. */
async function claimNotification(db: Database, orderId: string, kind: OrderNotificationKind): Promise<ClaimedNotification | null> {
  const [row] = await db
    .insert(orderNotifications)
    .values({ orderId, kind })
    .onConflictDoUpdate({
      target: [orderNotifications.orderId, orderNotifications.kind],
      set: { updatedAt: sql`now()` },
      setWhere: sql`${orderNotifications.sentAt} is null
        and ${orderNotifications.updatedAt} < now() - make_interval(mins => ${NOTIFICATION_LEASE_MINUTES})
        and ${orderNotifications.createdAt} > now() - make_interval(hours => ${NOTIFICATION_RETRY_HOURS})
        and (${orderNotifications.error} is null or (${orderNotifications.error} <> ${SUPERSEDED} and ${orderNotifications.error} not like ${`${PERMANENT_PREFIX}%`}))`,
    })
    // xmax is 0 on a row this statement inserted, and set on one it updated (the conflict path): a
    // long-standing Postgres idiom, pinned by emails.test.ts's retry tests (first attempt true,
    // retry false). It decides whether a new login link may be issued (loginUrlFor).
    .returning({ id: orderNotifications.id, firstAttempt: sql<boolean>`(xmax = 0)` });
  return row ? { id: row.id, firstAttempt: Boolean(row.firstAttempt) } : null;
}

/** A short, address-free description of a failed send for `order_notifications.error` and logs,
 * and whether retrying can help. The provider's own refusals (a 4xx other than timeout, conflict and
 * rate limit) are permanent, and so is an idempotency conflict: the key was already used for a
 * different payload (the order changed between a send whose answer was lost and its retry), so the
 * first copy most likely went out and a second must not. */
function classifySendError(error: unknown): { text: string; permanent: boolean } {
  if (error instanceof Error && error.name === "EmailDeliveryError") {
    const { status, providerError } = error as Error & { status?: unknown; providerError?: unknown };
    const permanent =
      (typeof status === "number" && status >= 400 && status < 500 && ![408, 409, 429].includes(status)) ||
      (status === 409 && providerError === "invalid_idempotent_request");
    const text = error.message.slice(0, 200);
    return { text: permanent ? PERMANENT_PREFIX + text : text, permanent };
  }
  return { text: error instanceof Error ? error.name : typeof error, permanent: false };
}

interface LoadedOrder {
  id: string;
  orderNo: string;
  customerId: string | null;
  /** false for a guest checkout order: its emails carry "Masuk ke akun" (plan §8). */
  placedWithSession: boolean | null;
  contactEmail: string | null;
  contactPhone: string | null;
  customerName: string | null;
  recipientName: string | null;
  snapshot: unknown;
  shippingAddress: string | null;
  totals: OrderEmailTotals;
  courierLabel: string | null;
  courier: string | null;
  trackingNumber: string | null;
  paymentExpiresAt: Date | null;
  paidAt: Date | null;
  lines: OrderEmailLine[];
  paymentUrl: string | null;
  supportEmail: string | null;
  whatsappNumber: string | null;
}

async function loadOrder(db: Database, orderId: string): Promise<LoadedOrder | null> {
  const [order] = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      customerId: orders.customerId,
      placedWithSession: orders.placedWithSession,
      contactEmail: orders.contactEmail,
      contactPhone: orders.contactPhone,
      customerName: customers.name,
      recipientName: orders.recipientName,
      snapshot: orders.shippingAddressSnapshot,
      shippingAddress: orders.shippingAddress,
      subtotal: orders.subtotalAmount,
      shipping: orders.shippingAmount,
      shippingCost: orders.shippingCostAmount,
      shippingSubsidy: orders.shippingSubsidyAmount,
      discount: orders.discountAmount,
      total: orders.totalAmount,
      courierLabel: orders.shippingCourierLabel,
      courier: orders.courier,
      trackingNumber: orders.trackingNumber,
      paymentExpiresAt: orders.paymentExpiresAt,
      paidAt: orders.paidAt,
    })
    .from(orders)
    .leftJoin(customers, eq(customers.id, orders.customerId))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return null;

  const items = await db
    .select({
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      qty: orderItems.qty,
      unitPrice: orderItems.unitPrice,
      listUnitPrice: orderItems.listUnitPrice,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.sku));
  // The snapshot only: what was charged, and the normal price when a product discount lowered it
  // (NULL on older orders, marketplace orders and undiscounted lines).
  const lines = items.map((item) => ({
    productName: item.productName,
    colorName: item.colorName,
    sizeLabel: sizeLabel(item.size),
    qty: item.qty,
    lineTotal: item.qty * item.unitPrice,
    listLineTotal: item.listUnitPrice !== null && item.listUnitPrice > item.unitPrice ? item.qty * item.listUnitPrice : null,
  }));
  if (lines.reduce((sum, line) => sum + line.lineTotal, 0) !== order.subtotal) {
    console.error("[emails] order lines do not add up to the subtotal", { orderNo: order.orderNo, lines: lines.length });
  }

  const [payment] = await db.select({ redirectUrl: payments.redirectUrl }).from(payments).where(eq(payments.orderId, orderId)).orderBy(desc(payments.attempt)).limit(1);
  const [settings] = await db.select({ supportEmail: storeSettings.supportEmail, whatsappNumber: storeSettings.whatsappNumber }).from(storeSettings).limit(1);

  return {
    id: order.id,
    orderNo: order.orderNo,
    customerId: order.customerId,
    placedWithSession: order.placedWithSession,
    contactEmail: order.contactEmail,
    contactPhone: order.contactPhone,
    customerName: order.customerName,
    recipientName: order.recipientName,
    snapshot: order.snapshot,
    shippingAddress: order.shippingAddress,
    totals: { subtotal: order.subtotal, shipping: order.shipping, shippingCost: order.shippingCost, shippingSubsidy: order.shippingSubsidy, discount: order.discount, total: order.total },
    courierLabel: order.courierLabel,
    courier: order.courier,
    trackingNumber: order.trackingNumber,
    paymentExpiresAt: order.paymentExpiresAt,
    paidAt: order.paidAt,
    lines,
    paymentUrl: paymentUrlOf(payment?.redirectUrl ?? null),
    supportEmail: settings?.supportEmail?.trim() || null,
    whatsappNumber: settings?.whatsappNumber?.trim() || null,
  };
}

/** A customer-typed string as one clean line (no line breaks or control characters, so it cannot
 * fake extra lines in the text part), or null when empty. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return line === "" ? null : line.slice(0, 500);
}

/** The buyer's first name for "Halo Kak ...," (owner request 2026-10-21): the first word of the
 * order's recipient name, capitalised normally ("muhammad tangguh" and "MUHAMMAD" both give
 * "Muhammad"). A guest checkout sets the name from the form before the email is verified, so
 * someone ordering with another person's address could put words in our greeting: a name that
 * looks like a link or an address, or carries a number (an account or phone number as a payment
 * lure, e.g. "Transfer ke BCA 8830123456"), is left out whole, and so is a first word that is not
 * a plain name (letters, with an inner hyphen or apostrophe). The greeting is then "Halo Kak,". */
export function greetingName(name: string | null): string | null {
  const line = text(name);
  if (!line || line.length > 60 || /(https?:|www\.|@|\.[a-z]{2,}(\/|\b))/i.test(line)) return null;
  if ((line.match(/\d/g) ?? []).length >= 5) return null;
  const first = line.split(" ")[0]!.replace(/[.,;:!?]+$/u, "");
  if (first.length === 0 || first.length > 30 || !/^\p{L}[\p{L}\p{M}]*(?:['\u2019-]\p{L}[\p{L}\p{M}]*)*$/u.test(first)) return null;
  return first
    .toLocaleLowerCase("id-ID")
    .replace(/(^|['\u2019-])(\p{L})/gu, (_match, separator: string, letter: string) => separator + letter.toLocaleUpperCase("id-ID"));
}

/** The stored payment page, only as an http(s) URL. */
function paymentUrlOf(value: string | null): string | null {
  return value && /^https?:\/\//i.test(value) ? value : null;
}

/** The address block from the order's snapshot (plan §3, version 2), or null when it is missing
 * (an anonymized order). The street, area and kode pos on one line; the courier note only for the
 * owner. */
function addressOf(order: LoadedOrder, withNotes: boolean): OrderEmailAddress | null {
  const snap = (typeof order.snapshot === "object" && order.snapshot !== null ? order.snapshot : {}) as Record<string, unknown>;
  const recipientName = text(snap.recipientName) ?? text(order.recipientName);
  const phone = text(snap.phone);
  const addressLine = text(snap.addressLine);
  if (!recipientName || !phone || !addressLine) return null;
  const province = text(snap.province);
  const postalCode = text(snap.postalCode);
  const parts = [addressLine, text(snap.subdistrict), text(snap.district), text(snap.city), [province, postalCode].filter(Boolean).join(" ") || null].filter((part): part is string => part !== null);
  const notes = withNotes ? text(snap.notes) : null;
  return { recipientName, phone, addressText: `${parts.join(", ")}${notes ? `. Catatan: ${notes}` : ""}` };
}

/** The storefront's own logo file (docs/design/storefront.md §9, the same PNG the header shows),
 * which is public wherever the storefront is. Only over https: a local `http://localhost` origin
 * is not reachable from a mail client, so those emails keep the text wordmark. */
export const EMAIL_LOGO_PATH = "/logos/ammari-primary.png";

/** The storefront's "Pengembalian & penukaran" page (apps/web `/returns-exchange`), linked from
 * "Pesanan sudah sampai". */
export const RETURNS_PAGE_PATH = "/returns-exchange";

function emailLogoUrl(origin: string): string | null {
  try {
    const url = new URL(EMAIL_LOGO_PATH, origin);
    if (url.protocol === "https:") return url.href;
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") console.warn("[emails] site origin is not https; emails go out without the logo", { origin: url.origin });
    return null;
  } catch {
    console.warn("[emails] site origin is not a URL; emails go out without the logo");
    return null;
  }
}

function siteHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** "Masuk ke akun" (plan §8, §9.3): only in the `created` and `paid` emails of a guest checkout
 * order, sent to the customer's own address. The token is derived from the notification row, so a
 * retry renders the same link; a new link (superseding the customer's live one) is issued only on
 * the email's first attempt, and a retry carries the link only if that first attempt issued it. So
 * a payload that may already have reached the provider never changes. A failure to issue sends the
 * email without the link rather than holding the order email back. */
async function loginUrlFor(deps: OrderEmailDeps, order: LoadedOrder, due: DueOrderEmail, claim: ClaimedNotification): Promise<string | null> {
  if (!deps.loginLinks || order.placedWithSession !== false || !order.customerId || !order.contactEmail) return null;
  if (due.kind !== "created" && due.kind !== "paid") return null;
  const token = deriveOrderEmailLoginToken(deps.linkSecret, claim.id);
  let result: LoginLinkIssueOutcome;
  try {
    result = await deps.loginLinks.issueOrReuse({ token, customerId: order.customerId, email: order.contactEmail, orderId: order.id, mayIssue: claim.firstAttempt });
  } catch (error) {
    console.error("[emails] could not issue the login link; the email goes without it", { orderNo: order.orderNo, kind: due.kind, ...errorLogFields(error) });
    return null;
  }
  if (result === "issued" || result === "existing") return `${deps.siteOrigin}/login/link?token=${token}`;
  // Each a deliberate drop (cap reached, the address is no longer the customer's email, or a retry of
  // an attempt that issued none), logged so an email without the link can be explained.
  const level = result === "not_issued" ? "info" : "warn";
  console[level]("[emails] the email goes without a login link", { orderNo: order.orderNo, kind: due.kind, customerId: order.customerId, result });
  return null;
}

/** Renders one due email for its recipient, minting the view token for a customer email. Returns
 * null when there is no recipient. */
async function prepare(db: Database, deps: OrderEmailDeps, order: LoadedOrder, due: DueOrderEmail, claim: ClaimedNotification): Promise<{ to: string; email: RenderedEmail } | null> {
  const notificationId = claim.id;
  if (due.kind === "owner_paid") {
    if (!order.supportEmail) return null;
    return {
      to: order.supportEmail,
      email: renderOwnerPaidEmail({
        orderNo: order.orderNo,
        variant: due.variant,
        lines: order.lines,
        totals: order.totals,
        courierLabel: order.courierLabel,
        paidAt: order.paidAt,
        buyer: { name: text(order.recipientName) ?? text(order.customerName), email: order.contactEmail, phone: order.contactPhone },
        address: addressOf(order, true),
        adminOrderUrl: deps.adminOrigin ? `${deps.adminOrigin}/orders/${order.id}` : null,
        logoUrl: emailLogoUrl(deps.siteOrigin),
      }),
    };
  }

  if (!order.contactEmail) return null;
  // One token per email (plan §8), derived from the notification row so a retry sends the same
  // link; inserting its hash again on a retry is a no-op.
  const token = deriveOrderEmailAccessToken(deps.linkSecret, notificationId);
  await db
    .insert(orderAccessTokens)
    .values({ orderId: order.id, tokenHash: hashOrderAccessToken(token), expiresAt: sql`now() + make_interval(days => ${ORDER_ACCESS_TOKEN_DAYS})` })
    .onConflictDoNothing({ target: orderAccessTokens.tokenHash });

  const view: CustomerOrderEmailView = {
    orderNo: order.orderNo,
    // The name typed at checkout (owner request after the 2026-10-21 sandbox run), never the linked
    // customer row's: an unverified guest checkout never renames it, so it can be a placeholder.
    greetingName: greetingName(order.recipientName),
    lines: order.lines,
    totals: order.totals,
    courierLabel: order.courierLabel,
    address: addressOf(order, false),
    orderUrl: `${deps.siteOrigin}/orders/${encodeURIComponent(order.orderNo)}?t=${token}`,
    loginUrl: await loginUrlFor(deps, order, due, claim),
    siteHost: siteHost(deps.siteOrigin),
    whatsappNumber: order.whatsappNumber,
    logoUrl: emailLogoUrl(deps.siteOrigin),
  };
  switch (due.kind) {
    case "created":
      if (!order.paymentExpiresAt) return null;
      return { to: order.contactEmail, email: renderCreatedEmail({ ...view, paymentDeadline: order.paymentExpiresAt, paymentUrl: order.paymentUrl }) };
    case "paid":
      return { to: order.contactEmail, email: renderPaidEmail(view, due.variant) };
    case "cancelled":
      return { to: order.contactEmail, email: renderCancelledEmail({ ...view, reason: due.reason, paymentDeadline: order.paymentExpiresAt }) };
    case "shipped":
      return { to: order.contactEmail, email: renderShippedEmail({ ...view, courier: order.courier, trackingNumber: order.trackingNumber }) };
    case "delivered":
      return { to: order.contactEmail, email: renderDeliveredEmail({ ...view, returnsUrl: `${deps.siteOrigin}${RETURNS_PAGE_PATH}` }) };
  }
}

/** One key per notification row: a retry of the same payload is answered from the provider's
 * record without a second delivery, and a retry whose payload changed meanwhile (a newer payment
 * page, an edited resi) is refused as a conflict rather than delivered twice (classifySendError). */
function idempotencyKey(notificationId: string): string {
  return `order-email/${notificationId}`;
}

async function sendOne(db: Database, deps: OrderEmailDeps, order: LoadedOrder, due: DueOrderEmail, claim: ClaimedNotification): Promise<OrderEmailOutcome> {
  const notificationId = claim.id;
  const log = { orderNo: order.orderNo, kind: due.kind };
  let prepared: Awaited<ReturnType<typeof prepare>>;
  try {
    prepared = await prepare(db, deps, order, due, claim);
  } catch (error) {
    console.error("[emails] could not prepare the email; retried later", { ...log, ...errorLogFields(error) });
    await recordFailure(db, notificationId, "prepare_failed", log);
    return "failed";
  }
  if (!prepared) {
    // The owner email without store_settings.support_email, or an order without a contact email.
    console.warn("[emails] no recipient; retried later", { ...log, recipient: due.kind === "owner_paid" ? "store_settings.support_email" : "orders.contact_email" });
    await recordFailure(db, notificationId, "no_recipient", log);
    return "no_recipient";
  }

  try {
    await deps.transport.send({ to: prepared.to, subject: prepared.email.subject, body: prepared.email.text, html: prepared.email.html, idempotencyKey: idempotencyKey(notificationId) });
  } catch (error) {
    const { text: reason, permanent } = classifySendError(error);
    console.error(permanent ? "[emails] send refused for good; not retried" : "[emails] send failed; retried later", { ...log, error: reason });
    await recordFailure(db, notificationId, reason, log);
    return permanent ? "permanent" : "failed";
  }

  try {
    await db.update(orderNotifications).set({ sentAt: sql`now()`, error: null }).where(eq(orderNotifications.id, notificationId));
  } catch (error) {
    // Sent, but not recorded: the retry renders the same payload under the same idempotency key,
    // so the provider does not deliver it again.
    console.error("[emails] sent but not recorded as sent", { ...log, ...errorLogFields(error) });
  }
  return "sent";
}

async function recordFailure(db: Database, notificationId: string, reason: string, log: Record<string, unknown>): Promise<void> {
  try {
    await db.update(orderNotifications).set({ error: reason, updatedAt: sql`now()` }).where(and(eq(orderNotifications.id, notificationId), isNull(orderNotifications.sentAt)));
  } catch (error) {
    console.error("[emails] could not record a failed send; retried after the lease", { ...log, ...errorLogFields(error) });
  }
}

/** Marks the order's unsent, still-retryable rows whose kind is no longer due as superseded (e.g. a
 * failed `created` email of an order that has been paid since), so they are neither retried nor
 * reported as lost. */
async function supersedeStaleRows(db: Database, order: { id: string; orderNo: string; status: OrderStatus }, due: readonly DueOrderEmail[]): Promise<number> {
  const { id: orderId, orderNo } = order;
  // A shipped order without a resi has not moved on: its "sudah dikirim" email is only waiting for
  // the resi, so an unsent row of it stays retryable.
  const dueKinds: OrderNotificationKind[] = [...due.map((email) => email.kind), ...(order.status === "shipped" ? (["shipped"] as const) : [])];
  const rows = await db
    .update(orderNotifications)
    .set({ error: SUPERSEDED })
    .where(
      and(
        eq(orderNotifications.orderId, orderId),
        isNull(orderNotifications.sentAt),
        sql`(${orderNotifications.error} is null or (${orderNotifications.error} <> ${SUPERSEDED} and ${orderNotifications.error} not like ${`${PERMANENT_PREFIX}%`}))`,
        ...(dueKinds.length > 0 ? [notInArray(orderNotifications.kind, dueKinds)] : []),
      ),
    )
    .returning({ kind: orderNotifications.kind });
  if (rows.length > 0) console.warn("[emails] unsent emails no longer due (the order moved on); not retried", { orderNo, kinds: rows.map((row) => row.kind) });
  return rows.length;
}

/** Sends every email the order needs now and has not had. Never throws. With `deadline` (epoch
 * ms), stops claiming once it has passed (the rest is sent by the next cron pass). */
export async function dispatchOrderEmails(db: Database, deps: OrderEmailDeps, ref: OrderRef, options: { now?: Date; deadline?: number } = {}): Promise<OrderEmailDispatch> {
  const label = "orderNo" in ref ? ref.orderNo : null;
  try {
    const [state] = await db
      .select(orderColumns)
      .from(orders)
      .where("orderNo" in ref ? eq(orders.orderNo, ref.orderNo) : eq(orders.id, ref.orderId))
      .limit(1);
    if (!state) return { orderNo: label, results: [] };
    const due = dueOrderEmails(state, options.now ?? new Date());
    await supersedeStaleRows(db, state, due);
    const results: OrderEmailDispatch["results"] = [];
    let loaded: LoadedOrder | null = null;
    for (const email of due) {
      if (options.deadline !== undefined && Date.now() > options.deadline) break;
      const claim = await claimNotification(db, state.id, email.kind);
      if (!claim) continue;
      const log = { orderNo: state.orderNo, kind: email.kind };
      if (!loaded) {
        try {
          loaded = await loadOrder(db, state.id);
        } catch (error) {
          console.error("[emails] could not load the order; retried later", { ...log, ...errorLogFields(error) });
        }
        if (!loaded) {
          await recordFailure(db, claim.id, "load_failed", log);
          results.push({ kind: email.kind, outcome: "failed" });
          break;
        }
      }
      results.push({ kind: email.kind, outcome: await sendOne(db, deps, loaded, email, claim) });
    }
    return { orderNo: state.orderNo, results };
  } catch (error) {
    console.error("[emails] dispatch failed; retried by the cron pass", { orderNo: label, ...errorLogFields(error) });
    return { orderNo: label, results: [] };
  }
}

export interface PendingEmailSummary {
  /** Orders with at least one email due and not yet sent or in progress. */
  orders: number;
  sent: number;
  /** Failed sends, retried after the lease. */
  failed: number;
  /** Refused for good by the provider this run (each logged as an error). */
  permanent: number;
  /** Waiting for a recipient (the owner email without store_settings.support_email). */
  noRecipient: number;
  /** Unsent rows whose retries ran out in the last hour (each one an email nobody got; reported for
   * about an hour of runs). */
  abandoned: number;
  /** Shipped checkout orders changed in the scan window that still have no resi: their "sudah
   * dikirim" email waits until staff add one on the admin order page. */
  waitingForResi: number;
  truncated: boolean;
}

/** The cron pass: sends what is due on checkout orders changed in the last NOTIFICATION_SCAN_HOURS
 * (retries failed sends, and covers state changes made where no email hook runs, e.g. staff's
 * "Tandai dikirim" in apps/admin). Orders with an email never tried come first, then retries, newest
 * first, so a backlog of failing retries never starves new orders. */
export async function dispatchPendingOrderEmails(
  db: Database,
  deps: OrderEmailDeps,
  options: { now?: Date; limit?: number; timeBudgetMs?: number } = {},
): Promise<PendingEmailSummary> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  const deadline = Date.now() + (options.timeBudgetMs ?? PENDING_PASS_TIME_BUDGET_MS);
  const since = new Date(now.getTime() - NOTIFICATION_SCAN_HOURS * 3_600_000);

  const candidates = await db
    .select(orderColumns)
    .from(orders)
    .where(and(isNotNull(orders.paymentStatus), gt(orders.updatedAt, since)))
    .orderBy(desc(orders.updatedAt))
    // A bound on one pass's read; far above two days of web orders at Ammari's volume.
    .limit(CANDIDATE_SCAN_LIMIT);
  if (candidates.length === CANDIDATE_SCAN_LIMIT) console.warn("[emails] email pass scan hit its limit; the oldest changed orders were not looked at", { limit: CANDIDATE_SCAN_LIMIT });
  const rows =
    candidates.length === 0
      ? []
      : await db
          .select({ orderId: orderNotifications.orderId, kind: orderNotifications.kind, sentAt: orderNotifications.sentAt, error: orderNotifications.error, createdAt: orderNotifications.createdAt, updatedAt: orderNotifications.updatedAt })
          .from(orderNotifications)
          .where(inArray(orderNotifications.orderId, candidates.map((candidate) => candidate.id)));
  const byOrder = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byOrder.get(row.orderId);
    if (list) list.push(row);
    else byOrder.set(row.orderId, [row]);
  }

  const leaseStart = now.getTime() - NOTIFICATION_LEASE_MINUTES * 60_000;
  const retryStart = now.getTime() - NOTIFICATION_RETRY_HOURS * 3_600_000;
  const terminal = (error: string | null) => error === SUPERSEDED || (error?.startsWith(PERMANENT_PREFIX) ?? false);
  const summary: PendingEmailSummary = { orders: 0, sent: 0, failed: 0, permanent: 0, noRecipient: 0, abandoned: 0, waitingForResi: 0, truncated: false };

  const fresh: typeof candidates = [];
  const retries: typeof candidates = [];
  for (const candidate of candidates) {
    if (candidate.status === "shipped" && !candidate.trackingNumber?.trim()) summary.waitingForResi += 1;
    const due = dueOrderEmails(candidate, now);
    const existing = byOrder.get(candidate.id) ?? [];
    const dueKinds = new Set<OrderNotificationKind>(due.map((email) => email.kind));
    // Retries that ran out in the last hour, for emails still due: reported, never retried.
    summary.abandoned += existing.filter(
      (row) => row.sentAt === null && !terminal(row.error) && dueKinds.has(row.kind) && row.createdAt.getTime() <= retryStart && row.createdAt.getTime() > retryStart - 3_600_000,
    ).length;
    const waitingForResi = (kind: OrderNotificationKind) => kind === "shipped" && candidate.status === "shipped";
    const stale = existing.some((row) => row.sentAt === null && !terminal(row.error) && !dueKinds.has(row.kind) && !waitingForResi(row.kind));
    let isFresh = false;
    let isRetry = false;
    for (const email of due) {
      const row = existing.find((candidateRow) => candidateRow.kind === email.kind);
      if (!row) isFresh = true;
      else if (row.sentAt === null && !terminal(row.error) && row.updatedAt.getTime() < leaseStart && row.createdAt.getTime() > retryStart) isRetry = true;
    }
    if (isFresh) fresh.push(candidate);
    else if (isRetry || stale) retries.push(candidate);
  }
  const pending = [...fresh, ...retries];
  summary.orders = pending.length;
  summary.truncated = pending.length > limit;

  for (const candidate of pending.slice(0, limit)) {
    if (Date.now() > deadline) {
      summary.truncated = true;
      break;
    }
    const dispatched = await dispatchOrderEmails(db, deps, { orderId: candidate.id }, { now, deadline });
    for (const result of dispatched.results) {
      if (result.outcome === "sent") summary.sent += 1;
      else if (result.outcome === "permanent") summary.permanent += 1;
      else if (result.outcome === "no_recipient") summary.noRecipient += 1;
      else summary.failed += 1;
    }
  }
  if (summary.truncated) console.warn("[emails] email pass did not reach every order; the rest go out on the next run", { orders: summary.orders, limit });
  if (summary.waitingForResi > 0) {
    console.warn("[emails] shipped web orders without a resi: their buyers get no \"sudah dikirim\" email until staff add one", { orders: summary.waitingForResi });
  }
  return summary;
}
