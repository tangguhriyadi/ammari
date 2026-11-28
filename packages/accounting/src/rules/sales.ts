import { MARKETPLACE_CHANNEL_IDS, type ChannelId, type OrderStatus, type PaymentStatus } from "@ammari/db/schema";
import { jakartaDateOf } from "../dates";
import type { JournalLineDraft } from "../journal";
import { STOCK_MOVEMENT_SOURCE_TYPE } from "./inventory";
import { isManualPaymentOrder, manualOrderMoneyIn, MANUAL_PAYMENT_MISSING_ISSUE, type ManualPaymentRecord } from "./manual-orders";
import { mappedAccount, negateOutcome, resolveOrIssue, systemAccount, type PostingContext, type PostingEvent, type PostingKey, type PostingOutcome, type PostingRule } from "./types";

// Sales (docs/plans/accounting.md §4.1-§4.3, Session 9). One order is one snapshot; every event of
// the order is derived from it in a fixed order, so a key whose journal builds on another's (a return
// on its sale) can see that other key's outcome in the same pass.
//
//   S1 (stock_movement, id, sale), created_at: goods leave the shelf at to_ship.
//      Dr 1-1505 Barang terjual belum dikirim / Cr 1-1504 Persediaan barang jadi, −value_amount.
//   S6 (order, id, collected), order_manual_payments.paid_on [D-3, owner 26 Nov 2026]: a manual
//      order's money. Dr the Kas & Bank account staff picked / Cr 2-1201 Uang muka pelanggan,
//      total_amount. No record → `manual_payment_missing`, never a guessed account.
//   W1 (payment, id, paid), payments.paid_at: a checkout payment. Dr 1-1301 Piutang Midtrans /
//      Cr 2-1201, gross_amount. A payment that arrived after its order was cancelled is owed back from
//      the moment it arrives: Cr 2-1202 Utang pengembalian dana instead (the plan's W1 + W3 for that
//      payment collapsed into one journal; same balances, no 2-1201 detour after the cancel).
//   S3 / M1 (order, id, recognised) [D-1, handover to the courier]: web and manual on shipped_at,
//      marketplace only on the real ship time (orders.marketplace_shipped_at: TikTok's collection_time,
//      T8; Shopee's export file once its Session 5 ships) [D-2] (no such time → the issue
//      `marketplace_ship_date_missing`, never the import time). Dr 2-1201 (web, manual) or Saldo
//      Penjual (marketplace) total_amount · Dr 4-1201 Potongan penjualan discount_amount [D-4] /
//      Cr Penjualan by channel subtotal_amount · Cr 2-1203 Titipan ongkir pembeli shipping_amount
//      [D-6, W6]; and Dr 5-1101 HPP / Cr 1-1505 the value of the order's sale movements. HPP is the
//      movements' exact value, not Σ qty × unit_cost: order_items.unit_cost is rounded per piece, and
//      1-1505 must clear to exactly 0.
//   M2 (order, id, channel_fees), M1's date [D-5]: Dr 6-1201 Biaya platform marketplace (every
//      component but seller_shipping_subsidy and payment_gateway_fee) · Dr 6-1202 Subsidi ongkir
//      penjual (seller_shipping_subsidy) / Cr Saldo Penjual. A re-upload that changes a fee: the
//      engine's reverse + repost, into the first open month when M1's month is closed.
//   S2 (stock_movement, id, return), created_at: goods back on the shelf at the original cost. A
//      cancel before shipping: Dr 1-1504 / Cr 1-1505. A return after shipping: Dr 1-1504 / Cr 5-1101
//      HPP [D-7].
//   S4 (order, id, returned), returned_at (a marketplace order: marketplace_returned_at when set) [D-7]: Dr 4-1301 Retur penjualan subtotal · Dr 6-1301 Beban
//      ongkos kirim shipping_amount (the courier was already paid) / Cr 4-1201 discount · Cr the
//      refund liability total (2-1202 web and manual; Saldo Penjual for a marketplace clawback).
//   W3 / S6 cancel (order, id, cancelled_paid), cancelled_at: a paid order cancelled before shipping.
//      Dr 2-1201 / Cr 2-1202, the money still held as a deposit (checkout: payments paid by the
//      cancel less what was already refunded from the deposit; manual: total_amount).
//   W4 (payment, id, refunded), the record_refund audit row's time [D-9]: a refund staff recorded
//      by hand. Dr 2-1202 (or 2-1201 for a refunded duplicate payment of an order going ahead) /
//      Cr 1-1201 Bank utama (`bank.main`). (payment, id, gateway_refunded): the part the gateway
//      refunded (refunded_amount less the hand-recorded part), Cr 1-1301, dated by the first verified
//      refund notification (payment_notifications); only without one by payments.updated_at, which
//      later reads bump, so the journal then keeps its first date while unchanged. The
//      MDR is never returned (W2 stays) [D-8]. A chargeback has no amount in the data: the issue
//      `payment_chargeback`.
//   W9 (shipment, id, charged), booked_at [D-10]: Dr 2-1203 the order's shipping_amount · Dr 6-1302
//      Subsidi ongkir website the order's shipping_subsidy_amount · Dr/Cr 6-1301 the rest (courier
//      price above or below the quote) / Cr 1-1603 Saldo Biteship cost_amount. The buyer's titipan is
//      used up in full by the booking, so check 3c sees 0 on a shipped, booked order. A manual order
//      has no subsidy: everything above its shipping_amount is 6-1301.
//   W10 (shipment, id, cancelled), cancelled_at: the exact negation of W9 (Biteship credits the
//      balance back); posted only while W9 is active (void rule, plan §2).
//
// Held events. A return (S2 after shipping, S4) and the marketplace fees (M2) build on the order's
// recognition: while S3 is blocked by a posting issue they are held behind it (no journal, no second
// issue) and follow in the same run once it posts. The cancel of a manual order is held the same way
// behind its S6. Unlike a void they post across the cut-over: they are real events of their own.
//
// Cut-over (plan §2): every event dated before the posting start is "none" (it lives in the opening
// balances). Events on older orders dated after it (a return, a refund) post normally.

