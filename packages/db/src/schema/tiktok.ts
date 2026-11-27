import { sql } from "drizzle-orm";
import { bigint, check, customType, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { checkIn, createdAtOnly, timestamps } from "./columns";
import { staffUsers } from "./rbac";

// TikTok Shop connection, OAuth state, sync cursors and webhook inbox (docs/plans/
// tiktok-shop-integration.md §3.1, §3.2; migration 0057). New tables only: nothing the previously
// deployed release reads changes (expand-only).

/** Raw bytes (`bytea`). Holds AES-256-GCM token ciphertext only (`version | iv | ct | tag`, plan
 * §7.2); never a plaintext token. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const TIKTOK_CONNECTION_STATUSES = ["active", "reauth_required", "deauthorized", "disconnected"] as const;
export type TikTokConnectionStatus = (typeof TIKTOK_CONNECTION_STATUSES)[number];

export const TIKTOK_SYNC_RESOURCES = ["orders", "returns", "cancellations", "statements", "payments", "unsettled"] as const;
export type TikTokSyncResource = (typeof TIKTOK_SYNC_RESOURCES)[number];

export const TIKTOK_WEBHOOK_EVENT_STATUSES = ["pending", "processed", "ignored", "failed"] as const;
export type TikTokWebhookEventStatus = (typeof TIKTOK_WEBHOOK_EVENT_STATUSES)[number];

/** The allowlisted inbox payload is capped at 16 KB (plan §3.2). */
export const TIKTOK_WEBHOOK_PAYLOAD_MAX_BYTES = 16_384;

/** One row per authorized shop. v1 expects one shop: at most one row is `active`. */
export const tiktokShopConnections = pgTable(
  "tiktok_shop_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: text("shop_id").notNull().unique(),
    // Sent on every shop-scoped call. Not a secret, but never logged next to a token.
    shopCipher: text("shop_cipher").notNull(),
    shopName: text("shop_name"),
    region: text("region"),
    sellerType: text("seller_type"),
    status: text("status", { enum: TIKTOK_CONNECTION_STATUSES }).notNull(),
    // Encrypted at rest (plan §7.2, AAD = connection id + column name). NULL once deauthorized or
    // disconnected: wiped, never kept.
    accessTokenCt: bytea("access_token_ct"),
    refreshTokenCt: bytea("refresh_token_ct"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
    // Which TIKTOK_TOKEN_ENC_KEY_V<n> encrypted the two columns (key rotation).
    tokenKeyVersion: smallint("token_key_version").notNull(),
    // Bumped by every token write. A refresh writes only `WHERE token_generation = $seen`, so two
    // refreshers never both rotate (plan §3.1).
    tokenGeneration: integer("token_generation").notNull().default(0),
    grantedScopes: text("granted_scopes").array().notNull().default(sql`'{}'::text[]`),
    connectedByStaffUserId: uuid("connected_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    connectedAt: timestamp("connected_at", { withTimezone: true, mode: "date" }).notNull(),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true, mode: "date" }),
    deauthorizedAt: timestamp("deauthorized_at", { withTimezone: true, mode: "date" }),
    // Topic 7 (UPCOMING_AUTHORIZATION_EXPIRATION) arrived; cleared by the next connect.
    expiryWarningAt: timestamp("expiry_warning_at", { withTimezone: true, mode: "date" }),
    lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true, mode: "date" }),
    lastPollOkAt: timestamp("last_poll_ok_at", { withTimezone: true, mode: "date" }),
    // Error codes only (a TikTok code or our own short reason), never a response body.
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_shop_connections_status_check", checkIn(table.status, TIKTOK_CONNECTION_STATUSES)),
    // Both token columns are set together or wiped together.
    check("tiktok_shop_connections_tokens_paired_check", sql`(${table.accessTokenCt} is null) = (${table.refreshTokenCt} is null)`),
    // An active connection has tokens; a deauthorized or disconnected one has none (wiped).
    check(
      "tiktok_shop_connections_tokens_status_check",
      sql`(${table.status} <> 'active' or ${table.accessTokenCt} is not null) and (${table.status} not in ('deauthorized', 'disconnected') or ${table.accessTokenCt} is null)`,
    ),
    check("tiktok_shop_connections_key_version_check", sql`${table.tokenKeyVersion} between 1 and 255`),
    check("tiktok_shop_connections_token_generation_check", sql`${table.tokenGeneration} >= 0`),
    check("tiktok_shop_connections_last_error_code_check", sql`${table.lastErrorCode} is null or char_length(${table.lastErrorCode}) <= 64`),
    uniqueIndex("tiktok_shop_connections_one_active").on(table.status).where(sql`${table.status} = 'active'`),
    index("tiktok_shop_connections_connected_by_idx").on(table.connectedByStaffUserId),
  ],
);

