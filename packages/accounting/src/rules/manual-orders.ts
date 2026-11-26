import { MARKETPLACE_CHANNEL_IDS, type ChannelId, type ManualOrderPaymentMethod } from "@ammari/db/schema";
import { PostingIssueError } from "./types";

// Manual-order money (docs/plans/accounting.md §4.1 S6, D-3, Session 6). Staff record per order how
// it was paid and into which Kas & Bank account (order_manual_payments, migration 0053). These are
// the pure pieces the order pages use today and rule S6 uses once Session 9 wires it (together with
// S1/S3, so Uang muka pelanggan is complete): which orders need a record, the account the picker
// suggests for a method, and the money side of S6, which is a posting issue when the record is
// missing. Never a default account for an order: a suggestion is only ever shown to staff.

/** Posting issue: a manual order whose payment method and account were never recorded. */
export const MANUAL_PAYMENT_MISSING_ISSUE = "manual_payment_missing";

/** A manual order, i.e. one whose money S6 posts: not a web checkout order (`payment_status` is
 * set only for those, migration 0030) and not a marketplace order (that money is Saldo Penjual,
 * D-11). Same rule as the 0053 trigger order_manual_payments_guard. */
export function isManualPaymentOrder(order: { channelId: ChannelId | string; paymentStatus: string | null }): boolean {
  return order.paymentStatus === null && !(MARKETPLACE_CHANNEL_IDS as readonly string[]).includes(order.channelId);
}

/** The account mapping key a method's suggestion comes from (D-17, D-18). */
export function cashMethodMappingKey(method: ManualOrderPaymentMethod): string {
  return `cash.method.${method}`;
}

/** The Kas & Bank account the picker preselects for a method: what the accountant mapped
 * `cash.method.<method>` to (initially cash → 1-1101 Kas tunai, transfer and card (a debit card,
 * D-18) → 1-1201 Bank utama). Null when unmapped: staff then pick one themselves. */
export function suggestedCashAccountFor(method: ManualOrderPaymentMethod, mappings: ReadonlyMap<string, string>): string | null {
  return mappings.get(cashMethodMappingKey(method)) ?? null;
}

export interface ManualPaymentRecord {
  method: ManualOrderPaymentMethod;
  cashAccountCode: string;
  /** Jakarta calendar date the money came in. */
  paidOn: string;
}

/** S6's money side: the account the order's money went into and the day it came in, exactly as
 * staff recorded them. No record → the posting issue `manual_payment_missing` (raised as a
 * PostingIssueError, so a rule body wrapped in resolveOrIssue turns it into an issue outcome),
 * never a guessed account. An inactive or header account is caught later by planEvent
 * (`account_not_postable`). */
export function manualOrderMoneyIn(order: { orderId: string; orderNo: string; payment: ManualPaymentRecord | null }): ManualPaymentRecord {
  if (!order.payment) throw new PostingIssueError(MANUAL_PAYMENT_MISSING_ISSUE, { orderId: order.orderId, orderNo: order.orderNo });
  return order.payment;
}
