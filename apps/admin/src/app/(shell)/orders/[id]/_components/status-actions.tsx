"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@ammari/ui";
import type { OrderStatus } from "@ammari/db/schema";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import { transitionOrderStatusAction } from "../../actions";

const TRANSITION_BUTTON_VARIANT: Partial<Record<OrderStatus, "primary" | "danger" | "secondary">> = {
  cancelled: "danger",
  returned: "danger",
};

export function StatusActions({ orderId, allowedTransitions }: { orderId: string; allowedTransitions: OrderStatus[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (allowedTransitions.length === 0) return null;

  function handleTransition(toStatus: OrderStatus) {
    setError(null);
    startTransition(async () => {
      const result = await transitionOrderStatusAction({ orderId, toStatus });
      if (!result.ok) {
        setError(result.error);
        return;
      }
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
      {error && (
        <p role="alert" className="text-base text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}
