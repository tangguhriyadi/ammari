import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { orders } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";

const col = (column: Parameters<typeof qualifiedColumn>[1]) => qualifiedColumn(orders, column);

/** Whether an order takes a thank-you card (SPEC §4.1, owner decision 2026-11-18). The ONE rule the
 * packing list, the sticker-code preview, the "no card" warning and `mintThankYouCard` all read, so
 * they can never disagree:
 *
 * - every order without a payment status (marketplace imports and staff-entered orders);
 * - a web checkout order only when it was placed without a session (a guest) AND it is that
 *   contact email's first website purchase: it is paid (`paid` / `partially_refunded`), not
 *   cancelled or returned, and no OTHER web checkout order with the same normalized contact email
 *   (`lower(btrim())`), guest or logged in, is a purchase that was paid earlier. Ties on `paid_at`
 *   go to the lower id, so of two first guest orders exactly one ever qualifies (earliest paid wins).
 *   A first order that is later cancelled or returned stops counting, so the next one takes over.
 *
 * Correlated on the outer `orders` row (never aliased by its callers); `qualifiedColumn` keeps the
 * correlation explicit (packages/db/src/sql-helpers.ts). The subquery uses
 * `orders_checkout_contact_email_norm_paid_idx` (migration 0045). */
export function takesThankYouCardSql(): SQL<boolean> {
  return sql<boolean>`(
    ${col(orders.paymentStatus)} is null
    or (
      ${col(orders.placedWithSession)} = false
      and ${col(orders.paymentStatus)} in ('paid', 'partially_refunded')
      and ${col(orders.status)} not in ('cancelled', 'returned')
      and not exists (
        select 1 from ${orders} as earlier
        where earlier.payment_status is not null
          and earlier.payment_status in ('paid', 'partially_refunded')
          and earlier.status not in ('cancelled', 'returned')
          and earlier.id <> ${col(orders.id)}
          and lower(btrim(earlier.contact_email::text)) = lower(btrim(${col(orders.contactEmail)}::text))
          and (earlier.paid_at, earlier.id) < (${col(orders.paidAt)}, ${col(orders.id)})
      )
    )
  )`;
}