export const ORDER_SOURCE_TYPE = "order";
export const PAYMENT_SOURCE_TYPE = "payment";
export const SHIPMENT_SOURCE_TYPE = "shipment";
export const SALES_RULE_VERSION = 1;

export const MARKETPLACE_SHIP_DATE_MISSING_ISSUE = "marketplace_ship_date_missing";
export const PAYMENT_CHARGEBACK_ISSUE = "payment_chargeback";

/** The order_channel_fees component fee work A will add for the Midtrans MDR (W2, not M2). */
export const PAYMENT_GATEWAY_FEE_COMPONENT = "payment_gateway_fee";

export interface OrderStockMovementSnapshot {
  id: string;
  type: "sale" | "return";
  sku: string;
  /** Signed: negative for a sale, its negation for the return. */
  valueAmount: number;
  createdAt: Date;
}

export interface OrderPaymentSnapshot {
  id: string;
  providerOrderId: string;
  status: PaymentStatus;
  grossAmount: number;
  paidAt: Date | null;
  refundedAmount: number;
  updatedAt: Date;
  /** The first signature-valid gateway notification reporting a refund (`refund` /
   * `partial_refund`) for this attempt (payment_notifications.received_at). A stable date for the
   * gateway part of a refund: payments.updated_at moves on every later status read. */
  gatewayRefundSeenAt: Date | null;
  /** The same for a chargeback (`chargeback` / `partial_chargeback`). */
  chargebackSeenAt: Date | null;
  /** The record_refund audit row for this attempt (recordManualRefund), if staff recorded one. */
  manualRefund: { amount: number; recordedAt: Date } | null;
}

