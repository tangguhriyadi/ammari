# TikTok Shop integration (Indonesia, ROW seller): in-house API sync in admin

Status: **T1 built** (`d6b82d2`); **T2 built** (`e2ec0a5`, connection + OAuth, migration 0057, runbook §7.4);
**T3 built** 27 Nov 2026 (webhook receiver, no migration, runbook §7.5); **T4 built** 27 Nov 2026 (order
read side in dry run, migration 0058, build notes §9.1). T5-T9 not started.
Every session below needs its own `/plan` approval first (CLAUDE.md Workflow 1). **Owner decisions of
27 Nov 2026 are recorded in §12** and folded into the sections and sessions they affect. Q1, Q3, Q6 and
Q13 are verified in T0 on the development shop.

Goal: TikTok Shop orders, returns and money reach Ammari's admin **through TikTok's Open API**
instead of a file upload. They feed the existing orders/stock write paths and the accounting
posting engine. For **TikTok only**, this replaces the blocked accounting Session 5
(accounting.md §8: real marketplace ship dates, D-2). **Shopee stays file import**, and Session 5
stays blocked for Shopee alone.

Sources read for this plan: `docs/plans/accounting.md` (§1.1, §1.4, §2, §4.1, §4.3 M1-M4, §8 incl.
Session 5 and the Session 9 notes, §9, §11, §13), `docs/plans/marketplace-import.md` (§3-§8),
`packages/commerce/src/marketplace-import/commit.ts`, `packages/commerce/src/orders/{status,lifecycle}.ts`,
`apps/admin/src/lib/marketplace-import/{status-rules.ts,adapters/tiktok.ts}`,
`packages/accounting/src/{rules/sales.ts,sales-loaders.ts}`, `packages/commerce/src/maintenance/{lock,retention}.ts`,
`apps/web/src/app/api/internal/shipping/poll/route.ts`, `apps/web/src/app/api/shipping/biteship/webhook/[token]/route.ts`,
`deploy/cron/cron.sh`, both Caddyfiles. TikTok's docv2 pages are rendered by JavaScript and could not be read
without a browser (an automated fetch returned an empty shell). So every TikTok fact here is one of
the facts the owner confirmed on 27 Nov 2026 (§0), and anything beyond them is listed as an open
question (§12). Nothing is guessed. The two official signature test vectors were copied from TikTok's
docs by the owner's assistant (27 Nov 2026) and **verified independently with `openssl dgst -sha256
-hmac`**: both reproduce TikTok's published hex exactly (T1).

---

## 0. Facts confirmed by the owner (27 Nov 2026)

These facts are the inputs to this plan. They are recorded once here, and the later sections only
reference them.

- **App** "Ammari Admin": custom service, category "TikTok Shop Seller", status **Draf**. App Key and
  App Secret are kept on the owner's Mac at `~/ammari-secrets/tiktok-app-key` and
  `~/ammari-secrets/tiktok-app-secret`. An agent never reads or prints them (§7). The registered
  redirect URL is `https://admin.ammari.id/api/integrations/tiktok/callback` (the prod admin host,
  `deploy-prod/caddy/Caddyfile`).
- **Scopes** enabled, pending TikTok review: `seller.order.info`, `seller.finance.info`,
  `seller.return_refund.basic`, `seller.shop.info`, `seller.logistics`, `seller.product.basic`.
- **Auth.** Authorize link: `https://services.tiktokshop.com/open/authorize?service_id=...&state=...`.
  The code is valid for 30 minutes and works once. Token: `GET https://auth.tiktok-shops.com/api/v2/token/get`
  with `grant_type=authorized_code` (not `authorization_code`). Refresh: `/api/v2/token/refresh` with
  `grant_type=refresh_token`. The access token lasts 7 days and is sent in the header
  `x-tts-access-token`. Webhook topics: `SELLER_DEAUTHORIZATION` (6) and
  `UPCOMING_AUTHORIZATION_EXPIRATION` (7).
- **API** host `https://open-api.tiktokglobalshop.com`. Query parameters: `app_key`, `timestamp`
  (10 digits, within 5 minutes), `sign`, and `shop_cipher` (from `GET /authorization/202309/shops`).
  **Sign** = HMAC-SHA256 hex of `app_secret + path + sorted {key}{value} (excluding sign, access_token)
  + exact raw body + app_secret`, keyed by `app_secret`.
- **Orders.** `POST /order/202309/orders/search`: `page_size` 1-100, sort by `update_time` ASC,
  always set both `update_time_ge` and `update_time_lt`, overlap of at least 5 minutes, and URL-encode
  `page_token`. `GET /order/202507/orders` takes up to 50 ids. There are nine statuses. The ship date
  for accounting is `collection_time` (IN_TRANSIT). A refund that happens in transit ends as
  **COMPLETED, not CANCELLED**. Ready-to-ship gate = `AWAITING_SHIPMENT` and (`is_on_hold_order` or
  1 h since `paid_time`). Buyer PII is masked. Store only what accounting and packing need.
- **Webhooks.** TikTok POSTs to an HTTPS URL. The reply must be 200 with an empty body within 3 s.
  The `Authorization` header is the lowercase hex of HMAC-SHA256(`app_key + raw body`, `app_secret`).
  Retries come at +2 m, +30 m, +3 h and +12 h, then the event is dropped. Delivery is at-least-once;
  dedupe on `tts_notification_id`. Topics: `ORDER_STATUS_CHANGE` 1, `RECIPIENT_ADDRESS_UPDATE` 3,
  `CANCELLATION_STATUS_CHANGE` 11, `RETURN_STATUS_CHANGE` 12. **A reconciliation poll is mandatory.**
- **Finance.** Get Statements, Get Transactions by Statement,
  `GET /finance/202501/orders/{order_id}/statement_transactions` (SKU-level fees), Get Unsettled
  Transactions, and Get Payments (payouts to the bank). Unsettled orders do not appear in the
  statement APIs.
- **Returns.** Search Cancellations and Search Returns. A refund is recorded at
  `RETURN_OR_REFUND_REQUEST_COMPLETE`. Sellers must respond within 48 h, or TikTok approves
  automatically.
- **Rate limits** are dynamic. On HTTP 429 or code `36009002`, back off: use `Retry-After` if present,
  else exponential 1-60 s with jitter, at most 5 tries. A 503 is **not** a rate limit.

---

## 1. What exists today, and what this plan changes

| Area | Today | With this plan (TikTok only) |
|---|---|---|
| TikTok orders | Typed by hand in `/orders/new` (channel `tiktok`, marketplace number required, created at `to_ship`, stock leaves at once). The TikTok file adapter refuses every upload (`adapters/tiktok.ts`, O3). | Created and moved by the sync. A hand-typed order with the same number is **matched and updated**, never duplicated (same key as the import, marketplace-import.md §6). The file adapter keeps refusing. Its "column mapping" prerequisite (accounting.md §13) is dropped for TikTok. |
| Ship date (D-2) | `orders.shipped_at` = the moment of the transition. Accounting M1 waits as `marketplace_ship_date_missing` (Session 5 blocked). The loader hard-codes `marketplaceShippedAt: null` (`sales-loaders.ts`). | New nullable `orders.marketplace_shipped_at` = TikTok `collection_time`. The loader reads it, M1 posts on it, and the issue clears for TikTok. |
| Fees (D-5) | `order_channel_fees` are written by the file import (Shopee). | Written by the finance sync: per-SKU statement transactions are aggregated into the same six components. |
| Seller balance (D-11) | 1-1303 Saldo Penjual TikTok. Withdrawals (M3) are manual journals. | M3 posts from Get Payments. Statement-level adjustments get their own rule. Rekonsiliasi checks 1-1303 per order and per statement. |
| Returns | Manual Retur, or an import with `marketplace_return_pending`. | Driven by Search Returns/Cancellations, with the real return time stored. |

**Not changed:** `transitionOrderStatus` stays the only way an order changes status (CLAUDE.md).
Stock moves only through `decrementStockForOrderItems` / `restoreStockForOrderItems`. No TikTok code
writes `orders.status`, `stock_movements` or journals directly. Shopee import, the web checkout and
the posting rules for other channels are untouched.

**Out of scope (phase 1, decided Q15):** writing anything back to TikTok (accepting or rejecting
returns, arranging shipments, printing labels). Phase 1 is **read-only towards TikTok**. Packing keeps
printing the TikTok label in Seller Center, and return responses stay in Seller Center. **Stock sync**
(Ammari stock → TikTok) is a later phase with its own plan; it needs a product write scope.

---

## 2. Architecture

```
                         TikTok Shop
        webhooks (POST)  │           ▲  signed GET/POST (rate-limited)
                         ▼           │
apps/web  /api/integrations/tiktok/webhook ──► tiktok_webhook_events (inbox, deduped)
apps/web  /api/internal/tiktok/sync  (cron) ──► drains inbox + reconciliation poll + finance + token refresh
apps/admin /api/integrations/tiktok/callback ──► OAuth code → tokens (encrypted) → shops → shop_cipher
apps/admin Pengaturan > Integrasi TikTok Shop, Pemetaan SKU TikTok, Perlu dicek
                         │
packages/tiktok-shop  (server-only: sign, client, backoff, token crypto, response parsing; no DB writes)
packages/commerce/src/tiktok/  (DB write paths: snapshots, applyTikTokOrder → createOrder-like insert,
                                transitionOrderStatus, stock; fees; finance rows)
packages/accounting  (reads only: loader gains marketplace_shipped_at / _returned_at; new M3/M5 rules)
```

Decisions behind the layout:

- **The webhook and the cron route live in `apps/web`, not admin.** Every machine-to-machine
  endpoint already lives there: Midtrans notification, Biteship webhook, and every
  `/api/internal/*` cron route. The cron container only reaches `http://web:3000` (`cron.sh`). Prod
  admin is Cloudflare-only with origin mTLS, and dev admin sits behind Cloudflare Access. The public
  web host already serves webhooks, with a documented Access bypass per path on dev (SPEC §11). So
  the webhook URL is `https://ammari.id/api/integrations/tiktok/webhook`. **Decided (Q5):** the
  webhook URL is configured per app (Partner Center app page > Kelola Webhook). It may be on a
  different HTTPS domain from the redirect, but it must use a domain name (not an IP). No per-shop
  API registration is needed.
- **OAuth lives in `apps/admin`.** The redirect URL is registered there, and only a signed-in staff
  user with `integrations.manage` may connect a shop. The exchange happens inside the callback
  request because the code is valid for 30 minutes and works once.
