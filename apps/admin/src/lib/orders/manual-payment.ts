import "server-only";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { isManualPaymentOrder, suggestedCashAccountFor } from "@ammari/accounting";
import { createOrder, transitionOrderStatus, type CreateOrderInput } from "@ammari/commerce/orders";
import { isPostgresConstraintViolation } from "@ammari/commerce/errors";
import {
  accountMappings,
  accounts,
  CASH_BANK_ACCOUNT_CODE_PATTERN,
  MANUAL_ORDER_PAYMENT_METHODS,
  orderItems,
  orderManualPayments,
  orders,
  staffUsers,
  stockMovements,
  type ManualOrderPaymentMethod,
  type OrderStatus,
} from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database, type Tx } from "@/lib/db";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { MANUAL_PAYMENT_MESSAGES, manualPaymentDateProblem, type ManualPaymentInput, type ManualPaymentOptions } from "./manual-payment-input";

// Cara bayar pesanan manual (docs/plans/accounting.md §4.1 S6, §8 Session 6, D-3). A manual order
// (WhatsApp, Instagram, offline, manual web) is always paid before it ships, so staff record how
// and into which Kas & Bank account the money came, and when, at the moment it becomes "Siap
// Kirim": in the order form (same transaction as the order), on "Siap Kirim" for an order waiting
// for payment (same transaction as the transition), or later with "Isi cara bayar" for an order
// entered before this feature. Rule S6 (Session 9) reads it; an order without a record is a
// posting issue there, never a default account.
//
// This file only adds the payment row around the existing commerce write path: createOrder and
// transitionOrderStatus run unchanged inside the outer transaction (drizzle nests them as
// savepoints), so stock, pricing and checkout logic are untouched.

/** Active, postable Kas & Bank accounts (D-17) and each method's mapped account. */
export async function loadManualPaymentOptions(db: Database = defaultDb): Promise<ManualPaymentOptions> {
  const [accountRows, mappingRows] = await Promise.all([
    db
      .select({ code: accounts.code, name: sql<string>`${accounts.name}::text` })
      .from(accounts)
      .where(and(sql`${accounts.code} ~ ${CASH_BANK_ACCOUNT_CODE_PATTERN}`, eq(accounts.isActive, true), eq(accounts.isHeader, false)))
      .orderBy(asc(accounts.sortOrder), asc(accounts.code)),
    db.select({ key: accountMappings.mappingKey, code: accountMappings.accountCode }).from(accountMappings).where(like(accountMappings.mappingKey, "cash.method.%")),
  ]);
  const mappings = new Map(mappingRows.map((row) => [row.key, row.code]));
  const suggestedAccount = Object.fromEntries(
    MANUAL_ORDER_PAYMENT_METHODS.map((method) => [method, suggestedCashAccountFor(method, mappings)]),
  ) as Record<ManualOrderPaymentMethod, string | null>;
  return { accounts: accountRows, suggestedAccount };
}

/** The 0053 guard's refusals, as messages (the checks below normally catch them first). `status`
 * tells an order still waiting for payment from one cancelled before it was ever paid. */
function mapManualPaymentWriteError(error: unknown, status: OrderStatus): never {
  if (isPostgresConstraintViolation(error, "23514", ["order_manual_payments_account", "order_manual_payments_cash_account_check"])) {
    throw new FieldError("cashAccountCode", MANUAL_PAYMENT_MESSAGES.accountNotAllowed);
  }
  if (isPostgresConstraintViolation(error, "23503", ["order_manual_payments_cash_account_code_accounts_code_fk"])) {
    throw new FieldError("cashAccountCode", MANUAL_PAYMENT_MESSAGES.accountNotAllowed);
  }
  if (isPostgresConstraintViolation(error, "23514", ["order_manual_payments_order"])) {
    throw new ActionError(status === "cancelled" ? MANUAL_PAYMENT_MESSAGES.cancelledBeforePayment : MANUAL_PAYMENT_MESSAGES.notPaidYet);
  }
  throw error;
}

function sameRecord(a: { method: string; cashAccountCode: string; paidOn: string }, b: ManualPaymentInput): boolean {
  return a.method === b.method && a.cashAccountCode === b.cashAccountCode && a.paidOn === b.paidOn;
}

