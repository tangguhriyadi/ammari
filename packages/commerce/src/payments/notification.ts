import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { paymentNotifications, payments } from "@ammari/db/schema";
import type { Database } from "../db";
import { applyPaymentStatus, type ApplyOutcome } from "./apply-status";
import { PAYMENT_STATUS_TIMEOUT_MS, PaymentProviderError, type PaymentProvider } from "./provider";

// The payment notification (docs/plans/cart-checkout.md §6.1, D6). Every notification is written
// to `payment_notifications` first, so none is ever lost, even when the rest fails. Then:
// signature (SHA-512 with the server key, constant time) -> the attempt by provider order id ->
// the attempt's status fetched from the gateway server to server -> the one state machine
// (./apply-status.ts). The notification body itself never decides anything; it only says which
// attempt to look at, so a replayed, duplicated or out-of-order notification just re-reads the
// current status.
//
// HTTP answers, by Midtrans' documented retry policy (https-notification-webhooks: 2xx no retry,
// 500 one retry, 503 four retries, 400/404 two, other failures up to five, over about 6 hours):
// 200 when handled (also for an attempt this environment does not know), 403 for a bad signature,
// 400 for a body that is not a notification, and 503 whenever it could not be handled yet (status
// fetch failed, database error, provider not configured), so the gateway keeps retrying. The
// expiry sweep (session 12) and the finish page's status check cover anything that still slips.

/** The route's body cap (plan §6.1). */
export const PAYMENT_NOTIFICATION_MAX_BYTES = 32 * 1024;

export type NotificationResult =
  | ApplyOutcome
  | "malformed"
  | "too_large"
  | "bad_signature"
  | "not_configured"
  | "unknown_order"
  | "status_unavailable"
  | "status_not_found"
  | "error";

export interface NotificationHandled {
  httpStatus: 200 | 400 | 403 | 503;
  result: NotificationResult;
  orderNo: string | null;
  productSlugs: string[];
}

// Checked exactly as sent (no trimming): the signature is computed over these strings, so a value
// that is not in the documented shape is refused rather than normalized into one that verifies.
const signedFields = z.object({
  order_id: z.string().regex(/^[A-Za-z0-9._~-]{1,64}$/),
  status_code: z.string().regex(/^[0-9]{3}$/),
  gross_amount: z.string().regex(/^[0-9]{1,15}(\.[0-9]{1,2})?$/),
  signature_key: z.string().regex(/^[0-9A-Fa-f]{128}$/),
  transaction_status: z.string().max(40).optional(),
});

/** What is kept of a notification that did not verify: the identifying fields only, so a flood of
 * forged bodies cannot fill the table with arbitrary JSON. */
function unverifiedPayload(body: Record<string, unknown>): Record<string, unknown> {
  const pick = (key: string) => {
    const value = body[key];
    return typeof value === "string" ? value.slice(0, 64) : null;
  };
  return { order_id: pick("order_id"), transaction_status: pick("transaction_status"), status_code: pick("status_code"), gross_amount: pick("gross_amount") };
}

/** A verified notification as stored: everything Midtrans sent except the signature (plan §10: no
 * signatures in logs). */
function verifiedPayload(body: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...body };
  delete rest.signature_key;
  return rest;
}

async function logNotification(
  db: Database,
  row: { providerOrderId: string | null; transactionStatus: string | null; statusCode: string | null; signatureValid: boolean; payload: unknown; result: NotificationResult | null },
): Promise<string> {
  const [inserted] = await db
    .insert(paymentNotifications)
    .values({ ...row, processedAt: row.result === null ? null : sql`now()` })
    .returning({ id: paymentNotifications.id });
  if (!inserted) throw new Error("payment notification was not logged");
  return inserted.id;
}

async function finish(db: Database, logId: string, result: NotificationResult): Promise<void> {
  await db.update(paymentNotifications).set({ result, processedAt: sql`now()` }).where(eq(paymentNotifications.id, logId));
}

/** Database errors log their name and Postgres code only (a query's text carries its values). */
function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof PaymentProviderError) return error.logFields();
  if (!(error instanceof Error)) return { error: typeof error };
  const cause = (error.cause ?? error) as { code?: unknown };
  return { error: error.name, code: cause.code };
}

/** Handles one raw notification body (already capped by the route). `provider` is null when the
 * payment provider is not configured: the notification is still logged and answered 503. Throws
 * only when even the log row cannot be written (the route answers 503). */
