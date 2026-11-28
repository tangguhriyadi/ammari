import { sql } from "drizzle-orm";
import { bigint, boolean, check, customType, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { productVariants } from "./catalog";
import { checkArraySubset, checkIn, createdAtOnly, timestamps } from "./columns";
import { ACCOUNTING_TRIAL_MONTH } from "./constants";
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

/** `products` (migration 0064, stock sync S1): the listing read pass (Search Products), its
 * `last_run_at` / `last_ok_at` / `last_error_code` only; it has no window. */
export const TIKTOK_SYNC_RESOURCES = ["orders", "returns", "cancellations", "statements", "payments", "unsettled", "products", "stock_push", "stock_reconcile"] as const;
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
    // "Sinkronkan stok ke TikTok" (docs/plans/tiktok-stock-sync.md, migration 0064): off by default.
    // ON only while orders_apply_enabled is ON (CHECK below), and a trigger turns it OFF whenever
    // orders_apply_enabled goes OFF (rule R1), so no code path, including an older release after a
    // rollback, can leave stock pushing while TikTok sales do not reduce Ammari stock.
    stockSyncEnabled: boolean("stock_sync_enabled").notNull().default(false),
    stockSyncChangedAt: timestamp("stock_sync_changed_at", { withTimezone: true, mode: "date" }),
    stockSyncChangedByStaffUserId: uuid("stock_sync_changed_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
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
    check("tiktok_shop_connections_stock_sync_needs_orders_check", sql`not ${table.stockSyncEnabled} or ${table.ordersApplyEnabled}`),
    index("tiktok_shop_connections_stock_sync_changed_by_idx").on(table.stockSyncChangedByStaffUserId),
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
/** `duplicate_in_admin` (migration 0063, T9): more than one hand-typed TikTok order carries this
 * number once spaces, `#`, `.` and `-` are ignored, so the sync cannot tell which one it is. */
export const TIKTOK_HELD_REASONS = ["unknown_sku", "short_stock", "lines_differ", "final_in_admin", "partial_shipping", "partial_refund", "unknown_status", "money_format", "line_format", "duplicate_in_admin"] as const;
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
    // T9 (migration 0063): set when the backfill was the first to store this order. Such an order is
    // not applied until the owner confirms that backfill after its preview ("Terapkan riwayat"); a
    // live store (poll, webhook) of the same order clears it, since the live sync would have applied
    // it anyway.
    backfillId: uuid("backfill_id").references((): AnyPgColumn => tiktokBackfills.id, { onDelete: "restrict" }),
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
    index("tiktok_orders_backfill_id_idx").on(table.backfillId).where(sql`${table.backfillId} is not null`),
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

// ---- Cancellations and returns (plan §4.5, T6, migration 0060) ------------------------------------

export const TIKTOK_AFTER_SALE_KINDS = ["return", "cancellation"] as const;
export type TikTokAfterSaleKind = (typeof TIKTOK_AFTER_SALE_KINDS)[number];

/** What the sync last made of a request (commerce/tiktok/after-sale-rules.ts). NULL until applied
 * (the T5 kill switch off: stored only, a dry run). */
export const TIKTOK_AFTER_SALE_STATES = [
  // No admin order to act on yet (not applied, held, skipped): re-checked every run.
  "waiting_order",
  // The request is open (seller may have to answer in Seller Center).
  "open",
  // Approved; goods not shipped back yet, or the refund is on its way.
  "approved",
  // The buyer shipped the goods back: the parcel is on its way (Q18).
  "goods_coming",
  // RETURN_OR_REFUND_REQUEST_COMPLETE with every item coming back: stock waits for "Retur diterima".
  "completed_goods",
  // RETURN_OR_REFUND_REQUEST_COMPLETE refund-only: one marketplace_refunds row (Q10).
  "completed_refund",
  // A cancellation TikTok completed: the order's own status path cancels it.
  "cancel_completed",
  // Rejected or withdrawn without a refund.
  "closed",
  // Some items only, with goods: marketplace_partial_return, settled by hand.
  "partial",
  // Nothing the rules can classify: a person decides (review_reason).
  "review",
] as const;
export type TikTokAfterSaleState = (typeof TIKTOK_AFTER_SALE_STATES)[number];

export const TIKTOK_AFTER_SALE_REVIEW_REASONS = [
  "unknown_status",
  "unknown_type",
  "replacement",
  "lines_unknown",
  "money_format",
  "refund_over_total",
  "before_shipping",
  "after_return",
  "package_rejected",
  "closed_after_goods",
] as const;
export type TikTokAfterSaleReviewReason = (typeof TIKTOK_AFTER_SALE_REVIEW_REASONS)[number];

/** The current state of each TikTok return or cancellation request (plan §4.5). Moves forward only
 * (`latest_update_time < $new`), like `tiktok_orders`. Its versions are snapshots of kind `return` /
 * `cancellation` in `tiktok_order_snapshots`, keyed by the TikTok order id. */
export const tiktokReturns = pgTable(
  "tiktok_returns",
  {
    kind: text("kind", { enum: TIKTOK_AFTER_SALE_KINDS }).notNull(),
    // TikTok's `return_id` / `cancel_id`.
    requestId: text("request_id").notNull(),
    tiktokOrderId: text("tiktok_order_id").notNull(),
    status: text("status").notNull(),
    requestType: text("request_type"),
    createTime: timestamp("create_time", { withTimezone: true, mode: "date" }),
    latestUpdateTime: timestamp("latest_update_time", { withTimezone: true, mode: "date" }).notNull(),
    latestSnapshotId: uuid("latest_snapshot_id")
      .notNull()
      .references(() => tiktokOrderSnapshots.id, { onDelete: "restrict" }),
    // When the seller must answer in Seller Center (TikTok's deadline, else create_time + 48 h, §0);
    // NULL once the request no longer waits for the seller.
    responseDueAt: timestamp("response_due_at", { withTimezone: true, mode: "date" }),
    // The `update_time` of the first RETURN_OR_REFUND_REQUEST_COMPLETE version (written once).
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    state: text("state", { enum: TIKTOK_AFTER_SALE_STATES }),
    reviewReason: text("review_reason", { enum: TIKTOK_AFTER_SALE_REVIEW_REASONS }),
    appliedUpdateTime: timestamp("applied_update_time", { withTimezone: true, mode: "date" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.requestId] }),
    check("tiktok_returns_kind_check", checkIn(table.kind, TIKTOK_AFTER_SALE_KINDS)),
    check("tiktok_returns_state_check", sql`${table.state} is null or ${checkIn(table.state, TIKTOK_AFTER_SALE_STATES)}`),
    check("tiktok_returns_review_reason_check", sql`${table.reviewReason} is null or ${checkIn(table.reviewReason, TIKTOK_AFTER_SALE_REVIEW_REASONS)}`),
    // A reason only with the review state, and the review state always with one.
    check("tiktok_returns_review_pair_check", sql`(${table.state} is not distinct from 'review') = (${table.reviewReason} is not null)`),
    check("tiktok_returns_request_id_check", sql`char_length(${table.requestId}) between 1 and 128`),
    check("tiktok_returns_order_id_text_check", sql`char_length(${table.tiktokOrderId}) between 1 and 128`),
    check("tiktok_returns_status_check", sql`char_length(${table.status}) between 1 and 64`),
    check("tiktok_returns_request_type_check", sql`${table.requestType} is null or char_length(${table.requestType}) between 1 and 64`),
    index("tiktok_returns_tiktok_order_id_idx").on(table.tiktokOrderId),
    index("tiktok_returns_order_id_idx").on(table.orderId),
    index("tiktok_returns_latest_snapshot_id_idx").on(table.latestSnapshotId),
    // The 48-hour list in admin.
    index("tiktok_returns_response_due_idx").on(table.responseDueAt).where(sql`${table.responseDueAt} is not null`),
  ],
);

// ---- Finance: statements, transactions, estimates, fees, payouts (plan §3.5, T7, migration 0061) ---

/** What a finance snapshot holds. Finance records have no `update_time`: a version is its content. */
export const TIKTOK_FINANCE_SNAPSHOT_KINDS = ["statement", "statement_transaction", "order_transactions", "unsettled_transaction", "payment"] as const;
export type TikTokFinanceSnapshotKind = (typeof TIKTOK_FINANCE_SNAPSHOT_KINDS)[number];

/** Why a finance record's money was not taken (never rounded, never defaulted, Q6). */
export const TIKTOK_FINANCE_HELD_REASONS = ["money_format", "currency", "sum_mismatch"] as const;
export type TikTokFinanceHeldReason = (typeof TIKTOK_FINANCE_HELD_REASONS)[number];

/** Where an order's fees come from (Q9): Get Unsettled Transactions, then the statements. */
export const TIKTOK_FEE_SOURCES = ["estimate", "actual"] as const;
export type TikTokFeeSource = (typeof TIKTOK_FEE_SOURCES)[number];

export const TIKTOK_FEE_GROUPS = ["fee", "tax", "shipping"] as const;
export type TikTokFeeGroupName = (typeof TIKTOK_FEE_GROUPS)[number];

/** A settled order transaction's SKU-level fee lines (Get Transactions by Order). */
export const TIKTOK_TRANSACTION_FEE_STATES = ["pending", "complete", "held"] as const;
export type TikTokTransactionFeeState = (typeof TIKTOK_TRANSACTION_FEE_STATES)[number];

/** What the sync last made of an order's fees (commerce/tiktok/finance-rules.ts). */
export const TIKTOK_ORDER_FEE_STATES = ["applied", "held", "waiting_order"] as const;
export type TikTokOrderFeeState = (typeof TIKTOK_ORDER_FEE_STATES)[number];

export const TIKTOK_ORDER_FEE_HELD_REASONS = ["fee_type_unmapped", "fee_negative", "fee_sum_mismatch", "money_format", "not_tiktok_order"] as const;
export type TikTokOrderFeeHeldReason = (typeof TIKTOK_ORDER_FEE_HELD_REASONS)[number];

const financeSnapshotRef = () => uuid("latest_snapshot_id").notNull().references((): AnyPgColumn => tiktokFinanceSnapshots.id, { onDelete: "restrict" });

/** Versioned, allowlisted copies of every finance record (plan §3.5, §6). A re-fetch of the same
 * content is a no-op (the unique key); changed content is a new row, so nothing settled is ever
 * lost. Kept as long as the records they belong to. */
export const tiktokFinanceSnapshots = pgTable(
  "tiktok_finance_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: TIKTOK_FINANCE_SNAPSHOT_KINDS }).notNull(),
    // The statement, transaction or payment id (the TikTok order id for `order_transactions`).
    externalId: text("external_id").notNull(),
    contentSha256: text("content_sha256").notNull(),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("tiktok_finance_snapshots_kind_check", checkIn(table.kind, TIKTOK_FINANCE_SNAPSHOT_KINDS)),
    check("tiktok_finance_snapshots_sha_check", sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check("tiktok_finance_snapshots_external_id_check", sql`char_length(${table.externalId}) between 1 and 128`),
    unique("tiktok_finance_snapshots_version_key").on(table.kind, table.externalId, table.contentSha256),
  ],
);

/** One row per TikTok statement (plan §3.5). Amounts NULL while held (money not whole rupiah, not
 * IDR, or its transactions do not add up to its settlement). */
export const tiktokStatements = pgTable(
  "tiktok_statements",
  {
    statementId: text("statement_id").primaryKey(),
    statementTime: timestamp("statement_time", { withTimezone: true, mode: "date" }).notNull(),
    currency: text("currency"),
    settlementAmount: bigint("settlement_amount", { mode: "number" }),
    revenueAmount: bigint("revenue_amount", { mode: "number" }),
    feeAmount: bigint("fee_amount", { mode: "number" }),
    adjustmentAmount: bigint("adjustment_amount", { mode: "number" }),
    shippingCostAmount: bigint("shipping_cost_amount", { mode: "number" }),
    // Raw (`PAID`, `PROCESSING`, ...). A statement not PAID yet is fetched again.
    paymentStatus: text("payment_status"),
    // The payout that paid it (tiktok_payouts.payment_id). No FK: the payout can arrive later.
    paymentId: text("payment_id"),
    heldReason: text("held_reason", { enum: TIKTOK_FINANCE_HELD_REASONS }),
    // Set once every transaction of this content version is stored and adds up.
    transactionsCompleteSha256: text("transactions_complete_sha256"),
    latestSnapshotId: financeSnapshotRef(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull(),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_statements_held_reason_check", sql`${table.heldReason} is null or ${checkIn(table.heldReason, TIKTOK_FINANCE_HELD_REASONS)}`),
    // Money is taken only in IDR (plan §3.5); a statement in another currency is held, never stored as rupiah.
    check("tiktok_statements_currency_check", sql`${table.heldReason} is not null or (${table.currency} = 'IDR' and ${table.settlementAmount} is not null)`),
    check("tiktok_statements_id_check", sql`char_length(${table.statementId}) between 1 and 128`),
    index("tiktok_statements_statement_time_idx").on(table.statementTime),
    index("tiktok_statements_payment_id_idx").on(table.paymentId),
    index("tiktok_statements_latest_snapshot_id_idx").on(table.latestSnapshotId),
  ],
);

/** Every transaction of a statement (plan §3.5): orders, refunds and adjustments, `type` as TikTok
 * sends it (T8 maps adjustment types in Pemetaan Akun, Q8; nothing is dropped or guessed here). */
export const tiktokStatementTransactions = pgTable(
  "tiktok_statement_transactions",
  {
    transactionId: text("transaction_id").primaryKey(),
    statementId: text("statement_id")
      .notNull()
      .references(() => tiktokStatements.statementId, { onDelete: "restrict" }),
    type: text("type").notNull(),
    // `order` for TikTok's ORDER/REFUND types (they carry the order's fees), `adjustment` otherwise.
    kind: text("kind", { enum: ["order", "adjustment"] }).notNull(),
    tiktokOrderId: text("tiktok_order_id"),
    settlementAmount: bigint("settlement_amount", { mode: "number" }),
    revenueAmount: bigint("revenue_amount", { mode: "number" }),
    feeTaxAmount: bigint("fee_tax_amount", { mode: "number" }),
    shippingCostAmount: bigint("shipping_cost_amount", { mode: "number" }),
    adjustmentAmount: bigint("adjustment_amount", { mode: "number" }),
    heldReason: text("held_reason", { enum: TIKTOK_FINANCE_HELD_REASONS }),
    // Order transactions only: whether the SKU-level fee lines are stored and add up.
    feesState: text("fees_state", { enum: TIKTOK_TRANSACTION_FEE_STATES }),
    feesHeldReason: text("fees_held_reason", { enum: TIKTOK_ORDER_FEE_HELD_REASONS }),
    contentSha256: text("content_sha256").notNull(),
    latestSnapshotId: financeSnapshotRef(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull(),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_statement_transactions_kind_check", sql`${table.kind} in ('order', 'adjustment')`),
    check("tiktok_statement_transactions_type_check", sql`char_length(${table.type}) between 1 and 64`),
    check("tiktok_statement_transactions_held_reason_check", sql`${table.heldReason} is null or ${checkIn(table.heldReason, TIKTOK_FINANCE_HELD_REASONS)}`),
    check("tiktok_statement_transactions_money_check", sql`${table.heldReason} is not null or ${table.settlementAmount} is not null`),
    check("tiktok_statement_transactions_fees_state_check", sql`${table.feesState} is null or ${checkIn(table.feesState, TIKTOK_TRANSACTION_FEE_STATES)}`),
    check("tiktok_statement_transactions_fees_held_check", sql`(${table.feesState} is not distinct from 'held') = (${table.feesHeldReason} is not null)`),
    // Only an order transaction (with its order) has fee lines to fetch.
    check("tiktok_statement_transactions_fees_kind_check", sql`${table.feesState} is null or (${table.kind} = 'order' and ${table.tiktokOrderId} is not null)`),
    index("tiktok_statement_transactions_statement_id_idx").on(table.statementId),
    index("tiktok_statement_transactions_tiktok_order_id_idx").on(table.tiktokOrderId),
    index("tiktok_statement_transactions_type_idx").on(table.type),
    index("tiktok_statement_transactions_latest_snapshot_id_idx").on(table.latestSnapshotId),
  ],
);

/** Get Unsettled Transactions (plan §5.3, Q9): the estimate for orders not settled yet. A row is kept
 * after it leaves TikTok's list (`last_seen_at` stops moving); the statements' actual replaces it. */
export const tiktokUnsettledTransactions = pgTable(
  "tiktok_unsettled_transactions",
  {
    transactionId: text("transaction_id").primaryKey(),
    type: text("type").notNull(),
    tiktokOrderId: text("tiktok_order_id"),
    estSettlementAmount: bigint("est_settlement_amount", { mode: "number" }),
    estRevenueAmount: bigint("est_revenue_amount", { mode: "number" }),
    estFeeTaxAmount: bigint("est_fee_tax_amount", { mode: "number" }),
    estShippingCostAmount: bigint("est_shipping_cost_amount", { mode: "number" }),
    heldReason: text("held_reason", { enum: TIKTOK_FINANCE_HELD_REASONS }),
    contentSha256: text("content_sha256").notNull(),
    latestSnapshotId: financeSnapshotRef(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull(),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_unsettled_transactions_type_check", sql`char_length(${table.type}) between 1 and 64`),
    check("tiktok_unsettled_transactions_held_reason_check", sql`${table.heldReason} is null or ${checkIn(table.heldReason, TIKTOK_FINANCE_HELD_REASONS)}`),
    index("tiktok_unsettled_transactions_tiktok_order_id_idx").on(table.tiktokOrderId),
    index("tiktok_unsettled_transactions_latest_snapshot_id_idx").on(table.latestSnapshotId),
  ],
);

/** The raw fee grain (plan §3.5): one signed amount per transaction × SKU × TikTok fee type, by
 * TikTok's own type names, as `estimate` (unsettled) or `actual` (statement transactions by order).
 * Estimates stay when the actual arrives (history); order_channel_fees takes actual over estimate. */
export const tiktokOrderFeeLines = pgTable(
  "tiktok_order_fee_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tiktokOrderId: text("tiktok_order_id").notNull(),
    source: text("source", { enum: TIKTOK_FEE_SOURCES }).notNull(),
    transactionId: text("transaction_id").notNull(),
    // "" for an order-level line (an estimate has no SKU split).
    tiktokSkuId: text("tiktok_sku_id").notNull().default(""),
    feeGroup: text("fee_group", { enum: TIKTOK_FEE_GROUPS }).notNull(),
    feeType: text("fee_type").notNull(),
    // Signed, as TikTok reports it (a cost is negative).
    amount: bigint("amount", { mode: "number" }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull(),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_order_fee_lines_source_check", checkIn(table.source, TIKTOK_FEE_SOURCES)),
    check("tiktok_order_fee_lines_group_check", checkIn(table.feeGroup, TIKTOK_FEE_GROUPS)),
    check("tiktok_order_fee_lines_type_check", sql`char_length(${table.feeType}) between 1 and 160`),
    unique("tiktok_order_fee_lines_grain_key").on(table.source, table.transactionId, table.tiktokSkuId, table.feeGroup, table.feeType),
    index("tiktok_order_fee_lines_tiktok_order_id_idx").on(table.tiktokOrderId, table.source),
  ],
);

/** What the sync last wrote to order_channel_fees for a TikTok order, or why it held them. */
export const tiktokOrderFees = pgTable(
  "tiktok_order_fees",
  {
    tiktokOrderId: text("tiktok_order_id").primaryKey(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
    state: text("state", { enum: TIKTOK_ORDER_FEE_STATES }).notNull(),
    heldReason: text("held_reason", { enum: TIKTOK_ORDER_FEE_HELD_REASONS }),
    // The source of the lines last considered; `applied_source` is what order_channel_fees holds.
    source: text("source", { enum: TIKTOK_FEE_SOURCES }),
    appliedSource: text("applied_source", { enum: TIKTOK_FEE_SOURCES }),
    // TikTok fee type names with no row in the fee table (shown for the accountant's review).
    unmappedTypes: text("unmapped_types").array().notNull().default(sql`'{}'::text[]`),
    // The components last written, `{ component: amount }`.
    appliedComponents: jsonb("applied_components"),
    appliedAt: timestamp("applied_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_order_fees_state_check", checkIn(table.state, TIKTOK_ORDER_FEE_STATES)),
    check("tiktok_order_fees_held_reason_check", sql`${table.heldReason} is null or ${checkIn(table.heldReason, TIKTOK_ORDER_FEE_HELD_REASONS)}`),
    check("tiktok_order_fees_held_pair_check", sql`(${table.state} = 'held') = (${table.heldReason} is not null)`),
    check("tiktok_order_fees_source_check", sql`${table.source} is null or ${checkIn(table.source, TIKTOK_FEE_SOURCES)}`),
    check("tiktok_order_fees_applied_source_check", sql`${table.appliedSource} is null or ${checkIn(table.appliedSource, TIKTOK_FEE_SOURCES)}`),
    index("tiktok_order_fees_order_id_idx").on(table.orderId),
    index("tiktok_order_fees_state_idx").on(table.state),
  ],
);

/** Payouts to the seller's bank (Get Payments, plan §3.5). Linked to their statements through
 * `tiktok_statements.payment_id`. No account number: its last four digits only. */
export const tiktokPayouts = pgTable(
  "tiktok_payouts",
  {
    paymentId: text("payment_id").primaryKey(),
    amount: bigint("amount", { mode: "number" }),
    currency: text("currency"),
    status: text("status"),
    createTime: timestamp("create_time", { withTimezone: true, mode: "date" }),
    paidTime: timestamp("paid_time", { withTimezone: true, mode: "date" }),
    bankAccountLast4: text("bank_account_last4"),
    heldReason: text("held_reason", { enum: TIKTOK_FINANCE_HELD_REASONS }),
    contentSha256: text("content_sha256").notNull(),
    latestSnapshotId: financeSnapshotRef(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull(),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_payouts_held_reason_check", sql`${table.heldReason} is null or ${checkIn(table.heldReason, TIKTOK_FINANCE_HELD_REASONS)}`),
    check("tiktok_payouts_money_check", sql`${table.heldReason} is not null or (${table.currency} = 'IDR' and ${table.amount} is not null)`),
    check("tiktok_payouts_last4_check", sql`${table.bankAccountLast4} is null or ${table.bankAccountLast4} ~ '^[0-9]{4}$'`),
    index("tiktok_payouts_paid_time_idx").on(table.paidTime),
    index("tiktok_payouts_latest_snapshot_id_idx").on(table.latestSnapshotId),
  ],
);

// ---- Backfill (plan T9, migration 0063) --------------------------------------------------------

/** `fetching`: the cron reads history slice by slice; `fetched`: everything is stored, the preview is
 * ready; `confirmed`: the owner pressed "Terapkan riwayat", so the orders it stored may be applied
 * (still only while the T5 kill switch is on). */
export const TIKTOK_BACKFILL_STATES = ["fetching", "fetched", "confirmed"] as const;
export type TikTokBackfillState = (typeof TIKTOK_BACKFILL_STATES)[number];

/** A backfill never reaches before the books start: the December 2026 trial month (D-22), Jakarta
 * midnight. Nothing before it is posted, so nothing before it is fetched. */
export const TIKTOK_BACKFILL_FLOOR = new Date(`${ACCOUNTING_TRIAL_MONTH}T00:00:00+07:00`);
/** Order slices start at 6 hours (the live poll's) and halve, down to one minute, when one does not
 * finish within a run (the T4 known limit). */
export const TIKTOK_BACKFILL_MAX_SLICE_SECONDS = 6 * 3600;
export const TIKTOK_BACKFILL_MIN_SLICE_SECONDS = 60;

/** One history read of TikTok orders, returns, cancellations, statements and payouts over
 * `[from_time, until_time)` (plan T9). At most one is not confirmed at a time. Progress is kept per
 * resource, so a run that stops (budget, error) resumes at the last finished slice. */
export const tiktokBackfills = pgTable(
  "tiktok_backfills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromTime: timestamp("from_time", { withTimezone: true, mode: "date" }).notNull(),
    untilTime: timestamp("until_time", { withTimezone: true, mode: "date" }).notNull(),
    state: text("state", { enum: TIKTOK_BACKFILL_STATES }).notNull().default("fetching"),
    ordersDoneUntil: timestamp("orders_done_until", { withTimezone: true, mode: "date" }),
    returnsDoneUntil: timestamp("returns_done_until", { withTimezone: true, mode: "date" }),
    cancellationsDoneUntil: timestamp("cancellations_done_until", { withTimezone: true, mode: "date" }),
    statementsDoneUntil: timestamp("statements_done_until", { withTimezone: true, mode: "date" }),
    paymentsDoneUntil: timestamp("payments_done_until", { withTimezone: true, mode: "date" }),
    ordersSliceSeconds: integer("orders_slice_seconds").notNull().default(TIKTOK_BACKFILL_MAX_SLICE_SECONDS),
    requestedByStaffUserId: uuid("requested_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "date" }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }),
    confirmedByStaffUserId: uuid("confirmed_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "date" }),
    // Codes only, never a response body.
    lastErrorCode: text("last_error_code"),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_backfills_state_check", checkIn(table.state, TIKTOK_BACKFILL_STATES)),
    check("tiktok_backfills_from_floor_check", sql`${table.fromTime} >= ${sql.raw(`'${TIKTOK_BACKFILL_FLOOR.toISOString()}'::timestamptz`)}`),
    check("tiktok_backfills_range_check", sql`${table.untilTime} > ${table.fromTime}`),
    check(
      "tiktok_backfills_slice_check",
      sql`${table.ordersSliceSeconds} between ${sql.raw(String(TIKTOK_BACKFILL_MIN_SLICE_SECONDS))} and ${sql.raw(String(TIKTOK_BACKFILL_MAX_SLICE_SECONDS))}`,
    ),
    check("tiktok_backfills_fetched_check", sql`(${table.state} = 'fetching') = (${table.fetchedAt} is null)`),
    check("tiktok_backfills_confirmed_check", sql`(${table.state} = 'confirmed') = (${table.confirmedAt} is not null and ${table.confirmedByStaffUserId} is not null)`),
    check("tiktok_backfills_last_error_code_check", sql`${table.lastErrorCode} is null or char_length(${table.lastErrorCode}) <= 64`),
    // One backfill at a time: a second can start only once the previous one is confirmed.
    uniqueIndex("tiktok_backfills_one_open").on(sql`(true)`).where(sql`${table.state} <> 'confirmed'`),
    index("tiktok_backfills_requested_by_idx").on(table.requestedByStaffUserId),
    index("tiktok_backfills_confirmed_by_idx").on(table.confirmedByStaffUserId),
  ],
);

// ---- Stock sync: TikTok listings (docs/plans/tiktok-stock-sync.md §3, S1, migration 0064) ---------

/** Why a listing SKU is never pushed (plan §2 R4-R10). NULL = pushable as far as the listing goes. */
export const TIKTOK_LISTING_HOLD_REASONS = [
  "unmapped",
  "status_not_updatable",
  "warehouse_unclear",
  "quantity_unreadable",
  "variant_on_several_listings",
  "product_too_many_skus",
  "not_listed",
] as const;
export type TikTokListingHoldReason = (typeof TIKTOK_LISTING_HOLD_REASONS)[number];

/** TikTok's per SKU and warehouse maximum. */
export const TIKTOK_LISTING_MAX_QUANTITY = 999_999;

/** One row per TikTok SKU of the connected shop, as the last read pass saw it (Search Products), plus
 * what S2 last pushed. The read never touches the `last_pushed_*` / `last_push_error_*` columns. */
export const tiktokListingSkus = pgTable(
  "tiktok_listing_skus",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => tiktokShopConnections.id, { onDelete: "restrict" }),
    tiktokSkuId: text("tiktok_sku_id").notNull(),
    tiktokProductId: text("tiktok_product_id").notNull(),
    // Raw (ACTIVATE, SELLER_DEACTIVATED, ...): kept so a status hold says which one.
    productStatus: text("product_status").notNull(),
    productTitle: text("product_title"),
    skuLabel: text("sku_label"),
    // As typed in TikTok.
    sellerSku: text("seller_sku"),
    // The variant the active tiktok_sku_mappings row names; NULL = unmapped. Set null on a variant's
    // deletion (the next read recomputes), so this table never blocks deleting a variant.
    variantSku: text("variant_sku").references(() => productVariants.sku, { onDelete: "set null" }),
    // Ammari's one (non-FBT) warehouse for this SKU and TikTok's quantity there; NULL when unclear.
    warehouseId: text("warehouse_id"),
    tiktokQuantity: integer("tiktok_quantity"),
    // The start of the read pass that last saw this SKU.
    readAt: timestamp("read_at", { withTimezone: true, mode: "date" }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    holdReason: text("hold_reason", { enum: TIKTOK_LISTING_HOLD_REASONS }),
    // S2 (the push). Codes only, never a response body.
    lastPushedQuantity: integer("last_pushed_quantity"),
    lastPushedAt: timestamp("last_pushed_at", { withTimezone: true, mode: "date" }),
    lastPushErrorCode: text("last_push_error_code"),
    lastPushErrorAt: timestamp("last_push_error_at", { withTimezone: true, mode: "date" }),
    ...timestamps(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.tiktokSkuId] }),
    check("tiktok_listing_skus_hold_reason_check", sql`${table.holdReason} is null or ${checkIn(table.holdReason, TIKTOK_LISTING_HOLD_REASONS)}`),
    check("tiktok_listing_skus_sku_id_check", sql`char_length(${table.tiktokSkuId}) between 1 and 128`),
    check("tiktok_listing_skus_product_id_check", sql`char_length(${table.tiktokProductId}) between 1 and 128`),
    check("tiktok_listing_skus_status_check", sql`char_length(${table.productStatus}) between 1 and 64`),
    check("tiktok_listing_skus_text_check", sql`(${table.productTitle} is null or char_length(${table.productTitle}) <= 255) and (${table.skuLabel} is null or char_length(${table.skuLabel}) <= 255) and (${table.sellerSku} is null or char_length(${table.sellerSku}) <= 128) and (${table.warehouseId} is null or char_length(${table.warehouseId}) <= 128)`),
    check("tiktok_listing_skus_quantity_check", sql`${table.tiktokQuantity} is null or ${table.tiktokQuantity} between 0 and ${sql.raw(String(TIKTOK_LISTING_MAX_QUANTITY))}`),
    check("tiktok_listing_skus_pushed_check", sql`(${table.lastPushedQuantity} is null) = (${table.lastPushedAt} is null) and (${table.lastPushedQuantity} is null or ${table.lastPushedQuantity} between 0 and ${sql.raw(String(TIKTOK_LISTING_MAX_QUANTITY))})`),
    check("tiktok_listing_skus_push_error_check", sql`(${table.lastPushErrorCode} is null) = (${table.lastPushErrorAt} is null) and (${table.lastPushErrorCode} is null or char_length(${table.lastPushErrorCode}) <= 64)`),
    // S2: which listings a changed variant feeds; also the several-listings check (R7).
    index("tiktok_listing_skus_variant_sku_idx").on(table.variantSku).where(sql`${table.variantSku} is not null`),
    // S2: one Update Inventory call per product.
    index("tiktok_listing_skus_product_idx").on(table.connectionId, table.tiktokProductId),
  ],
);

// ---- Stock sync: the push (docs/plans/tiktok-stock-sync.md §7, S2, migration 0065) -------------------

/** What marked a variant dirty. Written by the database triggers (stock, hold, mapping, tiktok_order) and
 * by the push code (the others). */
export const TIKTOK_STOCK_OUTBOX_SOURCES = ["stock", "hold", "mapping", "tiktok_order", "enable", "reconcile", "hold_expiry", "retry", "listing"] as const;
export type TikTokStockOutboxSource = (typeof TIKTOK_STOCK_OUTBOX_SOURCES)[number];

/** The dirty-variant outbox. INSERT-ONLY for every writer: the triggers on stock_movements,
 * stock_reservations, tiktok_sku_mappings and tiktok_orders add a row in the writer's own transaction
 * (so a rollback leaves none, and no write path can forget it), and never update one, so a stock write
 * never waits on a row lock held by the push. The push reads the highest id per variant before it
 * computes, and after the call deletes only ids up to that one: a change committed meanwhile keeps its
 * row and is pushed again. Rows are written only while a connection has the stock switch on (the
 * switch turning on queues every mapped variant itself). No foreign key on purpose (no lock on
 * product_variants from inside every stock write); a row for a deleted variant is simply drained. */
export const tiktokStockOutbox = pgTable(
  "tiktok_stock_outbox",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    variantSku: text("variant_sku").notNull(),
    source: text("source", { enum: TIKTOK_STOCK_OUTBOX_SOURCES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("tiktok_stock_outbox_source_check", checkIn(table.source, TIKTOK_STOCK_OUTBOX_SOURCES)),
    check("tiktok_stock_outbox_variant_sku_check", sql`char_length(${table.variantSku}) between 1 and 128`),
    index("tiktok_stock_outbox_variant_sku_idx").on(table.variantSku, table.id),
  ],
);

/** Retry state of a variant whose last push failed for a reason worth retrying (a rate limit, an
 * outage, a network failure, an unknown code). Written only by the push. Backoff 1, 2, 4 ... minutes,
 * at most an hour; deleted once the variant is pushed, unchanged or held. */
export const tiktokStockPushRetries = pgTable(
  "tiktok_stock_push_retries",
  {
    variantSku: text("variant_sku").primaryKey(),
    attempts: integer("attempts").notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" }).notNull(),
    lastErrorCode: text("last_error_code").notNull(),
    ...timestamps(),
  },
  (table) => [
    check("tiktok_stock_push_retries_attempts_check", sql`${table.attempts} >= 1`),
    check("tiktok_stock_push_retries_error_code_check", sql`char_length(${table.lastErrorCode}) between 1 and 64`),
    check("tiktok_stock_push_retries_variant_sku_check", sql`char_length(${table.variantSku}) between 1 and 128`),
  ],
);