export interface OrderShipmentSnapshot {
  id: string;
  attempt: number;
  status: string;
  costAmount: number | null;
  bookedAt: Date | null;
  cancelledAt: Date | null;
}

export interface OrderChannelFeeSnapshot {
  component: string;
  amount: number;
}

export interface OrderSnapshot {
  id: string;
  orderNo: string;
  channelId: ChannelId;
  status: OrderStatus;
  /** Set only on checkout orders. */
  paymentStatus: string | null;
  subtotalAmount: number;
  shippingAmount: number;
  discountAmount: number;
  totalAmount: number;
  shippingSubsidyAmount: number | null;
  shippedAt: Date | null;
  cancelledAt: Date | null;
  returnedAt: Date | null;
  /** The marketplace's real ship time (orders.marketplace_shipped_at, D-2): TikTok's
   * collection_time, written by the TikTok sync (tiktok-shop-integration.md T5). NULL for Shopee
   * until its own Session 5, and for any order whose ship time is not known yet: marketplace
   * revenue then waits as a posting issue, never the import time. */
  marketplaceShippedAt: Date | null;
  /** When the marketplace completed the return (orders.marketplace_returned_at: TikTok's
   * RETURN_OR_REFUND_REQUEST_COMPLETE or cancel time, T6). S4 of a marketplace order is dated here
   * when set, else by returned_at (tiktok-shop-integration.md §5.2). */
  marketplaceReturnedAt: Date | null;
  /** order_manual_payments (Session 6), manual orders only. */
  manualPayment: ManualPaymentRecord | null;
  movements: OrderStockMovementSnapshot[];
  payments: OrderPaymentSnapshot[];
  shipments: OrderShipmentSnapshot[];
  /** Marketplace fees (order_channel_fees). */
  fees: OrderChannelFeeSnapshot[];
}

export type OrderKind = "checkout" | "manual" | "marketplace";

export function orderKind(order: Pick<OrderSnapshot, "channelId" | "paymentStatus">): OrderKind {
  if ((MARKETPLACE_CHANNEL_IDS as readonly string[]).includes(order.channelId)) return "marketplace";
  return isManualPaymentOrder(order) ? "manual" : "checkout";
}

/** Attempt states that mean the money arrived (the same set as commerce's PAID_LIKE). */
const PAID_LIKE: readonly PaymentStatus[] = ["paid", "refunded", "partially_refunded", "chargeback"];

export function isPaidPayment(payment: Pick<OrderPaymentSnapshot, "status" | "paidAt">): payment is OrderPaymentSnapshot & { paidAt: Date } {
  return payment.paidAt !== null && PAID_LIKE.includes(payment.status);
}

/** A payment that arrived after its order was cancelled (`paid_after_cancel`). */
export function paidAfterCancel(order: Pick<OrderSnapshot, "status" | "cancelledAt">, payment: { paidAt: Date }): boolean {
  return order.status === "cancelled" && order.cancelledAt !== null && payment.paidAt.getTime() > order.cancelledAt.getTime();
}

/** The two refund parts of one attempt: what staff recorded by hand and what the gateway reported. */
export function refundParts(payment: OrderPaymentSnapshot): { manual: number; gateway: number } {
  const manual = payment.manualRefund ? Math.min(payment.manualRefund.amount, payment.refundedAmount) : 0;
  return { manual, gateway: Math.max(payment.refundedAmount - manual, 0) };
}

/** When the gateway part of a refund happened: the first notification that reported it, else
 * (a refund seen only by a status poll, or a notification older than the log's 12-month retention)
 * payments.updated_at, whose drift dateFollowsActive absorbs once posted. */
export function gatewayRefundAt(payment: Pick<OrderPaymentSnapshot, "gatewayRefundSeenAt" | "updatedAt">): Date {
  return payment.gatewayRefundSeenAt ?? payment.updatedAt;
}

