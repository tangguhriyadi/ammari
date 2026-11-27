import "server-only";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { tiktokShopConnections, tiktokWebhookEvents, TIKTOK_WEBHOOK_PAYLOAD_MAX_BYTES } from "@ammari/db/schema";
import { applyAllowlist, type AllowlistSpec, type AllowlistedObject } from "@ammari/tiktok-shop";
import type { Database } from "../db";
import { deauthorizeTikTokShop, recordTikTokExpiryWarning, tiktokEventConnectedBefore } from "./connection";

// The TikTok webhook inbox (docs/plans/tiktok-shop-integration.md §3.2, §4.1 step 1, §6, §8.1; T3).
// apps/web's `/api/integrations/tiktok/webhook` verifies the signature, then calls
// `recordTikTokWebhookEvent`: one statement that checks the shop is ours and inserts the event
// deduped on `tts_notification_id` (`INSERT ... ON CONFLICT DO NOTHING`), never a check followed by
// a separate write. No TikTok API call and no connection or order write happens in the request.
// After the answer (`after()`), `processTikTokWebhookEvent` applies topics 6 and 7 to the
// connection (T2's write paths); order, cancellation and return topics (1, 11, 12) stay `pending`
// for the sync (T4-T6). Topic 3 and unknown topics are stored `ignored` (§6: we hold no address).
// Nothing here logs; the route logs codes only, never a body.

export const TIKTOK_WEBHOOK_TOPICS = {
  ORDER_STATUS_CHANGE: 1,
  RECIPIENT_ADDRESS_UPDATE: 3,
  SELLER_DEAUTHORIZATION: 6,
  UPCOMING_AUTHORIZATION_EXPIRATION: 7,
  CANCELLATION_STATUS_CHANGE: 11,
  RETURN_STATUS_CHANGE: 12,
} as const;

/** Topics the sync processes later (T4-T6); stored `pending`. */
const ORDER_TOPICS: readonly number[] = [
  TIKTOK_WEBHOOK_TOPICS.ORDER_STATUS_CHANGE,
  TIKTOK_WEBHOOK_TOPICS.CANCELLATION_STATUS_CHANGE,
  TIKTOK_WEBHOOK_TOPICS.RETURN_STATUS_CHANGE,
];
/** Topics applied to the connection right after the answer; stored `pending` until then. */
const CONNECTION_TOPICS: readonly number[] = [TIKTOK_WEBHOOK_TOPICS.SELLER_DEAUTHORIZATION, TIKTOK_WEBHOOK_TOPICS.UPCOMING_AUTHORIZATION_EXPIRATION];

/** Plan §8.1: the request body is read up to 64 KB. */
export const TIKTOK_WEBHOOK_MAX_BODY_BYTES = 65_536;
/** After 10 attempts an event is `failed` (plan §3.2; the DB CHECK caps attempts at 10). */
export const TIKTOK_WEBHOOK_MAX_ATTEMPTS = 10;

/** Plan §6: the inbox keeps ids, statuses and times only. No buyer field (name, address, phone,
 * email, user id, buyer message) is on the list, so none can be stored, including fields TikTok
 * adds later. T5/T6 extend `data` when they need another field. */
export const TIKTOK_WEBHOOK_ALLOWLIST: AllowlistSpec = {
  type: true,
  tts_notification_id: true,
  shop_id: true,
  timestamp: true,
  data: {
    order_id: true,
    order_status: true,
    is_on_hold_order: true,
    update_time: true,
    cancel_id: true,
    cancel_status: true,
    return_id: true,
    return_status: true,
    return_type: true,
  },
};

// jsonb's text form adds at most two bytes (", " and ": ") per key or element, and each needs at
// least two bytes of its own, so half the column's cap fits its CHECK, given every number is a safe
// integer (jsonb writes 1e300 out as 301 digits; isStorable refuses such a number).
const PAYLOAD_JSON_MAX_BYTES = TIKTOK_WEBHOOK_PAYLOAD_MAX_BYTES / 2;
const ID_MAX_LENGTH = 128;