- **A new `packages/tiktok-shop`** holds everything that talks to TikTok. It is pure apart from
  `fetch`, has no `@ammari/db` import, and is testable with a fake HTTP server. `packages/commerce`
  owns every write, because order and stock writes must sit next to `transitionOrderStatus` (CLAUDE.md
  monorepo rule). Neither package imports from `apps/*`.
- **Gating:** the integration is off unless its env vars are present and valid. Missing config makes
  the cron answer `503 {notConfigured}` and makes the webhook answer 503, so TikTok retries later
  (§8). This follows the Biteship/Midtrans config pattern and fails closed. Dev has no TikTok
  connection by default. T0 checks what the development shop allows (Q3).

---

## 3. Data model (migrations 0057-0061, expand-only)

Every table is new, and every change to an existing table is a nullable column or a CHECK widened to
a superset. The previously deployed release never reads them, so rollback stays safe (CLAUDE.md
expand/contract). Reference data (the permission, mapping keys, attention flags) ships **in the
migration** with `ON CONFLICT DO NOTHING`, never only in `seed.ts`. Each migration is generated with
`drizzle-kit generate` and read line by line before it is committed.

### 3.1 Connection and tokens (0057)

`tiktok_shop_connections`, one row per authorized shop. v1 expects exactly one shop; a partial
unique index allows one `active` row.

| Column | Notes |
|---|---|
| `id uuid pk` | |
| `shop_id text not null unique` | TikTok shop id (from Get Authorized Shops). |
| `shop_cipher text not null` | Sent on every shop-scoped call. Not a secret, but never logged with the token. |
| `shop_name text`, `region text` (`ID`), `seller_type text` | Display only. |
| `status text` CHECK in `active`, `reauth_required`, `deauthorized`, `disconnected` | |
| `access_token_ct bytea`, `refresh_token_ct bytea` | **Encrypted at rest** (§7.2). NULL once deauthorized or disconnected (wiped, not kept). |
| `access_token_expires_at`, `refresh_token_expires_at timestamptz` | From the token response. |
| `token_key_version smallint not null` | Which `TIKTOK_TOKEN_ENC_KEY_V<n>` encrypted the row (rotation). |
| `token_generation integer not null default 0` | Bumped by every refresh. A refresh writes only `WHERE token_generation = $seen RETURNING` (conditional update, no check-then-write). |
| `granted_scopes text[]` | From the token response; shown on the settings page. |
| `connected_by_staff_user_id`, `connected_at`, `last_refreshed_at`, `deauthorized_at`, `expiry_warning_at` | Audit and banner. |
| `last_webhook_at`, `last_poll_ok_at`, `last_error_code text`, `last_error_at` | Health on the settings page. Error **codes** only, never response bodies. |

`tiktok_oauth_states`: `state_hash text pk` (SHA-256 of a 32-byte random state; the raw value exists
only in the authorize URL and the browser), `staff_user_id`, `created_at`, `expires_at` (+10 min),
`used_at`. The callback consumes a state with
`UPDATE ... SET used_at = now() WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now() AND staff_user_id = $session RETURNING`.
A state works once, only for the staff user who started the connection, and is atomic.

`tiktok_sync_cursors`: `resource text pk` (`orders`, `returns`, `cancellations`, `statements`,
`payments`, `unsettled`), `window_end timestamptz` (everything below it is fully processed),
`last_run_at`, `last_ok_at`, `last_error_code`, `backfill_from timestamptz`.