/** Which liability a refund made at `at` clears: the refund liability once the order was cancelled
 * or returned before it (or for money that arrived after the cancel), otherwise the deposit (a
 * duplicate payment of an order still going ahead). */
export function refundFromRefundLiability(order: Pick<OrderSnapshot, "status" | "cancelledAt" | "returnedAt">, payment: OrderPaymentSnapshot, at: Date): boolean {
  if (payment.paidAt && paidAfterCancel(order, { paidAt: payment.paidAt })) return true;
  const ended = order.status === "cancelled" ? order.cancelledAt : order.status === "returned" ? order.returnedAt : null;
  return ended !== null && at.getTime() >= ended.getTime();
}

/** The real recognition date (Jakarta) of an order that reached shipped, or null when it has none
 * yet (a marketplace order without the export file's ship time). */
export function recognitionDate(order: OrderSnapshot): string | null {
  if (!order.shippedAt) return null;
  if (orderKind(order) === "marketplace") return order.marketplaceShippedAt ? jakartaDateOf(order.marketplaceShippedAt) : null;
  return jakartaDateOf(order.shippedAt);
}

/** The HPP S3 moves out of 1-1505: the exact value of the order's sale movements. */
export function orderSaleValue(order: Pick<OrderSnapshot, "movements">): number {
  return -order.movements.filter((movement) => movement.type === "sale").reduce((sum, movement) => sum + movement.valueAmount, 0);
}

/** The deposit a paid checkout order still holds at its cancel: payments paid by then, less the
 * refunds made from the deposit before it. */
export function depositAtCancel(order: OrderSnapshot): number {
  if (!order.cancelledAt) return 0;
  const cancel = order.cancelledAt.getTime();
  let amount = 0;
  for (const payment of order.payments) {
    if (!isPaidPayment(payment) || payment.paidAt.getTime() > cancel) continue;
    amount += payment.grossAmount;
    const parts = refundParts(payment);
    if (payment.manualRefund && payment.manualRefund.recordedAt.getTime() < cancel) amount -= parts.manual;
    if (parts.gateway > 0 && gatewayRefundAt(payment).getTime() < cancel) amount -= parts.gateway;
  }
  return Math.max(amount, 0);
}

function key(sourceType: string, sourceId: string, sourceEvent: string): PostingKey {
  return { sourceType, sourceId, sourceEvent };
}

export const orderKey = (orderId: string, sourceEvent: "recognised" | "collected" | "returned" | "cancelled_paid" | "channel_fees") => key(ORDER_SOURCE_TYPE, orderId, sourceEvent);

/** Debit-first lines, zero amounts dropped; "none" when nothing is left. */
function ordered(description: string, lines: JournalLineDraft[]): PostingOutcome {
  const kept = lines.filter((line) => line.debit > 0 || line.credit > 0);
  const sorted = [...kept.filter((line) => line.debit > 0), ...kept.filter((line) => line.credit > 0)];
  return sorted.length === 0 ? { kind: "none" } : { kind: "journal", description, lines: sorted };
}

/** A signed amount as one line: positive = debit, negative = credit. */
function signed(accountCode: string, amount: number, dims: Partial<JournalLineDraft>): JournalLineDraft {
  return { accountCode, debit: Math.max(amount, 0), credit: Math.max(-amount, 0), ...dims };
}

function sellerBalanceKey(channelId: ChannelId): string {
  return `seller_balance.${channelId}`;
}

/** Where the buyer's money sits before recognition: Uang muka pelanggan, or Saldo Penjual. */
function prepaymentAccount(order: OrderSnapshot, context: PostingContext): string {
  return orderKind(order) === "marketplace" ? systemAccount(context, sellerBalanceKey(order.channelId)) : systemAccount(context, "liability.customer_deposit");
}

function refundLiabilityAccount(order: OrderSnapshot, context: PostingContext): string {
  return orderKind(order) === "marketplace" ? systemAccount(context, sellerBalanceKey(order.channelId)) : systemAccount(context, "liability.customer_refund");
}

