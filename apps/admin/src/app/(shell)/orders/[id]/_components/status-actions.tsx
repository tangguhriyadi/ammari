"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@ammari/ui";
import type { OrderStatus } from "@ammari/db/schema";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import type { ManualPaymentOptions } from "@/lib/orders/manual-payment-input";
import { confirmManualOrderPaymentAction, transitionOrderStatusAction } from "../../actions";
import { STOREFRONT_STALE_MESSAGE } from "@/lib/storefront-stale";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { emptyManualPaymentDraft, ManualPaymentFields, manualPaymentFromDraft, type ManualPaymentDraft } from "../../_components/manual-payment-fields";

const TRANSITION_BUTTON_VARIANT: Partial<Record<OrderStatus, "primary" | "danger" | "secondary">> = {
  cancelled: "danger",
  returned: "danger",
};

export function StatusActions({
  orderId,
  allowedTransitions,
  manualPayment,
}: {
  orderId: string;
  allowedTransitions: OrderStatus[];
  /** Set for a manual order (D-3): "Siap Kirim" then asks how and where the money came in, and
   * saves both together. */
  manualPayment?: { options: ManualPaymentOptions; today: string };
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [payment, setPayment] = useState<ManualPaymentDraft>(() => emptyManualPaymentDraft(manualPayment?.today ?? ""));

  if (allowedTransitions.length === 0) return null;

  function handleTransition(toStatus: OrderStatus) {
    setError(null);
    if (manualPayment && toStatus === "to_ship") {
      setPaymentOpen(true);
      return;
    }
    // Another status closes an open payment form: it belongs to "Siap Kirim" only.
    setPaymentOpen(false);
    startTransition(async () => {
      const result = await transitionOrderStatusAction({ orderId, toStatus });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!result.data.storefrontOk) toast.error(STOREFRONT_STALE_MESSAGE);
      router.refresh();
    });
  }

  function handleConfirmPayment() {
    setError(null);
    const input = manualPaymentFromDraft(payment, todayInJakarta());
    if (!input.ok) {
      setError(input.error);
      return;
    }
    startTransition(async () => {
      const result = await confirmManualOrderPaymentAction({ orderId, payment: input.payment });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!result.data.storefrontOk) toast.error(STOREFRONT_STALE_MESSAGE);
      setPaymentOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {allowedTransitions.map((toStatus) => (
          <Button
            key={toStatus}
            type="button"
            variant={TRANSITION_BUTTON_VARIANT[toStatus] ?? "secondary"}
            loading={pending}
            onClick={() => handleTransition(toStatus)}
          >
            {ORDER_STATUS_LABELS[toStatus]}
          </Button>
        ))}
      </div>
      {manualPayment && paymentOpen && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4"
          aria-label="Catat pembayaran"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleConfirmPayment();
          }}
        >
          <p className="text-sm text-neutral-600">Pesanan sudah dibayar? Catat cara bayar dan rekening tempat uangnya masuk.</p>
          <ManualPaymentFields idPrefix="confirm-payment" value={payment} onChange={setPayment} options={manualPayment.options} maxDate={manualPayment.today} disabled={pending} autoFocus />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setPaymentOpen(false);
                setError(null);
              }}
            >
              Batal
            </Button>
            <Button type="submit" loading={pending}>
              Simpan dan tandai Siap Kirim
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}
