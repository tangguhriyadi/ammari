// Customer-facing order status words for "Pesanan saya" (docs/plans/cart-checkout.md §9.1,
// docs/design/storefront.md §7): "Menunggu pembayaran", "Diproses", "Dikirim", "Selesai",
// "Dibatalkan", "Dikembalikan". Pure and client-safe; the inputs come from the server's own reads.

export interface CustomerOrderStatusInput {
  status: string;
  /** NULL for staff-entered and marketplace orders; set for every checkout order. */
  paymentStatus: string | null;
  /** The checkout order's 60-minute payment window has not ended yet. */
  paymentWindowOpen: boolean;
}

/** Where the order is, for layout decisions (the label is the words). */
export type CustomerOrderStage = "awaiting_payment" | "processing" | "shipped" | "completed" | "cancelled" | "returned";

export interface CustomerOrderStatus {
  stage: CustomerOrderStage;
  label: string;
  /** A second muted line for the few cases where the status alone would mislead. */
  note: string | null;
  /** Still waiting for the buyer to pay, inside the window ("Lanjutkan pembayaran" applies). */
  payable: boolean;
  /** Past the window and not finalized yet: a last-minute payment may still be confirmed. */
  confirming: boolean;
  /** Cancelled and never paid: "Pesan lagi" applies (checkout orders only). */
  reorderable: boolean;
}

const LATER_STAGES: Record<string, { stage: CustomerOrderStage; label: string }> = {
  to_ship: { stage: "processing", label: "Diproses" },
  shipped: { stage: "shipped", label: "Dikirim" },
  completed: { stage: "completed", label: "Selesai" },
  returned: { stage: "returned", label: "Dikembalikan" },
};

const REFUND_NOTES: Record<string, string> = {
  refunded: "Dana sudah dikembalikan.",
  partially_refunded: "Sebagian dana sudah dikembalikan.",
};

export function customerOrderStatus(order: CustomerOrderStatusInput): CustomerOrderStatus {
  const base = { note: null, payable: false, confirming: false, reorderable: false };
  const isCheckout = order.paymentStatus !== null;

  if (order.status === "awaiting_payment") {
    // Paid while the stock was short (plan §6.2): staff follow up, the buyer has already paid.
    if (order.paymentStatus === "paid") return { ...base, stage: "processing", label: "Diproses" };
    if (isCheckout && order.paymentStatus === "pending" && !order.paymentWindowOpen) {
      return { ...base, stage: "awaiting_payment", label: "Menunggu konfirmasi pembayaran", confirming: true };
    }
    return { ...base, stage: "awaiting_payment", label: "Menunggu pembayaran", payable: isCheckout && order.paymentStatus === "pending" };
  }

  if (order.status === "cancelled") {
    // Paid after the order had already been cancelled (plan §6.2): the money goes back.
    if (order.paymentStatus === "paid") return { ...base, stage: "cancelled", label: "Dibatalkan", note: "Pembayaranmu kami terima setelah pesanan dibatalkan. Dananya akan kami kembalikan penuh." };
    const note = order.paymentStatus ? (REFUND_NOTES[order.paymentStatus] ?? null) : null;
    const neverPaid = order.paymentStatus === "pending" || order.paymentStatus === "expired" || order.paymentStatus === "cancelled";
    return { ...base, stage: "cancelled", label: "Dibatalkan", note, reorderable: isCheckout && neverPaid };
  }

  const note = order.paymentStatus ? (REFUND_NOTES[order.paymentStatus] ?? null) : null;
  const later = LATER_STAGES[order.status];
  // An unknown status reads as being worked on, never as finished; logged so it gets a label.
  if (!later) console.error("[orders] order status without a customer label", { status: order.status });
  return { ...base, ...(later ?? { stage: "processing", label: "Diproses" }), note };
}
