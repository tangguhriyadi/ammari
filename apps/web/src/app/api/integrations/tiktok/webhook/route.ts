import { after } from "next/server";
import { errorLogFields } from "@ammari/commerce/errors";
import {
  TIKTOK_WEBHOOK_MAX_BODY_BYTES,
  TIKTOK_WEBHOOK_TOPICS,
  drainTikTokWebhookOrderEvent,
  parseTikTokWebhookBody,
  processDueTikTokConnectionEvents,
  processTikTokWebhookEvent,
  recordTikTokWebhookEvent,
  tiktokRuntimeFromEnv,
  touchTikTokLastWebhook,
  type ProcessTikTokWebhookResult,
  type RecordTikTokWebhookResult,
  type TikTokRuntime,
} from "@ammari/commerce/tiktok";
import { verifyWebhookSignature } from "@ammari/tiktok-shop";
import { defaultDb } from "@/lib/db";
import { readCappedBody } from "@/lib/http/capped-body";

// The TikTok Shop webhook (docs/plans/tiktok-shop-integration.md §2, §3.2, §4.1 step 1, §8.1; T3):
// `POST https://ammari.id/api/integrations/tiktok/webhook`, registered once per app in Partner
// Center > Kelola Webhook (Q5). TikTok signs every post: `Authorization` = lowercase hex
// HMAC-SHA256(key app_secret, app_key + raw body), checked over the exact bytes received. It
// retries a non-200 at +2 m, +30 m, +3 h and +12 h, then drops the event; the reconciliation poll
// (T4) is the backstop for everything. TikTok wants 200 with an empty body within 3 seconds, so the
// request only verifies and enqueues: no TikTok API call, no order or connection write.
//
// Answers, every one with an empty body:
// - 200: verified and stored, or a duplicate `tts_notification_id` (at-least-once delivery), or a
//   verified body that cannot be stored (malformed JSON or no notification/shop id; logged, left to
//   the poll).
// - 401: the signature is missing or wrong, or the shop is not ours. Nothing stored.
// - 400: the body did not arrive whole within 2 s (slow or broken sender). Nothing stored.
// - 413: body over 64 KB (checked before the signature, never buffered whole). Nothing stored.
// - 415: not `application/json`. Nothing read.
// - 503: the integration is not configured, the database failed, or it did not answer within the
//   budget. TikTok retries.
// After a stored delivery (`after()`): topics 6/7 go to T2's connection writes, any earlier 6/7
// event still pending is retried, and "last webhook" is set. A duplicate runs that retry too, so
// TikTok's redelivery of an event whose processing was lost (restart, or an insert that committed
// after a 503) applies it. Orders (1, 11, 12): the one order the event names is re-fetched from
// TikTok and stored as a snapshot (T4, read only; the body itself is never trusted). Anything not
// drained here is drained by the sync cron.
//
// One `[tiktok] webhook` log line per post: the result and short codes only. Never the
// `Authorization` header, the app key or secret, or the body.
// Caddy routes this path on the public host (only /api/internal/*, /api/test/* and /api/revalidate
// are refused there); on dev, Cloudflare Access needs a bypass for it (plan §7.5). Never cached.

export const dynamic = "force-dynamic";

/** The database part must finish inside this much of the request's life; TikTok's limit is 3 s. */
const TIKTOK_WEBHOOK_BUDGET_MS = 2_500;
/** The body must have arrived by then. */
const BODY_READ_TIMEOUT_MS = 2_000;

function reply(status: 200 | 400 | 401 | 413 | 415 | 503): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

type Result =
  | "stored"
  | "duplicate"
  | "not_configured"
  | "wrong_content_type"
  | "too_large"
  | "unreadable"
  | "bad_signature"
  | "unknown_shop"
  | "invalid_json"
  | "invalid_shape"
  | "db_failed"
  | "db_timeout";

interface LogFields {
  result: Result;
  contentType?: string | null;
  bytes?: number;
  type?: number;
  notificationId?: string;
  status?: string;
  payload?: string;
}

function log(fields: LogFields, error?: unknown): void {
  const line = { ...fields, ...(error === undefined ? {} : errorLogFields(error)) };
  if (fields.result === "stored" || fields.result === "duplicate") console.info("[tiktok] webhook", line);
  // A signed body we cannot use is TikTok's own and is lost for good (a deauthorization has no poll
  // to fall back on), so it is an error, like a database failure.
  else if (["not_configured", "db_failed", "db_timeout", "invalid_json", "invalid_shape"].includes(fields.result)) console.error("[tiktok] webhook", line);
  else console.warn("[tiktok] webhook", line);
}

/** The media type only, and only when it looks like one: the header is the caller's to set. */
function mediaType(headers: Headers): string | null {
  const value = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (value === "") return null;
  return /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(value) ? value : "other";
}

class BudgetExceeded extends Error {
  constructor() {
    super("tiktok webhook: database budget exceeded");
    this.name = "BudgetExceeded";
  }
}