/** Records (or corrects) one order's payment inside `tx`. Locks the order row first, so two staff
 * saving at once run one after the other and each audit row's `before` is what was really there.
 * Returns whether anything changed (saving the same values again writes nothing). */
async function writeManualPayment(tx: Tx, orderId: string, input: ManualPaymentInput, actorStaffUserId: string, now: Date): Promise<boolean> {
  const dateProblem = manualPaymentDateProblem(input.paidOn, todayInJakarta(now));
  if (dateProblem) throw new FieldError("paidOn", dateProblem);

  const [order] = await tx
    .select({ channelId: orders.channelId, paymentStatus: orders.paymentStatus, status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update");
  if (!order) throw new ActionError(MANUAL_PAYMENT_MESSAGES.orderNotFound);
  if (!isManualPaymentOrder(order)) throw new ActionError(MANUAL_PAYMENT_MESSAGES.notManualOrder);
  if (order.status === "awaiting_payment") throw new ActionError(MANUAL_PAYMENT_MESSAGES.notPaidYet);

  const [before] = await tx
    .select({ method: orderManualPayments.method, cashAccountCode: orderManualPayments.cashAccountCode, paidOn: orderManualPayments.paidOn })
    .from(orderManualPayments)
    .where(eq(orderManualPayments.orderId, orderId));
  if (before && sameRecord(before, input)) return false;

  const values = { method: input.method, cashAccountCode: input.cashAccountCode, paidOn: input.paidOn, recordedByStaffUserId: actorStaffUserId };
  try {
    // A savepoint, so a refused write leaves the caller's transaction usable for the mapped error.
    // Update or insert, never an upsert: an INSERT ... ON CONFLICT fires the insert trigger first,
    // which would re-check an unchanged account that was deactivated since. The order row lock
    // above serialises two saves of the same order, so the read of `before` cannot go stale.
    await tx.transaction(async (inner) => {
      if (before) await inner.update(orderManualPayments).set(values).where(eq(orderManualPayments.orderId, orderId));
      else await inner.insert(orderManualPayments).values({ orderId, ...values });
    });
  } catch (error) {
    mapManualPaymentWriteError(error, order.status);
  }
  await writeAuditLog(tx, {
    actorStaffUserId,
    action: before ? "update_manual_payment" : "record_manual_payment",
    entityType: "order",
    entityId: orderId,
    before: before ?? null,
    after: { method: input.method, cashAccountCode: input.cashAccountCode, paidOn: input.paidOn },
  });
  return true;
}

/** True when an order created with this channel and status must carry a payment record (D-3):
 * a manual channel created already paid ("Siap Kirim"). Staff-entered orders never carry a
 * checkout payment_status. */
export function createdOrderNeedsPayment(channelId: CreateOrderInput["channelId"], status: CreateOrderInput["status"]): boolean {
  return status === "to_ship" && isManualPaymentOrder({ channelId, paymentStatus: null });
}

/** "Simpan pesanan": the order (unchanged createOrder) and, for a manual order created as "Siap
 * Kirim", its payment record, in ONE transaction: either both are saved or neither. */
export async function createOrderWithManualPayment(
  input: CreateOrderInput,
  payment: ManualPaymentInput | null,
  actorStaffUserId: string,
  db: Database = defaultDb,
  now: Date = new Date(),
) {
  const needsPayment = createdOrderNeedsPayment(input.channelId, input.status);
  if (needsPayment && !payment) throw new ActionError(MANUAL_PAYMENT_MESSAGES.required);
  if (!needsPayment && payment) {
    throw new ActionError(input.status === "to_ship" ? MANUAL_PAYMENT_MESSAGES.notManualOrder : MANUAL_PAYMENT_MESSAGES.notPaidYet);
  }
  // Checked again inside, but before any stock work here.
  const dateProblem = payment ? manualPaymentDateProblem(payment.paidOn, todayInJakarta(now)) : null;
  if (dateProblem) throw new FieldError("paidOn", dateProblem);
  return db.transaction(async (tx) => {
    const order = await createOrder(input, actorStaffUserId, tx, now);
    if (payment) await writeManualPayment(tx, order.id, payment, actorStaffUserId, now);
    return order;
  });
}

async function loadOrderKind(db: Database, orderId: string) {
  const [order] = await db.select({ channelId: orders.channelId, paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, orderId));
  if (!order) throw new ActionError(MANUAL_PAYMENT_MESSAGES.orderNotFound);
  return order;
}

/** A manual order becomes "Siap Kirim" only together with its payment record (D-3), through
 * confirmManualOrderPayment. The plain status change refuses it on the server, not only in the UI.
 * Channel and payment_status never change on a manual order, so this read cannot go stale. */
export async function assertPlainTransitionAllowed(orderId: string, toStatus: OrderStatus, db: Database = defaultDb): Promise<void> {
  if (toStatus !== "to_ship") return;
  if (isManualPaymentOrder(await loadOrderKind(db, orderId))) throw new ActionError(MANUAL_PAYMENT_MESSAGES.useConfirmPayment);
}

/** "Siap Kirim" on a manual order waiting for payment: the unchanged transition (stock leaves)
 * and the payment record, in ONE transaction. */
export async function confirmManualOrderPayment(
  orderId: string,
  payment: ManualPaymentInput,
  actorStaffUserId: string,
  db: Database = defaultDb,
  now: Date = new Date(),
): Promise<void> {
  const dateProblem = manualPaymentDateProblem(payment.paidOn, todayInJakarta(now));
  if (dateProblem) throw new FieldError("paidOn", dateProblem);
  await db.transaction(async (tx) => {
    if (!isManualPaymentOrder(await loadOrderKind(tx, orderId))) throw new ActionError(MANUAL_PAYMENT_MESSAGES.notManualOrder);
    await transitionOrderStatus(orderId, "to_ship", actorStaffUserId, tx);
    await writeManualPayment(tx, orderId, payment, actorStaffUserId, now);
  });
}

/** "Isi cara bayar" / "Ubah cara bayar" for a manual order already past "Menunggu Bayar"
 * (e.g. entered before this feature). Returns whether anything changed. */
export async function recordManualOrderPayment(
  orderId: string,
  payment: ManualPaymentInput,
  actorStaffUserId: string,
  db: Database = defaultDb,
  now: Date = new Date(),
): Promise<{ changed: boolean }> {
  const changed = await db.transaction((tx) => writeManualPayment(tx, orderId, payment, actorStaffUserId, now));
  return { changed };
}

export interface ManualPaymentView {
  method: ManualOrderPaymentMethod;
  cashAccountCode: string;
  cashAccountName: string;
  paidOn: string;
  recordedByName: string | null;
  updatedAt: Date;
}

export interface ManualPaymentState {
  /** The order has received money (its stock left at "Siap Kirim"), so it needs a record. */
  required: boolean;
  /** Still "Menunggu Bayar": the record comes with "Siap Kirim". */
  awaitingPayment: boolean;
  payment: ManualPaymentView | null;
}

/** The "Pembayaran" card of a manual order's page; null for checkout and marketplace orders. */
export async function getManualPaymentState(
  order: { id: string; channelId: string; status: OrderStatus; isCheckout: boolean },
  db: Database = defaultDb,
): Promise<ManualPaymentState | null> {
  if (!isManualPaymentOrder({ channelId: order.channelId, paymentStatus: order.isCheckout ? "checkout" : null })) return null;
  const [[payment], [stockLeft]] = await Promise.all([
    db
      .select({
        method: orderManualPayments.method,
        cashAccountCode: orderManualPayments.cashAccountCode,
        cashAccountName: sql<string>`${accounts.name}::text`,
        paidOn: orderManualPayments.paidOn,
        recordedByName: staffUsers.name,
        updatedAt: orderManualPayments.updatedAt,
      })
      .from(orderManualPayments)
      .innerJoin(accounts, eq(accounts.code, orderManualPayments.cashAccountCode))
      .leftJoin(staffUsers, eq(staffUsers.id, orderManualPayments.recordedByStaffUserId))
      .where(eq(orderManualPayments.orderId, order.id)),
    // Same rule as the 0053 trigger: money came in once the order's stock left.
    db
      .select({ one: sql<number>`1` })
      .from(orderItems)
      .innerJoin(stockMovements, and(eq(stockMovements.refType, "order_item"), eq(stockMovements.refId, sql`${orderItems.id}::text`), eq(stockMovements.type, "sale")))
      .where(eq(orderItems.orderId, order.id))
      .limit(1),
  ]);
  return { required: stockLeft !== undefined, awaitingPayment: order.status === "awaiting_payment", payment: payment ?? null };
}
