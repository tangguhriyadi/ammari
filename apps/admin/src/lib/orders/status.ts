import type { OrderStatus } from "@ammari/db/schema";

/** The one allowed-transitions table for `orders.status` (approved plan, docs/plans/orders-core.md).
 * `packages/db` stays schema-only (docs/SPEC.md §10) — this business rule lives here instead,
 * in app code, mirroring how production's draft->posted transition is enforced by app code (plus
 * a DB trigger locking the already-posted state) rather than a stored transition table.
 *
 * `transitionOrderStatus` (queries.ts) is the ONLY path allowed to move an order between
 * statuses — every caller (the manual-entry UI, a future importer, a future packing page) must
 * go through it, never an ad hoc `UPDATE orders SET status = ...`.
 *
 * `shipped -> cancelled` is deliberately NOT allowed: a refused/failed delivery goes through
 * `returned` instead (approved plan, decision #6) — cancellation only ever applies before stock
 * has actually left the building in a shipment. */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  awaiting_payment: ["to_ship", "cancelled"],
  to_ship: ["shipped", "cancelled"],
  shipped: ["completed", "returned"],
  completed: ["returned"],
  cancelled: [],
  returned: [],
};

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses at which a sale has NOT yet been posted against finished-goods stock — the only
 * statuses a brand-new manual order may be created into directly. `to_ship`/`shipped`/
 * `completed` all require stock to already have left (see createOrder's doc comment), so a new
 * order starting there decrements stock at creation time; `awaiting_payment` defers that to its
 * later `to_ship` transition. */
export const STOCK_NOT_YET_DECREMENTED_STATUSES: readonly OrderStatus[] = ["awaiting_payment"];

/** The timestamp column transitioning TO a given status sets — `transitionOrderStatus` uses this
 * to know which column to stamp, so the mapping lives in exactly one place. `to_ship` has no
 * timestamp column of its own (orders can start there directly) and `awaiting_payment` is only
 * ever the START of a transition, never the target, so neither appears here. */
export const ORDER_STATUS_TIMESTAMP_COLUMN = {
  shipped: "shippedAt",
  completed: "completedAt",
  cancelled: "cancelledAt",
  returned: "returnedAt",
} as const satisfies Partial<Record<OrderStatus, string>>;