const dims = (order: OrderSnapshot, extra: Partial<JournalLineDraft> = {}): Partial<JournalLineDraft> => ({ orderId: order.id, channelId: order.channelId, ...extra });

function s1Outcome(order: OrderSnapshot, movement: OrderStockMovementSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() =>
    ordered(`Barang keluar untuk pesanan ${order.orderNo}: ${movement.sku}`, [
      signed(systemAccount(context, "inventory.sold_not_shipped"), -movement.valueAmount, dims(order, { memo: movement.sku })),
      signed(systemAccount(context, "inventory.finished_goods"), movement.valueAmount, dims(order, { memo: movement.sku })),
    ]),
  );
}

function s2Outcome(order: OrderSnapshot, movement: OrderStockMovementSnapshot, afterShipping: boolean, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const counter = afterShipping ? systemAccount(context, "cogs.finished_goods") : systemAccount(context, "inventory.sold_not_shipped");
    const what = afterShipping ? "Retur" : "Pembatalan";
    return ordered(`${what} pesanan ${order.orderNo}: ${movement.sku} kembali ke stok`, [
      signed(systemAccount(context, "inventory.finished_goods"), movement.valueAmount, dims(order, { memo: movement.sku })),
      signed(counter, -movement.valueAmount, dims(order, { memo: movement.sku })),
    ]);
  });
}

function s3Outcome(order: OrderSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const revenue = mappedAccount(context, `revenue.channel.${order.channelId}`, "unmapped_sales_channel", { channelId: order.channelId });
    const hpp = orderSaleValue(order);
    const d = dims(order);
    return ordered(`Penjualan pesanan ${order.orderNo}`, [
      signed(prepaymentAccount(order, context), order.totalAmount, d),
      signed(systemAccount(context, "contra_revenue.sales_discount"), order.discountAmount, d),
      signed(systemAccount(context, "cogs.finished_goods"), hpp, d),
      signed(revenue, -order.subtotalAmount, d),
      signed(systemAccount(context, "liability.buyer_shipping"), -order.shippingAmount, d),
      signed(systemAccount(context, "inventory.sold_not_shipped"), -hpp, d),
    ]);
  });
}

function m2Outcome(order: OrderSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const fees = order.fees.filter((fee) => fee.component !== PAYMENT_GATEWAY_FEE_COMPONENT);
    const subsidy = fees.filter((fee) => fee.component === "seller_shipping_subsidy").reduce((sum, fee) => sum + fee.amount, 0);
    const platform = fees.filter((fee) => fee.component !== "seller_shipping_subsidy").reduce((sum, fee) => sum + fee.amount, 0);
    const d = dims(order);
    return ordered(`Biaya marketplace pesanan ${order.orderNo}`, [
      signed(systemAccount(context, "expense.marketplace_fee"), platform, d),
      signed(systemAccount(context, "expense.marketplace_shipping_subsidy"), subsidy, d),
      signed(systemAccount(context, sellerBalanceKey(order.channelId)), -(platform + subsidy), d),
    ]);
  });
}

function s4Outcome(order: OrderSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const d = dims(order);
    return ordered(`Retur penjualan pesanan ${order.orderNo}`, [
      signed(systemAccount(context, "contra_revenue.sales_return"), order.subtotalAmount, d),
      signed(systemAccount(context, "expense.sales_shipping"), order.shippingAmount, d),
      signed(systemAccount(context, "contra_revenue.sales_discount"), -order.discountAmount, d),
      signed(refundLiabilityAccount(order, context), -order.totalAmount, d),
    ]);
  });
}

function s6Outcome(order: OrderSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const payment = manualOrderMoneyIn({ orderId: order.id, orderNo: order.orderNo, payment: order.manualPayment });
    const d = dims(order, { cashAccountCode: payment.cashAccountCode });
    return ordered(`Uang masuk pesanan ${order.orderNo}`, [
      signed(payment.cashAccountCode, order.totalAmount, d),
      signed(systemAccount(context, "liability.customer_deposit"), -order.totalAmount, d),
    ]);
  });
}

