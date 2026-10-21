"use client";

import { useEffect, useState } from "react";
import { PendingOrderBanner, type PendingOrderBannerProps } from "@/components/checkout/pending-order-banner";

type PendingOrder = PendingOrderBannerProps & { productIds: string[] };

function isPendingOrder(value: unknown): value is PendingOrder {
  if (typeof value !== "object" || value === null) return false;
  const order = value as Record<string, unknown>;
  return (
    typeof order.orderNo === "string" &&
    typeof order.payBy === "string" &&
    (order.paymentUrl === null || (typeof order.paymentUrl === "string" && /^https?:\/\//i.test(order.paymentUrl))) &&
    Array.isArray(order.productIds) &&
    order.productIds.every((id) => typeof id === "string")
  );
}

/** The product page's reminder of the visitor's own order waiting for payment, when this product
 * is in it (2026-10-21 sandbox run: the product looked sold out because its stock was held for that
 * order). Fetched after load (the page is ISR-cached and shared); nothing shows when there is no
 * such order or the read fails. */
export function PendingOrderNotice({ productId }: { productId: string }) {
  const [order, setOrder] = useState<PendingOrder | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/checkout/pending-order", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (response.ok) return response.json();
        // 404 is the flag being off; anything else is worth a line.
        if (response.status !== 404) console.warn("[checkout] pending order check answered", response.status);
        return null;
      })
      .then((body: unknown) => {
        const candidate = typeof body === "object" && body !== null ? (body as { order?: unknown }).order : null;
        setOrder(isPendingOrder(candidate) && candidate.productIds.includes(productId) ? candidate : null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("[checkout] pending order check failed", error instanceof Error ? error.name : typeof error);
      });
    return () => controller.abort();
  }, [productId]);

  if (!order) return null;
  return <PendingOrderBanner orderNo={order.orderNo} payBy={order.payBy} paymentUrl={order.paymentUrl} />;
}
