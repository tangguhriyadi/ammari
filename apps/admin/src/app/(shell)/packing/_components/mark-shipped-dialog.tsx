"use client";

import { ShipmentDetailsDialog } from "@/components/orders/shipment-details-dialog";
import { markShippedAction } from "../actions";

export interface MarkShippedDialogProps {
  orderId: string;
  orderNo: string;
  hasActiveCard: boolean;
  /** A web checkout order: courier and resi are required (2026-10-21 sandbox run). */
  isCheckout: boolean;
  /** Prefills "Kurir" with a web checkout order's quoted service (staff book exactly that one). */
  defaultCourier?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShipped: () => void;
}

/** Per-order "Tandai dikirim". Courier and resi are optional for manual and marketplace orders (the
 * owner's own requirement) and required for a web checkout order, whose buyer gets them by email.
 * An order without an active thank-you card needs an explicit confirmation
 * (docs/plans/packing-cards.md's "nothing ships without a card" rule) rather than silently letting
 * it through; web checkout orders never carry a card. */
export function MarkShippedDialog({ orderId, orderNo, hasActiveCard, isCheckout, defaultCourier, open, onOpenChange, onShipped }: MarkShippedDialogProps) {
  return (
    <ShipmentDetailsDialog
      title={`Tandai dikirim: ${orderNo}`}
      description={hasActiveCard ? undefined : "Pesanan ini belum punya kartu terima kasih. Lanjutkan hanya jika memang tidak perlu kartu."}
      confirmLabel="Tandai dikirim"
      confirmVariant={hasActiveCard ? "primary" : "danger"}
      checkoutOrder={isCheckout}
      defaultCourier={defaultCourier}
      open={open}
      onOpenChange={onOpenChange}
      submit={({ courier, trackingNumber }) =>
        markShippedAction({ orderId, courier: courier || undefined, trackingNumber: trackingNumber || undefined, confirmNoCard: !hasActiveCard })
      }
      onDone={onShipped}
    />
  );
}
