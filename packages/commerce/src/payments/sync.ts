import "server-only";
import { desc, eq } from "drizzle-orm";
import { orders, payments } from "@ammari/db/schema";
import type { Database } from "../db";
import { applyPaymentStatus, type ApplyResult } from "./apply-status";
import { PAYMENT_STATUS_TIMEOUT_MS, PaymentProviderError, type PaymentProvider } from "./provider";

// The finish page's one server-side status check (docs/plans/cart-checkout.md §4.4): for an order
// still awaiting payment, the latest attempt's status is fetched from the gateway (server to
// server, an authenticated status poll in CLAUDE.md's terms) and fed to the same state machine as
// a notification. It catches a notification that is late or lost. A browser redirect or query
// string never feeds it.

export type SyncPaymentResult =
  | { checked: false; reason: "not_pending" | "no_page" | "not_found" | "unavailable" | "not_admitted" }
  | { checked: true; applied: ApplyResult };

export async function syncLatestPaymentStatus(
  db: Database,
  provider: PaymentProvider,
  orderId: string,
  options: { timeoutMs?: number; admit?: () => Promise<boolean> } = {},
): Promise<SyncPaymentResult> {
  const [order] = await db.select({ status: orders.status, paymentStatus: orders.paymentStatus, orderNo: orders.orderNo }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order || order.status !== "awaiting_payment" || order.paymentStatus !== "pending") return { checked: false, reason: "not_pending" };

  const [latest] = await db
    .select({ providerOrderId: payments.providerOrderId, snapToken: payments.snapToken })
    .from(payments)
    .where(eq(payments.orderId, orderId))
    .orderBy(desc(payments.attempt))
    .limit(1);
  // Without a page the gateway has no transaction to report on.
  if (!latest?.snapToken) return { checked: false, reason: "no_page" };

  // The caller's rate limit counts only checks that really ask the gateway.
  if (options.admit && !(await options.admit())) return { checked: false, reason: "not_admitted" };

  let report;
  try {
    report = await provider.getPaymentStatus(latest.providerOrderId, { signal: AbortSignal.timeout(options.timeoutMs ?? PAYMENT_STATUS_TIMEOUT_MS) });
  } catch (error) {
    console.warn("[payments] finish page status check failed", { orderNo: order.orderNo, ...(error instanceof PaymentProviderError ? error.logFields() : { error: error instanceof Error ? error.name : typeof error }) });
    return { checked: false, reason: "unavailable" };
  }
  // The buyer has not picked a method yet.
  if (!report) return { checked: false, reason: "not_found" };
  const applied = await applyPaymentStatus(db, report);
  if (!applied) return { checked: false, reason: "not_found" };
  if (applied.outcome !== "unchanged") console.info("[payments] finish page status check applied", { orderNo: applied.orderNo, outcome: applied.outcome });
  return { checked: true, applied };
}