export interface TikTokWebhookEvent {
  type: number;
  ttsNotificationId: string;
  shopId: string;
  tiktokOrderId: string | null;
  timestampS: number | null;
  /** The allowlisted body, or null when even that is over the inbox cap. */
  payload: AllowlistedObject | null;
  /** Set when the payload was dropped: a short code, never content. */
  payloadProblem: "payload_too_large" | "payload_unstorable" | null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** What Postgres jsonb and the size bound above accept: no NUL, no lone surrogate (jsonb refuses
 * both), and numbers only as safe integers or short decimals. */
function isStorable(value: unknown): boolean {
  if (typeof value === "string") return !value.includes("\u0000") && !LONE_SURROGATE.test(value);
  if (typeof value === "number") return Number.isSafeInteger(value) || (Number.isFinite(value) && Math.abs(value) < 1e15 && String(value).length <= 24);
  if (Array.isArray(value)) return value.every(isStorable);
  if (isRecord(value)) return Object.values(value).every(isStorable);
  return true;
}

export type ParseTikTokWebhookResult = { ok: true; event: TikTokWebhookEvent } | { ok: false; reason: "invalid_json" | "invalid_shape" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= ID_MAX_LENGTH && /^[\x21-\x7e]+$/.test(value) ? value : null;
}

/** Parses a verified body. Only a body with a topic number, a notification id and a shop id can be
 * stored (the dedupe key and the shop check need them); anything else is refused, and the
 * reconciliation poll still finds the order (§8.1 "malformed JSON with a valid signature"). */
export function parseTikTokWebhookBody(text: string): ParseTikTokWebhookResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isRecord(body)) return { ok: false, reason: "invalid_shape" };
  const { type, tts_notification_id: notificationId, shop_id: shopId, timestamp, data } = body;
  if (typeof type !== "number" || !Number.isInteger(type) || type < 0 || type > 32_767) return { ok: false, reason: "invalid_shape" };
  const ttsNotificationId = boundedId(notificationId);
  const shop = boundedId(shopId);
  if (!ttsNotificationId || !shop) return { ok: false, reason: "invalid_shape" };
  const timestampS = typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
  const tiktokOrderId = isRecord(data) ? boundedId(data.order_id) : null;

  const allowlisted = applyAllowlist(body, TIKTOK_WEBHOOK_ALLOWLIST);
  const json = JSON.stringify(allowlisted);
  let payload: AllowlistedObject | null = allowlisted;
  let payloadProblem: TikTokWebhookEvent["payloadProblem"] = null;
  if (Buffer.byteLength(json, "utf8") > PAYLOAD_JSON_MAX_BYTES) {
    payload = null;
    payloadProblem = "payload_too_large";
  } else if (!isStorable(allowlisted)) {
    // Postgres jsonb would refuse it (or blow the size cap); the event itself is still stored.
    payload = null;
    payloadProblem = "payload_unstorable";
  }
  return { ok: true, event: { type, ttsNotificationId, shopId: shop, tiktokOrderId, timestampS, payload, payloadProblem } };
}

/** `pending` for the topics something acts on, `ignored` for topic 3 and unknown topics. */
export function tiktokWebhookInitialStatus(type: number): "pending" | "ignored" {
  return ORDER_TOPICS.includes(type) || CONNECTION_TOPICS.includes(type) ? "pending" : "ignored";
}

export type RecordTikTokWebhookResult =
  | { kind: "stored"; id: string; status: "pending" | "ignored" }
  /** The same `tts_notification_id` again (TikTok delivers at least once): nothing written. */
  | { kind: "duplicate" }
  /** No connection, in any status, has this shop id: nothing written (the route answers 401). */
  | { kind: "unknown_shop" };

/** One statement: the shop check and the deduped insert. A shop is ours when a connection row has
 * its id, whatever its status (a late event for a deauthorized shop is stored, not refused, and
 * acts on nothing). */
export async function recordTikTokWebhookEvent(db: Database, event: TikTokWebhookEvent): Promise<RecordTikTokWebhookResult> {
  const status = tiktokWebhookInitialStatus(event.type);
  const rows = await db.execute<{ known_shop: boolean; id: string | null; status: "pending" | "ignored" | null }>(sql`
    with shop as (
      select 1 from tiktok_shop_connections where shop_id = ${event.shopId} limit 1
    ), inserted as (
      insert into tiktok_webhook_events (tts_notification_id, type, shop_id, tiktok_order_id, timestamp_s, payload, status, processed_at, last_error_code)
      select ${event.ttsNotificationId}, ${event.type}, ${event.shopId}, ${event.tiktokOrderId}, ${event.timestampS},
             ${event.payload === null ? null : JSON.stringify(event.payload)}::jsonb, ${status},
             ${status === "ignored" ? sql`now()` : sql`null`}, ${event.payloadProblem}
      where exists (select 1 from shop)
      on conflict (tts_notification_id) do nothing
      returning id, status
    )
    select exists (select 1 from shop) as known_shop, (select id from inserted) as id, (select status from inserted) as status
  `);
  const row = rows[0];
  if (!row?.known_shop) return { kind: "unknown_shop" };
  if (!row.id || !row.status) return { kind: "duplicate" };
  return { kind: "stored", id: row.id, status: row.status };
}

