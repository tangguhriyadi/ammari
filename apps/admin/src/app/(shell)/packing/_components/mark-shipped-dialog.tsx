"use client";

import { useState, useTransition } from "react";
import { Dialog, Input, Label } from "@ammari/ui";
import { markShippedAction } from "../actions";

const COURIER_SUGGESTIONS = ["JNE", "J&T", "SiCepat", "AnterAja", "Ninja Xpress", "ID Express", "POS Indonesia", "Lion Parcel"];

export interface MarkShippedDialogProps {
  orderId: string;
  orderNo: string;
  hasActiveCard: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShipped: () => void;
}

/** Per-order "Tandai dikirim" — courier/resi are both optional (the owner's own requirement),
 * and if this order has no active thank-you card, shipping it requires an explicit confirmation
 * (docs/plans/packing-cards.md's "nothing ships without a card" rule) rather than silently
 * letting it through. */
export function MarkShippedDialog({ orderId, orderNo, hasActiveCard, open, onOpenChange, onShipped }: MarkShippedDialogProps) {
  const [courier, setCourier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await markShippedAction({
        orderId,
        courier: courier || undefined,
        trackingNumber: trackingNumber || undefined,
        confirmNoCard: !hasActiveCard,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      onShipped();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Tandai dikirim — ${orderNo}`}
      description={
        hasActiveCard
          ? undefined
          : "Pesanan ini belum punya kartu terima kasih. Lanjutkan hanya jika memang tidak perlu kartu."
      }
      confirmLabel="Tandai dikirim"
      confirmVariant={hasActiveCard ? "primary" : "danger"}
      onConfirm={handleConfirm}
      loading={pending}
    >
      <div className="flex flex-col gap-4">
        <div>
          <Label htmlFor="ship-courier">Kurir</Label>
          <Input id="ship-courier" list="courier-suggestions" value={courier} onChange={(event) => setCourier(event.target.value)} placeholder="Opsional" />
          <datalist id="courier-suggestions">
            {COURIER_SUGGESTIONS.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <div>
          <Label htmlFor="ship-tracking">No. resi</Label>
          <Input id="ship-tracking" value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} placeholder="Opsional" />
        </div>
        {error && (
          <p role="alert" className="text-base text-danger-700">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
