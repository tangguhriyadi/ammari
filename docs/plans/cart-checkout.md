# Plan: Storefront cart, checkout, online payment and web orders (`apps/web`)

**Status:** **Approved by the owner, 2026-10-20** (all §16 decisions are final). **Session 0 done**
(SPEC.md §3.4, §5.2, §5.3, §8, §10.2, §10.3, §11 and docs/design/storefront.md §4, §7 updated to
match this plan). **Session 1 done 2026-10-20** (`@ammari/commerce` extracted, no behavior
change; see the session table). **Session 2 done 2026-10-20** (migration 0030 `checkout_core`,
schema only). **Session 3 done 2026-10-20** (area dataset licence not clean: plain-text
address fields, no data migration; see §3). **Session 4 done 2026-10-20** (stock holds,
storefront availability, admin "Dipesan"; see the session table). **Session 5 done 2026-10-20**
(cart backend: `@ammari/commerce/cart`, server actions, cookie, merge, caps, `cart_write` rate
limit; see the session table). **Session 6 done 2026-10-21** (cart UI: PDP add, header count,
`/cart`, flag 404; see the session table). **Revised 2026-10-21 for the shipping subsidy**
(owner decision: free shipping is replaced by a subsidy of at most Rp20.000 per order, see §4.5;
Komerce Shipping Cost and destination search moved from Phase K into Phase C as new sessions 7
and 8; the old sessions 7 to 15 are now 9 to 17, mapping in §15). **Session 7 done 2026-10-21**
(migration 0031 `shipping_quote`, product weight in admin; see the session table). Next: session 8.

**Go-live:** 1 Dec 2026. Everything ships dark behind `STOREFRONT_CART_ENABLED` (already exists,
`apps/web/src/lib/cart-flag.ts`, default off) until launch day.

**Shipping cost (Komerce Shipping Cost API) is a launch requirement** since 2026-10-21: checkout
cannot price an order without it (§4.5). Shipping Cost (Search Destination, Calculate) is on
every Komerce plan, so Ammari needs a Komerce subscription and key before launch (§14).
**Courier booking and tracking (Komerce Shipping Delivery API) stays in Phase K** (§15): it needs
the **Komerce Enterprise plan** (Rp249.000/month, cheaper annually). Until Phase K ships, staff
book the order's quoted courier service by hand, enter the resi with the existing "Tandai
dikirim", and mark orders "Selesai" by hand.

## 1. Grounding: what already exists

- **Orders** (`packages/db/src/schema/orders.ts`): `orders` already has `status` with
  `awaiting_payment` in `ORDER_STATUSES`, `channel_id` (`web` exists and is seeded by migration
  0014), `order_no` (`ORD-YYYYMM-NNNN`, shared across channels), `customer_id`, money columns with
  the `total = subtotal + shipping - discount` CHECK, free-text `shipping_address`, `courier`,
  `tracking_number`. `order_items` locks `unit_cost` when stock leaves.
- **Order domain logic lives in `apps/admin`** (`lib/orders/queries.ts`, `status.ts`,
  `order-number.ts`, `lib/stock/db.ts`, `lib/stock/queries.ts`, `lib/inventory/moving-average.ts`,
  `lib/packing/queries.ts`'s `voidActiveCardForOrder`, `lib/db.ts`'s `writeAuditLog`).
  `transitionOrderStatus` is the only path that changes status; `awaiting_payment -> to_ship`
  writes the `sale` movements (SKU row lock, refuses negative stock, snapshots `unit_cost`);
  cancel/return writes exact-negation `return` rows only if stock had left. `apps/web` cannot
  import any of this today.
- **Stock:** append-only `stock_movements`; availability on the storefront is
  `SUM(qty) > 0` (`packages/db/src/storefront/queries.ts`, `available` / `inStock`). Defect stock
  is a separate ledger and is never sellable. No reservations exist.
- **Vouchers** (`schema/customers.ts`): `vouchers.status` active/used/expired/void,
  `used_order_id` UNIQUE, `used_at`, `expires_at`, CHECK that `used` iff `used_order_id` and
  `used_at` are set. Nothing redeems or restores yet. No job flips `active -> expired`; expiry is
  effectively `expires_at`.
- **Customers and auth:** Better Auth **1.7.7** customer instance (Google + email OTP),
  `loadOrCreateCustomerForEmail` (`packages/auth/src/customer/customer-data.ts`) links by
  `citext` email with an insert-first, race-safe idiom, run from
  `databaseHooks.user.create.before`. `customers.phone` is UNIQUE and nullable, format
  `+62[0-9]{8,13}`. `/consent` gates on `pdp_consent_at`. `getCustomerSession()` re-reads
  `customers` per request.
- **Better Auth `magic-link` plugin (1.7.7, read from the installed source):** supports hashed
  token storage, a configurable expiry and atomic single-use consumption, but its verify endpoint
  is a **GET that creates the session immediately**, older links are **not invalidated** when a new
  one is issued, the stored record binds only the **email** (no customer id), and issuance is a
  **public** `POST /sign-in/magic-link` for any email. See D15 for why we use a small custom
  plugin instead.
- **Account:** `/account` lists "Pesanan saya" (`lib/account/queries.ts`, no cost data) and
  vouchers.
- **PDP:** `ProductPurchasePanel` already has the cart branch behind `cartEnabled` ("Pilih
  ukuran" / "Tambah ke keranjang", inline "Masuk keranjang" box, WhatsApp demoted to the outline
  secondary button, SOLD OUT). PDP is ISR (`revalidate = 3600`), revalidated by admin stock
  changes through `/api/revalidate`.
- **Email:** `EmailSender` (`packages/auth`), `ResendEmailSender`, plain text body only.
- **Throttle idiom:** `claim_rate_limits` (atomic insert+count per `(ip, action)`, `action` is
  free text) and `auth_email_throttle` (per-email cooldown/cap plus the global hourly circuit
  breaker).
- **No scheduler** exists anywhere (no cron in `deploy/` or workflows).
- **Design:** `docs/design/storefront.md` §7 and `mockup-cart.png` / `mockup-checkout.png`.
  The mockup's courier list is superseded by one automatically chosen service (§4.5); its cart row
  "Dihitung saat checkout" is back (it was "Gratis" under the old free-shipping rule). The
  footer's payment chips (design §4) list "Kartu kredit", which must go (D16).
- **No weight anywhere (checked 2026-10-21):** neither `products` nor `product_variants` has a
  weight column, so the parcel weight a shipping quote needs is new (§4.5.3).
- **Komerce (public docs, checked 2026-10-20):** one API host
  (`api.collaborator.komerce.id`, sandbox `api-sandbox.collaborator.komerce.id`, header
  `x-api-key`) with Search Destination, Calculate, Store Order, Cancel Order, Detail Order,
  History AWB, Pickup Request and Print Label endpoints. A webhook URL is registered with
  `PUT /webhook`; pushes carry `order_no`, `cnote` (AWB) and `status` (documented examples:
  Diajukan, Dijemput, Dikirim, Dibatalkan, Selesai). **No signature scheme is documented**, and
  the full status list and retry rules are not documented.
- **Last migration:** 0029. This plan uses 0030 onward.

## 2. Key decisions (design)