async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetExceeded()), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let loggedConfigProblems: string | null = null;

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const contentType = mediaType(request.headers);

  const runtime = tiktokRuntimeFromEnv(process.env);
  if (!runtime.ok) {
    // Problems name variables, never values. Logged in full once per change, then the short line.
    const signature = runtime.problems.join("|");
    if (signature !== loggedConfigProblems) {
      console.error("[tiktok] webhook not configured; TikTok retries, the poll covers the rest", { problems: runtime.problems });
      loggedConfigProblems = signature;
    }
    log({ result: "not_configured", contentType });
    return reply(503);
  }
  loggedConfigProblems = null;

  if (contentType !== "application/json") {
    log({ result: "wrong_content_type", contentType });
    return reply(415);
  }

  const body = await readCappedBody(request, TIKTOK_WEBHOOK_MAX_BODY_BYTES, { timeoutMs: BODY_READ_TIMEOUT_MS });
  if (!body.ok) {
    log({ result: body.reason, contentType, bytes: body.bytesRead });
    return reply(body.reason === "too_large" ? 413 : 400);
  }

  const { config } = runtime.runtime;
  const verified = verifyWebhookSignature({
    appKey: config.appKey.reveal(),
    appSecret: config.appSecret.reveal(),
    rawBody: body.raw,
    authorization: request.headers.get("authorization"),
  });
  if (!verified) {
    log({ result: "bad_signature", contentType, bytes: body.bytes });
    return reply(401);
  }

  const parsed = parseTikTokWebhookBody(body.text);
  if (!parsed.ok) {
    // Signed by TikTok but unusable: a retry would bring the same bytes, so 200; the poll finds it.
    log({ result: parsed.reason, contentType, bytes: body.bytes });
    return reply(200);
  }
  const { event } = parsed;
  const base = { contentType, bytes: body.bytes, type: event.type, notificationId: event.ttsNotificationId, ...(event.payloadProblem ? { payload: event.payloadProblem } : {}) };

  let recorded: RecordTikTokWebhookResult;
  try {
    recorded = await withinBudget(recordTikTokWebhookEvent(defaultDb, event), TIKTOK_WEBHOOK_BUDGET_MS - (Date.now() - startedAt));
  } catch (error) {
    // Not stored (or not known to be): 503 and TikTok retries; a late commit is deduped then.
    log({ result: error instanceof BudgetExceeded ? "db_timeout" : "db_failed", ...base }, error);
    return reply(503);
  }

  if (recorded.kind === "unknown_shop") {
    log({ result: "unknown_shop", ...base });
    return reply(401);
  }
  const receivedAt = new Date();
  if (recorded.kind === "duplicate") {
    log({ result: "duplicate", ...base });
    after(() => afterDelivery(runtime.runtime, event.shopId, receivedAt, null));
    return reply(200);
  }

  log({ result: "stored", ...base, status: recorded.status });
  after(() => afterDelivery(runtime.runtime, event.shopId, receivedAt, { id: recorded.id, type: event.type }));
  return reply(200);
}

function reportOutcome(eventId: string | null, outcome: ProcessTikTokWebhookResult): void {
  const fields = { ...(eventId ? { eventId } : {}), ...outcome };
  if (outcome.kind === "retry_scheduled" || outcome.kind === "failed" || outcome.kind === "threw") console.error("[tiktok] webhook connection event not applied", fields);
  else if (outcome.kind === "processed" && outcome.stale) console.warn("[tiktok] webhook connection event older than the current authorization; not applied", fields);
  else if (outcome.kind === "processed") console.info("[tiktok] webhook connection event processed", fields);
}

/** Runs after the answer. Each step is isolated: one failing never skips the next. */
const ORDER_TOPICS: readonly number[] = [TIKTOK_WEBHOOK_TOPICS.ORDER_STATUS_CHANGE, TIKTOK_WEBHOOK_TOPICS.CANCELLATION_STATUS_CHANGE, TIKTOK_WEBHOOK_TOPICS.RETURN_STATUS_CHANGE];

async function afterDelivery(runtime: TikTokRuntime, shopId: string, receivedAt: Date, stored: { id: string; type: number } | null): Promise<void> {
  try {
    await touchTikTokLastWebhook(defaultDb, shopId, receivedAt);
  } catch (error) {
    console.error("[tiktok] webhook could not set the last-webhook time", errorLogFields(error));
  }
  if (stored && ORDER_TOPICS.includes(stored.type)) {
    // Read only: re-fetch and store this order. A failure leaves the event for the cron (retried
    // with backoff); codes only in the log.
    try {
      const outcome = await drainTikTokWebhookOrderEvent(defaultDb, { api: runtime.api, auth: runtime.auth, keyring: runtime.config.tokenKeyring }, stored.id);
      if (outcome.kind === "error") console.warn("[tiktok] webhook order refresh failed; the sync cron retries", { eventId: stored.id, ...outcome.error });
      else if (outcome.kind === "not_stored") console.warn("[tiktok] webhook order not stored; retried with backoff", { eventId: stored.id, problems: outcome.problems });
      else if (outcome.kind !== "processed") console.info("[tiktok] webhook order refresh left to the sync cron", { eventId: stored.id, reason: outcome.kind });
    } catch (error) {
      console.error("[tiktok] webhook order refresh failed; the sync cron retries", { eventId: stored.id, type: stored.type, ...errorLogFields(error) });
    }
  } else if (stored) {
    // Topics 6/7: applied to the connection now.
    try {
      reportOutcome(stored.id, await processTikTokWebhookEvent(defaultDb, stored.id));
    } catch (error) {
      console.error("[tiktok] webhook processing failed; the event stays pending", { eventId: stored.id, type: stored.type, ...errorLogFields(error) });
    }
  }
  // Any topic 6/7 event whose processing was lost or whose retry is due.
  try {
    const earlier = await processDueTikTokConnectionEvents(defaultDb);
    for (const outcome of earlier ?? []) if (outcome.kind !== "not_pending") reportOutcome(null, outcome);
  } catch (error) {
    console.error("[tiktok] webhook could not retry pending connection events", errorLogFields(error));
  }
}