function cancelPaidOutcome(order: OrderSnapshot, amount: number, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const d = dims(order);
    return ordered(`Pesanan ${order.orderNo} dibatalkan, dana pembeli perlu dikembalikan`, [
      signed(systemAccount(context, "liability.customer_deposit"), amount, d),
      signed(systemAccount(context, "liability.customer_refund"), -amount, d),
    ]);
  });
}

function w1Outcome(order: OrderSnapshot, payment: OrderPaymentSnapshot & { paidAt: Date }, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const late = paidAfterCancel(order, payment);
    const credit = late ? systemAccount(context, "liability.customer_refund") : systemAccount(context, "liability.customer_deposit");
    const d = dims(order, { memo: payment.providerOrderId });
    return ordered(late ? `Pembayaran Midtrans ${payment.providerOrderId} setelah pesanan ${order.orderNo} dibatalkan` : `Pembayaran Midtrans ${payment.providerOrderId} pesanan ${order.orderNo}`, [
      signed(systemAccount(context, "receivable.midtrans"), payment.grossAmount, d),
      signed(credit, -payment.grossAmount, d),
    ]);
  });
}

function refundOutcome(order: OrderSnapshot, payment: OrderPaymentSnapshot, amount: number, at: Date, via: "bank" | "gateway", context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const debit = refundFromRefundLiability(order, payment, at) ? systemAccount(context, "liability.customer_refund") : systemAccount(context, "liability.customer_deposit");
    const credit = via === "bank" ? systemAccount(context, "bank.main") : systemAccount(context, "receivable.midtrans");
    const d = dims(order, { memo: payment.providerOrderId, ...(via === "bank" ? { cashAccountCode: credit } : {}) });
    const label = via === "bank" ? "Pengembalian dana" : "Pengembalian dana lewat Midtrans";
    return ordered(`${label} pesanan ${order.orderNo} (${payment.providerOrderId})`, [signed(debit, amount, d), signed(credit, -amount, d)]);
  });
}

export function shipmentChargeOutcome(order: OrderSnapshot, shipment: OrderShipmentSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const cost = shipment.costAmount ?? 0;
    const buyer = order.shippingAmount;
    const subsidy = orderKind(order) === "checkout" ? (order.shippingSubsidyAmount ?? 0) : 0;
    const d = dims(order, { memo: `Pengiriman ke-${shipment.attempt}` });
    return ordered(`Ongkir kurir pesanan ${order.orderNo} (pengiriman ke-${shipment.attempt})`, [
      signed(systemAccount(context, "liability.buyer_shipping"), buyer, d),
      signed(systemAccount(context, "expense.web_shipping_subsidy"), subsidy, d),
      signed(systemAccount(context, "expense.sales_shipping"), cost - buyer - subsidy, d),
      signed(systemAccount(context, "prepaid.biteship"), -cost, d),
    ]);
  });
}

