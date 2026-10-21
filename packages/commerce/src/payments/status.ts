import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { NotificationSignatureFields, PaymentStatusReport } from "./provider";

// Midtrans transaction status bodies and notification signatures (docs/plans/cart-checkout.md D6,
// §6.1). Read from the public docs 2026-10-21:
// - https://docs.midtrans.com/docs/https-notification-webhooks : the notification is a JSON POST
//   with `transaction_status`, `status_code`, `order_id`, `gross_amount` (a string with two
//   decimals, "20000.00"), `transaction_id`, `payment_type`, `fraud_status`, `currency`,
//   `signature_key`, times in GMT+7. `signature_key = SHA512(order_id + status_code + gross_amount
//   + server key)`, hex, over the strings exactly as sent.
// - https://docs.midtrans.com/reference/get-transaction-status : `GET /v2/{order_id}/status`
//   answers the same fields (plus `refund_amount`, `refunds`); an unknown order answers
//   `status_code` "404" "Transaction doesn't exist.".
// - https://docs.midtrans.com/reference/transaction-status : authorize, capture, settlement, deny,
//   pending, cancel, refund, partial_refund, chargeback, partial_chargeback, expire, failure.
// No server-only import: the e2e fake signs its notifications with the same helper.

/** Every `transaction_status` Midtrans documents. `capture` and `authorize` are card-only (cards
 * are never enabled, D16), so they are anomalies here. */
export const MIDTRANS_TRANSACTION_STATUSES = [
  "pending",
  "settlement",
  "capture",
  "authorize",
  "deny",
  "cancel",
  "expire",
  "failure",
  "refund",
  "partial_refund",
  "chargeback",
  "partial_chargeback",
] as const;
export type MidtransTransactionStatus = (typeof MIDTRANS_TRANSACTION_STATUSES)[number];

export function isKnownTransactionStatus(value: string): value is MidtransTransactionStatus {
  return (MIDTRANS_TRANSACTION_STATUSES as readonly string[]).includes(value);
}

/** `"259000.00"` / `"259000"` / `259000` -> 259000; anything with a non-zero fraction, a sign or
 * text -> null (never rounded: a fraction means the amounts do not match). */
export function parseWholeRupiah(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^([0-9]{1,15})(?:\.([0-9]{1,2}))?$/.exec(text);
  if (!match || (match[2] !== undefined && Number(match[2]) !== 0)) return null;
  return Number(match[1]);
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .pipe(z.string().max(max))
    .nullish()
    .transform((value) => (value ? value : null));

/** The fields a status body or a notification must carry. Everything else is ignored. */
const statusBody = z.object({
  order_id: text(64),
  transaction_status: text(40).transform((value) => value.toLowerCase()),
  status_code: optionalText(8),
  transaction_id: optionalText(100),
  payment_type: optionalText(40),
  gross_amount: z.union([z.string(), z.number()]).nullish(),
  currency: optionalText(8),
  fraud_status: optionalText(20),
  refund_amount: z.union([z.string(), z.number()]).nullish(),
  transaction_time: optionalText(40),
  settlement_time: optionalText(40),
  expiry_time: optionalText(40),
  va_numbers: z.array(z.object({ bank: optionalText(20) }).loose()).nullish(),
  issuer: optionalText(40),
});

/** A status API body (or the fake's) as a PaymentStatusReport, or null when it lacks the
 * documented shape. */
export function parsePaymentStatusBody(json: unknown): PaymentStatusReport | null {
  const parsed = statusBody.safeParse(json);
  if (!parsed.success) return null;
  const body = parsed.data;
  const bank = body.va_numbers?.[0]?.bank ?? null;
  return {
    providerOrderId: body.order_id,
    transactionStatus: body.transaction_status,
    transactionId: body.transaction_id,
    paymentType: body.payment_type,
    grossAmount: parseWholeRupiah(body.gross_amount),
    currency: body.currency,
    fraudStatus: body.fraud_status,
    refundAmount: body.refund_amount === undefined || body.refund_amount === null ? null : parseWholeRupiah(body.refund_amount),
    // Allowlisted for payments.last_status: what staff need to read a payment, nothing secret (no
    // signature, no VA number, no buyer data).
    snapshot: {
      transaction_status: body.transaction_status,
      status_code: body.status_code,
      transaction_id: body.transaction_id,
      payment_type: body.payment_type,
      bank,
      issuer: body.issuer,
      gross_amount: body.gross_amount === undefined || body.gross_amount === null ? null : String(body.gross_amount),
      currency: body.currency,
      fraud_status: body.fraud_status,
      transaction_time: body.transaction_time,
      settlement_time: body.settlement_time,
      expiry_time: body.expiry_time,
    },
  };
}

/** The `signature_key` Midtrans puts on a notification (lower-case hex SHA-512). */
export function midtransSignature(fields: Omit<NotificationSignatureFields, "signatureKey">, serverKey: string): string {
  return createHash("sha512").update(`${fields.orderId}${fields.statusCode}${fields.grossAmount}${serverKey}`, "utf8").digest("hex");
}

/** Constant-time comparison of the received `signature_key` with the expected one. A key of the
 * wrong length or with non-hex characters is simply false. */
export function verifyMidtransSignature(fields: NotificationSignatureFields, serverKey: string): boolean {
  if (serverKey.length === 0) return false;
  const received = fields.signatureKey.trim().toLowerCase();
  if (!/^[0-9a-f]{128}$/.test(received)) return false;
  const expected = Buffer.from(midtransSignature(fields, serverKey), "hex");
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}