| # | Decision | Why |
|---|---|---|
| D1 | Hoist order/stock/voucher domain logic into a new workspace package **`@ammari/commerce`** (`packages/commerce`), used by both apps. No behavior change in the move. | Web checkout, the payment webhook, the Komerce tracking handler and admin must share one `transitionOrderStatus`, one stock path and one voucher path. |
| D2 | **Cart is stored in the database** (`carts`, `cart_items`), identified by an httpOnly random cookie for guests and by `customer_id` when logged in. Merge on login (any login method, including the magic link). | Server-side validation, login merge, no client-trusted prices. |
| D3 | **Stock is reserved at order creation** in `stock_reservations`; the real `sale` movement is written only at payment (existing `awaiting_payment -> to_ship`). Release on expire/cancel. Storefront availability becomes `SUM(movements) - active reservations > 0`. | Ledger keeps "real sales only"; prevents two web buyers paying for the last piece. A reservation counts only while `expires_at > now()`, so a missed sweep never strands stock. |
| D4 | Admin paths (manual orders, future marketplace import) keep checking **physical stock only**. | A marketplace sale already happened and must never be refused (decision 9). |
| D5 | **Midtrans Snap, redirect mode** (`redirect_url`), not the snap.js popup. | Mobile first, no third-party script on our pages, robust in Instagram/TikTok in-app browsers. |
| D6 | **"Paid" is set only after the SHA512 signature check and a server-to-server `GET /v2/{order_id}/status` re-fetch**, never from a redirect. | CLAUDE.md security rules; defeats replayed or reordered notifications. |
| D7 | One `payments` row per attempt; Midtrans `order_id` = `<prefix><order_no>-<attempt>`, prefix from env (`""` in prod, `DEV-` / `LOCAL-` elsewhere). | Dev and local share one Sandbox account and would collide. |
| D8 | Per-transaction notification URL via `X-Override-Notification`. | One Sandbox account serves dev and local. |
| D9 | Guest checkout links or creates a `customers` row by email but **never signs the guest in at checkout**. | The email is unverified at that point; account takeover risk. |
| D10 | Vouchers only with a session; redeem atomically in the order transaction; restore on cancel or payment expiry only. | SPEC §4.5, §8; decision 8. |
| D11 | **Shipping subsidy (2026-10-21, replaces free shipping):** Ammari pays at most Rp20.000 of the courier cost per order; the buyer pays `max(0, cost - 20.000)` as a separate "Ongkir" line. `orders.shipping_amount` is the buyer's share; the quoted courier cost and the subsidy are stored on the order too (§4.5.6). Product prices are the same everywhere. The cost actually paid at booking goes on `shipments` in Phase K. | Owner decision: free shipping to e.g. Papua (Rp90.000 to Rp200.000+ per kg) is too expensive. |
| D12 | **Address area from Komerce Search Destination (2026-10-21).** The buyer picks a Komerce destination (kelurahan, kecamatan, city, province, kode pos) from a search box; the chosen row is cached in **`shipping_areas`** (keyed by `komerce_destination_id`) and the order and saved address point at it. Session 3's plain-text fields (no licensed dataset) are superseded for checkout; `@ammari/commerce/address` stays for validation, formatting and the snapshot. | A quote needs a Komerce destination id; the area list is licensed through the Komerce subscription. |
| D13 | Unpaid expiry finalized by Midtrans `expire` notifications plus a **sweeper** route called every 5 minutes by a cron container on the VPS internal network. The same cron drives Komerce tracking polls in Phase K. | No scheduler exists. |
| D14 | Transactional emails sent after commit with an `order_notifications (order_id, kind)` UNIQUE row as the idempotency guard. | Retries must not double-send; email failure never fails a webhook. |
| D15 | **Two separate links in guest order emails.** "Lihat pesanan": view-only access to that one order (§9.2). "Masuk ke akun": a magic login link (§9.3), implemented as a **small custom Better Auth plugin** on the customer instance (our own endpoint, Better Auth's session creation, cookie, rate limiter and CSRF middleware), not the stock `magic-link` plugin. | The stock plugin logs in on GET (email scanners prefetch links), does not invalidate older links, does not bind to a customer id, and exposes public issuance. A plugin keeps the login inside Better Auth's own HTTP router, so its rate limiter and origin checks apply (SPEC §10.1's reason for not calling `.api` from server actions). |
| D16 | **No card payments**, not enabled in Snap and not planned. | Decision 2. |
| D17 | **Shipping quotes are server-side only**, behind a `ShippingRateProvider` interface (`@ammari/commerce/shipping`; Komerce in production, a fake in tests and e2e). The browser never sends a price, a courier or a Komerce id; the quote is recomputed in `placeOrder` and locked into the order. No quote, no order (§4.5.5). | Money rule; Ammari must never ship at an unknown cost. |

## 3. Data model (all expand-only, backward compatible)

### Migration 0030 `checkout_core` (schema only, session 2)

- **`carts`**: `id uuid`, `token_hash text UNIQUE NULL` (sha256 of the guest cookie value, 128+
  bit random), `customer_id uuid UNIQUE NULL`, `last_activity_at`, timestamps. CHECK: at least
  one of `token_hash` / `customer_id` set.
- **`cart_items`**: `cart_id` (cascade), `sku` (FK restrict), `qty int` CHECK `1..10`,
  `added_at`; UNIQUE `(cart_id, sku)`. No price column.
- **`stock_reservations`**: `id`, `order_id`, `order_item_id UNIQUE`, `sku`, `qty > 0`, `status`
  (`active` / `consumed` / `released`, from a new `STOCK_RESERVATION_STATUSES` constant),
  `expires_at`, `consumed_at`, `released_at`, created_at. Partial index on `(sku)` WHERE
  `status = 'active'`.
- **`payments`**: `id`, `order_id`, `provider` (`midtrans`), `provider_order_id UNIQUE`,
  `provider_ref UNIQUE NULL` (Midtrans `transaction_id`), `attempt int`, `snap_token`,
  `redirect_url`, `gross_amount bigint`, `status` (`created` / `pending` / `paid` / `failed` /
  `expired` / `cancelled` / `refunded` / `partially_refunded` / `chargeback`), `payment_type`,
  `paid_at`, `expires_at`, `refunded_amount bigint default 0`, `last_status jsonb` (allowlisted
  fields), timestamps. UNIQUE `(order_id, attempt)`. No `fraud_status` column (no cards).
- **`payment_notifications`**: `provider_order_id`, `transaction_status`, `status_code`,
  `signature_valid bool`, `payload jsonb`, `received_at`, `processed_at`, `result text`.
- **`customer_addresses`**: `customer_id`, `recipient_name`, `phone`, `address_line`,
  `shipping_area_id NULL`, denormalized `province` / `city` / `district` / `postal_code`,
  `notes`, `latitude` / `longitude` NULL, `is_default` (partial UNIQUE per customer where true),
  timestamps.
- **`shipping_areas`**: `id`, `province`, `city`, `district`, `postal_code`, `search_text`,
  `komerce_destination_id text NULL`. UNIQUE `(province, city, district, postal_code)`. Empty in
  0030.
- **`orders`** new nullable / defaulted columns: `payment_status` (NULL for non-checkout
  orders; `ORDER_PAYMENT_STATUSES` = `pending` / `paid` / `expired` / `cancelled` / `refunded` /
  `partially_refunded` / `chargeback`, deliberately without the attempt-only `created` and
  `failed`; owner decision 2026-10-20), `payment_expires_at`, `paid_at`, `contact_email citext`,
  `contact_phone`, `recipient_name`, `shipping_address_snapshot jsonb` (the text
  `shipping_address` is also filled so admin and packing work unchanged), `shipping_area_id`,
  `checkout_attempt_id uuid UNIQUE NULL`, `terms_accepted_at`, `promo_opt_in bool`,
  `cancel_reason text` (`payment_expired` / `payment_cancelled` / `admin`, only on a cancelled
  order), `needs_attention text[] NOT NULL DEFAULT '{}'`, a **set** of flags
  (`ORDER_ATTENTION_FLAGS`: `stock_short_at_payment`, `paid_after_cancel`, `amount_mismatch`,
  `refund_due`, `refund_received`, `payment_anomaly` for a card-only status or `credit_card`
  payment type, and Phase K's `tracking_stale`, `delivery_problem`, all allowed from 0030; owner
  decision 2026-10-20: adding a flag never removes another, clearing is per flag, the admin
  "Perlu perhatian" filter is `cardinality(needs_attention) > 0`), `placed_with_session bool`
  (whether the buyer was logged in at checkout; decides whether emails carry a magic link).
  CHECKs: `channel_id = 'web'` or `payment_status IS NULL`; a checkout order has
  `payment_expires_at`, `checkout_attempt_id`, `terms_accepted_at`, `promo_opt_in` and
  `placed_with_session`; `paid` has `paid_at`; `contact_phone` is `+62...`. A **checkout order is
  `payment_status IS NOT NULL`**, never just `channel_id = 'web'`: staff can also enter manual
  orders on the `web` channel.
- `stock_reservations` references its order line through one composite FK
  `(order_item_id, order_id, sku) -> order_items (id, order_id, sku)` (new UNIQUE on
  `order_items`), ON DELETE RESTRICT, so the admin's delete-and-reinsert item edit fails loudly
  on a line that still holds stock (session 16, was 14, blocks item edits on checkout orders anyway).
- **`order_access_tokens`** (the "Lihat pesanan" links): `id`, `order_id`, `token_hash UNIQUE`,
  `expires_at`, `created_at`, `last_used_at`. One row per email sent, so every email has its own
  working link (raw tokens are never stored, so a later email cannot reuse an earlier one).
- **`order_notifications`**: `order_id`, `kind` (`created` / `paid` / `shipped` / `delivered` /
  `cancelled` / `owner_paid`), `sent_at`, `error`; UNIQUE `(order_id, kind)`.
- Rate limiting reuses `claim_rate_limits` with new action keys `cart_write`,
  `checkout_submit`, `area_search`, `order_view`, `login_link_view`.
- No permission keys or other reference rows.

### ~~Migration `shipping_areas_data`~~ (skipped, session 3; it would have been 0031)

**Licence check 2026-10-20: not clean, so no data migration (D12 fallback).** The kecamatan
hierarchy (Kepmendagri 2025, e.g. via `cahyadsn/wilayah`) is arguably public domain under UU
28/2014 Pasal 42, but no kode pos source has a clear licence chain: the MIT-labelled repos
(`cahyadsn/wilayah_kodepos`, `pentagonal/Indonesia-Postal-Code`) do not state where their postal
codes come from (ultimately Pos Indonesia), datahub.io's ID postal dataset dropped
`wilayah_kodepos` for an "unverified licence chain", GeoNames has no Indonesia postal file, and
`pentagonal` is also outdated (34 provinces). `shipping_areas.postal_code` is NOT NULL, so a
kecamatan-only load would also need a schema change. Owner chose plain fields.

Instead: `@ammari/commerce/address` (pure, no DB, usable in the browser too):
`INDONESIAN_PROVINCES` (38, for a select), `normalizeIndonesianPhone` (`0812...`, `62...`,
`+62 ...`, `8...` to `+62...`; **mobile numbers only**, national `8` + 7 to 12 digits, inside the DB
CHECKs; landlines refused because contact is WhatsApp and the courier must reach the recipient),
`parseShippingAddress` (all errors at once in form order, Indonesian messages, single-line
cleaned text without control/zero-width characters or lone surrogates, length caps, postal code
`[1-9][0-9]{4}`), `formatShippingAddress` (the one-line `orders.shipping_address`:
recipient, phone, address, kecamatan, city, province + postal code, ". Catatan: ..."), and
`toShippingAddressSnapshot` (`version: 1`, `shippingAreaId: null`; copies the fields one by one so
a saved-address row passed in never leaks its ids into the order). For later sessions: `orders.
contact_phone` is the buyer's WhatsApp, the recipient's phone lives in the snapshot; the same
recipient data sits in `shipping_address`, `recipient_name` and the snapshot, so the §11
anonymization must clear all three; "set as default" on `customer_addresses` must unset and set
in one statement or transaction (partial UNIQUE), never check-then-write. ~~`shipping_areas` stays
empty and every `shipping_area_id` stays NULL until Phase K K1.~~ **Superseded 2026-10-21 (D12):**
`shipping_areas` is filled on demand from Komerce Search Destination in Phase C (session 8,
§4.5.1) and every checkout order and saved address gets a `shipping_area_id`; the `area_search`
rate-limit key is used from session 8. Numbers are assigned by `drizzle-kit generate` at the time;
the order below is what matters.

### Migration 0031 `shipping_quote` (session 7, added 2026-10-21)

All additive and backward compatible with the session 6 release (which never writes a checkout
order, never reads `shipping_areas`, and does not know the new columns):

- **`products.shipping_weight_grams int NULL`**, CHECK `BETWEEN 50 AND 30000`: one packed piece
  (folded, in its own plastic). Nullable in the migration; required when a product goes from hidden
  to published from session 7 on (§4.5.3).
- **`orders`** new nullable columns, written only by `placeOrder`:
  `shipping_cost_amount bigint` (the courier cost as quoted), `shipping_subsidy_amount bigint`
  (what Ammari covers on this order), `shipping_courier_code text` / `shipping_service_code text`
  (e.g. `jne` / `REG`, as Komerce names them), `shipping_courier_label text` (display, e.g.
  "JNE Reguler"), `shipping_weight_grams int`, `shipping_destination_id text` (the Komerce id,
  snapshotted because `shipping_areas` rows can be re-synced), `shipping_quoted_at timestamptz`.
  CHECKs: the eight are all NULL or all set; when set, `shipping_subsidy_amount BETWEEN 0 AND
  shipping_cost_amount` and **`shipping_amount = shipping_cost_amount - shipping_subsidy_amount`**
  (so the existing `total = subtotal + shipping - discount` CHECK still balances); `payment_status
  IS NULL OR shipping_cost_amount IS NOT NULL` (every checkout order carries a quote; safe because
  no checkout order exists before session 9). The Rp20.000 cap itself is a code constant, not a
  CHECK, so changing it never conflicts with old orders.
- **`shipping_areas`**: add `subdistrict text NULL` (kelurahan), `label text` (Komerce's display
  label), `last_synced_at timestamptz`; make `postal_code` nullable (a few Komerce destinations
  carry no kode pos; the buyer then types it, §4.5.1); replace the UNIQUE `(province, city,
  district, postal_code)` (two kelurahan can share all four) with a UNIQUE on
  `komerce_destination_id`. Dropping the old UNIQUE is safe: the table is empty and no released
  code reads it. **As built (session 7):** a plain UNIQUE constraint
  `shipping_areas_komerce_destination_id_key` (NULLs stay distinct, so it is equivalent to the
  partial index) so the upsert can say `ON CONFLICT (komerce_destination_id)` without a predicate;
  `label` is nullable (columns added by a migration stay nullable) and session 8 always writes it;
  `last_synced_at` is NOT NULL DEFAULT now(). The two loosenings (DROP CONSTRAINT, DROP NOT NULL)
  were confirmed by the owner on 2026-10-21.
- **`customer_addresses`**: add `subdistrict text NULL`. The snapshot moves to `version: 2`
  (adds `subdistrict`, `shippingAreaId`, `komerceDestinationId`); v1 never reached an order.
- **`shipping_rate_cache`**: `origin_id text`, `destination_id text`, `weight_grams int`,
  `services_key text` (hash of the allowlist), `result jsonb` (allowlisted services and prices
  only), `fetched_at`; UNIQUE `(origin_id, destination_id, weight_grams, services_key)`, written
  with `INSERT ... ON CONFLICT DO UPDATE` (§4.5.4).
- No permission keys or other reference rows (the courier allowlist and the subsidy cap are code
  constants).

### Migration 0032 `customer_login_links` (session 14; was 0031 before 2026-10-21)

- **`customer_login_links`**: `id`, `customer_id` (FK restrict), `email citext` (the address it
  was sent to), `token_hash text UNIQUE`, `order_id NULL` (which order email issued it),
  `expires_at` (issue + 24 h), `consumed_at`, `superseded_at`, `created_at`, `consumed_ip`.
  Partial UNIQUE on `(customer_id)` WHERE `consumed_at IS NULL AND superseded_at IS NULL`, so at
  most one live link per customer exists, enforced by the database.

### Phase K migrations (numbers assigned at the time, expected 0033 and 0034)

- **`shipments`** (K2): `order_id UNIQUE` (one shipment per order in v1), `provider`
  (`komerce`), `provider_order_no UNIQUE`, `courier`, `service`, `awb UNIQUE NULL`, `cost_amount`
  (what Ammari actually pays at booking; compare with the order's quoted `shipping_cost_amount`),
  `label_url`, `status` (normalized: `created` / `pickup_requested` /
  `picked_up` / `in_transit` / `delivered` / `cancelled` / `returning` / `returned` /
  `problem`), `provider_status text` (raw), `delivered_at`, `last_polled_at`, `last_event_at`,
  timestamps.
- **`shipment_events`** (K3): `shipment_id`, `occurred_at`, `provider_status`,
  `normalized_status`, `description`, `location`, `source` (`webhook` / `poll`), UNIQUE
  `(shipment_id, occurred_at, provider_status)` so replays and repeated polls never duplicate.
- **`komerce_webhook_events`** (K3): raw log like `payment_notifications`.

Rollback safety: every new column is nullable or defaulted; nothing the current release reads is
renamed or dropped. No contract migration is needed.

## 4. Storefront UX

### 4.1 Cart storage and merge

- Guest: first "Tambah ke keranjang" creates a cart and sets `ammari_cart` (httpOnly, Secure,
  SameSite=Lax, 60 days). Only the hash is stored.
- Logged in: cart keyed by `customer_id`. On any cart read or write where both a session and a
  guest cookie exist, `resolveCart()` merges in one transaction (lock both cart rows, upsert with
  `qty = LEAST(old + new, 10)`, then trim to the 20-piece order cap, delete the guest cart, clear
  the cookie). This runs on the first request after any login (OTP, Google or magic link).
- Limits (decision 4): 1 to 10 per line, at most 20 pieces per cart and per order. Only active,
  published products and active variants can be added.

### 4.2 Cart UI

- No drawer in v1. PDP: "Tambah ke keranjang" calls a server action, then shows the existing
  inline box "Masuk keranjang: Beige, M · Lihat" and the header count updates.
- Header: cart icon with count, only when the flag is on.
- `/cart` per `mockup-cart.png`: image, name, "Warna · Ukuran", line price, stepper, remove ×,
  "N barang", Subtotal, "Ongkir: Dihitung saat checkout" (was "Gratis" before 2026-10-21; the
  cart has no destination, so it never quotes), primary "Lanjut ke checkout", text link "Lanjut
  belanja". Empty state with a primary button back to the collection. Reaching 20 pieces shows
  "Maksimal 20 barang per pesanan."
- Stock checks: every render re-reads availability uncached. Unavailable line: "Habis" muted with
  only "Hapus". Quantity above availability: "Stok tidak cukup untuk jumlah ini". No counts are
  ever shown. Deactivated or unpublished: "Tidak tersedia lagi". Checkout refuses while any line
  is unavailable.
- Size/colour change inside the cart: not in v1.

### 4.3 Checkout `/checkout` (single page, numbered sections)

1. **Kontak.** Guest: email + nomor WhatsApp (normalized to `+62...`). Logged in: locked card,
   "Bukan kamu? Keluar". A logged-in customer without a phone types it here.
2. **Alamat pengiriman.** Nama penerima, nomor HP penerima, **"Kecamatan / kelurahan / kode
   pos"** search (one combobox, §4.5.1; the chosen area shows as a read-only line "Kelurahan,
   Kecamatan, Kota, Provinsi 12345" with "Ganti"), Kode pos input only when the chosen area has
   none, alamat lengkap (jalan, nomor rumah, RT/RW), catatan untuk kurir (optional). Logged in
   with saved address: summary card with "Ubah" / "Ganti alamat" and "Perbarui alamat tersimpan".
   No map pin. Province select and free-typed city/kecamatan/kode pos (session 3) are gone.
3. **Pengiriman.** One fixed row, no choice and no delivery estimate (decisions 12, 18): before an
   area is chosen "Pilih alamat dulu untuk menghitung ongkir."; after, the chosen service
   ("JNE Reguler") with the buyer's share, and a muted line "Ongkir Rp35.000, subsidi Ammari
   -Rp20.000." (when the cost is at most Rp20.000: "Ongkir Rp18.000, ditanggung penuh subsidi
   Ammari." and the share shows "Rp0"), then "Nomor resi dikirim lewat email setelah pesanan
   dikirim." Failure states per §4.5.5.
4. **Ringkasan.** Lines, voucher field, Subtotal, **Ongkir** (the buyer's share, "Rp0" allowed,
   "-" until quoted), "Voucher -Rp20.000" (no "Hemat" badge, decision 5), Total.
   - Logged in: dropdown of usable vouchers, best auto-selected (largest amount, then soonest
     expiry), × clears it.
   - Guest: "Masuk untuk pakai voucher" goes to `/login?next=/checkout`; the cart merges on
     return.
   - Required consent checkbox (S&K + Kebijakan privasi links), optional promo checkbox.
   - "Bayar sekarang" always enabled, `#F07A1A` with `#1E1A1A` text, 54 px; submit shows one
     inline alert listing what to fix.
   - Note under the button: "Metode pembayaran dipilih di langkah berikutnya: QRIS, virtual
     account, atau e-wallet." Never the gateway name, never cards.
- Flag off: `/cart`, `/checkout`, `/checkout/*` return `notFound()` on the server.
- Ticking the checkout consent stamps `pdp_consent_at` for a logged-in customer whose value is
  null.

### 4.4 After submit

1. `placeOrder` (§5) creates the order and payment attempt, calls Snap, returns `redirect_url`.
2. Snap callbacks point to `/checkout/finish?order=<orderNo>`, authorized by session or the
   order access cookie set at checkout. It reads our DB and, if still pending, does one
   server-side status fetch. States: "Pembayaran berhasil", "Menunggu pembayaran" (with
   "Lanjutkan pembayaran" and the deadline in WIB), "Pembayaran gagal atau kedaluwarsa".
3. For a guest, the finish page also shows **"Masuk untuk melihat semua pesanan"**, linking to
   `/login?next=/orders` with the contact email prefilled (email OTP). It never logs in by itself.
4. The cart is emptied when the order is created. After expiry, "Pesan lagi" refills the cart
   from the order lines.

### 4.5 Shipping subsidy and rates (added 2026-10-21, D11, D12, D17)

The rule: the buyer pays `buyerShipping = max(0, cost - SHIPPING_SUBSIDY_MAX_AMOUNT)` with
`SHIPPING_SUBSIDY_MAX_AMOUNT = 20_000` (code constant in `@ammari/commerce/shipping`), and
`subsidy = cost - buyerShipping`. Product prices never depend on location. All of it is computed
on the server; the browser only ever sees the result.

#### 4.5.1 Address: Komerce destination search

- The combobox calls a flag-gated server endpoint (`GET /api/shipping/destinations?q=`, or a
  server action; session 8 picks after reading the installed Next docs) after 3 characters and a
  300 ms debounce. It accepts a kelurahan, kecamatan, city or kode pos fragment.
- The server calls Komerce Search Destination, **upserts every returned row into `shipping_areas`**
  (`ON CONFLICT (komerce_destination_id) DO UPDATE`, refreshing names, label, kode pos and
  `last_synced_at`), and returns at most 10 rows as **our `shipping_areas.id`** plus the display
  label. The browser never sends a Komerce id: the form posts `shippingAreaId`, and the server
  reads the area fields from that row. An id not in `shipping_areas` is a validation error.
- `shipping_areas.search_text` (lowercased, accent-free label) stays for a later local-first
  search; v1 always asks Komerce, so names and ids stay current.
- Rate limits on `claim_rate_limits`: **`area_search` 60 per 10 minutes per IP** (CF-Connecting-IP,
  same rules as `cart_write`), plus the global Komerce budget (§4.5.4). Over the limit: "Terlalu
  banyak pencarian. Coba lagi sebentar lagi."
- `@ammari/commerce/address` stays the one validator: `parseShippingAddress` takes the free fields
  (recipient, phone, address line, notes, and a kode pos only when the area has none) plus the
  loaded area row, keeps its cleaning, caps and all-errors-at-once messages, and refuses a missing
  area ("Pilih kecamatan atau kelurahan dari daftar."). `formatShippingAddress` adds the kelurahan.
  `toShippingAddressSnapshot` writes `version: 2` (adds `subdistrict`, `shippingAreaId`,
  `komerceDestinationId`). `INDONESIAN_PROVINCES` is no longer used by the form (kept for admin
  manual orders if wanted).
- A saved address without `shipping_area_id` (none exist yet; possible only from a future
  import) shows "Pilih ulang kecamatan" and cannot be used until re-picked.

#### 4.5.2 Courier and service (decision 18)

Options considered: one fixed courier (simplest, often not cheapest outside Java, fails where it
has no service); buyer chooses from a list (more UI and more quotes to validate, and Java buyers
see several "Rp0" rows); **cheapest among an allowlist (chosen)**.

- `SHIPPING_SERVICE_ALLOWLIST` (code constant): regular, non-COD, non-instant, non-cargo services
  only. Starting proposal, confirmed against the sandbox service codes in session 8: JNE REG,
  J&T EZ, SiCepat REG, ID Express Standard, AnterAja Reguler, POS Reguler (POS keeps remote
  destinations covered).
- One Calculate call per quote returns every courier's services; the server filters to the
  allowlist and takes the **lowest price, ties broken by allowlist order** (deterministic, so the
  same inputs always give the same service).
- The chosen courier and service are stored on the order. Before Phase K staff book exactly that
  service by hand; Phase K's Store Order uses it.
- No ETA is shown (decision 12), even though Komerce returns one.

#### 4.5.3 Weight (decision 19)

- `products.shipping_weight_grams` (migration 0031): one packed piece. Admin product form field
  "Berat kirim (gram)" with the hint "Berat 1 pcs yang sudah dilipat dan dibungkus plastik".
- **Required to publish** from session 7 (a new publish rule beside "at least one photo"), **only on
  the hidden -> published step** (owner decision 2026-10-21; no feature flag in admin). Products
  already published without it stay published and can still be saved, and every active product
  without a weight shows a "Berat kirim belum diisi" badge in the admin product list; checkout
  refuses an order containing one (§4.5.5) and logs the SKUs. A weight cannot be cleared while the
  product is published. The launch checklist (§14) requires zero published products without a
  weight.
- Order weight = `sum(qty x shipping_weight_grams) + SHIPPING_PACKAGING_GRAMS` (one outer mailer
  per order, code constant, starting at 100 g; the owner confirms by weighing one packed order).
  Sent to Komerce in grams; the courier applies its own kg rounding. Volume weight is ignored
  (folded gamis are small); revisit if a courier starts charging it.
- 20 pieces x ~800 g stays well inside regular-service limits.

#### 4.5.4 Quotes: server-side, cached, locked

- `quoteShipping({ areaId, lines })` in `@ammari/commerce/shipping` (no transaction): loads weights,
  computes the parcel weight, reads `shipping_rate_cache` for `(KOMERCE_ORIGIN_ID, destination,
  weight, allowlist hash)`; a hit younger than `SHIPPING_QUOTE_CACHE_MINUTES` (default 360) is
  used, otherwise one Calculate call refreshes the row. Returns `{ courierCode, serviceCode,
  label, costAmount, subsidyAmount, buyerAmount, weightGrams, destinationId, quotedAt }` or a
  typed refusal.
- **Checkout page:** quotes when the area or the cart changes (server action, never a client
  computed figure); shows the result in sections 3 and 4.
- **`placeOrder`:** calls `quoteShipping` again **before** opening the order transaction (no
  external call inside a DB transaction), from the cart lines it is about to lock. Inside the
  transaction it re-checks that the locked lines give the same weight (else rolls back with "Isi
  keranjang berubah. Cek ringkasan lagi.") and writes all eight `shipping_*` columns plus
  `shipping_amount = buyerAmount`. A different total than `expectedTotal` (price, voucher or
  ongkir changed) rolls back with "Harga, ongkir atau voucher berubah. Cek ringkasan lagi."
- **Locked:** once the order exists its shipping figures never change. A later tariff change, or a
  different actual cost at booking (Phase K `shipments.cost_amount`), is Ammari's gain or loss,
  never charged to the buyer.
- **Rate limits:** `shipping_quote` 30 per 10 minutes per IP; and a **global Komerce budget**:
  every outgoing Komerce call first inserts into `claim_rate_limits` with ip `*` and action
  `komerce_call`, refused above `KOMERCE_DAILY_CALL_BUDGET` per Jakarta day (set below the plan's
  daily quota so a bot cannot exhaust it). Refusal is treated as "Komerce down" (§4.5.5).
- Komerce calls: 5 s timeout, one retry after 300 ms on network errors and 5xx only, zod-parsed
  responses, typed errors (`unavailable`, `no_service`, `bad_response`, `budget_exhausted`,
  `missing_weight`); keys never logged; only the destination id and weight go to Komerce at this
  stage (no name, phone or street).

#### 4.5.5 Failure handling (decision 20)

No quote, no order; never a fallback rate.

| Case | Section 3 shows | "Bayar sekarang" |
|---|---|---|
| Komerce down, timeout, bad response, budget exhausted | "Ongkir belum bisa dihitung. Coba lagi sebentar lagi." + "Coba lagi" button | refuses with the same message |
| No allowlisted service to the destination | "Pengiriman ke alamat ini belum tersedia lewat website. Hubungi kami lewat WhatsApp." + WhatsApp link (prefilled with the area label, no city named in our own copy) | refuses |
| A product without a weight | "Ongkir belum bisa dihitung untuk pesanan ini. Hubungi kami lewat WhatsApp." + error log naming the SKUs | refuses |
| `placeOrder` quote differs from the shown one | n/a | rolls back with the drift message, page re-quotes |

Every failure is logged with the typed reason (no key, no address); repeated `unavailable`
within an hour is worth an owner alert later (not v1).

#### 4.5.6 Money

- Order fields: §3 migration 0031. `shipping_amount` = buyer's share (same meaning as the admin
  manual-order field "Ongkos kirim (ditanggung pembeli)").
- `total = subtotal + shipping_amount - discount`, the existing CHECK.
- **Voucher:** applies to goods only, `discount = min(voucher, subtotal)`; it never reduces ongkir
  and the subsidy never stacks into the voucher.
- **Midtrans `item_details`:** product lines, then `{ id: "SHIPPING", name: "Ongkir", price:
  buyerAmount, quantity: 1 }` **only when `buyerAmount > 0`**, then the negative "Voucher" line;
  their sum equals `gross_amount` (Midtrans rejects a mismatch). No subsidy line (it is not money
  the buyer pays).
- **Cancel / expiry (unpaid):** nothing was paid, nothing to refund; the quote stays on the
  cancelled order for metrics.
- **Paid, cancelled before shipping (§6.5):** `refund_due` covers the full `total_amount`,
  ongkir included.
- **Returns after delivery:** whether the buyer's ongkir is refunded follows the "Pengembalian &
  penukaran" page (owner wording); staff refund by hand as today.
- **Admin order detail** (session 16) "Pengiriman": layanan ("JNE Reguler"), berat ("1,4 kg"),
  tujuan (area label), "Ongkir kurir Rp35.000", "Subsidi Ammari Rp20.000", "Dibayar pembeli
  Rp15.000", quote time; Phase K adds the actual booked cost. `/packing` shows the service so
  staff book the right one before Phase K.
- **Overview:** a web order's goods revenue is `subtotal - discount`; ongkir is pass-through, and
  Ammari's shipping expense is `shipping_cost_amount - shipping_amount` (= the subsidy) until Phase
  K records the actual cost. Whoever builds web-order metrics must not count `shipping_amount` as
  sales.

## 5. Order creation (`placeOrder`, in `@ammari/commerce`)

All in one transaction, trusting the client only for cart identity, form fields, chosen voucher
id, consent booleans, a `checkoutAttemptId`, and an `expectedTotal` used only to detect drift.

1. Rate limits: `checkout_submit` per IP (10 per 10 min) and at most 3 unpaid web orders per
   contact email in 2 hours.
2. Zod validation (email, `+62` phone, `shippingAreaId` that exists in `shipping_areas`, free
   address fields via `parseShippingAddress`, lengths, consent true).
2a. **Shipping quote, before the transaction** (§4.5.4): `quoteShipping` from the current cart
   lines and the area. A refusal returns the §4.5.5 message and creates nothing.
3. Re-read cart lines, products/variants (active, published) and current `products.base_price`;
   compute subtotal; enforce 10 per line and 20 per order; recompute the parcel weight from the
   locked lines and refuse if it differs from the quote's.
4. Customer: session customer, or link-or-create by email (insert-first idiom). New customer:
   stamp `pdp_consent_at`, `promo_consent_at` if ticked, phone only if free. Existing customer
   matched by an unverified email: never changes its name, phone or consent; the order carries its
   own contact snapshot and consent evidence.
5. `generateOrderNumber(tx)` (`ORD-YYYYMM-NNNN`, decision 6).
6. Insert `orders` (`channel_id = 'web'`, `awaiting_payment`, `payment_status = 'pending'`,
   `shipping_amount` = the quote's buyer share plus the other seven `shipping_*` columns,
   `shipping_area_id`, snapshots (address `version: 2`), `placed_with_session`, `payment_expires_at = now + 60 min`)
   and `order_items` (`unit_cost = 0` until paid).
7. Reserve stock per SKU (sorted, `lockVariantForUpdate`, `physical - active reservations >=
   qty`), `expires_at = now + 75 min` (decision 1). Error names product, colour and size.
8. Voucher (session only): `UPDATE vouchers SET status='used', used_order_id, used_at WHERE id
   AND customer_id AND status='active' AND expires_at > now() RETURNING amount`; zero rows rolls
   back with "Voucher tidak bisa dipakai". Discount = `min(amount, subtotal)`.
9. `total = subtotal + shipping_amount - discount`; drift from `expectedTotal` rolls back with
   "Harga, ongkir atau voucher berubah. Cek ringkasan lagi."
10. Insert `payments` attempt 1, insert one `order_access_tokens` row for the checkout cookie,
    delete cart items, audit log (`action = 'web_checkout'`, no staff actor).
11. After commit: Snap `POST /snap/v1/transactions` with `transaction_details`, `item_details`
    (product lines, an "Ongkir" line when the buyer's share is above 0, and a negative "Voucher"
    line; §4.5.6), `customer_details`, `enabled_payments = ["other_qris",
    "gopay", "shopeepay", "bca_va", "bni_va", "bri_va", "echannel", "permata_va"]` (decision 2;
    `echannel` is Mandiri Bill), `expiry` 60 minutes, `callbacks.finish`,
    `X-Override-Notification`. Snap failure keeps the order pending with a retry button; the
    sweeper expires it if never paid. Ammari absorbs the fee (decision 3): no fee line.

Concurrency tests: last unit with two buyers, the same voucher in two tabs, double submit
(`checkout_attempt_id` UNIQUE returns the same order), a cart change between the quote and the
transaction (weight mismatch rolls back). Shipping tests: subsidy split at cost 0, 19.999,
20.000, 20.001 and 200.000; a voucher with a non-zero buyer share; a quote refusal creates no
order and holds no stock.

## 6. Payments: Midtrans Snap

### 6.1 Notification endpoint `POST /api/payments/midtrans/notification` (apps/web)

1. Raw JSON, 32 KB limit, logged to `payment_notifications`.
2. Verify `signature_key == sha512(order_id + status_code + gross_amount + SERVER_KEY)`,
   constant-time. Mismatch: 403, no change.
3. Unknown `provider_order_id`: 200 and log.
4. Fetch `GET /v2/{order_id}/status`; apply the state machine to that response. `gross_amount`
   must equal `payments.gross_amount` (IDR), else `needs_attention = 'amount_mismatch'`, never
   paid. A `payment_type` of `credit_card` (should be impossible) adds the `payment_anomaly`
   flag instead, never paid.
5. One transaction, `FOR UPDATE` on the order, conditional updates, so replays and out-of-order
   deliveries are no-ops.
6. 200 after commit, 500 on errors (Midtrans retries). Emails via `after()`.

The path is excluded from the dev site's login wall (Cloudflare Access bypass for exactly this
path) and from bot challenges.

### 6.2 Status mapping (no card statuses: cards are not enabled)

| Midtrans `transaction_status` | `payments.status` | Order effect |
|---|---|---|
| `pending` | `pending` | none |
| `settlement` | `paid` | `awaiting_payment -> to_ship`: reservations `consumed`, `sale` movements, `unit_cost` locked, `paid_at`, `payment_status = 'paid'`; emails `paid` (customer) and `owner_paid` (decision 11) |
| `deny`, `failure` | `failed` | none (customer may retry inside Snap until expiry) |
| `expire` | `expired` | `-> cancelled`, `cancel_reason = 'payment_expired'`, reservations released, voucher restored |
| `cancel` | `cancelled` | same, `cancel_reason = 'payment_cancelled'` |
| `refund` / `partial_refund` | `refunded` / `partially_refunded` | flag `refund_received`; staff decides the order status |
| `chargeback` / `partial_chargeback` | `chargeback` | flag only (not expected without cards; handled defensively) |
| `capture`, `authorize` | unchanged | card-only statuses: logged and flagged `payment_anomaly`, never paid |
| paid for an order already `cancelled` | `paid` | flag `paid_after_cancel` for a manual refund |
| paid with insufficient physical stock (decision 9) | `paid` | stays `awaiting_payment`, `payment_status = 'paid'`, flag `stock_short_at_payment`; admin "Proses" retries once stock arrives, or the owner refunds |

### 6.3 Expiry sweeper `POST /api/internal/payments/sweep`

Bearer `INTERNAL_CRON_SECRET`, internal network only (Caddy does not route `/api/internal/*`).
Every 5 minutes: web orders `awaiting_payment` past the 75-minute hold get a Midtrans status
fetch; still `pending` gets `POST /v2/{order_id}/cancel`; the result goes through the same state
machine. `/account`, `/orders` and checkout also finalize the current customer's own stale orders
lazily. Customers cannot cancel unpaid orders themselves (decision 10).

Cron: a small service in `deploy/docker-compose.yml` (pinned `curlimages/curl` loop or
supercronic) on the `internal` network, dev and prod.

### 6.4 Voucher reversal

On any `-> cancelled` of a web order, same transaction:
`UPDATE vouchers SET status = CASE WHEN expires_at > now() THEN 'active' ELSE 'expired' END,
used_order_id = NULL, used_at = NULL WHERE used_order_id = $order AND status = 'used'`.
`returned` never restores (decision 8).

### 6.5 Admin cancel of a web order

- `awaiting_payment`: calls Midtrans cancel first; refuses if Midtrans reports it paid.
- `to_ship`: allowed as today, plus "Kembalikan dana pembeli lewat dashboard pembayaran" and flag
  `refund_due` until a refund notification arrives or staff clears it. The amount to refund is the
  full `total_amount`, ongkir included (§4.5.6).

## 7. How web orders fit the existing admin flow

- **Statuses:** unchanged `ORDER_STATUSES`. `payment_status` separate, web only.
- **`/orders`:** payment badge, "Perlu dicek" filter (`needs_attention`), detail "Pembayaran"
  section (method, paid time, attempts, transaction id, refunds), contact and structured
  address, actions per §6.5, item edit blocked for web orders, and a "Pengiriman" section with the
  locked quote (§4.5.6); Phase K adds the booking and tracking to it (§15).
- **`/packing`:** paid web orders enter the `to_ship` queue showing the quoted service ("JNE
  Reguler"). Thank-you cards stay marketplace only (verify and enforce server-side). Before Phase
  K: staff book that service by hand, then manual "Tandai dikirim" (courier prefilled from the
  order) with the resi sends the "Pesanan dikirim" email. After Phase K: "Buat pengiriman" books Komerce and prints
  the label; the manual path stays as fallback.
- **`/stock`:** read-only "Dipesan" figure from active reservations, reservation rows on
  `/stock/[sku]`, and a note on the count page that reserved pieces are still counted.
- **Revalidation** of affected product paths after reserve, release and sale.
- **Overview:** the 18% marketplace fee assumption must not apply to `web`; ongkir is not sales
  revenue and the subsidy is a shipping expense (§4.5.6).
- **Products:** "Berat kirim (gram)" on the product form, required to publish, badge on the list
  when missing (§4.5.3, session 7).

## 8. Emails (Resend, Indonesian, plain text first)

| Kind | Trigger | Content |
|---|---|---|
| `created` | order created | order no, lines, subtotal, ongkir (buyer's share, with "subsidi ongkir Rp20.000" when it applied), voucher, total, "Lanjutkan pembayaran" link, deadline in WIB, **"Lihat pesanan"** link; guest orders (`placed_with_session = false`) also **"Masuk ke akun"** |
| `paid` | to `to_ship` | "Pembayaran diterima", lines, address, next steps, "Lihat pesanan"; guest orders also a fresh "Masuk ke akun" (supersedes the earlier one) |
| `shipped` | manual "Tandai dikirim" or Komerce picked-up/in-transit | courier, resi, "Lihat pesanan" (tracking shows there) |
| `delivered` | Komerce delivered (Phase K) | "Pesanan sudah sampai", returns/exchange info link |
| `cancelled` | expire/cancel | reason in plain words, voucher restored note, "Pesan lagi" |
| `owner_paid` | paid (decision 11) | to `store_settings.support_email`: order no, lines, total, link to admin order |

Each customer email mints its own `order_access_tokens` row. Magic links are rate limited and
skipped silently when the limit is hit (§9.3). Idempotent via `order_notifications`, sent with
`after()`, failures recorded and never thrown into a webhook. Never the gateway name.

## 9. Customer order access

### 9.1 "Pesanan saya" (`/account`, `/orders`, `/orders/[orderNo]`)

- `/account`: list extended with status, payment status, total and a detail link. Customer
  labels: "Menunggu pembayaran", "Diproses", "Dikirim", "Selesai", "Dibatalkan", "Dikembalikan".
  Marketplace orders show as today.
- `/orders`: paginated list for the logged-in customer.
- `/orders/[orderNo]`: lines, totals (subtotal, ongkir as paid, voucher, total), address, status timeline, "Lanjutkan pembayaran" while
  pending, "Pesan lagi" when cancelled, and a **"Lacak pengiriman"** block: courier and resi from
  the order (before Phase K), then the `shipment_events` timeline with the latest status on top
  (Phase K). Unknown or unauthorized: the same not-found page.
- e2e at 390 px and 1280 px.

### 9.2 "Lihat pesanan" view-only token

- 32 random bytes, base64url, only the sha256 stored in `order_access_tokens`. URL
  `/orders/<orderNo>?t=<token>`; on first open it is moved to an httpOnly cookie scoped to
  `/orders/<orderNo>` and the URL is cleaned (also removes it from Referer and history).
- Grants view of **that one order only**: no other orders, no vouchers, no account data, no
  writes except "Lanjutkan pembayaran" (which only re-opens the stored Snap `redirect_url`).
- **Lifetime: 120 days from issuance** (each email's token). That covers payment, shipping,
  delivery and the returns window with room to spare. After expiry the page offers "Masuk untuk
  melihat pesanan" (OTP).
- Rate limited `order_view` per IP; tokens compared by hash lookup.

### 9.3 "Masuk ke akun" magic login link

Custom Better Auth plugin `orderLoginLink` in `packages/auth/src/customer/` (D15):

- **Issuance (server-side only, no public endpoint):** called from the email step for guest
  orders. In one transaction: mark the customer's live link `superseded_at = now()`, insert a new
  row (`customer_id`, `email` = the customer's current email, sha256 `token_hash`, `order_id`,
  `expires_at = now + 24 h`). The partial UNIQUE index guarantees one live link per customer.
  Rate limit: at most 5 issued per customer per 24 hours, and the existing per-email throttle and
  global circuit breaker apply to the send. Over the limit: the email goes out without the magic
  link (still has "Lihat pesanan").
- **Link target:** `/login/link?token=<token>`. **Opening it does not log in.** The page (GET) is
  `noindex`, `Referrer-Policy: no-referrer`, does a read-only hash lookup, and shows either "Masuk
  sebagai a***@gmail.com" with a **"Masuk"** button, or "Link sudah tidak berlaku" with an OTP
  login link. Prefetchers and email security scanners only ever trigger this read.
- **Login happens on the button's POST** to the plugin endpoint `POST
  /api/auth/order-login-link/consume` (a plain HTML form, token in a hidden field). Protection:
  Better Auth's `formCsrfMiddleware` + origin check against `trustedOrigins`, SameSite cookies,
  Better Auth rate limit rule (10 per 10 minutes per IP via `cf-connecting-ip`).
- **Consume, atomically:** `UPDATE customer_login_links SET consumed_at = now(), consumed_ip
  WHERE token_hash = $h AND consumed_at IS NULL AND superseded_at IS NULL AND expires_at > now()
  RETURNING customer_id, email`. Zero rows: generic "Link sudah tidak berlaku". Then check
  `customers.email` still equals the link email (bound to that customer and email). Find the
  Better Auth user by email, or create it (`emailVerified: true`; our `user.create.before` hook
  links it to the same `customers` row) and refuse if the linked `customer_id` differs. Set
  `emailVerified` and `customers.email_verified_at` if missing (the click proves ownership).
  Create the session with Better Auth's internal adapter and session cookie (same cookie, expiry
  and `session.create` hooks as OTP/Google logins).
- **Audit:** `audit_log` row (`actor_staff_user_id = null`, action `customer_login_link`,
  entity `customer`, after: link id, order id, ip). Failed consumes are logged without the token.
- **After login:** redirect to `/orders`; the next request merges the guest cart (§4.1). The
  `/consent` gate still applies if `pdp_consent_at` is null.
- Tests: GET never creates a session; second POST fails; superseded and expired links fail;
  email changed between issue and use fails; CSRF (missing/foreign Origin) fails; rate limits;
  audit row written.

## 10. Security checklist

- Server recomputes prices, discount, shipping quote, totals and stock everywhere;
  `expectedTotal` only detects drift. The browser never sends a price, courier, weight or Komerce
  id; areas are referenced by our own `shipping_areas.id` (§4.5).
- Atomic patterns only: SKU locks + reservations; conditional voucher UPDATE;
  `checkout_attempt_id` UNIQUE; webhook conditional updates; cart merge upsert; magic link
  consume UPDATE ... RETURNING; one live login link per customer by partial UNIQUE index.
- CSRF: server actions use Next's built-in Origin check; the magic-link POST uses Better Auth's
  CSRF middleware; webhooks and the sweep are authenticated by signature, secret path token or
  bearer secret.
- No silent login anywhere: checkout never creates a session; the magic link needs a POST.
- Rate limits: cart writes, checkout submit, area search, shipping quote, the global daily Komerce
  call budget, order view, login link view/consume, magic link issuance.
- Outbound Komerce calls go only to the configured base URL (no user-controlled URL, so no SSRF),
  with a timeout; responses are zod-parsed and only allowlisted fields are cached.
- Inventory hoarding: 75-minute hold, 3 unpaid orders per email, 20-piece cap.
- Customer sessions never reach admin (unchanged).
- Secrets only in env; Midtrans server key and Komerce key never reach the browser.
- No cost data in storefront queries.
- Logs never include keys, signatures, raw tokens or full addresses.
- Reviewers: `security-reviewer` on sessions 5, 8, 9, 10, 11, 14 and K3; `silent-failure-hunter`
  on the Komerce rate client (session 8), the payment webhook, sweeper, emails and the Komerce
  webhook/poller.

## 11. Data retention

| Data | Retention |
|---|---|
| Paid orders, items, payments, address snapshots, shipments and tracking events | 10 years (bookkeeping, UU KUP), then contact fields anonymized |
| Expired/cancelled unpaid orders | contact and address anonymized after 90 days; rows kept for metrics |
| `payment_notifications.payload`, `komerce_webhook_events` | 12 months |
| `order_access_tokens` | deleted 30 days after expiry |
| `customer_login_links` | deleted 30 days after expiry/consume (audit rows stay in `audit_log`) |
| Guest carts / customer carts | 30 days / 180 days after last activity |
| `customer_addresses` | until the customer deletes them or the account is deleted |
| Rate limit rows (incl. `komerce_call`) | 1 day |
| `shipping_rate_cache` | rows older than 7 days deleted (only fresh rows are ever used) |
| `shipping_areas` | kept (public reference data, no personal data; re-synced on every search hit) |

Run daily from the same internal sweep route.

### 11.1 Privacy policy and terms changes (owner edits the live text in admin Konten before launch)

**Kebijakan Privasi**, add or update:
1. Data collected at checkout: name, email, WhatsApp number, recipient name and phone, shipping
   address, order contents, payment status and payment method type (we never receive or store
   card data or banking credentials; no card payments are offered).
2. Purposes: processing and delivering orders, payment confirmation, sending order and shipping
   emails, customer service, legal bookkeeping obligations, and promotions only with separate
   consent.
3. Shared with: a licensed payment processor (to process payment), **the shipping service
   provider and the courier** (updated 2026-10-21): at checkout only the chosen area (kelurahan,
   kecamatan, kode pos) and the parcel weight are sent to calculate ongkir; once the order is
   paid, the recipient's name, phone and full address go to the shipping provider and courier to
   deliver the package and provide tracking. And the email delivery provider. No sale of data.
4. Accounts: a checkout creates or links an account by email; login is passwordless (email code,
   Google, or a one-time login link sent by email that expires in 24 hours); no password is
   stored.
5. Retention periods from §11 (in plain words: order and payment records 10 years; unpaid
   expired orders anonymized after 90 days; carts 30/180 days; saved addresses until deleted).
6. Rights under UU PDP: access, correction, deletion of saved addresses and the account, and
   withdrawing promo consent, with the contact channel (support email / WhatsApp).
7. Cookies: login session, cart cookie and order-view cookie are strictly necessary.

**Syarat & Ketentuan**, add or update:
1. Ordering: an order is placed when "Bayar sekarang" is pressed and is confirmed only after
   payment is received.
2. Payment: within 60 minutes, by QRIS, e-wallet (GoPay, ShopeePay) or virtual account (BCA, BNI,
   BRI, Mandiri, Permata); unpaid orders are cancelled automatically and stock is released.
3. Prices in rupiah and the same for every location. **Ongkir (updated 2026-10-21):** Ammari
   covers up to Rp20.000 of the shipping cost per order; the buyer pays the rest, shown as
   "Ongkir" before payment and included in the total. No other fees at checkout. Vouchers do not
   apply to ongkir.
4. Limits: maximum 10 per item and 20 pieces per order.
5. Vouchers: Rp20.000, one per order, no minimum, cannot be cashed out or exceed the subtotal;
   returned when an order is cancelled or its payment expires (if still valid), not after a
   return.
6. Stock: if an item turns out to be unavailable after payment, Ammari contacts the buyer and
   refunds in full.
7. Shipping: Ammari chooses the courier and regular service (the cheapest available to the
   address); delivery time depends on the courier and is not guaranteed; some areas may not be
   reachable through the website (order via WhatsApp instead); tracking is available in "Pesanan
   saya"; an order is marked complete when the courier reports it delivered.
8. Cancellation by the buyer of a paid order and refunds go through customer service; a paid
   order cancelled before shipping is refunded in full, ongkir included; returns and exchanges
   (including whether ongkir is refunded) follow the "Pengembalian & penukaran" page.

Also update the **Pengiriman** info page and the announcement bar text (both owner-edited in
admin) to the subsidy wording; the code defaults were changed 2026-10-21 except the announcement
bar's column default (owner changes the live text).

The checker for the payment processor's merchant review may also want the processor named on the
policy page; if so, that is the one allowed exception to the "never name the gateway" rule,
confirmed by the owner.

## 12. Environment variables (names only)

apps/web: `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION`, `MIDTRANS_ORDER_ID_PREFIX`,
`MIDTRANS_NOTIFICATION_URL`, `CHECKOUT_PAYMENT_EXPIRY_MINUTES` (60),
`CHECKOUT_STOCK_HOLD_MINUTES` (75), `INTERNAL_CRON_SECRET`, existing `STOREFRONT_CART_ENABLED`,
`RESEND_API_KEY`, `EMAIL_FROM`, `BETTER_AUTH_URL`, `CUSTOMER_BETTER_AUTH_SECRET`.
apps/web Phase C shipping (session 8): `KOMERCE_COST_API_KEY`, `KOMERCE_COST_BASE_URL` (Shipping
Cost: Search Destination, Calculate), `KOMERCE_ORIGIN_ID` (Ammari's own destination id, never
shown), `KOMERCE_DAILY_CALL_BUDGET`, `SHIPPING_QUOTE_CACHE_MINUTES` (360),
`SHIPPING_RATE_PROVIDER` (`komerce`, or `fake` only behind the e2e fixtures gate; production
refuses `fake`).
apps/admin: `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION`, `MIDTRANS_ORDER_ID_PREFIX`,
existing `MAIN_SITE_URL`; Phase K adds `KOMERCE_DELIVERY_API_KEY`, `KOMERCE_DELIVERY_BASE_URL`,
`KOMERCE_ORIGIN_ID`, `KOMERCE_SHIPPER_*` (name, phone, address as Komerce needs). The cost and
delivery key pairs are separate names because Komerce may issue separate keys or hosts per
product; they can hold the same values.
apps/web Phase K: `KOMERCE_DELIVERY_API_KEY`, `KOMERCE_DELIVERY_BASE_URL`,
`KOMERCE_WEBHOOK_PATH_TOKEN`.
cron service: `INTERNAL_CRON_SECRET`.
Added to `deploy/env/*.env.example` and `.env.example`; payment and Komerce code paths fail
closed when their variables are missing.

## 13. Testing strategy

- **Unit (TDD for vouchers, payments, stock, login links, shipping money):** pricing, best
  voucher, signature, every row of §6.2, provider order id, phone normalization, area search
  parsing, subsidy split (0, 19.999, 20.000, 20.001, 200.000), cheapest-service pick with ties
  and non-allowlisted services, parcel weight with packaging, Midtrans item_details sum with and
  without an Ongkir line, Komerce response parsing against **hand-written fixtures copied from the
  documented examples** (never recorded from a real call), Komerce status normalization,
  retention cut-offs.
- **DB integration:** reservations, last-unit race, voucher double redeem, double submit, webhook
  replay and out-of-order, expiry release + voucher restore, expired voucher not restored,
  paid-after-cancel, stock-short-at-payment, cart merge caps, admin cancel, login link single use
  and supersede, shipment event dedupe and auto-complete.
- **Fakes:** `FakePaymentProvider` (with a gated local "Snap" page under `/api/test/...`),
  `FakeShippingRateProvider` (session 8: a handful of fictional destinations, e.g. "Kelurahan
  E2E Murah" quoting Rp12.000 (buyer Rp0), "Kelurahan E2E Jauh" quoting Rp95.000 (buyer
  Rp75.000), one with no allowlisted service, one that times out, one without kode pos) and
  `FakeShippingProvider` for Phase K, all behind the existing e2e fixtures gate. Unit tests inject
  a stub `fetch` into the Komerce client; nothing in CI or e2e reaches Komerce or Midtrans.
- **e2e (Chromium + WebKit, 390 px and 1280 px):** add to cart, cart edits and sold-out line,
  guest checkout alert, guest checkout to fake payment to finish page, finish page OTP link,
  magic link (GET page, POST login, cart merged, "Pesanan saya"), "Lihat pesanan" token page,
  logged-in checkout with voucher, expiry and "Pesan lagi", order list/detail, admin sees the order
  in `/orders` and `/packing`, flag off 404. On `ammari_e2e` only.
- **e2e shipping (session 10):** area search and pick, Rp0 and Rp75.000 buyer shares in sections 3
  and 4, no-service and timeout states block "Bayar sekarang", the Ongkir line reaches the fake
  payment page, at 390 px and 1280 px.
- **Sandbox contract tests (opt-in with sandbox keys, skipped by default, run by hand):** Midtrans
  create/status/cancel; Komerce destination search and calculate (session 8), store order,
  detail, history AWB, cancel (Phase K).
- **Manual sandbox checklist:** BCA VA and QRIS via the Midtrans simulator, GoPay and ShopeePay
  simulators, Mandiri bill, expiry after 60 minutes on dev, webhook received on `ammari.my.id`,
  emails and both links received and working. Phase K: a sandbox shipment through to
  "Selesai".

## 14. Launch switch (WhatsApp CTA to cart)

- Until 1 Dec: prod `STOREFRONT_CART_ENABLED=false` (WhatsApp primary CTA, no cart icon,
  `/cart` and `/checkout` 404). Dev runs with `true` from session 6 on.
- Before launch (by ~15 Nov): Midtrans production approved with exactly the methods in decision
  2, production keys in prod env, notification URL set, one real low-value QRIS payment refunded,
  privacy policy and terms updated (§11.1), footer payment chips changed to QRIS, Virtual
  Account, GoPay, ShopeePay (remove "Kartu kredit").
- Before launch, shipping (added 2026-10-21): a Komerce subscription with Shipping Cost access and
  its production key in the prod env (§15 "Komerce plan"), `KOMERCE_ORIGIN_ID` set to Ammari's
  own destination, `KOMERCE_DAILY_CALL_BUDGET` below the plan's daily quota, **zero published
  products without "Berat kirim"**, the packaging allowance confirmed by weighing one packed order,
  a spot check of 3 quotes on dev (one in Java, one in Sumatra or Sulawesi, one in Papua) against
  Komerce's own calculator, and the announcement bar and Pengiriman page re-worded by the owner.
- Launch: flag `true` in the prod env file, restart the web container (no rebuild), trigger the
  full-storefront revalidation, smoke test one order.
- Rollback: flag `false`, restart, revalidate. Webhooks, sweeper and `/orders/*` stay on.
- After launch: WhatsApp stays as the outlined secondary "Tanya via WhatsApp" (decision 7, already
  implemented); `/how-to-order` copy updated in admin Konten.

## 15. Sessions

Each session: `/plan` confirmed, TDD where required, `drizzle-kit generate` and the migration read
before commit, `/code-review` with the matching reviewers, `/checkpoint`. Read the installed
Next.js and Better Auth docs/source before route, action or plugin work.

### Phase C: cart, checkout, payment (target: done by ~20 Nov)

| # | Session | Migration | Tests | Reviewers |
|---|---|---|---|---|
| 0 | **DONE 2026-10-20.** Approve plan; update SPEC.md (§3.4 no shipping-cost calculation, tracking via Komerce; §5.2/§5.3 new tables; §8 gateway = Midtrans without cards, courier = Komerce; §10.3 order login link) and design spec (§4 footer chips without card, §7 fixed shipping row) | none | none | none |
| 1 | **DONE 2026-10-20.** Extract `@ammari/commerce` (no behavior change). Moved: `db` (`Tx`, `Database`, `writeAuditLog`), `errors` (`FieldError`, `ActionError`, `mapUniqueViolation`), `jakarta-month`, `moving-average`, `order-status`, `orders` (`createOrder`, `updateOrderItems`, `transitionOrderStatus`, `generateOrderNumber`), `stock` (`lockVariantForUpdate`, `currentBalanceForSkuLocked`, `adjustStock`, `saveStockCount`), `thank-you-cards` (`voidActiveCardForOrder`). Admin's `@/lib/db` and `@/lib/errors` re-export them (one error class for `instanceof`). Admin-only read queries (order list/detail with cost, SKU picker, stock overview/ledger/count sheet) stay in apps/admin, so cost-bearing reads never sit in a package web imports. No voucher redeem/restore code existed to move (§1); it is new in session 7, in this package. apps/web does not use the package yet. Its test task is chained after `@ammari/auth#test` (`packages/commerce/turbo.json`) | none | existing admin tests moved and green | typescript, database |
| 2 | **DONE 2026-10-20.** Schema `checkout_core` + constants + constraint tests. `packages/db/src/schema/checkout.ts` (new tables), checkout columns on `orders`, constants `STOCK_RESERVATION_STATUSES`, `PAYMENT_PROVIDERS`, `PAYMENT_STATUSES`, `ORDER_PAYMENT_STATUSES`, `ORDER_CANCEL_REASONS`, `ORDER_ATTENTION_FLAGS`, `ORDER_NOTIFICATION_KINDS`. Migration hand edits: `SET LOCAL lock_timeout = '5s'`, `set_updated_at` triggers on the 5 new tables with `updated_at`, and the `order_items` UNIQUE moved before the composite FK that needs it (drizzle-kit emitted it after). Tests: `test/checkout-schema.test.ts`, `test/migration-0030.test.ts` (upgrade from 0029 with data, previous release's writes, idempotent re-run) | 0030 | db tests | database |
| 3 | **DONE 2026-10-20.** Shipping areas: licence check **not clean** (§3), so the plain-field fallback: `@ammari/commerce/address` (province list, phone normalization, `parseShippingAddress`, `formatShippingAddress`, `toShippingAddressSnapshot`). No dataset script, no data migration, no area search; `shipping_areas` stays empty. Tests: `packages/commerce/src/address.test.ts` (unit, plus DB checks that parsed output satisfies the `customer_addresses` and `orders` constraints). Session 8's form uses a province select and plain city/kecamatan/postal code inputs (superseded 2026-10-21: Komerce area search, §4.5.1) | none (0031 skipped) | unit + db | database, typescript |
| 4 | **DONE 2026-10-20.** Reservations + storefront availability + admin "Dipesan". `@ammari/commerce/stock`: `reserveStockForOrder(tx, orderId, lines, holdMinutes)` (runs inside the caller's order transaction; per SKU sorted, variant `FOR UPDATE`, `physical - active unexpired holds >= qty`, `expires_at = now() + holdMinutes`; refusal is a `FieldError` on the SKU naming product, colour and size, never a count), `DEFAULT_STOCK_HOLD_MINUTES = 75`, `consumeReservationsForOrder` / `releaseReservationsForOrder` (conditional `UPDATE ... WHERE status = 'active' RETURNING`, replay-safe). Wired into `transitionOrderStatus`: `awaiting_payment -> to_ship` writes the sale (physical check only, D4) then consumes the order's holds, expired or not; an unpaid cancel releases them; a paid cancel restores via the ledger and leaves consumed holds alone. `updateOrderItems` refuses checkout orders (`payment_status` set). The "which holds count" rule (`active` and `expires_at > now()`) lives once in `@ammari/db/stock-availability` (`physicalStockQtySql`, `activeReservedQtySql`, `sellableQtySql`), used by the storefront (`available`, tile `soldOut`) and admin (`getReservedQtyBySku`, `listActiveReservationsForSku`). Admin: "Dipesan N" on `/stock`, a hold list on `/stock/[sku]` (order link with `orders.view`), "Dipesan: N pcs (tetap dihitung)" plus a note on the count page; all shown only while a hold exists, so nothing changes until checkout writes one. Tests: `packages/commerce/src/stock/reservations.test.ts` (incl. last-piece race), storefront availability tests, admin query tests, `apps/admin/e2e/stock-reservations.spec.ts` (390/1280, hold seeded in e2e global setup) | none | TDD stock + admin e2e 390/1280 | database, typescript, react |
| 5 | **DONE 2026-10-20.** Cart backend. `@ammari/commerce/cart` (apps/web now depends on `@ammari/commerce`, workspace link only): `resolveCart` (read, never creates; merges when a session and a guest cookie are both present), `addCartItem` / `setCartItemQty` / `removeCartItem` (one transaction each, cart row locked first by the upsert or `FOR UPDATE`, so the 20-piece cap that spans rows is atomic; a refusal throws inside and rolls the write back, so it never leaves an empty cart; a login merge commits in its own transaction first, so a refused write never undoes it), `getCartView` (current `base_price`, line status `ok` / `insufficient` / `sold_out` / `unavailable` from `sellableQtySql`, image of the line's colour then the thumbnail; no stock number or cost column ever leaves the module), `getCartPieceCount`, token helpers (32 random bytes base64url, sha256 hex stored). `@ammari/commerce/cart-limits` (no server-only, for client UI): `CART_MAX_QTY_PER_LINE` 10, `CART_MAX_PIECES` 20, refusal and line-status messages. Merge: guest lines first (current intent), then the customer's; same SKU `LEAST(old + new, 10)`; trimmed to 20 in that order (`mergeTrimmed` reported); lock order guest then customer. Add refuses inactive/unpublished/inactive-variant SKUs, `line_limit`, `cart_limit`, `sold_out`, `insufficient_stock` (line total vs sellable); set-quantity allows lowering always, re-checks stock and cap only when raising, refuses unavailable lines (remove only). apps/web `lib/cart/`: `identity.ts` (`ammari_cart` cookie: httpOnly, SameSite=Lax, Secure on https and always in a production build, 60 days, re-set on every guest write; malformed values ignored; a well-formed token is reused only while it names a live guest cart, otherwise a fresh one is minted, so a planted token never becomes a shared cart), `ip.ts` (`CF-Connecting-IP` validated with `net.isIP`; missing or invalid in production is logged and the write refused, never one shared bucket; locally 127.0.0.1), `actions.ts` (`addToCartAction`, `updateCartItemQtyAction`, `removeCartItemAction`: flag check first, then per IP on `claim_rate_limits` `cart_write` 120 per 10 minutes and, for an add that creates a guest cart, `cart_create` 20 per hour; zod input; Indonesian messages; unexpected errors logged and returned as "Terjadi kesalahan. Coba lagi."; clears the guest cookie after any customer write that carried one), `queries.ts` (`loadCartView`, `loadCartPieceCount` for server components; empty while the flag is off). Tests: `packages/commerce/src/cart/cart.test.ts` (caps, availability, holds, merge and trim, ownership, three committed-transaction races), `apps/web/src/lib/cart/actions.test.ts` (cookie attributes, hash-only storage, planted token, flag off, both rate limits, IP fallback, generic error, merge on login incl. a refused write) | none | TDD integration | security, typescript, database |
| 6 | **DONE 2026-10-21.** Cart UI. PDP: "Tambah ke keranjang" calls `addToCartAction` (one piece per tap, the selected size's SKU; `ProductView` now carries `sku` per size option and `allsizeSkuByColor`), then unrolls the inline "Masuk keranjang: Beige, M · Lihat" box with the existing `Curtain`; a refusal shows the server's message (`role="alert"`), a trimmed login merge shows "Maksimal 20 barang per pesanan.". Header: `CartLink` (bag icon after the account icon, at the right edge on every width; count as a small superscript, `aria-label` "Keranjang, N barang") rendered only when the flag is on; the count is **never server-rendered**: the browser fetches `GET /api/cart/count` (uncached route handler, `Cache-Control: private, no-store`, 404 with the flag off) on every navigation, and cart writes announce their new count with a window event (`lib/cart/count-event.ts`; a fetch started before an announcement is ignored). `/cart` (`app/cart/page.tsx`): `force-dynamic` (required: with the flag off the page calls `notFound()` before any cookie read, so a flag-off `next build` would otherwise prerender a static 404 that a runtime flip could never replace), `noindex`, lines per mockup (image 96×144, name, "Warna · Ukuran", line total, 1 to 10 stepper, ×; `insufficient` keeps the stepper but only lowers; `sold_out` / `unavailable` show "Habis" / "Tidak tersedia lagi" with only "Hapus"), "N barang", Subtotal, "Ongkir: Gratis" (changed to "Ongkir: Dihitung saat checkout" on 2026-10-21, subsidy), cap note at 20 pieces or after a trimmed merge, "Lanjut ke checkout" a real link to `/checkout` when `canCheckout` (owner decision 2026-10-21: it 404s until session 8, now 10), otherwise disabled with "Ubah atau hapus barang yang ditandai untuk lanjut ke checkout.", "Lanjut belanja" and the empty state go to `/#koleksi`. Summary beside the lines from `md`, below them on phones. Every stepper/remove goes through the session 5 actions, then `router.refresh()` inside the same transition (the line stays pending until the refreshed props land, so a double tap never sends a stale quantity). Review fixes: a server action call that rejects (offline, 5xx, deploy skew) is caught on the PDP and in `/cart` and shows "Terjadi kesalahan. Coba lagi." instead of throwing into the error boundary; `app/cart/error.tsx` (Indonesian retry) for a failed cart read; always-mounted screen-reader status regions (PDP add with the new count, `/cart` quantity and removal), focus to the heading after a removal, `aria-disabled` instead of `disabled` for pending and bound states so keyboard focus stays; an add that resolves after the buyer changed variant only updates the count; `CartLink` hides itself on a 404 (flag switched off under a cached page), logs non-abort fetch failures and re-fetches on a back/forward-cache restore. Tests: `product-purchase-panel.test.tsx` (add flow, all-size SKU, refusal, trimmed merge, reset on size change), `cart-link.test.tsx`, `cart/cart-line-item.test.tsx`, `api/cart/count/route.test.ts`, rejected-call tests, `e2e/cart.spec.ts` (390/1280: flag off 404s and no icon; PDP add to `/cart`, stepper, remove; seeded line states; 20-piece cap; empty state; header layout; summary layout). e2e runs both ways: `pnpm test:e2e` (flag off, the default) and `pnpm test:e2e:cart` (`E2E_CART_ENABLED=true`); `e2e/helpers/cart-flag.ts` picks each spec's expectations; `e2e/helpers/cart-db.ts` seeds guest carts in `ammari_e2e` | none | e2e 390/1280 | react, typescript |
| 7 | **DONE 2026-10-21.** Shipping schema + product weight. Migration 0031 `shipping_quote` (hand edits: header and `SET LOCAL lock_timeout = '5s'` only): `products.shipping_weight_grams` (CHECK 50 to 30000, bounds `PRODUCT_SHIPPING_WEIGHT_MIN/MAX_GRAMS` in `@ammari/db/schema`), the eight `orders.shipping_*` columns with `orders_shipping_quote_all_or_none_check` (`num_nulls(...) in (0, 8)`), `orders_shipping_quote_amounts_check` (subsidy between 0 and cost, `shipping_amount = cost - subsidy`), `orders_shipping_weight_grams_check` and `orders_checkout_shipping_quote_check`; `shipping_areas` `subdistrict`, `label`, `last_synced_at`, nullable `postal_code`, UNIQUE `komerce_destination_id` replacing the four-column UNIQUE (§3 "As built"); `customer_addresses.subdistrict`; `shipping_rate_cache` (UNIQUE lookup key, `fetched_at` index for the prune). `@ammari/commerce/shipping` exports `SHIPPING_SUBSIDY_MAX_AMOUNT` (20.000) and `SHIPPING_PACKAGING_GRAMS` (100), no server-only. Admin: "Berat kirim (gram)" on the product form (create and edit, optional to save, dots accepted as thousands, `lib/products/shipping-weight.ts`), publish refused on hidden -> published without a weight (`updateProductStorefront`, under the product lock), clearing a weight refused while published (`updateProduct`), guidance lines in the "Toko online" card, "Berat kirim belum diisi" badge for active products in both list layouts. Nothing is unpublished; prod's published products keep working without a weight. Tests: `packages/db/test/shipping-schema.test.ts` (constraints, subsidy boundaries 0 / 19.999 / 20.000 / 20.001 / 200.000, both upserts), `test/migration-0031.test.ts` (upgrade from 0030 with a published product without weight, orders and a cart; session 6 writes; key swap; idempotent re-run; a quote-less checkout order rolls the whole migration back), admin `shipping-weight.test.ts`, `storefront.test.ts`, `queries.test.ts`, `e2e/storefront-section.spec.ts` (refusal then publish), `e2e/product-shipping-weight.spec.ts` (390/1280 badge, live product stays live; seeded "E2E Gamis Tanpa Berat"). Checkout fixtures (`shippingQuoteValues`, admin e2e hold seed) now carry a quote | 0031 | db constraint tests + admin e2e 390/1280 | database (no Critical/High; Mediums recorded for 8 and 9 below), typescript (nothing above Low), react (one High fixed: `@ammari/ui` Input/Textarea/Select/Checkbox let a caller's `aria-describedby` replace the merged error id; now merged and deduplicated, `packages/ui/test/field-describedby.test.tsx`) |
| 8 | **New 2026-10-21 (moved from Phase K K1).** Shipping rates: `@ammari/commerce/shipping` (`ShippingRateProvider`, Komerce Shipping Cost client with timeout/retry/zod/typed errors, `FakeShippingRateProvider`, `parcelWeightGrams`, `pickCheapestService`, `splitShippingCost`, `quoteShipping` with `shipping_rate_cache` and the `komerce_call` budget); destination search endpoint (`area_search`, upsert into `shipping_areas`); `@ammari/commerce/address` v2 (area row in, `version: 2` snapshot); allowlist confirmed against sandbox service codes; opt-in sandbox contract test | none | TDD (shipping money) + fixtures | security, silent-failure-hunter, typescript, database |
| 9 | `placeOrder` backend with `FakePaymentProvider` and `FakeShippingRateProvider`, incl. the quote before the transaction and the locked `shipping_*` fields (was 7) | none | TDD vouchers, stock, shipping, concurrency | security, database, typescript |
| 10 | Checkout UI + finish page (incl. "Masuk untuk melihat semua pesanan" OTP link), area combobox, section 3 states, Ongkir in the summary (was 8) | none | e2e guest + logged-in + shipping states | react, security |
| 11 | Midtrans provider + webhook + mapping + sandbox contract tests; Ongkir `item_details` line (was 9) | none | TDD payments | security, silent-failure-hunter, typescript |
| 12 | Sweeper + cron service + retention job, incl. `shipping_rate_cache` pruning (was 10) | none | integration | silent-failure-hunter, database |
| 13 | Emails: templates (with ongkir and subsidy lines), `order_notifications`, `order_access_tokens` minting, owner paid alert, manual-shipped email hook (was 11) | none | unit + integration | typescript, silent-failure-hunter |
| 14 | Magic login link: `customer_login_links`, `orderLoginLink` plugin, `/login/link` page, issuance in emails, audit, rate limits (was 12) | 0032 | TDD + e2e | security, typescript, database |
| 15 | "Pesanan saya", `/orders`, `/orders/[orderNo]` (ongkir in totals), "Lihat pesanan" token access, "Lacak pengiriman" block (courier + resi) (was 13) | none | e2e list 390/1280 | react, security |
| 16 | Admin: payment section, "Pengiriman" section with the locked quote, service on `/packing`, "Perlu dicek", web cancel via Midtrans, item edit block, thank-you cards marketplace-only (was 14) | none | admin e2e 390/1280 | react, security, database |
| 17 | Launch readiness: env examples (incl. Komerce cost keys), runbook (Cloudflare Access bypass, cron), full sandbox run on dev, footer chips, shipping checks from §14, launch/rollback checklist in `docs/runbooks/` (was 15) | none | manual checklist | none |

Sessions 7 and 8 can overlap only in their pure parts (8's DB-touching code needs 0031); 14 can run
any time after 13. **Renumbering 2026-10-21:** old 7 to 15 are now 9 to 17 (add 2). Code comments
written before then (e.g. `packages/commerce/src/cart/cart.ts` "placeOrder in session 7",
`stock/reservations.ts` "session 9" for the payment webhook) use the old numbers; the session
notes below are already renumbered. Schedule risk: two more sessions inside the ~20 Nov target;
sessions 7 and 8 are small; if session 10 is not done by ~10 Nov, raise it with the owner then.

Notes from session 7 for later sessions:
- **8 (rates, area search):** import the constants from `@ammari/commerce/shipping` (add the
  server-only rate code there; keep the constants file free of server-only if a client needs it).
  Upsert areas with `ON CONFLICT (komerce_destination_id) DO UPDATE` and always write `label` and
  `last_synced_at`. **Normalize any kode pos that is not `^[0-9]{5}$` (empty, "0", 4 digits) to NULL
  before the upsert** (with a test): `shipping_areas_postal_code_format_check` would otherwise fail
  the whole multi-row upsert. `customer_addresses.postal_code` stays NOT NULL, so the typed kode pos
  is required when the area has none. The rate cache upsert targets
  `(origin_id, destination_id, weight_grams, services_key)`.
- **9 (placeOrder):** write all eight `shipping_*` columns plus `shipping_amount` in the order
  insert (the CHECKs refuse anything partial or unbalanced). Once quoted orders exist, admin order
  editing must refuse or lock `shipping_amount` on orders with `shipping_cost_amount` set and map a
  23514 from `orders_shipping_quote_amounts_check` to an Indonesian message (an older admin image
  after a rollback would hit the CHECK; failing is safe but shows a raw error). Products without a
  weight: refuse with the §4.5.5 message and log the SKUs.
- **17 (launch):** the admin product list's "Berat kirim belum diisi" badge lists every active
  product still missing a weight; the owner fills "Berat kirim (gram)" for each published product
  (in prod: Haura Dress) before the flag goes on.

Notes from session 6 for later sessions (renumbered 2026-10-21):
- **10 (checkout):** `/checkout` and `/checkout/*` need `export const dynamic = "force-dynamic"`
  for the same reason as `/cart` (a flag-off build must not prerender a static 404). `/cart` already
  links to `/checkout` when `canCheckout`. After `placeOrder` empties the cart, the header count
  catches up on the next navigation (`CartLink` re-fetches per pathname); call
  `announceCartCount(0)` if the client stays on the same path.
- **15 ("Pesan lagi"):** refilling the cart from order lines should announce the new count the same
  way.
- **17 (launch):** the header bag icon and the PDP cart button live in ISR HTML, so flipping the
  flag needs the full-storefront revalidation already in §14 (until then an ISR page can show the
  old state for up to its `revalidate` window, and the PDP button and header icon can disagree);
  the count itself is always fetched live, and on rollback a stale icon hides itself once the
  count route answers 404. `GET /api/cart/count` resolves the cart like every cart read, so it can perform the login
  merge (a write) on a GET; it is same-origin, read-only in effect for the visitor, and returns
  only a number.

Notes from session 5 for later sessions (renumbered 2026-10-21):
- **6 (cart UI):** call the actions from client components and `router.refresh()` (or the PDP's
  own state) after `ok`; show `message` on `ok: false` and "Maksimal 20 barang per pesanan." when
  `mergeTrimmed`. Render `/cart` from `loadCartView()` with `dynamic` rendering (it reads cookies
  and the session). A render cannot set cookies, so a merge during a page read leaves the stale
  guest cookie in place (it names no cart any more); the next action clears it. **The header count
  cannot be part of the ISR-cached layout/PDP HTML:** fetch it per request (a small dynamic route
  handler or a client fetch to one), never bake it into a cached page. Flag off: `/cart` must
  `notFound()` itself; the actions already refuse.
- **9 (placeOrder):** read the cart through `resolveCart` + the cart lines inside the order
  transaction and lock the cart row (`FOR UPDATE`) so a concurrent cart write cannot change the
  lines being ordered; delete the cart items in the same transaction (§5 step 10). Re-validate
  with the same rules (`getCartView`'s statuses must all be `ok`); `reserveStockForOrder` stays the
  real stock check.
- **12 (retention):** guest carts 30 days, customer carts 180 days after
  `last_activity_at`, which every cart write bumps (the 60-day cookie outlives a purged guest
  cart; the next add then gets a fresh token). Also prune `claim_rate_limits` (1 day).
- **17 (launch):** with the flag on, the cart refuses writes in production when
  `CF-Connecting-IP` is missing, so confirm the origin only accepts Cloudflare traffic (SPEC §11)
  and that the proxy forwards Host consistently (Next's server action Origin check).

Notes from session 4 for later sessions (renumbered 2026-10-21):
- **5/6 (cart):** the cart's per-line checks need a sellable quantity per SKU; build it from
  `sellableQtySql` (never show the number to buyers). PDP/tiles are ISR, so a new hold or release
  is only visible after revalidation (§7 "Revalidation"): sessions 9 (reserve), 11 (consume,
  release) and 12 (sweeper release) must revalidate the affected product paths.
- **9 (placeOrder):** call `reserveStockForOrder` inside the order transaction with
  `CHECKOUT_STOCK_HOLD_MINUTES` (fallback `DEFAULT_STOCK_HOLD_MINUTES`). It does not check
  `is_active`/published or merge duplicate cart lines: placeOrder validates both first (step 3).
  The refusal is a `FieldError` keyed by SKU, for the cart-line alert.
- **11 (payments):** `transitionOrderStatus(..., "to_ship")` throws a `FieldError` when physical
  stock is short (an admin adjustment or marketplace sale may have taken held pieces, D4); the
  webhook must catch it and keep `awaiting_payment` + `payment_status = 'paid'` +
  `stock_short_at_payment` (§6.2), never drop the notification. A payment after the hold was
  released still sells (consume is then a no-op); test "paid after expiry/release".
  `transitionOrderStatus` still requires a staff actor id; webhook/sweeper callers need a null
  actor path.

### Phase K: Komerce courier booking and tracking (required; starts when the sandbox key arrives)

Not a launch blocker for 1 Dec (manual courier + resi and manual "Selesai" cover the gap), but
required: target live within the first weeks of December. **Prerequisite: a Komerce Enterprise
subscription**, started when Phase K starts (see "Komerce plan" below).

| # | Session | Migration | Notes |
|---|---|---|---|
| K1 | Komerce **delivery** client next to session 8's rate client in `@ammari/commerce/shipping`: detail order, history AWB, typed errors, sandbox contract tests. **First, confirm that the Shipping Cost destination ids stored on orders (`shipping_destination_id`) are accepted by Store Order**; if the Delivery API uses its own ids, add the mapping (search by kode pos + kelurahan, unmatched rows reported for manual review). Destination search and the `shipping_areas` fill moved to session 8 (2026-10-21) | none | read-only APIs first |
| K2 | `shipments` table; admin "Buat pengiriman" on `/packing` and order detail: Store Order with the order's locked courier, service and destination (Ammari as payer; the buyer's share was already collected), Pickup Request, Print Label; AWB written to `orders.tracking_number`/`courier` and `shipments`; actual cost stored as `cost_amount` and shown next to the quote; cancel shipment | expected 0033 | security, database |
| K3 | Tracking: webhook endpoint + poller + `shipment_events` + status normalization + automatic `to_ship -> shipped` (on picked up/in transit) and `shipped -> completed` (on delivered), emails `shipped`/`delivered`, `tracking_stale` / `delivery_problem` flags | expected 0034 | security, silent-failure-hunter |
| K4 | Customer tracking timeline in "Pesanan saya" and admin "Pengiriman" section; manual fallback actions | none | react, e2e 390/1280 |

**Webhook vs polling.** Komerce documents a webhook (register with `PUT /webhook`; payload
`order_no`, `cnote`, `status`) but **no signature**. So:
- The webhook is a **hint only**: the registered URL carries a long random path token
  (`/api/shipping/komerce/webhook/<KOMERCE_WEBHOOK_PATH_TOKEN>`); the handler logs the payload,
  looks up the shipment by `order_no`/`cnote`, then **re-fetches Detail Order / History AWB from
  Komerce** and acts only on that response (same rule as Midtrans). Always 200 quickly.
- **Polling is the backstop:** the cron calls an internal route that polls History AWB for every
  shipment not in a final state, every 3 hours (and once 30 minutes after booking), within the
  plan's daily hit quota. A shipment with no new event for 5 days flags `tracking_stale`.
- Normalization maps Komerce statuses (Diajukan, Dijemput, Dikirim, Selesai, Dibatalkan, plus any
  return/problem statuses found in sandbox) to `shipments.status`; **an unknown status never
  completes an order**, it is stored raw and flagged. Whether "Selesai" means delivered to the
  recipient must be confirmed in sandbox and with Komerce support before auto-complete is turned
  on.
- **Auto-complete:** `shipped -> completed` runs through `transitionOrderStatus` (no staff actor,
  audit-logged) only on a normalized `delivered`. **Manual fallback:** staff can still "Tandai
  dikirim" and "Tandai selesai" from admin; a returned-to-sender status flags
  `delivery_problem` and never auto-transitions to `returned` (staff confirm, since stock rows
  follow).

**Komerce plan: Enterprise** (corrected 2026-10-20; an earlier version of this plan said the
"Pro" tier was enough, which is wrong).
- **Pro (Rp149.000/month) does not include the Shipping Delivery API** (Store Order / create
  AWB, Cancel Order, Detail Order, Pickup Request, Print Label, History AWB tracking). Only
  **Enterprise (Rp249.000/month, cheaper when paid annually)** includes it, so Phase K needs
  Enterprise. Shipping Cost (live rates: Search Destination, Calculate) is available on every
  plan.
- Ammari does **not** use Komerce Payment or QRISLY; online payment stays on Midtrans (D5).
- **Cost:** Rp249.000/month (less on the annual plan) from the month Phase K starts, plus the
  courier fees Ammari pays per shipment (the full courier cost; the buyer's share above the
  Rp20.000 subsidy is collected at checkout, D11). **Since 2026-10-21 Phase C also needs a plan
  with Shipping Cost** (every plan has it) from about mid-November: a key for session 8's opt-in
  contract test and dev checks, and production before 1 Dec (§14).
- **When:** a plan with Shipping Cost before launch (Phase C); Enterprise when Phase K starts.
  Subscribing to Enterprise directly in November avoids a plan switch if its quota fits both;
  owner's call when subscribing (open item below). K1 to K3 build against the sandbox key.

What Phase K needs from that plan (confirm each with Komerce when subscribing):
1. Shipping Delivery API (Komship) production access: Store Order, Cancel Order, Detail Order,
   Pickup Request, Print Label, History AWB.
2. Webhook registration for order status updates.
3. Search Destination and Calculate (Phase C, from session 8), and whether their destination ids
   are the ones Store Order accepts (K1).
4. A daily request quota covering destination search and quotes at checkout (Phase C: roughly 5
   searches and 1 to 2 uncached quotes per checkout visit, capped by `KOMERCE_DAILY_CALL_BUDGET`)
   plus polling: roughly orders in transit x 8 polls/day. Confirm the quota covers it.
5. Universal waybill tracking (RajaOngkir track waybill) only if some web orders will ship
   outside Komship; recommendation: ship every web order through Komship so one tracking source
   covers all.
6. Billing for shipments (deposit/balance or invoice), since Ammari pays every shipment.
7. A sandbox key for K1 to K3.

**Risks:**
- Subscribing to Pro (or no plan) would block K2 and K3 entirely: no booking, labels or
  tracking. Check the subscription is Enterprise before K2 starts.
- If Enterprise is not subscribed in time, the manual path (staff book the quoted service,
  "Tandai dikirim" with courier + resi, manual "Selesai") stays the only path. **Phase C now
  depends on Komerce Shipping Cost** (2026-10-21): without a working key checkout refuses every
  order (§4.5.5), so the key is a hard launch prerequisite and its outage stops web sales (the
  WhatsApp path stays open).
- The Shipping Cost quote and the actual booking price can differ (tariff updates, Komship
  discounts); Ammari carries the difference, visible per order from K2.
- Enterprise's daily request quota is not in the public docs; if it is too low for polling,
  lengthen the poll interval (the webhook is a hint anyway) before raising the plan question.

## 16. Decisions (owner, 2026-10-20)

1. Payment window **60 minutes**; stock held **75 minutes**.
2. Payment methods: **QRIS, GoPay, ShopeePay, VA BCA, BNI, BRI, Mandiri, Permata. No credit
   cards at all**, not enabled and not planned.
3. Ammari absorbs gateway fees; no fee line.
4. Max **10 per line, 20 pieces per order**.
5. No "Hemat" badge; summary line "Voucher -Rp20.000".
6. Order number stays **`ORD-YYYYMM-NNNN`**.
7. WhatsApp CTA stays as the outlined secondary button after launch.
8. Voucher restored only on cancel or payment expiry, not on returns.
9. When a marketplace sale takes the last piece, the marketplace sale stands; the web order is
   flagged at payment for refund or restock.
10. No customer self-cancel of unpaid orders in v1; they expire.
11. Email the owner on every paid order (to the support email in store settings).
12. No delivery estimate at checkout until Komerce. **Kept in v1 (2026-10-21)** even though
    Komerce rates (which carry an estimate) are now used at checkout.
13. Area dataset licence checked in session 3; plain-text fields if not clean. **Result
    (2026-10-20): not clean; plain-text fields** (§3). **Superseded 2026-10-21:** the area is
    picked from Komerce Search Destination (D12, §4.5.1).
14. Privacy policy and terms updated before launch by the owner in admin; exact changes in §11.1.
15. **Komerce tracking is required.** The owner subscribes to the **Komerce Enterprise** plan
    (Rp249.000/month, cheaper annually; Pro lacks the Shipping Delivery API) when Phase K starts
    (§15). Komerce Payment / QRISLY are not used.
    Web orders move to `completed` automatically when tracking reports delivered, with a manual
    fallback; customers see tracking in "Pesanan saya". Delivered in Phase K.
16. **No silent login after guest checkout.** Guest order emails carry a separate "Masuk ke akun"
    magic link (24 h, single use, hashed, bound to customer and email, superseded by a newer one,
    login only on a confirmation-page POST with CSRF protection, rate limited, audit-logged) and
    a "Lihat pesanan" view-only link (one order, 120 days). The finish page offers "Masuk untuk
    melihat semua pesanan" via OTP. Built as a custom Better Auth plugin because the stock
    `magic-link` plugin in 1.7.7 logs in on GET and does not supersede older links (D15).

Owner decisions 2026-10-21 (shipping subsidy):

17. **Free shipping is replaced by a shipping subsidy of at most Rp20.000 per order.** The buyer
    pays `max(0, cost - 20.000)` as a separate "Ongkir" line; prices are the same everywhere
    (D11, §4.5).
18. **Courier: the cheapest allowlisted regular service, chosen by the server**, shown as one
    fixed row; no buyer choice in v1 (§4.5.2).
19. **Weight per product, required to publish** (`products.shipping_weight_grams`), plus a
    packaging allowance per order (§4.5.3).
20. **Komerce down or no service: checkout refuses**, with a retry or the WhatsApp link; never a
    fallback rate (§4.5.5).
21. **Migration numbering:** the shipping migration takes 0031; the login-link migration becomes
    0032; Phase K's expected 0033 and 0034.

Remaining small items to confirm with third parties (not owner decisions): Komerce's daily
request quota per plan and the meaning of "Selesai" (Enterprise is settled for Phase K); whether
Shipping Cost destination ids work for Store Order (K1); the exact Komerce service codes for the
allowlist (session 8); whether the Midtrans merchant review requires naming the processor on the
privacy page. Open owner item: which plan to subscribe in November (a Shipping Cost plan first, or
Enterprise directly).