/** "Last webhook" on the Integrasi page. Best effort: a row held by a token refresh (which keeps it
 * locked during its TikTok call) is skipped rather than waited for; the next delivery sets it. */
export async function touchTikTokLastWebhook(db: Database, shopId: string, at: Date): Promise<void> {
  const time = at.toISOString();
  await db.execute(sql`
    update tiktok_shop_connections set last_webhook_at = ${time}::timestamptz
    where id in (
      select id from tiktok_shop_connections
      where shop_id = ${shopId} and (last_webhook_at is null or last_webhook_at < ${time}::timestamptz)
      for update skip locked
    )
  `);
}

export type ProcessTikTokWebhookResult =
  /** Topic 6 or 7 applied (or a no-op: already applied or the shop is gone); the row is
   * `processed`. `stale`: not applied because the shop was reconnected after the event (logged). */
  | { kind: "processed"; changed: boolean; stale?: true }
  /** Topics 1, 11, 12: left `pending` for the sync (T4-T6). */
  | { kind: "awaiting_sync" }
  /** Not pending any more (processed by someone else, ignored or failed), or gone. */
  | { kind: "not_pending" }
  /** Recording the failure itself threw (database down); the event stays as it was. */
  | { kind: "threw"; errorCode: string }
  /** The connection write threw: attempts + 1 and a later retry, or `failed` after the last one. */
  | { kind: "retry_scheduled"; attempts: number; errorCode: string }
  | { kind: "failed"; attempts: number; errorCode: string };

/** Backoff between attempts: 1, 2, 4, ... minutes, at most 6 hours. */
export function tiktokWebhookRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

/** A short code for `last_error_code`: the Postgres code or the error's name, never a message. */
function errorCode(error: unknown): string {
  const cause = (error instanceof Error ? (error.cause ?? error) : null) as { code?: unknown } | null;
  const code = typeof cause?.code === "string" ? `pg:${cause.code}` : error instanceof Error ? error.name : "unknown";
  return code.slice(0, 64);
}

/** When the event happened: TikTok's `timestamp`, never later than when we received it. */
function eventTime(row: { timestampS: number | null; receivedAt: Date }): Date {
  if (row.timestampS === null) return row.receivedAt;
  return new Date(Math.min(row.timestampS * 1000, row.receivedAt.getTime()));
}

/** Processes one inbox event. Topics 6 and 7 call T2's conditional writes, which are idempotent, so
 * two processors racing on one event change the connection once; the `processed` mark is itself
 * conditional on `pending`. The connection write's failure is recorded on the row (code only) and
 * retried by `processDueTikTokConnectionEvents`; only a failure to read or record (database down)
 * throws. */
