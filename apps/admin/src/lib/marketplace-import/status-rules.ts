import { ORDER_STATUS_TRANSITIONS } from "@ammari/commerce/order-status";
import type { OrderStatus } from "@ammari/db/schema";
import type { StatusRule } from "./adapters/types";

// What a marketplace status does to the admin order (docs/plans/marketplace-import.md §3). Pure:
// the planner (session 3) calls it per order, and the commit (session 4) runs the returned steps
// one by one through transitionOrderStatus, the only path an order's status may take.

export type StatusDecision =
  /** Create at `to_ship` (stock leaves), then run `transitions` in order. */
  | { kind: "create"; transitions: OrderStatus[]; setReturnPending: boolean }
  | { kind: "skip"; reason: "unpaid" | "undone_before_import" }
  | { kind: "update"; transitions: OrderStatus[]; setReturnPending: boolean; clearReturnPending: boolean }
  | { kind: "unchanged" }
  | { kind: "review"; reason: "unknown_status" | "final_in_admin"; message: string };

const FINAL_STATUSES: readonly OrderStatus[] = ["cancelled", "returned"];
const UNDONE_STATUSES: readonly OrderStatus[] = ["cancelled", "returned"];

/** The shortest allowed path from `from` to `to` (excluding `from`), or null when `to` cannot be
 * reached, which for this forward-only graph means it is behind or on another branch. */
function forwardPath(from: OrderStatus, to: OrderStatus): OrderStatus[] | null {
  if (from === to) return [];
  const previous = new Map<OrderStatus, OrderStatus>();
  const queue: OrderStatus[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of ORDER_STATUS_TRANSITIONS[current]) {
      if (next === from || previous.has(next)) continue;
      previous.set(next, current);
      if (next === to) {
        const path: OrderStatus[] = [to];
        for (let step = current; step !== from; step = previous.get(step)!) path.unshift(step);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** The admin target for a status rule, given where the admin order is now. An undo maps to the
 * lifecycle's own word for it: before shipping a cancel, after shipping a return (owner decision 4;
 * `shipped -> cancelled` and `to_ship -> returned` do not exist). */
function targetFor(rule: Extract<StatusRule, { kind: "status" }>, current: OrderStatus): OrderStatus {
  const shippedOrLater = current === "shipped" || current === "completed";
  if (rule.status === "cancelled" && shippedOrLater) return "returned";
  if (rule.status === "returned" && !shippedOrLater) return "cancelled";
  return rule.status;
}

export function decideStatus(rule: StatusRule | undefined, current: { status: OrderStatus; returnPending: boolean } | null): StatusDecision {
  if (!rule) return { kind: "review", reason: "unknown_status", message: "Status pesanan ini belum dikenal, jadi pesanan belum diimpor." };

  if (current === null) {
    if (rule.kind === "unpaid") return { kind: "skip", reason: "unpaid" };
    if (rule.kind === "return_pending") return { kind: "create", transitions: forwardPath("to_ship", "shipped")!, setReturnPending: true };
    if (UNDONE_STATUSES.includes(rule.status)) return { kind: "skip", reason: "undone_before_import" };
    return { kind: "create", transitions: forwardPath("to_ship", rule.status)!, setReturnPending: false };
  }

  if (FINAL_STATUSES.includes(current.status)) {
    const marketplaceUndone = rule.kind === "status" && UNDONE_STATUSES.includes(rule.status);
    if (marketplaceUndone || rule.kind === "unpaid") {
      // Already undone in admin (e.g. marked Retur by hand): a leftover return flag has nothing left to wait for.
      return current.returnPending ? { kind: "update", transitions: [], setReturnPending: false, clearReturnPending: true } : { kind: "unchanged" };
    }
    return {
      kind: "review",
      reason: "final_in_admin",
      message: "Pesanan ini sudah dibatalkan atau diretur di admin, tapi statusnya di marketplace berbeda. Periksa manual.",
    };
  }

  if (rule.kind === "unpaid") return { kind: "unchanged" };

  const target = rule.kind === "return_pending" ? "shipped" : targetFor(rule, current.status);
  const transitions = forwardPath(current.status, target) ?? [];
  const setReturnPending = rule.kind === "return_pending" && !current.returnPending;
  // Cleared only when the return really ends here (the order becomes cancelled/returned). Any other
  // status keeps the flag: an older overlapping file still saying Selesai/Dikirim must not erase a
  // pending return, and a rejected return is the owner's call on the order page (owner decision 3;
  // session 1 review).
  const endsUndone = transitions.length > 0 && UNDONE_STATUSES.includes(transitions[transitions.length - 1]!);
  const clearReturnPending = current.returnPending && endsUndone;
  if (transitions.length === 0 && !setReturnPending && !clearReturnPending) return { kind: "unchanged" };
  return { kind: "update", transitions, setReturnPending, clearReturnPending };
}
