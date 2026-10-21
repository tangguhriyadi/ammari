import { PAYMENT_NOTIFICATION_MAX_BYTES, handlePaymentNotification, logRefusedNotificationBody } from "@ammari/commerce/payments";
import { getCartClientIp } from "@/lib/cart/ip";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { defaultDb } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments/runtime";
import { revalidateProductPages } from "@/lib/payments/revalidate";

// The payment gateway's HTTP notification (docs/plans/cart-checkout.md §6.1):
// `POST /api/payments/midtrans/notification`, registered in the Midtrans dashboard and sent per
// transaction as X-Override-Notification (MIDTRANS_NOTIFICATION_URL, D8). Authenticated by the
// SHA-512 signature only (no session, no CSRF token: a server-to-server call), and "paid" is set
// only after the attempt's status is re-fetched from the gateway (@ammari/commerce/payments
// handlePaymentNotification). Deliberately NOT behind STOREFRONT_CART_ENABLED (plan §14, owner
// decision 2026-10-21): after a rollback of the flag, orders already placed must still be paid
// or expired. Without Midtrans configured it answers 503 and logs, so the gateway retries.
//
// Never cached; the body is read up to 32 KB (larger bodies are refused before parsing, and still
// leave a row). Rows for notifications that do not verify are capped per IP, so forged posts cannot
// grow the table. The answer body never says why (Midtrans only reads the status code; the reason is
// in our logs).

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function answer(status: number, text: string): Response {
  return new Response(text, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
}

/** Rows for unverified notifications per IP (`payment_notification_unverified`): 30 per 10
 * minutes. Midtrans' own notifications verify, so they never count. */
const UNVERIFIED_ROW_WINDOW_SECONDS = 600;
const UNVERIFIED_ROW_LIMIT = 30;

type BodyRead = { ok: true; text: string } | { ok: false; reason: "too_large" | "unreadable"; bytesRead: number; declaredBytes: number | null };

/** The body as text, refused when it is larger than the cap (read incrementally, so a huge body is
 * never buffered whole). */
async function readCappedBody(request: Request): Promise<BodyRead> {
  const header = request.headers.get("content-length");
  const declared = header === null ? null : Number(header);
  const declaredBytes = declared !== null && Number.isFinite(declared) ? declared : null;
  if (declaredBytes !== null && declaredBytes > PAYMENT_NOTIFICATION_MAX_BYTES) return { ok: false, reason: "too_large", bytesRead: 0, declaredBytes };
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PAYMENT_NOTIFICATION_MAX_BYTES) {
        await reader.cancel();
        return { ok: false, reason: "too_large", bytesRead: size, declaredBytes };
      }
      chunks.push(value);
    }
  } catch (error) {
    console.warn("[payments] notification body could not be read", { error: error instanceof Error ? error.name : typeof error, bytesRead: size });
    return { ok: false, reason: "unreadable", bytesRead: size, declaredBytes };
  }
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)) };
}

function errorFields(error: unknown): Record<string, unknown> {
  const cause = (error instanceof Error ? (error.cause ?? error) : {}) as { code?: unknown };
  return { error: error instanceof Error ? error.name : typeof error, code: cause.code };
}

export async function POST(request: Request): Promise<Response> {
  const body = await readCappedBody(request);
  try {
    if (!body.ok) {
      console.warn("[payments] notification body refused before parsing", { reason: body.reason, bytesRead: body.bytesRead, declaredBytes: body.declaredBytes });
      await logRefusedNotificationBody(defaultDb, body);
      return answer(400, "refused");
    }

    const handled = await handlePaymentNotification(defaultDb, getPaymentProvider(), body.text, {
      admitUnverifiedRow: async () => {
        const ip = await getCartClientIp("payment notification");
        if (!ip) return false;
        return (await recordClaimAttemptAndCount(defaultDb, ip, "payment_notification_unverified", UNVERIFIED_ROW_WINDOW_SECONDS)) <= UNVERIFIED_ROW_LIMIT;
      },
    });
    revalidateProductPages(handled.productSlugs, { orderNo: handled.orderNo });
    return answer(handled.httpStatus, handled.httpStatus === 200 ? "ok" : "refused");
  } catch (error) {
    // Only when even the log row could not be written (database down): 503 so it is retried.
    console.error("[payments] notification could not be logged; answered 503 so it is retried", {
      ...errorFields(error),
      bytes: body.ok ? Buffer.byteLength(body.text, "utf8") : body.bytesRead,
    });
    return answer(503, "retry");
  }
}