Permission **`integrations.manage`** (group `settings`: connect, reconnect, disconnect, "Sinkronkan
sekarang"), inserted by the migration. The owner and super_admin hold it by default.

### 3.2 Webhook inbox (0057)

`tiktok_webhook_events`:

| Column | Notes |
|---|---|
| `id uuid pk` | |
| `tts_notification_id text not null unique` | Dedupe: `INSERT ... ON CONFLICT DO NOTHING`. |
| `type smallint not null` | Topic number (1, 3, 6, 7, 11, 12, or an unknown one, stored and ignored). |
| `shop_id text`, `tiktok_order_id text`, `timestamp_s bigint` | Parsed from the body. The order id is used for draining. |
| `payload jsonb` | The verified body **after the §6 allowlist** (no buyer data). Capped at 16 KB raw. |
| `received_at timestamptz default now()` | |
| `status text` CHECK in `pending`, `processed`, `ignored`, `failed` | |
| `attempts smallint`, `next_attempt_at`, `processed_at`, `last_error_code` | Retry with backoff. After 10 attempts → `failed`, shown on the settings page. |

Only a request whose signature verifies is stored. Rejected requests get one log line and nothing in
the database (same as the Biteship webhook). Retention: 12 months, added to the existing daily
retention job (`maintenance/retention.ts`).

### 3.3 Orders: projection, versioned snapshots, SKU mapping (0058)

`tiktok_order_snapshots` stores versioned, PII-stripped copies of an order:

| Column | Notes |
|---|---|
| `id uuid pk` | |
| `tiktok_order_id text not null` | |
| `update_time timestamptz not null` | TikTok's `update_time`, the version. |
| `content_sha256 text not null` | Hash of the allowlisted JSON (canonical key order). |
| `payload jsonb not null` | The **allowlisted projection** (§6). It is never the raw response. |
| `source text` CHECK in `webhook`, `poll`, `backfill`, `manual` | |
| `fetched_at timestamptz` | |
| UNIQUE `(tiktok_order_id, update_time, content_sha256)` | A replay of the same version is a no-op (`ON CONFLICT DO NOTHING`). The same `update_time` with different content is kept as its own row and flagged `tiktok_snapshot_conflict` (it should not happen; never silently chosen). |

Retention: kept as long as the order. These snapshots are the audit trail for accounting dates.

`tiktok_orders` is the current state, one row per TikTok order:
`tiktok_order_id text pk`, `order_id uuid null fk orders (restrict)` (set once applied),
`status text`, `latest_update_time timestamptz`, `latest_snapshot_id fk`, `paid_time`,
`collection_time`, `delivery_time`, `cancel_time`, `is_on_hold_order bool`, `rts_sla_time`
(ship-by deadline for packing), `apply_state text` CHECK in `applied`, `held`, `skipped_unpaid`,
`skipped_undone`, `held_reason text` (`unknown_sku`, `short_stock`, `lines_differ`, `final_in_admin`,
`partial_shipping`, `partial_refund`, `unknown_status`, `money_format`), `applied_update_time`,
`buyer_message text null` (CHECK `char_length <= 1000`, for packing, Q14) and
`buyer_message_purge_after timestamptz null` (set to the terminal time + 30 days when TikTok reports
`COMPLETED` or `CANCELLED`). `buyer_message` lives **only** in this column. It is never in a snapshot
or the inbox, so it can be purged.
**The projection only moves forward.** An update is written `WHERE latest_update_time < $new`, so an
older snapshot arriving late (webhook vs poll) never overwrites a newer one.

`tiktok_sku_mappings` maps a TikTok SKU to an Ammari variant:
`tiktok_sku_id text pk`, `tiktok_product_id text`, `seller_sku text` (as typed in TikTok),
`variant_sku text not null fk product_variants(sku)`,
`source text` CHECK in `auto_seller_sku`, `manual`, `mapped_by_staff_user_id`, `mapped_at`,
`is_active bool`. An exact (trimmed, uppercase) match of `seller_sku` to an active Ammari SKU is
auto-mapped and recorded as `auto_seller_sku`. This is the Daftar SKU workflow the wife already uses:
she fills Ammari's SKU into the TikTok listing. Anything else is held as `unknown_sku` until someone
maps it on **Pemetaan SKU TikTok** (reuses the "Cocokkan ke varian" picker from
marketplace-import.md §8.1; audited `tiktok_sku_map`). Changing a mapping never rewrites applied
orders, whose lines are locked once stock has left (marketplace-import.md §6). It affects only orders
still held or not yet applied. **Decided (Q12): one TikTok SKU = one Ammari variant, no bundles.** The
primary key on `tiktok_sku_id` enforces this, and there is no 1→n table. Two TikTok SKUs (two
listings) may point at the same variant.

### 3.4 Order columns for real dates (0059)

These generalize Session 5's planned columns. The names are final here, and Shopee's Session 5 can
reuse them later.

- `orders.marketplace_shipped_at timestamptz NULL`: TikTok `collection_time`.
- `orders.marketplace_completed_at timestamptz NULL`: reference and reconciliation only (D-1).
- `orders.marketplace_returned_at timestamptz NULL`: when the return/refund reached
  `RETURN_OR_REFUND_REQUEST_COMPLETE` (closes accounting.md §9 "marketplace returns keep the import
  time" for TikTok).

The app's own `shipped_at` / `completed_at` / `returned_at` are never overwritten, so management
screens keep working (Session 5 rule). The ship time is written **once**: the update is conditional on
`marketplace_shipped_at IS NULL`. A different later `collection_time` is flagged
`tiktok_ship_time_changed`, not overwritten.

`ORDER_ATTENTION_FLAGS` gains `tiktok_on_hold` (not yet packable), `marketplace_partial_return`,
`marketplace_review` (with a reason: multi-package/partial shipping, Q2), `tiktok_return_response_due`
and `marketplace_return_in_transit` (a failed delivery or return coming back: stock waits for the
parcel, Q11). The CHECK is dropped and re-added with the superset in the same file (the pattern from
migration 0040).

`marketplace_refunds` (new, in 0059) records **refund-only** money, where the goods stay with the
buyer (Q10). The admin lifecycle cannot express this: `returned` always restores stock.

| Column | Notes |
|---|---|
| `id uuid pk` | |
| `order_id uuid not null fk orders (restrict)` | |
| `channel_id text` | `tiktok` (Shopee may reuse it later) |
| `channel_refund_id text not null` | TikTok return/refund id. UNIQUE `(channel_id, channel_refund_id)` makes a replay a no-op. |
| `kind text` CHECK in `refund_only` | Only this kind in v1. Partial returns with goods stay manual review. |
| `amount bigint not null > 0` | Whole rupiah, refused if not an integer (Q6). |
| `refunded_at timestamptz not null` | The time of `RETURN_OR_REFUND_REQUEST_COMPLETE`. |
| `created_at` | |

Writing a row leaves the order's status and its stock **untouched**. Rows are append-only. How a
TikTok-side correction of a completed refund is recorded is decided in T6's `/plan`; v1 does not
expect corrections.

### 3.5 Finance (0060)

- `tiktok_statements`: `statement_id text pk`, `statement_time`, `settlement_amount bigint`,
  `revenue_amount`, `fee_amount`, `adjustment_amount`, `payment_status text`, `payment_id text null`,
  `currency text` CHECK `= 'IDR'`, `payload jsonb` (allowlisted), `fetched_at`.
- `tiktok_statement_transactions`: `id text pk` (TikTok's transaction id),
  `statement_id fk`, `type text` (order, refund, adjustment, …, stored as received), `tiktok_order_id
  text null`, `order_id uuid null fk orders`, the parsed `bigint` amounts the accountant needs, and
  `payload jsonb` (allowlisted).
- `tiktok_order_fee_lines`: `(tiktok_order_id, tiktok_sku_id, fee_type)` unique, `amount bigint`,
  `source text` CHECK in `estimate` (Get Unsettled Transactions), `actual` (statement transactions),
  `fetched_at`. This is the raw grain. It is aggregated into `order_channel_fees` (existing table,
  unchanged) by the fixed mapping in §5.3. Raw `fee_type` values without a mapping hold the order's
  fees as `fee_type_unmapped` (never `other` by default).
- `tiktok_payouts`: `payment_id text pk`, `amount bigint`, `paid_time`, `status`,
  `bank_account_last4 text`, `payload jsonb` (allowlisted, without the full account number).

`order_channel_fees` needs no new column. Fee work A plans its own `source` column on that table
(accounting.md §1.2). This plan deliberately does not add one, so the two features cannot collide.
Provenance lives in `tiktok_order_fee_lines`.

### 3.6 Accounting reference data (0061)

- Mapping key `cash.tiktok_payout` → 1-1201 Bank utama. **Decided (Q17): payouts always go to Bank
  utama.** The key exists so the accountant can point it at a sub-account. It is inserted with
  `ON CONFLICT DO NOTHING`.
- Mapping keys `tiktok.adjustment.<type>` have **no default row**. The accountant maps each type in
  **Pemetaan Akun**, and an unmapped type is a posting issue (Q8). The types are a closed set known
  only from real statements, so the migration ships none. T8 makes Pemetaan Akun list every type seen
  in `tiktok_statement_transactions` that is still unmapped. The owner decided that **ads paid from
  the balance** go to the ads expense account (6-1101 Iklan, the account of category `ads_tiktok`).
  The accountant maps that type there like every other type. The editor shows 6-1101 as the
  suggested target for types whose name marks them as ads; this is a suggestion only, never an
  automatic mapping.
- No new accounts. 1-1303 Saldo Penjual TikTok, 4-1103 Penjualan TikTok, 6-1201 and 6-1202 already
  exist (accounting.md §3).

---

## 4. How a TikTok order flows into orders and stock

### 4.1 Intake (webhook, poll, backfill all end in one function)

1. **Webhook** (topics 1, 11, 12). Verify, store in the inbox, reply 200 with an empty body (§8.1).
   The request path makes **no API call and no order write**, so the 3-s budget holds. After the
   reply (`after()`, as the Biteship webhook does), it drains that one order (step 3). Anything left
   over is drained by the cron.
2. **Reconciliation poll** (mandatory, cron, §9). Search orders by `update_time` windows. Every order
   id seen goes to step 3. Webhooks only make the poll faster; correctness never depends on them.
3. `syncTikTokOrders(ids)`: Get Order Detail in batches of ≤ 50. Allowlist each order (§6) and insert
   its snapshot. Move the projection forward. Then `applyTikTokOrder(orderId)`.

### 4.2 `applyTikTokOrder`: pure decision + one transaction

The function is split like the import (`status-rules.ts` + `commit.ts`):

- **`decideTikTokOrder(snapshot, adminOrder, mappings, stock, now)`** is pure and table-tested. It
  returns `create | update | unchanged | hold(reason) | skip(reason)` with the list of
  `transitionOrderStatus` steps. It reuses `forwardPath` and the import's rules: only forward,
  terminal stays terminal, and cancel after shipping is `returned` (marketplace-import.md §3).
- **`commitTikTokOrder`** opens one transaction and takes
  `pg_advisory_xact_lock(hashtext('tiktok-order:' || tiktok_order_id))`, so the webhook drain and the
  cron poll on the same order run one after the other. It re-reads under the lock (it never trusts a
  pre-lock read), locks the order row and then the SKUs in sorted order (the same order as the
  import, so no deadlock with payments or stock counts), with `lock_timeout` 10 s. Then it inserts
  with `INSERT ... ON CONFLICT (channel_id, channel_order_no) DO NOTHING RETURNING` and makes every
  change with a conditional `UPDATE ... WHERE ... RETURNING`. Drift → roll back and retry on the next
  drain. It never checks and then writes (CLAUDE.md).
- It records `tiktok_orders.apply_state`, writes one `audit_log` row per order (`tiktok_create`,
  `tiktok_update`, actor NULL, `after.source = webhook|poll|backfill`), and writes `channel_status` =
  the raw TikTok status and `channel_synced_at`.

### 4.3 Status mapping (TikTok → admin)

TikTok has nine statuses. The code handles **both ON_HOLD flows** (decided, Q1): an `ON_HOLD` status,
and `AWAITING_SHIPMENT` with `is_on_hold_order`. T0 checks on the development shop which one Indonesia
uses. Statuses not in this table are held as `unknown_status`, never guessed.

| TikTok status | New order (not in admin) | Existing admin order |
|---|---|---|
| `UNPAID` | Skip (not a sale yet, same rule as Shopee) | No change |
| `ON_HOLD` | **Create at `to_ship`, stock leaves** (paid), flag `tiktok_on_hold` | No status change; set the flag |
| `AWAITING_SHIPMENT` | Create at `to_ship`, stock leaves. Packable once the gate passes (§4.4) | No change if already `to_ship` or later |
| `PARTIALLY_SHIPPING` | Create at `to_ship`, flag `marketplace_review` (`partial_shipping`) | Flag `marketplace_review`. **Decided (Q2): manual review only, no automation.** Also applied to any order whose packages carry more than one package id. No status moves until the order reaches a single-package status (`IN_TRANSIT` and later): the owner settles it by hand |
| `AWAITING_COLLECTION` | Create at `to_ship` | No change (label printed, waiting for the courier) |
| `IN_TRANSIT` | Create → `shipped` | `to_ship → shipped`, and **`marketplace_shipped_at = collection_time`**. No `collection_time` → stays shipped, M1 stays an issue, never another timestamp (Q13) |
| `DELIVERED` | Create → `shipped` | Stays `shipped`. Stores `delivery_time` in the projection only |
| `COMPLETED` | Create → `shipped → completed` | → `completed`, `marketplace_completed_at`. **A COMPLETED order may still carry a refund made in transit** (§0), so COMPLETED never clears a return. Returns come only from §4.5 |
| `CANCELLED` | Skip (it never existed for us) | Before shipping: `→ cancelled` (stock restored). After shipping (a failed delivery): **no status change yet** (decided, Q11). Set `marketplace_returned_at = cancel_time` and the flags `marketplace_return_pending` + `marketplace_return_in_transit`. The order goes `→ returned`, which restores stock, only when staff confirm the parcel is physically back (§4.5 "Retur diterima") |

Lines: TikTok line items are grouped per mapped variant SKU (same merge rule as the import,
marketplace-import.md §4). Once the order exists, lines are **never** changed. A difference is held as
`lines_differ`, and the order is untouched (import decision 6).

Amounts (decided, Q7: seller item discounts → Potongan penjualan 4-1201, D-4):
- `unit_price` = TikTok's original (list) price per piece. `list_unit_price` = NULL.
- `subtotal_amount` = Σ qty × `unit_price`.
- `discount_amount` = **every seller-funded discount**: item-level seller discounts and seller
  vouchers. S3/M1 debits it to 4-1201. Platform discounts and coins are TikTok's and are not recorded.
  This differs on purpose from web product discounts, which sit inside `unit_price`.
- `shipping_amount = 0`. Buyer ongkir is pass-through.
- `total_amount = subtotal − discount`.

The invariant tested later in T8 is that `total_amount` equals what TikTok credits before fees
(reconciled per order).

### 4.4 Stock deduction timing (decided, Q1)

- **Decided: stock leaves when TikTok first reports the order paid** (`ON_HOLD` or `AWAITING_SHIPMENT`, i.e.
  `paid_time` set and not cancelled). The admin order is created at `to_ship` through the existing
  `decrementStockForOrderItems`, so S1 posts to 1-1505 as for every channel. Reason: from that moment
  TikTok has sold the piece, and leaving it on Ammari's shelf for an hour lets the website sell the
  same last unit (marketplace paths check physical stock only, SPEC §5.2). A buyer cancelling within
  the hold window causes `to_ship → cancelled`, whose exact-negation return movement nets S1 to zero.
  That is harmless.
- **The packing gate is separate from stock.** An order shows as packable on `/packing` only when
  the gate holds: **`AWAITING_SHIPMENT` and (`is_on_hold_order` or 1 h since `paid_time`)**, exactly
  as decided (Q1). The predicate is one pure function, `tiktokReadyToShip(order, now)`. Its truth table
  is checked in T0 against real orders on the development shop before T5 relies on it (§12 Q1). If
  that check shows a different meaning of `is_on_hold_order`, only this function and its tests change.
  Until the gate passes, the order shows "Tunggu: pembeli masih bisa membatalkan (sampai 14.32)" and the
  `tiktok_on_hold` flag. The cron re-evaluates the gate, because no webhook fires when an hour
  passes.
- **Short stock:** the ledger refuses a sale below 0. The order is held as `short_stock` in Perlu
  dicek with a link to `/stock?q=SKU`. TikTok still expects the order to ship, so this is a loud
  dashboard item, not a silent skip. The next drain or poll picks it up once stock is recorded.
- **Unknown SKU:** held as `unknown_sku`. No stock moves until it is mapped. Once mapped, the order
  applies on the next drain.

### 4.5 Cancellations and returns (T6)

- Search Cancellations and Search Returns are polled by `update_time` windows (same cursor mechanics
  as orders), and webhook topics 11/12 trigger them. They are stored as allowlisted snapshots in the
  same snapshot table with `kind` (column added in 0059).
- **The refund is recorded at `RETURN_OR_REFUND_REQUEST_COMPLETE`.** `marketplace_returned_at` = the
  time TikTok reports for that state. A cancel before shipping → `→ cancelled` (stock restored).
- **Return with goods** (decided, Q10: per D-7, Retur penjualan + HPP back at the original cost). The
  money side is dated `marketplace_returned_at`. The stock side follows the Q11 principle: **stock comes
  back only when the parcel is physically received**. Until then the order keeps
  `marketplace_return_pending` + `marketplace_return_in_transit`. **Decided (Q18, owner, 27 Nov 2026):**
  this applies to returns with goods as well as failed deliveries.
- **"Retur diterima"** is an action on the order page and in Perlu dicek (staff with `orders.manage`).
  It runs `transitionOrderStatus(→ returned)`, which writes the exact-negation return movements and
  clears both flags. It is offered only while `marketplace_return_in_transit` is set. A parcel that never
  comes back stays visible in Perlu dicek, sorted by age. Writing it off (lost) is a stock adjustment
  by the owner, never automatic.
- While the request is still open, the order carries `marketplace_return_pending` (existing flag), and
  `tiktok_return_response_due` until its 48-h deadline. Perlu dicek lists open requests sorted by
  deadline ("Perlu direspons di Seller Center sebelum Sabtu 14.00"). Phase 1 does not respond through
  the API (decided, Q15). The response stays in Seller Center.
- **Refund-only** (decided, Q10: money back, goods stay with the buyer). At
  `RETURN_OR_REFUND_REQUEST_COMPLETE` the sync writes one `marketplace_refunds` row (§3.4) with the
  refunded amount and time. The order's status and stock are untouched, and HPP is not reversed. The
  ledger posts Retur penjualan on that date (§5.2, rule S7). The flag `marketplace_return_pending` is
  cleared.
- **Partial return with goods** (some items back), or anything TikTok reports that fits neither
  path: flag `marketplace_partial_return`, manual review. Nothing moves automatically.

---

## 5. How TikTok feeds the accounting engine (replaces Session 5 for TikTok)

The ledger stays **derived**. Nothing here calls the engine. The engine reads new columns and new
tables on its normal 15-minute run.

### 5.1 M1 / S3 revenue at handover (D-1, D-2)

- `sales-loaders.ts` reads `orders.marketplace_shipped_at` instead of the hard-coded `null`.
  `recognitionDate()` already returns `jakartaDateOf(marketplaceShippedAt)` for marketplace orders,
  so **the rule code does not change and `SALES_RULE_VERSION` is not bumped**. A bump would reverse
  and repost every sales journal. Test: every existing journal is a no-op after the loader change.
- So for TikTok, M1 posts Dr 1-1303 `total_amount` · Dr 4-1201 discount / Cr 4-1103 subtotal, plus
  HPP Dr 5-1101 / Cr 1-1505, dated by the Jakarta date of `collection_time`. Every TikTok order
  shipped since 1 Dec that is now `marketplace_ship_date_missing` clears once the backfill (T9) fills
  its `collection_time`.
- Shopee keeps reading NULL until its own Session 5. This loader change is per column, not per
  channel.

### 5.2 Returns (S4) and refund-only (new rule S7) (decided, Q10/Q11)

- **Return with goods, and a failed delivery (D-7).** S4 (Retur penjualan, Cr 1-1303 clawback) posts
  once the admin order is `returned`. For TikTok that happens at "Retur diterima" (§4.5). The loader
  passes `marketplace_returned_at ?? returned_at` as the return date, so S4 is dated by TikTok's
  `RETURN_OR_REFUND_REQUEST_COMPLETE` / cancel time. This is a data-level change with no rule bump.
  S2 (HPP back at the original cost) is dated by the return movement, i.e. physical receipt. Between
  the two dates the revenue is already reversed while the HPP is still expensed; the goods are on
  their way back. If the parcel comes back in a later month than TikTok's date, S2 lands in that
  later month. A month that is already closed → the first open month (D-23, engine behaviour).
- **Refund-only (new rule S7 `marketplace_refund`)** (`marketplace_refund`, id, `refunded`), dated
  by the Jakarta date of `refunded_at`: Dr 4-1301 Retur penjualan / Cr 1-1303 Saldo Penjual TikTok,
  the refunded `amount`. The goods stay with the buyer, so there is **no stock return and no HPP
  reversal** (no S2). The order stays `shipped`/`completed`. It is its own rule and source type, so
  `SALES_RULE_VERSION` is unchanged. It is held behind M1 (`requiresActiveJournalAcrossBooks`, like S4)
  while M1 is a posting issue.
- **Management P&L** (decided, Q19, owner, 27 Nov 2026): a refund-only order keeps its status, so T8
  makes Ringkasan (and every figure built from the shared `revenue-sql.ts` fragments) **subtract
  `marketplace_refunds.amount`**, by the Jakarta date of `refunded_at`, from the order's channel's
  revenue. The management P&L then matches the ledger's Retur penjualan. Rekonsiliasi check 4 assigns
  S7's 4-1301 lines to that same component, so it shows no difference.

### 5.3 M2 fees on the sale date (D-5)

- Fees are dated by M1's date (unchanged rule). They arrive from the finance sync, usually after
  shipping.
- **Estimate, then actual** (decided, Q9, the same pattern as the MDR, D-8). Get Unsettled Transactions
  provides fee lines for unsettled orders (`source = estimate`). The statement transactions replace
  them (`actual`). `order_channel_fees` holds actual if present, else estimate. The engine's normal
  reverse + repost handles the change, and a closed month gets the difference in the first open
  month (D-5, D-23). Month close **warns** while a shipped TikTok order in the month has only estimated
  fees, the same pattern as the MDR estimate warning (D-8). An order shipped with no estimate yet
  (unsettled data not fetched) has no M2 until one arrives. It is never posted as zero fees.
- **Fees → 6-1201 Biaya platform marketplace** (decided, Q8 "Beban biaya marketplace", D-5). Every
  TikTok fee type goes to one of the components that M2 already sends to 6-1201 (`admin_fee`,
  `service_fee`, `platform_commission`, `affiliate_commission`, `other`). The exception is
  `seller_shipping_subsidy`, which stays 6-1202 (D-6, unchanged). The fee-type → component table lives
  in code. Its rows are filled in T7 from the fee types actually seen on the development shop's
  statements, and the accountant reviews it once. The transaction/payment fee is **not**
  `payment_gateway_fee`, which is Midtrans W2 only. An unknown `fee_type` holds the order's fees
  (`fee_type_unmapped`). It is never summed into `other` silently.

### 5.4 M3 payouts and statement adjustments (D-11)

- **New rule M3 `tiktok_payout`** (`tiktok_payout`, payment_id, `paid_out`), dated by the Jakarta
  date of `paid_time`: Dr `cash.tiktok_payout` (1-1201 Bank utama, decided Q17) / Cr 1-1303, `amount`. This replaces the
  manual withdrawal journal for TikTok. The manual-journal template stays for Shopee. **Cut-over:**
  payouts before 1 Jan 2027 are in the opening balance (the engine's cut-over filter).
- **New rule M5 `tiktok_adjustment`** (`tiktok_statement_transaction`, id, `adjustment`) for statement
  transactions that are not an order or a refund (compensation, deductions, ads paid from the
  balance, …). The accountant maps every type in **Pemetaan Akun** through `tiktok.adjustment.<type>`
  (decided, Q8). Ads paid from the balance map to the ads expense account (6-1101 Iklan). An unmapped
  type → posting issue `tiktok_adjustment_unmapped`, never guessed. An ad already recorded as a
  business expense with channel `tiktok` also posts as M4 (Cr 1-1303). The Rekonsiliasi page lists
  M5 ads lines next to M4 expenses of the same month and amount, so one of the pair is removed and it
  is never booked twice.
- **Rekonsiliasi** (new section "TikTok Shop"):
  - (a) per order: the 1-1303 lines for the order vs the statement's settlement for it (= total −
    fees − refunds);
  - (b) per statement: Σ transactions = settlement amount;
  - (c) per payout: payout amount = Σ statements paid by it;
  - (d) 1-1303 balance vs (Σ unsettled + settled-not-paid-out). Each red line links to the order or
    the statement.
- The opening balance of 1-1303 on 31 Dec 2026 can be proposed from the API (unsettled +
  settled-not-paid-out at that date) instead of being typed from the dashboard. It is still
  confirmed by hand in the Saldo awal wizard (accounting.md §13 step 7).

### 5.5 What changes in accounting.md once this ships

Session 5's row gets "TikTok: replaced by tiktok-shop-integration.md T5/T8; Shopee still blocked".
§9's return-date risk becomes Shopee-only. §13's "full TikTok column mapping" item is dropped. That
doc edit is part of T8, not this plan.

---

## 6. PII: store only what accounting and packing need

Buyer data from TikTok is masked anyway. Ammari stores **none** of it, the same as imported orders
(`customerId`, `buyerUsername`, `shippingAddress`, `notes` = NULL; marketplace-import decision 9).
Every TikTok payload (snapshot, webhook, finance) passes through **one allowlist per payload type**
before it touches the database. Fields not on the list are dropped, including fields TikTok adds
later.

- **Kept for orders:** order id, status, the timestamps (`create`, `paid`, `update`, `collection`,
  `delivery`, `cancel`, `rts_sla`), `is_on_hold_order`, cancel reason code, line items (ids, seller
  SKU, product/SKU name, qty, prices and seller/platform discount amounts), payment amounts,
  package/shipping provider name, tracking number, delivery option, fulfillment type.
- **Dropped:** recipient name, address, phone, email, `user_id`, and any field not on the list.
- **`buyer_message`** (decided, Q14) is kept for packing, and **only** in
  `tiktok_orders.buyer_message`. It is shown on the packing page and the order page. It is stripped
  from snapshots and never logged. The daily retention job sets it to NULL once
  `buyer_message_purge_after` (30 days after TikTok reports `COMPLETED` or `CANCELLED`) has passed. An
  order that leaves a terminal status again, which TikTok should never do, is flagged, not un-purged.
- A test feeds a fixture full of buyer fields through every allowlist and asserts that none of them
  survives, including inside nested objects and arrays.
- `RECIPIENT_ADDRESS_UPDATE` (3) is stored in the inbox and marked `ignored`, since we hold no
  address. Labels stay in Seller Center in phase 1 (decided, Q15).

---

## 7. Secrets

### 7.1 Environment variables (never committed, never logged)

| Var | Where | Notes |
|---|---|---|
| `TIKTOK_APP_KEY` | web.env, admin.env | Not secret on its own, but kept with the secret. |
| `TIKTOK_APP_SECRET` | web.env, admin.env | Signs requests and verifies webhooks. |
| `TIKTOK_SERVICE_ID` | admin.env | For the authorize link. **Decided (Q4): the app ID shown in Partner Center, `7712559784284669716`, not the App Key.** Not secret: it is in the authorize URL. It is still an env var so dev and prod can differ. |
| `TIKTOK_TOKEN_ENC_KEY_V1` | web.env, admin.env | 32 random bytes, base64. New, generated on the owner's Mac into `~/ammari-secrets/tiktok-token-enc-key-v1`. |
| `TIKTOK_TOKEN_ENC_KEY_CURRENT` | both | `1`. Rotation adds `_V2`, re-encrypts, then retires `_V1`. |

- They are set by the owner with `deploy/set-env-var.sh` / `deploy-prod/upload-prod-env.sh`, reading
  from `~/ammari-secrets`. An agent never reads those files, never echoes a value, and never puts one
  on a command line (the `cron.sh` header-file pattern). `.env.example` and the `*.env.example` files
  get the names with empty values.
- A config module (`packages/tiktok-shop/src/config.ts`) validates presence and format once and
  returns `{ configured: false, problem }` otherwise. Secret values are wrapped in a `Secret` type
  whose `toString`, `toJSON` and `util.inspect` all return `[redacted]`.
- **Never logged:** the app secret, tokens, `sign`, the `Authorization` header of a webhook, the
  authorization code, the OAuth `state`, or a full request URL (its query holds `sign` and
  `app_key`). Client errors carry `{ path, httpStatus, code, requestId }` only. A test captures
  `console.*` during a failing call, a refresh and a callback, and asserts that no secret or token
  string appears in it.

### 7.2 Tokens at rest

AES-256-GCM with a random 12-byte IV per encryption and AAD = `connection_id || column_name`, so a
ciphertext cannot be swapped between rows or columns. Stored as `bytea` = `version byte | iv | ct |
tag`. Decryption fails closed: a tampered or wrong-key value → `reauth_required`, never a crash loop.
Backups therefore hold only ciphertext. Deauthorize or disconnect wipes both columns.

### 7.3 OAuth flow (admin)

1. "Hubungkan TikTok Shop" (requires `integrations.manage`, server-checked) creates a state row and
   redirects to the authorize link.
2. The callback is a GET with `code` and `state`. It requires a staff session with
   `integrations.manage` (middleware already keeps customer sessions out of admin), consumes the
   state atomically, and exchanges the code with `grant_type=authorized_code`. Then it calls
   `GET /authorization/202309/shops`, then upserts the connection under
   `pg_advisory_xact_lock('tiktok-connection')`, and writes audit `tiktok_connect`.
3. Any failure redirects to the settings page with an Indonesian message and an error code, never
   TikTok's raw body. A replayed code fails at TikTok and shows "Kode sudah dipakai, ulangi
   Hubungkan".
4. Refresh happens in the cron when the access token has < 24 h left, or once on an auth-error
   response, under the advisory lock `tiktok-token`. The write is conditional on `token_generation`,
   so two refreshers never both rotate. A refresh token that is about to expire, or topic 7, shows a
   banner on the admin home and Integrasi ("Hubungkan ulang sebelum …"). Topic 6 (deauthorization)
   wipes the tokens, sets `deauthorized`, stops sync and shows a red banner.

### 7.4 Runbook: setting up the connection (T0, owner)

T2 built the connection; nothing reaches TikTok until the owner sets these. Values come from
`~/ammari-secrets` and are never echoed, pasted into a chat or put on a command line.

1. **Generate the token encryption key once**, on the owner's Mac (the agent never runs this):

   ```bash
   (umask 077; openssl rand -base64 32 > ~/ammari-secrets/tiktok-token-enc-key-v1)
   ```

   Losing it means every stored token becomes unreadable: the connection shows "Perlu dihubungkan
   ulang" and the owner reconnects (nothing else is lost). Keep it with the other secrets backups.
2. **admin.env** (dev with `/opt/ammari/set-env-var.sh`, prod with `deploy/set-env-var.sh` into
   `~/ammari-secrets/prod-admin.env`, then `deploy-prod/upload-prod-env.sh`), names as in
   `deploy/env/admin.env.example` / `deploy-prod/env/admin.env.example`:
   - `TIKTOK_APP_KEY` from `~/ammari-secrets/tiktok-app-key`
   - `TIKTOK_APP_SECRET` from `~/ammari-secrets/tiktok-app-secret`
   - `TIKTOK_SERVICE_ID` = the Partner Center app ID (Q4), not the App Key
   - `TIKTOK_TOKEN_ENC_KEY_V1` from `~/ammari-secrets/tiktok-token-enc-key-v1`
   - `TIKTOK_TOKEN_ENC_KEY_CURRENT=1`
3. **web.env** gets the same `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET`, `TIKTOK_TOKEN_ENC_KEY_V1` and
   `TIKTOK_TOKEN_ENC_KEY_CURRENT` when T3 ships (webhook and cron). The key must be identical in both
   files, or the cron cannot read what the admin stored.
4. Restart admin, open **Administrasi > Integrasi TikTok**, press **Hubungkan TikTok Shop**, approve
   in TikTok. The callback is the registered redirect URL (§0), so this works only on the host
   registered in Partner Center (prod admin); what dev can use is checked in T0 (Q3).
5. To verify in T0, on the first real connect: the token response's field names and that
   `access_token_expire_in` / `refresh_token_expire_in` are absolute Unix seconds
   (`packages/tiktok-shop/src/auth.ts` refuses anything else as `invalid_response` and the page shows
   `kode: invalid_response`), and the envelope codes TikTok uses for an expired access token
   (passed to the API client as `authErrorCodes` in T4).
6. **Key rotation:** add `TIKTOK_TOKEN_ENC_KEY_V2` (same command, new file), set
   `TIKTOK_TOKEN_ENC_KEY_CURRENT=2`, restart, reconnect (or let the next refresh re-encrypt with V2),
   then remove `_V1` once `token_key_version` is 2 on the connection row.

### 7.5 Runbook: the webhook (T3, owner)

1. **web.env** (dev `/opt/ammari/set-env-var.sh env/web.env NAME < file`; prod `deploy/set-env-var.sh`
   into `~/ammari-secrets/prod-web.env`, then `deploy-prod/upload-prod-env.sh`): `TIKTOK_APP_KEY`,
   `TIKTOK_APP_SECRET`, `TIKTOK_TOKEN_ENC_KEY_V1` and `TIKTOK_TOKEN_ENC_KEY_CURRENT`, **the same values
   as admin.env** (§7.4 step 3). Names as in `deploy/env/web.env.example` /
   `deploy-prod/env/web.env.example`. Restart web. Without them the webhook answers 503 and logs
   `[tiktok] webhook not configured` with the variable names (never values).
2. **Partner Center > Kelola Webhook** (per app, Q5): `https://ammari.id/api/integrations/tiktok/webhook`.
   Dev, if T0 shows the Draf app can point a webhook at dev: `https://ammari.my.id/api/integrations/tiktok/webhook`.
3. **Caddy:** nothing to change. The public web block routes every path except `/api/internal/*`,
   `/api/test/*` and `/api/revalidate`, so this path reaches web on both hosts.
4. **Cloudflare Access (dev only):** if `https://ammari.my.id` shows an Access login, add a
   Self-hosted application for domain `ammari.my.id`, path `api/integrations/tiktok/webhook`, one
   policy, action **Bypass**, include **Everyone**: exactly that path, as for Midtrans and Biteship
   (`docs/launch/checkout-dev.md` A5). Bot Fight Mode: same advice as there (A5.2), with this path.
5. **Check:** the Integrasi page shows "Webhook terakhir" after TikTok's first delivery; the web log
   has one `[tiktok] webhook` line per post with `result` (`stored`, `duplicate`, `bad_signature`,
   `unknown_shop`, `db_failed`, ...). A run of `bad_signature` means the App Secret in web.env differs
   from Partner Center; `unknown_shop` means no shop is connected yet (TikTok's events are refused
   until §7.4 step 4).

**T3 build notes.**
- Answers (all with an empty body): 200 stored or duplicate, or signed but unusable (malformed JSON,
  no `tts_notification_id`/`shop_id`: logged, left to the poll); 401 bad/missing signature or a shop
  with no connection row (any status: a late event for a deauthorized shop is stored and acts on
  nothing); 400 body not complete within 2 s (slow-drip sender); 413 over 64 KB; **415 anything but
  `application/json`** (not in §8.1; TikTok posts JSON); 503 not configured, database error, or no
  database answer within 2.5 s of the request's start. A signed but unusable body is logged at
  `error` (it is TikTok's own and lost for good).
- The request does one statement (`recordTikTokWebhookEvent`: shop check + `INSERT ... ON CONFLICT
  (tts_notification_id) DO NOTHING`). Topic 3 and unknown topics are stored `ignored`; 1, 6, 7, 11, 12
  `pending`. The inbox payload is the body after `TIKTOK_WEBHOOK_ALLOWLIST` (ids, statuses, times
  only); a payload over half the 16 KB column cap is stored as NULL with `last_error_code`
  `payload_too_large`, one jsonb would refuse (NUL, lone surrogate, a huge number) as NULL with
  `payload_unstorable`, so a signed delivery never fails the insert.
- After the answer (`after()`, each step isolated): "last webhook" (skips a row a token refresh
  holds), topics 6/7 through T2's `deauthorizeTikTokShop` / `recordTikTokExpiryWarning` dated by the
  event's `timestamp` (never later than receipt), then any pending 6/7 event that is due
  (`processDueTikTokConnectionEvents`, one sweep per process at a time, one event's failure never
  stops the others). A **duplicate** delivery runs that sweep too, so TikTok's redelivery of an event
  whose processing was lost (restart before `after()`, or an insert that committed after a 503)
  applies it. Both T2 writes now wait at most 3 s for the row (`lock_timeout`; a refresh holds it
  during its TikTok call) and refuse an event more than 60 s older than the connection's
  `connected_at` (second-resolution timestamps and clock skew), so a late deauthorization never wipes
  a newer reconnect; such a skip is logged as a warning (`stale`). A failing write retries with
  backoff (1, 2, 4 ... min, ≤ 6 h) and is `failed` after 10 attempts (logged at `error`).
  Orders (1, 11, 12) stay `pending` for T4.
- **Left for T4** (review notes): until the sync cron exists, a due 6/7 retry runs only on the next
  delivery; T4's cron must call `processDueTikTokConnectionEvents`, and its settings-page health (§8.3)
  must show `failed` inbox events. The inbox is a hint only: T4-T6 re-fetch the order and never trust
  the body (a delivery replayed after the 12-month purge is re-inserted as `pending`). A request that
  hits the 2.5 s budget leaves its statement running until Postgres finishes it (no
  `statement_timeout` on the shared pool); the late commit is deduped on TikTok's retry.
- No migration: the 0057 indexes (`pending_idx` on `next_attempt_at` where pending, `received_at_idx`)
  already serve the sweep and the 12-month retention rule (`tiktok_webhook_events` in
  `maintenance/retention.ts`).

---

## 8. Failure handling

### 8.1 Webhook endpoint

- Body capped at 64 KB (read with the existing `readCappedBody`). The signature is checked over the
  **exact raw bytes** (no re-serialization), compared with `timingSafeEqual` on equal-length buffers.
  The header must be 64 lowercase hex characters, otherwise it is rejected.
- Valid signature and inserted, or a duplicate → **200 with an empty body**.
- Invalid signature, or a `shop_id` that is not ours → 401 with an empty body and one log line
  (reason only).
- Database failure or integration not configured → **503**. TikTok retries at +2 m/+30 m/+3 h/+12 h.
  This is unlike Biteship, where we always answer 200, because Biteship never retries. Once TikTok
  drops an event, the reconciliation poll still finds the order.
- Unknown topic → stored as `ignored`. Malformed JSON with a valid signature → 200, logged, and left
  for the poll to catch.

### 8.2 API client

- Per request: 10-s timeout. On 429 or `code 36009002`: `Retry-After` if present, else exponential
  1-60 s with full jitter, at most 5 tries, then `rate_limited`.
- **503 is not a rate limit:** 2 short retries (1 s, 3 s), then `unavailable`. Other 5xx are handled
  the same way. Network errors: 2 retries.
- An auth error → one refresh + one retry, then `reauth_required`. Any other non-zero `code` → a
  typed `TikTokApiError(code, requestId)`, no retry.
- Clock: `timestamp` = `Math.floor(now/1000)`. A timestamp-out-of-window error is logged as
  `clock_skew` (the server uses NTP).
- Each run has a time budget (stops starting new calls after 150 s, like the shipping poll) because
  it holds the shared cron lock.

### 8.3 Sync

- The cursor advances only after a window slice has been fully fetched **and** applied. Windows are
  sliced to ≤ 6 h. Each run starts at `window_end − 5 min` (overlap ≥ 5 min, §0) and ends at
  `now − 2 min`, with both bounds always set. `page_token` is URL-encoded. A failure mid-slice leaves
  the cursor where it was, and the next run repeats the slice; snapshots and apply are idempotent.
- A held order (unknown SKU, short stock, lines differ, …) does not block the cursor. It stays held in
  `tiktok_orders`, the cron retries held orders each run, and they show in Perlu dicek with the reason.
- Inbox rows: claimed with `FOR UPDATE SKIP LOCKED` and retried with backoff. After 10 attempts →
  `failed` (visible; the poll still covers the order).
- **Alerts:** the cron log prints `ALERT` after 3 failed runs in a row (the `cron.sh` pattern). The
  settings page shows last poll OK, last webhook, the number held per reason, and inbox failures. The
  admin home shows a banner when the last OK poll is > 1 h old or the connection is not `active`.
- No silent fallbacks anywhere. Money that does not parse as whole rupiah is **rejected** (decided,
  Q6: `parseRupiah` refuses `"125000.50"`, an exponent, an empty value or a negative where none is
  allowed). The order or statement is held as `money_format` and never rounded. A missing
  `collection_time`, an unmapped fee or adjustment type: each becomes a visible held reason or a
  posting issue, never a default value. `silent-failure-hunter` reviews T3-T7.

---

## 9. Cron reuse

- A new route `POST /api/internal/tiktok/sync` in apps/web, `authorizeCronRequest(request,
  "tiktok_sync")`. It runs under `withExclusiveRun(defaultDb, "tiktokSync", …)`: `tiktokSync` is
  added to `CRON_JOBS`, and all cron jobs share one lock and never overlap. Caddy already refuses
  `/api/internal/*` on public hosts.
- Steps per run, each within the time budget:
  1. refresh the token if due;
  2. drain the inbox;
  3. re-check held orders and the packing gate;
  4. order poll slice(s);
  5. cancellations/returns poll;
  6. every 6th run: unsettled transactions, statements, payouts.
  Answers: 200, `{skipped:"running"}`, 503 not configured, 429 rate limited, 502 TikTok unavailable,
  500 failed. Every non-2xx is an ERROR line in the cron log.
- `cron.sh` (byte-identical in `deploy/cron` and `deploy-prod/cron`) gets a `TIKTOK_SYNC_EVERY=300`
  loop entry with `TIKTOK_SYNC_MAX_TIME=240` and `TIKTOK_SYNC_ALERT_AFTER=3`. Five minutes keeps
  packing fresh even when webhooks are late. The accounting posting run (15 min) picks up the results
  on its own schedule. No new secret: the existing `INTERNAL_CRON_SECRET`.
- Admin "Sinkronkan sekarang" (`integrations.manage`) calls the same function under the same lock
  (skipped if a cron run holds it).

### 9.1 T4 build notes (27 Nov 2026)

- **Read side only.** `runTikTokSync` (packages/commerce/src/tiktok/sync.ts) runs: due topic 6/7
  events (`processDueTikTokConnectionEvents`, the retry T3 left for the cron), the token refresh when
  due, the inbox drain, then the order poll. No admin order, stock or journal is written;
  `tiktok_orders.order_id` / `apply_state` stay NULL until T5. Steps 3, 5 and 6 of §9 are T5-T7.
- **Inbox (topics 1/11/12):** refresh triggers only. Claimed with `FOR UPDATE SKIP LOCKED` and a
  10-minute lease (`next_attempt_at`), the order re-fetched with Get Order Detail (the body is never
  trusted), then `processed` (`last_error_code` `order_not_found` when TikTok did not return it) or
  `ignored` (`no_order_id`). A TikTok error counts an attempt with T3's backoff, `failed` after 10;
  running out of budget gives the claim back without counting. The webhook's `after()` drains its own
  event the same way (20-s budget, outside the cron lock: the store is serialized per order).
- **Poll:** windows per §8.3 (`order-windows.ts`): start `window_end − 5 min` (first run:
  `backfill_from`, else 24 h back), end `now − 2 min`, contiguous ≤ 6-h slices in whole seconds, both
  bounds always sent, `page_size` 100, `update_time` ASC. An id already stored in the run is not
  fetched again (page boundaries and the overlap repeat ids). A `page_token` TikTok hands back twice,
  or more than 500 pages in a slice, stops the run as `invalid_response`. The cursor moves forward
  only, after each fully stored slice. `last_poll_ok_at` is set only when the run caught up.
- **Store** (`order-store.ts`): one transaction per order under
  `pg_advisory_xact_lock(hashtext('tiktok-order:' || id))`; snapshot `ON CONFLICT DO NOTHING`; same
  `update_time` with other content → kept and `review_flags` `tiktok_snapshot_conflict`; projection
  `ON CONFLICT DO UPDATE ... WHERE latest_update_time < $new`; leaving COMPLETED/CANCELLED →
  `tiktok_left_terminal`. `buyer_message` only on the projection, cut to 1000 characters, never stored
  again once its purge date has passed. The daily retention run clears it after
  `buyer_message_purge_after` while the order is still COMPLETED/CANCELLED.
- **0058 additions beyond §3.3:** `tiktok_orders.review_flags text[]` (CHECK on the two flags above),
  `first_seen_at`; `tiktok_sku_mappings` CHECK that `manual` rows name a staff user and auto rows do
  not. Removing a mapping sets `is_active = false` (kept, so the auto-map never brings it back).
- **Pages** (integrations.manage): Pemetaan SKU TikTok (`/settings/integrations/tiktok/sku-mappings`,
  unmapped SKUs from orders not yet applied and not cancelled, "Cocokkan ke varian" reusing the import's
  variant search; audited `tiktok_sku_map` / `tiktok_sku_unmap` / `tiktok_sku_auto_map`), Pratinjau
  pesanan TikTok (`/settings/integrations/tiktok/orders`, latest 100: Akan dibuat / Akan dicocokkan /
  Ditahan (unknown SKU, money format, unknown status) / Dilewati, computed at read time; stock is not
  checked until T5). The Integrasi page shows the order cursor and the latest failed inbox events.
- **Cron:** `POST /api/internal/tiktok/sync` (`tiktokSync` in `CRON_JOBS`), `cron.sh` every 5 min
  (`TIKTOK_SYNC_MAX_TIME=240`, ALERT after 3 failures). A 503 (not configured, e.g. dev without
  TikTok) is an ERROR line, no ALERT, retried hourly. No shop connected → 200 `skipped:
  not_connected`. `reauth_required` → 500.
- **Nothing listed is skipped** (review fixes): an id Search lists that Get Order Detail does not
  return (`order_missing`), returns unusable (`order_invalid`, also a Search entry without an id) or
  that fails to store (`store_failed`) holds the slice's cursor; the run answers 500 `incomplete` with
  up to 20 order ids, and the next run repeats the slice. One bad order never stops the others. For the
  inbox the same outcomes count an attempt with that code (never settled as done); events whose orders
  were stored before a failure are settled `processed`. Payload strings are cleaned of what jsonb
  refuses (NUL, lone surrogate). The inbox gets at most half of the run's budget, so the poll always
  runs; a run that ran out of budget answers 200 but logs a warning and leaves `budget_exhausted` on
  the cursor. A refresh failure, an unapplied 6/7 event or a snapshot conflict logs a warning.
- **Known limits, left as they are:** a single 6-h slice too big for one 150-s run (thousands of
  orders) never finishes (T9 sizes backfill slices); an allowlist change makes a re-fetched,
  unchanged order look like a `tiktok_snapshot_conflict`; webhook `after()` drains are not
  rate-bounded; `listUnmappedTikTokSkus` reads every unapplied order's latest snapshot (fine at
  Ammari's volume, revisit with a lines table); snapshots have no retention (kept as long as the order).
- **To check in T0:** the 202309/202507 order field names in `TIKTOK_ORDER_ALLOWLIST`
  (packages/tiktok-shop/src/orders.ts; a misnamed field is dropped, never guessed, and the preview
  shows what it breaks), whether line items carry `quantity`, and TikTok's auth-error codes (still not
  passed as `authErrorCodes`; HTTP 401 always counts). Admin "Sinkronkan sekarang" is not built yet.

---

## 10. Sessions

Every session: `/plan` approval, then TDD (`tdd-workflow`) where it touches stock, payments/money or
tokens. The reviewers at `/code-review`: `typescript-reviewer` always; `security-reviewer` for T1-T3
and T7; `database-reviewer` for each migration session; `silent-failure-hunter` for T3-T7 (webhook and
sync code); `react-reviewer` for `.tsx`. List pages get e2e tests at **390 px and 1280 px**. Every
migration is read before it is committed. Test DBs are `ammari_e2e`/scratch databases, never `ammari`.

| # | Scope | Migration | Tests |
|---|---|---|---|
| **T0** | Owner, no code. TikTok approves the app's scopes. **Verification on the development shop** (decided: Q1, Q3, Q6, Q13 are settled by real data, not by guessing): (a) which ON_HOLD flow Indonesia uses (an `ON_HOLD` status, or `is_on_hold_order` on `AWAITING_SHIPMENT`), and a few real orders checked against the gate predicate; (b) that the Draf app can authorize the development shop, and what dev can use (redirect URL, test orders); (c) that amounts come back as whole-rupiah strings; (d) how far back order search reaches, and that `collection_time` is set for each fulfilment type used. Results are recorded in §12 before the session that needs each one. Webhook URL `https://ammari.id/api/integrations/tiktok/webhook` set in Partner Center > Kelola Webhook once T3 is deployed. The token encryption key generated into `~/ammari-secrets` and the T2 env vars set (§7.4). | none | — |
| **T1** | `packages/tiktok-shop`: config + `Secret`; `signRequest` (sorted params, excluding `sign`/`access_token`, exact raw body); `verifyWebhookSignature`; HTTP client (envelope parsing with zod, typed errors, backoff, 503 rule, time budget); `parseRupiah` (strict: rejects non-integers, Q6); token encryption (AES-256-GCM, AAD); allowlist helper. No DB, no routes. | none | **Official TikTok test vectors** in `packages/tiktok-shop/test/fixtures/official-vectors.json` (source: TikTok docs, copied by the owner's assistant; **verified with `openssl dgst -sha256 -hmac` on 27 Nov 2026, both match**). (1) API sign: app_secret `e59af819cc`, `GET /authorization/202309/shops`, query `app_key=29a39d`, `timestamp=1623812664`, `sign`/`access_token` excluded. String to sign `e59af819cc/authorization/202309/shopsapp_key29a39dtimestamp1623812664e59af819cc` → `b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8`. The test asserts both the string-to-sign builder and the final hex, and that adding `sign=…`/`access_token=…` to the query does not change it. (2) Webhook: app_key `abcdef`, app_secret `123`, the raw body stored **byte-exact as a separate file** (`official-webhook-body.json`, no trailing newline; the test asserts its length and SHA-256 so an editor cannot reformat it unnoticed) → `Authorization` `5dec0f11ec2f6783b8deee53c9ffbf8d024302f7c7e7fa55a35d17629031ac05`. Raw body (TikTok Order Sync guide, Appendix B; 223 bytes, SHA-256 `3007a31e74e55c2825a5868a29f4ae001fc63a298d429dc3dbfa2a7aa908e492`; re-verified 27 Nov 2026 with `{ printf '%s' 'abcdef'; cat official-webhook-body.json; } | openssl dgst -sha256 -hmac '123'`): `{"type":1,"tts_notification_id":"7380066284010030890","shop_id":"7495540735365777507","timestamp":1718305585,"data":{"is_on_hold_order":true,"order_id":"576653688135258178","order_status":"UNPAID","update_time":1718305585}}`. Both are dummy credentials from the docs, never real ones. Plus own vectors, each derived with openssl and the command recorded in the fixture: POST with a JSON body whose whitespace must be kept byte for byte, params arriving unsorted, empty values, unicode in the body. Webhook: one byte changed → refused, uppercase hex refused, wrong length refused. Backoff schedule with a fake clock and seeded jitter: `Retry-After` honoured, 5-try cap, 1-60 s bounds, 429 vs `36009002` vs 503 vs 500. `page_token` with `+/=` URL-encoded. `parseRupiah`: `"125000"` ok; `"125000.50"`, `"1e5"`, `""`, `" 1"` refused. Crypto: round trip, tamper → fail, AAD swap → fail, wrong key version → fail. Redaction: `JSON.stringify`/`inspect`/template string of a `Secret` show `[redacted]`. |
| **T2** | Connection + OAuth: 0057 tables (connections, oauth states, sync cursors, inbox), permission `integrations.manage`; admin Pengaturan > **Integrasi TikTok Shop** page (status, shop, scopes, expiry, health, Hubungkan/Hubungkan ulang/Putuskan); authorize link with `service_id` = the Partner Center app ID (Q4) + callback route; Get Authorized Shops; token refresh service; deauthorization and expiry handling (applied when T3 delivers topics 6/7). | **0057** | DB: migration idempotent, permission row present; state consumed once (two concurrent callbacks → one wins), expired or other-staff state refused; refresh race (two refreshers → one TikTok call, one write, `token_generation` +1); deauth wipes the ciphertext. Unit: the authorize URL uses `TIKTOK_SERVICE_ID`, never the App Key; callback error mapping to Indonesian messages. Security: customer session and staff without the permission → 403 on page, action and callback; log capture: no code, state, token or secret in any log line. e2e: Integrasi page at 390/1280 with a stubbed TikTok. |
| **T3** | Webhook receiver in apps/web (`/api/integrations/tiktok/webhook`, registered per app in Kelola Webhook, Q5): capped body, verify, shop check, inbox insert, 200 empty / 401 / 503; `after()` drain hook (no-op until T4); topics 6/7 wired to T2; retention entry; Cloudflare Access bypass + Caddy note in the runbook. | none | Route tests: **the official webhook vector** (T1 fixture) posted as the raw body with its `Authorization` → verified (with that test's app key/secret injected), stored, 200 with an empty body; replay of the same `tts_notification_id` → 200, still one row; bad signature → 401, no row; oversized → 413/401, no row; DB down → 503; unknown topic → `ignored`; response time with the DB stubbed slow stays < 3 s (no API call in the request path). Retention deletes > 12 months only. |
| **T4** | Order read side: 0058 tables (snapshots, `tiktok_orders` incl. `buyer_message` + purge date, SKU mappings 1→1, Q12); allowlists; order search poll with cursors and slicing; Get Order Detail batches of ≤ 50; snapshot versioning; `buyer_message` purge in the retention job (Q14); `/api/internal/tiktok/sync` + `CRON_JOBS` + `cron.sh`; **Pemetaan SKU TikTok** page; **no admin order writes yet** (dry-run view "Akan dibuat / ditahan"). | **0058** | Unit: window math (overlap ≥ 5 min, both bounds set, ≤ 6-h slices, lag), pagination, cursor advances only after a full slice. DB: the same snapshot twice → one row; an older `update_time` after a newer one → projection unchanged; same `update_time` with different content → conflict flag. PII: buyer-field fixture through every allowlist → nothing survives, and `buyer_message` is absent from snapshots and the inbox but present in `tiktok_orders`; purge: NULL at COMPLETED/CANCELLED + 30 days, kept at + 29 days, never purged for an open order. Mapping: one TikTok SKU can map to one variant only (PK), two TikTok SKUs to one variant allowed; auto-map exact seller SKU and not a near miss (case/whitespace handled, `POKA-FZ-SAGE-M` ≠ `POKA-FZ-SAGE-L`). Cron lock skip. e2e: SKU mapping page at 390/1280. |
| **T5** | **Apply to orders and stock** (TDD, stock): 0059 (`marketplace_shipped_at/_completed_at/_returned_at`, attention flags incl. `marketplace_return_in_transit`, snapshot `kind`, `marketplace_refunds`); `decideTikTokOrder` + `commitTikTokOrder` in commerce; amounts per Q7 (seller item discounts → `discount_amount`); matching hand-typed TikTok orders; `tiktokReadyToShip` gate on `/packing` and the order list badges; `buyer_message` on packing; multi-package → review flag only (Q2); Perlu dicek reasons. | **0059** | Unit (pure decide, table-driven): every row of §4.3 for new and existing orders; **both ON_HOLD flows** (an `ON_HOLD` status, and `AWAITING_SHIPMENT` + `is_on_hold_order`); gate truth table (on hold true/false × before/after 1 h since `paid_time`); terminal stays terminal; COMPLETED never clears a return; `PARTIALLY_SHIPPING` → flag, no transition; cancel after shipping → flags only, no `returned`; unknown status held. Amounts: item seller discount + seller voucher → `discount_amount`, platform discount ignored, `total = subtotal − discount`. DB through `transitionOrderStatus` fixtures: create at first paid status → one sale movement per line; paid → cancelled in the hold window → exact return, stock net 0; IN_TRANSIT sets `marketplace_shipped_at` once and a later different value is flagged, not overwritten; short stock held, then applied after a receipt; unknown SKU held, then applied after mapping; a hand-typed order is matched, not duplicated, and its different lines are held; **concurrency:** the webhook drain and the poll apply the same order at once → one order, one set of movements (advisory lock + ON CONFLICT); a replayed snapshot → no writes. e2e: orders list and `/packing` show a TikTok order, its badge, its buyer message and its packable state at 390/1280. |
| **T6** | Cancellations and returns: polls + topics 11/12; refund recorded at `RETURN_OR_REFUND_REQUEST_COMPLETE` with `marketplace_returned_at`; **return with goods and failed delivery wait for physical receipt** (Q11; Q18) via "Retur diterima" → `returned`; **refund-only → `marketplace_refunds` row**, no status or stock change (Q10); pre-ship → `cancelled`; pending flag and 48-h deadline list (responses stay in Seller Center, Q15); partial return with goods → `marketplace_partial_return`. | none | Unit: return/cancellation state → decision. DB: failed delivery → flags, stock unchanged until "Retur diterima", then exact-negation return movements and flags cleared; "Retur diterima" refused without the flag and for staff without `orders.manage`; a refund in transit on a COMPLETED order → the matching path (refund-only → refund row; with goods → waits for receipt); refund-only → one refund row, **no stock movement**, status unchanged; a replayed refund → still one row (unique); repeated return snapshots → idempotent. e2e: Perlu dicek deadline list and "Retur diterima" at 390/1280. |
| **T7** | Finance read side (TDD, money): 0060 tables; unsettled transactions → `estimate` fee lines (Q9); statements + transactions + per-order SKU-level fees → `actual`; payouts; aggregation into `order_channel_fees` by the §5.3 fee-type table, rows filled from the fee types seen on the development shop and reviewed once by the accountant. | **0060** | Unit: `parseRupiah` on real response shapes (non-integer → `money_format`, never rounded); fee-type table complete for every type in the fixtures, and only `seller_shipping_subsidy` outside the 6-1201 components; an unknown type → held, not `other`. DB: estimate then actual → the actual replaces it with one upsert per component; no estimate yet → no fee rows (never zero); statement re-fetch → idempotent; Σ transactions = settlement per statement; payout ↔ statements link. |
| **T8** | Accounting: loader reads the new columns (no `SALES_RULE_VERSION` bump); new rules S7 `marketplace_refund`, M3 `tiktok_payout` (→ Bank utama, Q17) and M5 `tiktok_adjustment`; 0061 mapping key `cash.tiktok_payout`; Pemetaan Akun lists unmapped TikTok adjustment types (Q8, ads → 6-1101 suggested); close warning for estimated TikTok fees (Q9); **Ringkasan / `revenue-sql.ts` subtract refund-only amounts** (Q19) and check 4 maps S7 to that component; Rekonsiliasi "TikTok Shop" checks (a)-(d) plus the M4/M5 ads pair list; opening 1-1303 proposal; accounting.md updated (Session 5 split, §9, §13). | **0061** | Unit: M1 dated by Jakarta `collection_time` (23:30 UTC → next Jakarta day); M2 on the same date, discount on 4-1201 (Q7); estimate → actual into a closed month → first open month; S7 Dr 4-1301 / Cr 1-1303 on `refunded_at` with no HPP line; S7 held while M1 is an issue; S4 dated `marketplace_returned_at`, S2 dated by the receipt movement; M3 Dr 1-1201 / Cr 1-1303; M5 unmapped → issue, mapped ads type → 6-1101. DB: **existing journals unchanged** after the loader change (a run on a fixture DB with posted journals → zero new rows); a TikTok order through paid → shipped → completed → settled → paid out leaves 1-1303 at 0 for that order; refund-only order → 1-1303 at 0 after settlement, 1-1505/HPP unchanged; Ringkasan revenue for the refund's month is lower by the refund amount and **check 4 shows no difference** (the existing `getExpenseSummary().net` equality test extended with a refund-only fixture). e2e: Rekonsiliasi TikTok section and Pemetaan Akun adjustment types at 390/1280. |
| **T9** | Cut-over and backfill: backfill orders, returns and finance from `backfill_from` (proposal 1 Dec 2026, limited by what T0 found for Q13) in "enrich" mode (fills `marketplace_shipped_at` and fees on orders that already exist, moves status forward, creates missing ones); **a warning only** on `/orders/new` when channel `tiktok` is picked while TikTok is connected (decided, Q16: never blocked; "Pesanan TikTok masuk otomatis dari TikTok Shop. Buat manual hanya jika pesanan ini tidak muncul."); runbook (connect, webhook URL in Kelola Webhook, env vars incl. `TIKTOK_SERVICE_ID`, Access bypass, alerts, reconnect, key rotation, disconnect); SPEC §5.x updated. | none | DB: backfill over orders already in admin → no duplicate orders and no stock movements, dates filled; a re-run → no-op. e2e: the `/orders/new` warning shows for `tiktok` and does not block saving, at 390/1280. Runbook dry-run on dev with the stubbed TikTok. |

Order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9. T5 must not start before T4 has run in dry-run
against the development shop for at least a few days, so the T0 checks (Q1, Q13) are confirmed by real
data. For the December trial month and the 1 Jan 2027 cut-over: T1-T5 and T8's loader change are what
clear `marketplace_ship_date_missing` for TikTok, and T7-T8 automate M2/M3. Anything not live by then
keeps today's behaviour: the posting issue, and manual journals for withdrawals (accounting.md §9).
Nothing is guessed.

---

## 11. Risks

- **App review takes long or scopes are cut:** T1-T4 can be built against fixtures and a stubbed
  server, but nothing goes live without approval. Without `seller.finance.info`, T7/T8's M3/M5 stay
  manual journals.
- **Double source of truth while hand entry continues:** hand entry stays allowed with a warning
  (Q16). This is handled by matching on `(channel, channel_order_no)` and holding line differences
  (T5/T9).
- **The cron lock is shared:** a slow TikTok run delays the payment sweep by at most its time budget
  (240 s < 300 s). If that bites, TikTok gets its own lock key. That is a small `lock.ts` change, but
  it gives up the "never more than two pool connections" property, so it is not done by default.
- **Returns waiting for the parcel** (Q11): until "Retur diterima" the goods are neither in stock nor
  sold. Perlu dicek lists them by age so a lost parcel is noticed and written off by hand. If the
  parcel comes back in a later month than TikTok's return date, the revenue reversal and the HPP
  reversal land in different months.
- **Partial returns with goods and multi-package orders** need a person (Q2, Q10). The count is
  visible in Perlu dicek, so it cannot be forgotten.
- **API versions** (`202309`, `202501`, `202507`) will be deprecated by TikTok. Versions are pinned
  per endpoint in one file, and the settings page shows TikTok deprecation error codes.

---

## 12. Owner decisions (27 Nov 2026) and what is still open

### 12.1 Answered

| # | Question | Decision | Affects |
|---|---|---|---|
| Q1 (stock) | When does stock leave? | When TikTok **first reports the order as paid**. | §4.4, T5 |
| Q1 (gate) | ON_HOLD flow and gate | The code handles **both ON_HOLD flows**. Gate = `AWAITING_SHIPMENT` and (`is_on_hold_order` or 1 h since `paid_time`). Which flow Indonesia uses is **verified in T0** on the development shop. | §4.3, §4.4, T0, T5 |
| Q2 | Multi-package / partial shipping | Flag for **manual review**, no automation. | §3.4, §4.3, T5 |
| Q3 | Draft app, dev testing | **Verified in T0** on the development shop. | §2, T0 |
| Q4 | `service_id` | The **app ID shown in Partner Center, `7712559784284669716`**, not the App Key. | §7.1, T2 |
| Q5 | Webhook URL | Configured **per app** (Partner Center app page > Kelola Webhook). It may be on a different HTTPS domain from the redirect; a domain name is required. → `https://ammari.id/api/integrations/tiktok/webhook`. | §2, T0, T3 |
| Q6 | Money format | **Verified in T0.** Code **rejects non-integer IDR amounts** (held, never rounded). | §8.3, T1, T7 |
| Q7 | Seller item discounts | → **Potongan penjualan 4-1201** (D-4), via `discount_amount`. | §4.3, T5, T8 |
| Q8 | Fees, ads, adjustments | Marketplace fees → **Biaya platform marketplace 6-1201** (D-5). Ads paid from the balance → the **ads expense account** (6-1101 Iklan). **Every adjustment type is mapped by the accountant in Pemetaan Akun**; unmapped = posting issue. | §3.6, §5.3, §5.4, T7, T8 |
| Q9 | Estimated fees | **Yes:** estimates from unsettled transactions post on the ship date and are replaced by actuals at settlement. Differences go to the first open month (D-5/D-23, same pattern as MDR D-8). | §5.3, T7, T8 |
| Q10 | Refund-only / returns | Refund-only: **Retur penjualan dated at `RETURN_OR_REFUND_REQUEST_COMPLETE`**. The goods stay with the buyer: **no stock return, HPP not reversed**. Return with goods: per **D-7**. | §3.4, §4.5, §5.2, T6, T8 |
| Q11 | Failed delivery | Stock returns **only when the parcel is physically received back**. | §3.4, §4.3, §4.5, T6 |
| Q12 | Bundles | **One TikTok SKU = one Ammari variant**, no bundles. | §3.3, T4 |
| Q13 | History and `collection_time` | **Verified in T0** on the development shop. | T0, T9 |
| Q14 | `buyer_message` | **Store it for packing**; purge automatically **30 days after COMPLETED/CANCELLED**. | §3.3, §6, T4, T5 |
| Q15 | Write actions | **Phase 1 is read-only**: no write-back to TikTok (labels and return responses stay in Seller Center). Stock sync is a later phase. | §1, §4.5, §6 |
| Q16 | Manual TikTok entry once connected | **Warning only**, never blocked. | §11, T9 |
| Q17 | Payout bank | TikTok payouts **always go to Bank utama** (1-1201). | §3.6, §5.4, T8 |
| Q18 | Stock on returns with goods | Like failed deliveries (Q11), **returns with goods put stock back only when the parcel is physically received** ("Retur diterima"). (owner, 27 Nov 2026) | §4.5, §5.2, T6 |
| Q19 | Refund-only in the management P&L | **Ringkasan subtracts refund-only amounts** so the management P&L matches the ledger; built in T8. (owner, 27 Nov 2026) | §5.2, T8 |

### 12.2 Still open

- **T0 verification results** for Q1 (which ON_HOLD flow, and the gate on real orders), Q3 (what the
  Draf app and dev can do), Q6 (amounts are whole numbers) and Q13 (backfill reach, `collection_time`
  per fulfilment type). They are recorded here when known. The code already handles both outcomes
  of Q1 and rejects non-integers for Q6.
- **Fee-type table and adjustment types:** their exact names come from the first real statements (T7).
  The accountant reviews the fee table once and maps each adjustment type in Pemetaan Akun (Q8 decided
  how; only the names are unknown).

---

## 13. Done when

- A paid TikTok order appears in admin within about 5 minutes (≤ 1 minute with webhooks), with stock
  out, and shows as packable when the gate passes.
- Every TikTok order shipped from the cut-over has `marketplace_shipped_at`. No
  `marketplace_ship_date_missing` issue remains for channel `tiktok`.
- 1-1303 Saldo Penjual TikTok reconciles per order, per statement and per payout on the Rekonsiliasi
  page.
- No token, secret, signature or buyer data is in the database in plaintext or in any log.