export async function handlePaymentNotification(
  db: Database,
  provider: PaymentProvider | null,
  rawBody: string,
  options: {
    statusTimeoutMs?: number;
    /** The route's per-IP cap on rows for notifications that did not verify (malformed or a bad
     * signature): above it they are only logged to the console, so a flood of forged posts cannot
     * grow the table. Verified notifications are always written. */
    admitUnverifiedRow?: () => Promise<boolean>;
  } = {},
): Promise<NotificationHandled> {
  const answer = (httpStatus: NotificationHandled["httpStatus"], result: NotificationResult, orderNo: string | null = null, productSlugs: string[] = []): NotificationHandled => ({
    httpStatus,
    result,
    orderNo,
    productSlugs,
  });

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = null;
  }
  const object = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const fields = object ? signedFields.safeParse(object) : null;
  const mayLogUnverified = async () => (options.admitUnverifiedRow ? options.admitUnverifiedRow() : true);

  if (!object || !fields?.success) {
    const unverified = object ? unverifiedPayload(object) : null;
    if (await mayLogUnverified()) await logNotification(db, {
      providerOrderId: typeof unverified?.order_id === "string" ? unverified.order_id : null,
      transactionStatus: null,
      statusCode: null,
      signatureValid: false,
      payload: unverified ?? { unparsable: true, bytes: Buffer.byteLength(rawBody, "utf8") },
      result: "malformed",
    });
    console.warn("[payments] notification without the signed fields refused");
    return answer(400, "malformed");
  }
  const signed = fields.data;
  const identity = { providerOrderId: signed.order_id, transactionStatus: signed.transaction_status ?? null, statusCode: signed.status_code };

  if (!provider) {
    await logNotification(db, { ...identity, signatureValid: false, payload: unverifiedPayload(object), result: "not_configured" });
    console.error("[payments] notification received but the payment provider is not configured; answered 503 so it is retried", { providerOrderId: signed.order_id });
    return answer(503, "not_configured");
  }

  const signatureValid = provider.verifyNotificationSignature({
    orderId: signed.order_id,
    statusCode: signed.status_code,
    grossAmount: signed.gross_amount,
    signatureKey: signed.signature_key,
  });
  if (!signatureValid) {
    if (await mayLogUnverified()) await logNotification(db, { ...identity, signatureValid: false, payload: unverifiedPayload(object), result: "bad_signature" });
    // Loud: one of these is a forgery, but a steady stream of them means MIDTRANS_SERVER_KEY does
    // not match the account sending the notifications (every real payment would be refused).
    console.error("[payments] notification with a bad signature refused (forged, or MIDTRANS_SERVER_KEY does not match the sending account)", {
      providerOrderId: signed.order_id,
    });
    return answer(403, "bad_signature");
  }

  const logId = await logNotification(db, { ...identity, signatureValid: true, payload: verifiedPayload(object), result: null });

  try {
    const [attempt] = await db.select({ id: payments.id }).from(payments).where(eq(payments.providerOrderId, signed.order_id)).limit(1);
    if (!attempt) {
      // Another environment's attempt on the shared Sandbox account, or a stale test: nothing to do.
      await finish(db, logId, "unknown_order");
      console.info("[payments] notification for an unknown attempt", { providerOrderId: signed.order_id });
      return answer(200, "unknown_order");
    }

    let report;
    try {
      report = await provider.getPaymentStatus(signed.order_id, { signal: AbortSignal.timeout(options.statusTimeoutMs ?? PAYMENT_STATUS_TIMEOUT_MS) });
    } catch (error) {
      await finish(db, logId, "status_unavailable");
      console.error("[payments] status fetch for a notification failed; answered 503 so it is retried", { providerOrderId: signed.order_id, ...errorFields(error) });
      return answer(503, "status_unavailable");
    }
    if (!report) {
      // A verified notification for a transaction the status API does not know (yet): retried.
      await finish(db, logId, "status_not_found");
      console.error("[payments] status API does not know a notified attempt; answered 503 so it is retried", { providerOrderId: signed.order_id });
      return answer(503, "status_not_found");
    }

    const applied = await applyPaymentStatus(db, report);
    if (!applied) {
      await finish(db, logId, "unknown_order");
      return answer(200, "unknown_order");
    }
    // Committed: from here on the answer is 200 with the real outcome, even if recording the result
    // fails (a 503 would only bring back a retry that finds nothing to do and nothing to revalidate).
    if (applied.outcome !== "unchanged") console.info("[payments] notification applied", { orderNo: applied.orderNo, outcome: applied.outcome });
    try {
      await finish(db, logId, applied.outcome);
    } catch (error) {
      console.error("[payments] notification applied but its result was not recorded", { orderNo: applied.orderNo, outcome: applied.outcome, ...errorFields(error) });
    }
    return answer(200, applied.outcome, applied.orderNo, applied.productSlugs);
  } catch (error) {
    console.error("[payments] notification could not be applied; answered 503 so it is retried", { providerOrderId: signed.order_id, ...errorFields(error) });
    try {
      await finish(db, logId, "error");
    } catch (logError) {
      console.error("[payments] notification result could not be recorded", { providerOrderId: signed.order_id, ...errorFields(logError) });
    }
    return answer(503, "error");
  }
}

/** A body over PAYMENT_NOTIFICATION_MAX_BYTES (or one that could not be read) is never parsed, but
 * it is still logged, so no notification leaves no trace. Throws when the log row cannot be
 * written. */
export async function logRefusedNotificationBody(db: Database, details: { bytesRead: number; declaredBytes: number | null; reason: "too_large" | "unreadable" }): Promise<void> {
  await logNotification(db, {
    providerOrderId: null,
    transactionStatus: null,
    statusCode: null,
    signatureValid: false,
    payload: { refused: details.reason, bytesRead: details.bytesRead, declaredBytes: details.declaredBytes },
    result: details.reason === "too_large" ? "too_large" : "malformed",
  });
}
