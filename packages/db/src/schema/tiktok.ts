import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, index, integer, jsonb, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { productVariants } from "./catalog";
import { checkArraySubset, checkIn, createdAtOnly, timestamps } from "./columns";
import { orders } from "./orders";
import { staffUsers } from "./rbac";

// TikTok Shop connection, OAuth state, sync cursors and webhook inbox (docs/plans/
// tiktok-shop-integration.md §3.1, §3.2; migration 0057), and the order read side: versioned
// snapshots, the current-state projection and the SKU mapping (§3.3; migration 0058). New tables
// only: nothing the previously deployed release reads changes (expand-only).

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
    // The kill switch for T5 (migration 0059): while false the sync stays a dry run (snapshots and
    // projection only, no admin order or stock). Off by default; turned on and off on the Integrasi
    // page without a deploy, audited.
    ordersApplyEnabled: boolean("orders_apply_enabled").notNull().default(false),
    ordersApplyChangedAt: timestamp("orders_apply_changed_at", { withTimezone: true, mode: "date" }),
    ordersApplyChangedByStaffUserId: uuid("orders_apply_changed_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
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
    index("tiktok_shop_connections_orders_apply_changed_by_idx").on(table.ordersApplyChangedByStaffUserId),
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

// ---- Orders: snapshots, projection, SKU mapping (plan §3.3, T4, migration 0058) -----------------

export const TIKTOK_SNAPSHOT_SOURCES = ["webhook", "poll", "backfill", "manual"] as const;
/** What a snapshot holds (migration 0059): an order (T4/T5), or a return / cancellation (T6). */
export const TIKTOK_SNAPSHOT_KINDS = ["order", "return", "cancellation"] as const;
export type TikTokSnapshotKind = (typeof TIKTOK_SNAPSHOT_KINDS)[number];
export type TikTokSnapshotSource = (typeof TIKTOK_SNAPSHOT_SOURCES)[number];

/** Written by T5 once an order is applied to admin; NULL until then (T4 is a dry run). */
export const TIKTOK_APPLY_STATES = ["applied", "held", "skipped_unpaid", "skipped_undone"] as const;
export type TikTokApplyState = (typeof TIKTOK_APPLY_STATES)[number];

/** `line_format` (migration 0059, T5): a line quantity that is not a positive whole number, or one
 * variant at two prices in one order (it cannot be one order line). */
export const TIKTOK_HELD_REASONS = ["unknown_sku", "short_stock", "lines_differ", "final_in_admin", "partial_shipping", "partial_refund", "unknown_status", "money_format", "line_format"] as const;
export type TikTokHeldReason = (typeof TIKTOK_HELD_REASONS)[number];

/** Things the sync saw that it never resolves on its own (plan §3.3, §6): the same `update_time`
 * with different content, and an order leaving COMPLETED/CANCELLED again. Shown on the dry-run page. */
export const TIKTOK_ORDER_REVIEW_FLAGS = [
  "tiktok_snapshot_conflict",
  "tiktok_left_terminal",
  // Migration 0059 (T5): a later version reported another `collection_time` than the one already
  // written to `orders.marketplace_shipped_at` (written once, never overwritten, plan §3.4); and the
  // reason behind an order's `marketplace_review` flag (multi-package / partial shipping, Q2).
  "tiktok_ship_time_changed",
  "tiktok_partial_shipping",
] as const;
export type TikTokOrderReviewFlag = (typeof TIKTOK_ORDER_REVIEW_FLAGS)[number];

export const TIKTOK_SKU_MAPPING_SOURCES = ["auto_seller_sku", "manual"] as const;
export type TikTokSkuMappingSource = (typeof TIKTOK_SKU_MAPPING_SOURCES)[number];

/** `tiktok_orders.buyer_message` is capped (plan §3.3, Q14). */
export const TIKTOK_BUYER_MESSAGE_MAX_CHARS = 1_000;

/** Versioned, allowlisted copies of an order (plan §3.3). Never the raw response, never the buyer
 * message. A replay of the same version is a no-op (the unique key); the same `update_time` with
 * different content is kept as its own row and flagged on the projection. Kept as long as the order. */
export const tiktokOrderSnapshots = pgTable(
  "tiktok_order_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tiktokOrderId: text("tiktok_order_id").notNull(),
    // TikTok's `update_time`: the version.
    updateTime: timestamp("update_time", { withTimezone: true, mode: "date" }).notNull(),
    // SHA-256 hex of the allowlisted JSON with sorted keys.
    contentSha256: text("content_sha256").notNull(),
    payload: jsonb("payload").notNull(),
    source: text("source", { enum: TIKTOK_SNAPSHOT_SOURCES }).notNull(),
    kind: text("kind", { enum: TIKTOK_SNAPSHOT_KINDS }).notNull().default("order"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("tiktok_order_snapshots_source_check", checkIn(table.source, TIKTOK_SNAPSHOT_SOURCES)),
    check("tiktok_order_snapshots_kind_check", checkIn(table.kind, TIKTOK_SNAPSHOT_KINDS)),
    check("tiktok_order_snapshots_sha_check", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check("tiktok_order_snapshots_order_id_check", sql`char_length(${table.tiktokOrderId}) between 1 and 128`),
    unique("tiktok_order_snapshots_version_key").on(table.tiktokOrderId, table.updateTime, table.contentSha256),
  ],
);

/** The current state of each TikTok order (plan §3.3). Moves forward only: every write is
 * conditional on `latest_update_time < $new`, so a late older snapshot never overwrites a newer one.
 * `buyer_message` lives only here (never in a snapshot or the inbox) so it can be purged. */
export const tiktokOrders = pgTable(
  "tiktok_orders",
  {
    tiktokOrderId: text("tiktok_order_id").primaryKey(),
    // Set by T5 once the order is applied to admin.
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    latestUpdateTime: timestamp("latest_update_time", { withTimezone: true, mode: "date" }).notNull(),
    latestSnapshotId: uuid("latest_snapshot_id")
      .notNull()
      .references((): AnyPgColumn => tiktokOrderSnapshots.id, { onDelete: "restrict" }),
    paidTime: timestamp("paid_time", { withTimezone: true, mode: "date" }),
    collectionTime: timestamp("collection_time", { withTimezone: true, mode: "date" }),
    deliveryTime: timestamp("delivery_time", { withTimezone: true, mode: "date" }),
    cancelTime: timestamp("cancel_time", { withTimezone: true, mode: "date" }),
    isOnHoldOrder: boolean("is_on_hold_order"),
    // Ship-by deadline, for packing (T5).
    rtsSlaTime: timestamp("rts_sla_time", { withTimezone: true, mode: "date" }),
    applyState: text("apply_state", { enum: TIKTOK_APPLY_STATES }),
    heldReason: text("held_reason", { enum: TIKTOK_HELD_REASONS }),
    appliedUpdateTime: timestamp("applied_update_time", { withTimezone: true, mode: "date" }),
    buyerMessage: text("buyer_message"),
    // Terminal time (COMPLETED/CANCELLED) + 30 days (Q14). The retention job clears the message then.
    buyerMessagePurgeAfter: timestamp("buyer_message_purge_after", { withTimezone: true, mode: "date" }),
    reviewFlags: text("review_flags").array().notNull().default(sql`'{}'::text[]`),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_orders_apply_state_check", sql`${table.applyState} is null or ${checkIn(table.applyState, TIKTOK_APPLY_STATES)}`),
    check("tiktok_orders_held_reason_check", sql`${table.heldReason} is null or ${checkIn(table.heldReason, TIKTOK_HELD_REASONS)}`),
    check("tiktok_orders_buyer_message_check", sql`${table.buyerMessage} is null or char_length(${table.buyerMessage}) <= ${sql.raw(String(TIKTOK_BUYER_MESSAGE_MAX_CHARS))}`),
    check("tiktok_orders_status_check", sql`char_length(${table.status}) between 1 and 64`),
    check("tiktok_orders_review_flags_check", checkArraySubset(table.reviewFlags, TIKTOK_ORDER_REVIEW_FLAGS)),
    uniqueIndex("tiktok_orders_order_id_key").on(table.orderId).where(sql`${table.orderId} is not null`),
    index("tiktok_orders_latest_update_time_idx").on(table.latestUpdateTime),
    index("tiktok_orders_latest_snapshot_id_idx").on(table.latestSnapshotId),
    // The retention job's purge.
    index("tiktok_orders_buyer_message_purge_idx").on(table.buyerMessagePurgeAfter).where(sql`${table.buyerMessage} is not null`),
  ],
);

/** One TikTok SKU = one Ammari variant (plan §3.3, decided Q12): the primary key allows no 1→n.
 * Two TikTok SKUs (two listings) may point at the same variant. An inactive row counts as unmapped
 * and is never re-created by the auto-map (someone removed it on purpose). */
export const tiktokSkuMappings = pgTable(
  "tiktok_sku_mappings",
  {
    tiktokSkuId: text("tiktok_sku_id").primaryKey(),
    tiktokProductId: text("tiktok_product_id"),
    // As typed in TikTok.
    sellerSku: text("seller_sku"),
    variantSku: text("variant_sku")
      .notNull()
      .references(() => productVariants.sku, { onDelete: "restrict" }),
    source: text("source", { enum: TIKTOK_SKU_MAPPING_SOURCES }).notNull(),
    mappedByStaffUserId: uuid("mapped_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    mappedAt: timestamp("mapped_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_sku_mappings_source_check", checkIn(table.source, TIKTOK_SKU_MAPPING_SOURCES)),
    check("tiktok_sku_mappings_sku_id_check", sql`char_length(${table.tiktokSkuId}) between 1 and 128`),
    // A manual mapping names who made it; the auto-map has no person.
    check("tiktok_sku_mappings_actor_check", sql`(${table.source} = 'manual') = (${table.mappedByStaffUserId} is not null)`),
    index("tiktok_sku_mappings_variant_sku_idx").on(table.variantSku),
    index("tiktok_sku_mappings_mapped_by_idx").on(table.mappedByStaffUserId),
  ],
);
