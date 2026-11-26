import { jakartaDateOf } from "./dates";
import { depositAtCancel, gatewayRefundAt, isPaidPayment, orderKind, orderSaleValue, paidAfterCancel, recognitionDate, refundFromRefundLiability, refundParts, type OrderSnapshot } from "./rules/sales";

// Rekonsiliasi checks 1 (1-1505), 3 (2-1201 Uang muka pelanggan) and 3c (2-1203 Titipan ongkir
// pembeli) per order (docs/plans/accounting.md §6.3, Session 9). What the order's own records say
// each account moved within a window of the books (the set of books' first day up to the "per
// tanggal" date), so the Rekonsiliasi page can set it beside the journals that carry the order's id.
// Events dated before the window are not counted (they are in the opening balance, or in no journal
// in the trial month); `startsBeforeBooks` marks the orders that have such events.

export interface OrderAccountMovements {
  /** 1-1505 Barang terjual belum dikirim: stock out at to_ship, less a cancel's return, less the
   * HPP recognised at shipping. */
  soldNotShipped: number;
  /** 2-1201 Uang muka pelanggan as a credit balance (money held for an order not yet recognised). */
  deposit: number;
  /** 2-1203 Titipan ongkir pembeli as a credit balance (buyer ongkir received, not yet paid to the
   * courier). */
  buyerShipping: number;
  /** Some event of the order is dated before the window. */
  startsBeforeBooks: boolean;
  /** Something the records cannot date or price yet: a marketplace sale without its real ship
   * time (Session 5), a manual order without its payment record (Session 6). */
  pending: boolean;
}

export function orderAccountMovements(order: OrderSnapshot, from: string, to: string): OrderAccountMovements {
  let startsBeforeBooks = false;
  const inWindow = (date: string | null): boolean => {
    if (date === null || date > to) return false;
    if (date < from) {
      startsBeforeBooks = true;
      return false;
    }
    return true;
  };
  const at = (instant: Date | null) => (instant ? jakartaDateOf(instant) : null);
  const kind = orderKind(order);
  const result: OrderAccountMovements = { soldNotShipped: 0, deposit: 0, buyerShipping: 0, startsBeforeBooks: false, pending: false };

  // 1-1505
  for (const movement of order.movements) {
    if (!inWindow(at(movement.createdAt))) continue;
    if (movement.type === "sale") result.soldNotShipped -= movement.valueAmount;
    else if (order.status !== "returned") result.soldNotShipped -= movement.valueAmount;
  }
  const recognised = recognitionDate(order);
  if (order.shippedAt && recognised === null) result.pending = true;
  const recognisedInWindow = inWindow(recognised);
  if (recognisedInWindow) {
    result.soldNotShipped -= orderSaleValue(order);
    result.buyerShipping += order.shippingAmount;
  }

  // 2-1201
  if (kind === "manual") {
    const sold = order.movements.some((movement) => movement.type === "sale");
    if (sold && !order.manualPayment) result.pending = true;
    if (order.manualPayment && inWindow(order.manualPayment.paidOn)) result.deposit += order.totalAmount;
    if (sold && order.status === "cancelled" && inWindow(at(order.cancelledAt))) result.deposit -= order.totalAmount;
    if (recognisedInWindow) result.deposit -= order.totalAmount;
  } else if (kind === "checkout") {
    for (const payment of order.payments) {
      if (!isPaidPayment(payment)) continue;
      if (!paidAfterCancel(order, payment) && inWindow(at(payment.paidAt))) result.deposit += payment.grossAmount;
      const parts = refundParts(payment);
      const refunds: [number, Date | null][] = [
        [parts.manual, payment.manualRefund?.recordedAt ?? null],
        [parts.gateway, parts.gateway > 0 ? gatewayRefundAt(payment) : null],
      ];
      for (const [amount, when] of refunds) {
        if (amount > 0 && when && !refundFromRefundLiability(order, payment, when) && inWindow(at(when))) result.deposit -= amount;
      }
    }
    if (order.status === "cancelled" && inWindow(at(order.cancelledAt))) result.deposit -= depositAtCancel(order);
    if (recognisedInWindow) result.deposit -= order.totalAmount;
  }

  // 2-1203: each charged booking uses the buyer's titipan; a cancelled one gives it back.
  for (const shipment of order.shipments) {
    if (shipment.costAmount === null || shipment.bookedAt === null) continue;
    const charged = at(shipment.bookedAt);
    if (inWindow(charged)) result.buyerShipping -= order.shippingAmount;
    // A cancel of a booking charged before the window is not journaled (void rule).
    if (shipment.status === "cancelled" && charged !== null && charged >= from && inWindow(at(shipment.cancelledAt))) result.buyerShipping += order.shippingAmount;
  }

  result.startsBeforeBooks = startsBeforeBooks;
  return result;
}
