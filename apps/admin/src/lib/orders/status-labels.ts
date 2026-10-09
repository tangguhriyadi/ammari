import type { OrderStatus } from "@ammari/db/schema";
import type { BadgeVariant } from "@ammari/ui";

/** Single source of Indonesian labels + badge color for every order status — shared by the
 * list, detail, and filter-tabs UI so they can never drift out of sync with each other. Badge
 * colors reuse the existing design-token variants (CLAUDE.md: muted earth tones, never raw
 * saturated red/green) rather than inventing new ones. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  awaiting_payment: "Menunggu Bayar",
  to_ship: "Siap Kirim",
  shipped: "Dikirim",
  completed: "Selesai",
  cancelled: "Dibatalkan",
  returned: "Retur",
};

export const ORDER_STATUS_BADGE_VARIANT: Record<OrderStatus, BadgeVariant> = {
  awaiting_payment: "warning",
  to_ship: "neutral",
  shipped: "neutral",
  completed: "success",
  cancelled: "danger",
  returned: "danger",
};
