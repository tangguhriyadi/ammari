import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { checkIn, timestamps } from "./columns";
import { SHIPMENT_PROVIDERS, SHIPMENT_STATUSES, type ShipmentProviderName, type ShipmentStatus } from "./constants";
import { orders } from "./orders";
import { staffUsers } from "./rbac";

// Courier bookings (docs/plans/cart-checkout.md §3 "Phase K migrations", §15 Phase K, migration
// 0034, K2). One row per booking ATTEMPT: a shipment cancelled before pickup can be booked again as
// the next attempt. The database itself allows at most one live attempt per order (partial UNIQUE
// below), so two "Pesan kurir" at once can never book twice.

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    // `shipmentReferenceId(prefix, orderNo, attempt)`: `<prefix><order_no>-K<attempt>`. Sent to the
    // provider as its unique `reference_id`, so a re-sent booking is refused as a duplicate.
    referenceId: text("reference_id").notNull().unique("shipments_reference_id_key"),
    provider: text("provider").$type<ShipmentProviderName>().notNull(),
    // The provider's order id. NULL while the booking's answer is unknown (or it was refused).
    providerOrderId: text("provider_order_id").unique("shipments_provider_order_id_key"),
    providerTrackingId: text("provider_tracking_id"),
    // The locked quote's courier and service codes, as sent (`orders.shipping_courier_code` /
    // `shipping_service_code`).
    courier: text("courier").notNull(),
    service: text("service").notNull(),
    // The waybill (`courier.waybill_id`); can change later (K3, `order.waybill_id`).
    awb: text("awb"),
    // Printed on our own label.
    routingCode: text("routing_code"),
    trackingLink: text("tracking_link"),
    // What Ammari actually pays (the provider's `price`), whole rupiah; NULL until known. Compare
    // with the order's `shipping_cost_amount` (decision 47).
    costAmount: bigint("cost_amount", { mode: "number" }),
    status: text("status").$type<ShipmentStatus>().notNull().default("booking"),
    // The provider's raw status as sent (trimmed, capped), known or not.
    providerStatus: text("provider_status"),
    // Why the last provider call did not settle the attempt: a reason and provider code only (e.g.
    // `refused:40002039`), never a body or personal data.
    lastError: text("last_error"),
    driverName: text("driver_name"),
    driverPhone: text("driver_phone"),
    driverPlateNumber: text("driver_plate_number"),
    // When the provider confirmed the booking.
    bookedAt: timestamp("booked_at", { withTimezone: true, mode: "date" }),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true, mode: "date" }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: "date" }),
    // Staff asked to cancel and the answer was lost: the next check reads the order first.
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
    // K3: the poller and webhook bookkeeping.
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true, mode: "date" }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true, mode: "date" }),
    bookedByStaffUserId: uuid("booked_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    cancelledByStaffUserId: uuid("cancelled_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (table) => [
    // Also the order_id index (leading column).
    unique("shipments_order_id_attempt_key").on(table.orderId, table.attempt),
    // Never a double booking: at most one attempt per order that has not ended.
    uniqueIndex("shipments_live_order_id_key")
      .on(table.orderId)
      .where(sql`${table.status} not in ('cancelled', 'failed')`),
    // K3's poller: open shipments, oldest poll first.
    index("shipments_open_last_polled_at_idx")
      .on(table.lastPolledAt)
      .where(sql`${table.status} not in ('cancelled', 'failed', 'delivered', 'returned')`),
    index("shipments_booked_by_staff_user_id_idx").on(table.bookedByStaffUserId),
    index("shipments_cancelled_by_staff_user_id_idx").on(table.cancelledByStaffUserId),
    check("shipments_provider_check", checkIn(table.provider, SHIPMENT_PROVIDERS)),
    check("shipments_status_check", checkIn(table.status, SHIPMENT_STATUSES)),
    check("shipments_attempt_check", sql`${table.attempt} between 1 and 99`),
    check("shipments_cost_amount_check", sql`${table.costAmount} is null or ${table.costAmount} >= 0`),
    // A refused booking never reached the provider as an order; every state after the answer
    // carries the provider's order id.
    check(
      "shipments_provider_order_id_check",
      sql`${table.status} in ('booking', 'failed') or ${table.providerOrderId} is not null`,
    ),
    check("shipments_failed_consistency_check", sql`(${table.status} = 'failed') = (${table.failedAt} is not null)`),
    check("shipments_failed_unbooked_check", sql`${table.status} <> 'failed' or ${table.providerOrderId} is null`),
    check("shipments_cancelled_at_check", sql`${table.status} <> 'cancelled' or ${table.cancelledAt} is not null`),
  ],
);