/** OAuth `state`, single use and expiring (plan §3.1). Only the SHA-256 is stored; the raw value
 * lives in the authorize URL and the browser. Consumed with one conditional UPDATE ... RETURNING. */
export const tiktokOauthStates = pgTable(
  "tiktok_oauth_states",
  {
    stateHash: text("state_hash").primaryKey(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "cascade" }),
    ...createdAtOnly(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    check("tiktok_oauth_states_hash_check", sql`${table.stateHash} ~ '^[0-9a-f]{64}$'`),
    check("tiktok_oauth_states_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    index("tiktok_oauth_states_staff_user_id_idx").on(table.staffUserId),
    index("tiktok_oauth_states_expires_at_idx").on(table.expiresAt),
  ],
);

/** Where each poll resumes (plan §3.1, §8.3). Rows are created by the sync (T4). */
export const tiktokSyncCursors = pgTable(
  "tiktok_sync_cursors",
  {
    resource: text("resource", { enum: TIKTOK_SYNC_RESOURCES }).primaryKey(),
    // Everything below it is fully fetched and applied.
    windowEnd: timestamp("window_end", { withTimezone: true, mode: "date" }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "date" }),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true, mode: "date" }),
    lastErrorCode: text("last_error_code"),
    backfillFrom: timestamp("backfill_from", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_sync_cursors_resource_check", checkIn(table.resource, TIKTOK_SYNC_RESOURCES)),
    check("tiktok_sync_cursors_last_error_code_check", sql`${table.lastErrorCode} is null or char_length(${table.lastErrorCode}) <= 64`),
  ],
);

/** Verified webhook deliveries, deduped on `tts_notification_id` (plan §3.2). Filled by T3. */
export const tiktokWebhookEvents = pgTable(
  "tiktok_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ttsNotificationId: text("tts_notification_id").notNull().unique(),
    // Topic number: 1, 3, 6, 7, 11, 12, or an unknown one (stored and ignored).
    type: smallint("type").notNull(),
    shopId: text("shop_id"),
    tiktokOrderId: text("tiktok_order_id"),
    timestampS: bigint("timestamp_s", { mode: "number" }),
    // The verified body after the §6 allowlist (no buyer data).
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    status: text("status", { enum: TIKTOK_WEBHOOK_EVENT_STATUSES }).notNull().default("pending"),
    attempts: smallint("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    lastErrorCode: text("last_error_code"),
  },
  (table) => [
    check("tiktok_webhook_events_status_check", checkIn(table.status, TIKTOK_WEBHOOK_EVENT_STATUSES)),
    check("tiktok_webhook_events_attempts_check", sql`${table.attempts} between 0 and 10`),
    check("tiktok_webhook_events_payload_size_check", sql`${table.payload} is null or octet_length(${table.payload}::text) <= ${sql.raw(String(TIKTOK_WEBHOOK_PAYLOAD_MAX_BYTES))}`),
    check("tiktok_webhook_events_last_error_code_check", sql`${table.lastErrorCode} is null or char_length(${table.lastErrorCode}) <= 64`),
    // The drain claims pending rows that are due.
    index("tiktok_webhook_events_pending_idx").on(table.nextAttemptAt).where(sql`${table.status} = 'pending'`),
    index("tiktok_webhook_events_tiktok_order_id_idx").on(table.tiktokOrderId),
    // Retention (12 months) and the settings page's "last webhook".
    index("tiktok_webhook_events_received_at_idx").on(table.receivedAt),
  ],
);