/** Every posting event of one order, in dependency order (see the module comment). */
export function salesEvents(order: OrderSnapshot, context: PostingContext): PostingEvent[] {
  const start = context.postingStartDate;
  const kind = orderKind(order);
  const events: PostingEvent[] = [];
  const dated = (date: string, build: () => PostingOutcome): PostingOutcome => (date < start ? { kind: "none" } : build());
  const sales = order.movements.filter((movement) => movement.type === "sale");
  const returns = order.movements.filter((movement) => movement.type === "return");
  const sold = sales.length > 0;

  // S1
  for (const movement of sales) {
    const date = jakartaDateOf(movement.createdAt);
    events.push({ key: key(STOCK_MOVEMENT_SOURCE_TYPE, movement.id, "sale"), sourceDate: date, outcome: dated(date, () => s1Outcome(order, movement, context)) });
  }

  // S6
  let s6Blocked = false;
  if (kind === "manual" && sold) {
    const firstSale = jakartaDateOf(new Date(Math.min(...sales.map((movement) => movement.createdAt.getTime()))));
    const date = order.manualPayment?.paidOn ?? firstSale;
    const outcome = dated(date, () => s6Outcome(order, context));
    s6Blocked = outcome.kind === "issue" && outcome.issueCode === MANUAL_PAYMENT_MISSING_ISSUE;
    events.push({ key: orderKey(order.id, "collected"), sourceDate: date, outcome });
  }

  // W1
  for (const payment of order.payments) {
    if (!isPaidPayment(payment)) continue;
    const date = jakartaDateOf(payment.paidAt);
    events.push({ key: key(PAYMENT_SOURCE_TYPE, payment.id, "paid"), sourceDate: date, outcome: dated(date, () => w1Outcome(order, payment, context)) });
  }

  // S3 / M1, then M2
  const recognisedKey = orderKey(order.id, "recognised");
  let s3Blocked = false;
  let recognisedOn: string | null = null;
  if (order.shippedAt) {
    const appShipped = jakartaDateOf(order.shippedAt);
    const realDate = recognitionDate(order);
    let outcome: PostingOutcome;
    if (realDate === null) {
      // A marketplace order shipped per the app, without the export file's ship time. The import
      // stamps shipped_at at import, never before the real ship time: imported before the start
      // means shipped before it too (opening balances).
      outcome = appShipped < start ? { kind: "none" } : { kind: "issue", issueCode: MARKETPLACE_SHIP_DATE_MISSING_ISSUE, details: { orderNo: order.orderNo, channelId: order.channelId } };
    } else {
      outcome = dated(realDate, () => s3Outcome(order, context));
    }
    s3Blocked = outcome.kind === "issue";
    recognisedOn = realDate ?? appShipped;
    events.push({ key: recognisedKey, sourceDate: recognisedOn, outcome });
    if (kind === "marketplace") {
      events.push({
        key: orderKey(order.id, "channel_fees"),
        sourceDate: recognisedOn,
        outcome: realDate === null ? (appShipped < start ? { kind: "none" } : m2Outcome(order, context)) : dated(realDate, () => m2Outcome(order, context)),
        ...(s3Blocked ? { requiresActiveJournalFor: recognisedKey, requiresActiveJournalAcrossBooks: true } : {}),
      });
    }
  }
  const heldBehindRecognition = s3Blocked ? { requiresActiveJournalFor: recognisedKey, requiresActiveJournalAcrossBooks: true } : {};

  // S2: a return movement is after shipping exactly when the order ended as returned (a cancel is
  // only possible before shipping, ORDER_STATUS_TRANSITIONS).
  const afterShipping = order.status === "returned";
  for (const movement of returns) {
    const date = jakartaDateOf(movement.createdAt);
    events.push({
      key: key(STOCK_MOVEMENT_SOURCE_TYPE, movement.id, "return"),
      sourceDate: date,
      outcome: dated(date, () => s2Outcome(order, movement, afterShipping, context)),
      ...(afterShipping ? heldBehindRecognition : {}),
    });
  }

  // S4: a marketplace return is dated by the marketplace's own return time when it has one (T8,
  // tiktok-shop-integration.md §5.2), so it lands on TikTok's date, not on "Retur diterima". S2 keeps
  // the return movement's date (physical receipt).
  if (order.status === "returned" && order.returnedAt) {
    const returnedAt = kind === "marketplace" && order.marketplaceReturnedAt ? order.marketplaceReturnedAt : order.returnedAt;
    const date = jakartaDateOf(returnedAt);
    events.push({ key: orderKey(order.id, "returned"), sourceDate: date, outcome: dated(date, () => s4Outcome(order, context)), ...heldBehindRecognition });
  }

  // W3 / S6 cancel
  if (order.status === "cancelled" && order.cancelledAt && kind !== "marketplace") {
    const date = jakartaDateOf(order.cancelledAt);
    const amount = kind === "manual" ? (sold ? order.totalAmount : 0) : depositAtCancel(order);
    // Always emitted: when nothing is held any more the outcome is "none", so a journal posted
    // earlier for this key is reversed rather than left behind.
    events.push({
      key: orderKey(order.id, "cancelled_paid"),
      sourceDate: date,
      outcome: amount > 0 ? dated(date, () => cancelPaidOutcome(order, amount, context)) : { kind: "none" },
      ...(s6Blocked && amount > 0 ? { requiresActiveJournalFor: orderKey(order.id, "collected"), requiresActiveJournalAcrossBooks: true } : {}),
    });
  }

  // W4
  for (const payment of order.payments) {
    if (payment.status === "chargeback") {
      const date = jakartaDateOf(payment.chargebackSeenAt ?? payment.updatedAt);
      events.push({
        key: key(PAYMENT_SOURCE_TYPE, payment.id, "chargeback"),
        sourceDate: date,
        outcome: date < start ? { kind: "none" } : { kind: "issue", issueCode: PAYMENT_CHARGEBACK_ISSUE, details: { orderNo: order.orderNo, providerOrderId: payment.providerOrderId } },
      });
    }
    if (!isPaidPayment(payment)) continue;
    // Both refund keys are emitted for every paid attempt ("none" while there is no such refund),
    // so a journal whose refund disappears from the records is reversed, never left behind.
    const parts = refundParts(payment);
    const manualAt = payment.manualRefund?.recordedAt ?? null;
    const manualDate = manualAt ? jakartaDateOf(manualAt) : jakartaDateOf(payment.paidAt);
    events.push({
      key: key(PAYMENT_SOURCE_TYPE, payment.id, "refunded"),
      sourceDate: manualDate,
      outcome: manualAt && parts.manual > 0 ? dated(manualDate, () => refundOutcome(order, payment, parts.manual, manualAt, "bank", context)) : { kind: "none" },
    });
    const gatewayAt = gatewayRefundAt(payment);
    const gatewayDate = jakartaDateOf(gatewayAt);
    events.push({
      key: key(PAYMENT_SOURCE_TYPE, payment.id, "gateway_refunded"),
      sourceDate: gatewayDate,
      outcome: parts.gateway > 0 ? dated(gatewayDate, () => refundOutcome(order, payment, parts.gateway, gatewayAt, "gateway", context)) : { kind: "none" },
      // Only the fallback date (updated_at) drifts; a notification's time never moves.
      ...(payment.gatewayRefundSeenAt ? {} : { dateFollowsActive: true }),
    });
  }

  // W9 / W10
  for (const shipment of order.shipments) {
    if (shipment.costAmount === null || shipment.bookedAt === null) continue;
    const chargedKey = key(SHIPMENT_SOURCE_TYPE, shipment.id, "charged");
    const date = jakartaDateOf(shipment.bookedAt);
    const charge = () => shipmentChargeOutcome(order, shipment, context);
    events.push({ key: chargedKey, sourceDate: date, outcome: dated(date, charge) });
    if (shipment.status === "cancelled" && shipment.cancelledAt) {
      events.push({
        key: key(SHIPMENT_SOURCE_TYPE, shipment.id, "cancelled"),
        sourceDate: jakartaDateOf(shipment.cancelledAt),
        outcome: negateOutcome(charge(), `Pembatalan pengiriman ke-${shipment.attempt} pesanan ${order.orderNo}, saldo Biteship kembali`),
        requiresActiveJournalFor: chargedKey,
      });
    }
  }

  return events;
}

export const salesRule: PostingRule<OrderSnapshot> = {
  name: "sales",
  ruleVersion: SALES_RULE_VERSION,
  events: salesEvents,
};