export async function processTikTokWebhookEvent(db: Database, eventId: string, now: Date = new Date()): Promise<ProcessTikTokWebhookResult> {
  const [row] = await db
    .select({ id: tiktokWebhookEvents.id, type: tiktokWebhookEvents.type, shopId: tiktokWebhookEvents.shopId, timestampS: tiktokWebhookEvents.timestampS, receivedAt: tiktokWebhookEvents.receivedAt, attempts: tiktokWebhookEvents.attempts })
    .from(tiktokWebhookEvents)
    .where(and(eq(tiktokWebhookEvents.id, eventId), eq(tiktokWebhookEvents.status, "pending")));
  if (!row) return { kind: "not_pending" };
  if (!CONNECTION_TOPICS.includes(row.type)) return { kind: "awaiting_sync" };

  let changed: boolean;
  try {
    if (row.shopId === null) changed = false;
    else if (row.type === TIKTOK_WEBHOOK_TOPICS.SELLER_DEAUTHORIZATION) changed = await deauthorizeTikTokShop(db, { shopId: row.shopId, at: eventTime(row) });
    else changed = await recordTikTokExpiryWarning(db, { shopId: row.shopId, at: eventTime(row) });
  } catch (error) {
    const code = errorCode(error);
    const attempts = row.attempts + 1;
    const final = attempts >= TIKTOK_WEBHOOK_MAX_ATTEMPTS;
    const [updated] = await db
      .update(tiktokWebhookEvents)
      .set({
        attempts: sql`least(${tiktokWebhookEvents.attempts} + 1, ${TIKTOK_WEBHOOK_MAX_ATTEMPTS})`,
        status: final ? "failed" : "pending",
        nextAttemptAt: final ? null : new Date(now.getTime() + tiktokWebhookRetryDelayMs(attempts)),
        lastErrorCode: code,
      })
      .where(and(eq(tiktokWebhookEvents.id, row.id), eq(tiktokWebhookEvents.status, "pending"), eq(tiktokWebhookEvents.attempts, row.attempts)))
      .returning({ attempts: tiktokWebhookEvents.attempts, status: tiktokWebhookEvents.status });
    // Another processor recorded this attempt (or finished the event) meanwhile.
    if (!updated) return { kind: "not_pending" };
    return updated.status === "failed" ? { kind: "failed", attempts: updated.attempts, errorCode: code } : { kind: "retry_scheduled", attempts: updated.attempts, errorCode: code };
  }

  await db
    .update(tiktokWebhookEvents)
    .set({ status: "processed", processedAt: now, nextAttemptAt: null })
    .where(and(eq(tiktokWebhookEvents.id, row.id), eq(tiktokWebhookEvents.status, "pending")));
  if (!changed && row.shopId !== null && (await reconnectedAfter(db, row.shopId, eventTime(row)))) return { kind: "processed", changed: false, stale: true };
  return { kind: "processed", changed };
}

/** Whether the shop's current authorization is newer than an event (the guard in T2's writes), so a
 * skipped event is reported as such rather than as an idempotent no-op. */
async function reconnectedAfter(db: Database, shopId: string, at: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: tiktokShopConnections.id })
    .from(tiktokShopConnections)
    .where(and(eq(tiktokShopConnections.shopId, shopId), inArray(tiktokShopConnections.status, ["active", "reauth_required"]), gt(tiktokShopConnections.connectedAt, tiktokEventConnectedBefore(at))));
  return row !== undefined;
}

/** One sweep at a time per process: a burst of deliveries must not queue several sweeps on the
 * shared pool behind one row lock. */
let sweepRunning = false;

/** Topic 6/7 events still pending and due (a process restart lost their `after()`, the insert
 * committed after the route already answered 503, or a retry is due). Run after every verified
 * delivery (stored or duplicate, so TikTok's own redelivery of a lost event triggers it) and by the
 * sync cron once T4 adds it. Until T4, a due retry waits for the next delivery. One event's failure
 * never stops the others. Null when another sweep is already running in this process. */
export async function processDueTikTokConnectionEvents(db: Database, options: { now?: Date; limit?: number } = {}): Promise<ProcessTikTokWebhookResult[] | null> {
  if (sweepRunning) return null;
  sweepRunning = true;
  try {
    return await sweepDue(db, options);
  } finally {
    sweepRunning = false;
  }
}

async function sweepDue(db: Database, options: { now?: Date; limit?: number }): Promise<ProcessTikTokWebhookResult[]> {
  const now = options.now ?? new Date();
  const due = await db
    .select({ id: tiktokWebhookEvents.id })
    .from(tiktokWebhookEvents)
    .where(
      and(
        eq(tiktokWebhookEvents.status, "pending"),
        inArray(tiktokWebhookEvents.type, [...CONNECTION_TOPICS]),
        or(isNull(tiktokWebhookEvents.nextAttemptAt), lte(tiktokWebhookEvents.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(tiktokWebhookEvents.receivedAt))
    .limit(options.limit ?? 20);
  const results: ProcessTikTokWebhookResult[] = [];
  for (const { id } of due) {
    try {
      results.push(await processTikTokWebhookEvent(db, id, now));
    } catch (error) {
      results.push({ kind: "threw", errorCode: errorCode(error) });
    }
  }
  return results;
}
