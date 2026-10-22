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
shipping rates and area search moved from Phase K into Phase C as new sessions 7 and 8; the old
sessions 7 to 15 are now 9 to 17, mapping in §15). **Session 7 done 2026-10-21** (migration 0031
`shipping_quote`, product weight in admin; see the session table). **Revised 2026-10-21 for the
shipping provider (D18): Komerce is replaced by Biteship** for area search, rates, orders, pickup
and tracking (one area id across all of them; the Grow plan covers it at Rp149.000/month).
**Session 8 done 2026-10-21** (see the session table). **Session 9 done 2026-10-21** (`placeOrder`,
payment provider seam with the fake, `placeOrderAction` without UI; see the session table).
**Session 10 done 2026-10-21** (checkout page, quote action, finish page, gated fake payment page;
see the session table). **Session 11 done 2026-10-21** (Midtrans Snap provider, notification
webhook, payment state machine, finish-page status check and retry; see the session table).
**Session 12 done 2026-10-21** (expiry sweep, retention job, internal cron service; see the session
table and decisions 27 to 29). **Session 13 done 2026-10-21** (order emails, `order_notifications`
guard, view-token minting, owner alert, cron email pass; see the session table and decisions 30 to
33). **Session 14 done 2026-10-21** (migration 0033, "Masuk ke akun" login links, /account contact
offer; see the session table and decisions 34 to 37). **Session 15 done 2026-10-21** ("Pesanan saya",
order page, "Lihat pesanan" token link, "Pesan lagi", login landing on `/orders`; see the session
table and decisions 38 to 42). **Session 16 done 2026-10-21** (admin for checkout orders: payment and
shipping sections, "Perlu dicek", staff cancel through the gateway, refunds recorded by hand, card-free
web orders on /packing; see the session table and decisions 43 to 45). **Session 17 done
2026-10-21** (launch readiness: runbooks `docs/launch/checkout-dev.md` and `checkout-prod.md`, legal
drafts, `DEPLOY_ENV` allowlist for shipping, env examples, deploy tooling; see the session table).
Phase C code is complete; next are the owner's dev sandbox run, the prod deploy and the 1 Dec
launch (runbooks), then Phase K. **Sandbox fixes round 2 done 2026-10-21** (resi required for web
orders, "menunggu pembayaran" reminder, saved address, "Beli sekarang", stale deploys, account name,
"Halo Kak"; see "Sandbox fixes, round 2" after the session table). **Phase K started 2026-10-22:**
Biteship docs researched, breakdown K1 to K4 and decisions 46 to 51 confirmed by the owner; **K1
done 2026-10-22** (order client, fake, shipment config, Code 128 and our own label; no migration;
see §15 Phase K). **K2 done 2026-10-22** (migration 0034 `shipments`, two new flags, "Pesan kurir"
from admin, our label; see §15 Phase K "K2 as built"). **K3 done 2026-10-22** (migration 0035
`shipment_tracking`, Biteship webhook, poller, status mapping, "sudah sampai" email; see §15 Phase K
"K3 as built").

**Go-live:** 1 Dec 2026. Everything ships dark behind `STOREFRONT_CART_ENABLED` (already exists,
`apps/web/src/lib/cart-flag.ts`, default off) until launch day.

**Shipping rates (Biteship Maps + Rates API) are a launch requirement** since 2026-10-21: checkout
cannot price an order without them (§4.5), so Ammari needs a Biteship account with a live key
before launch (§14), on the **Grow plan** (§15 "Biteship plan"). **Courier booking and tracking
(Biteship Order + Tracking API, same account and key) stays in Phase K** (§15). Until Phase K
ships, staff book the order's quoted courier service by hand, enter the resi with the existing
"Tandai dikirim", and mark orders "Selesai" by hand.

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
- **Email:** `EmailSender` (`packages/auth`), `ResendEmailSender`, plain text body only (session 13
  added an optional HTML part and an idempotency key).
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
- **Biteship (public docs at https://biteship.com/id/docs, read 2026-10-21; replaces Komerce,
  D18):** one host `https://api.biteship.com`, header `authorization: <key>` (raw key, no
  `Bearer`), JSON. Test and live mode share the host and are chosen by the key (`biteship_test.` /
  `biteship_live.` prefix, "Mode Testing" in the dashboard). Endpoints used by this plan:
  - Maps: `GET /v1/maps/areas?countries=ID&input=<text>&type=single` returns `areas[]` with `id`
    (e.g. `IDNP6IDNC148IDND843IDZ12250`), `name` ("Pesanggrahan, Jakarta Selatan, DKI Jakarta.
    12250"), `administrative_division_level_1_name` (province), `_2_` (city), `_3_` (kecamatan)
    and a numeric `postal_code`. **Ids are kecamatan + kode pos; there is no kelurahan level**
    (rates docs: "Area Id is using district as its lowest area level"). The docs ask for a
    debounced call. No `limit` parameter.
  - Rates: `POST /v1/rates/couriers` with `origin_area_id`, `destination_area_id`, `couriers`
    (`"jne,jnt,..."`) and `items[]` (`name`, `value`, `weight` in grams, `quantity`; dimensions
    optional, they can raise the price by volume). Returns `pricing[]` with `courier_code`,
    `courier_service_code`, `price` (final: fee plus surcharge minus discount plus insurance/COD
    when requested, which we never request), `duration`, `type`. Errors are `{ success: false,
    error, code }`; `40001010` is "No courier available for requested location".
  - Orders (Phase K): `POST /v1/orders` takes the same `origin_area_id` / `destination_area_id`
    ("Use area_id from Maps API", the wording the rates page uses too), contacts, address,
    `courier_company` + `courier_type` (= the rates `courier_code` + `courier_service_code`),
    `delivery_type` `now` (waybill and pickup right away) or `scheduled`, `items`, and a unique
    `reference_id`. **Corrected 2026-10-22:** a repeated `reference_id` is **refused** with code
    `40002060` and the existing order in the error's `details` (`order_id`, `waybill_id`); it does
    not return the order, so the caller recovers it with `GET /v1/orders/:id`. The waybill is
    issued at booking but **can change later** (the `order.waybill_id` webhook). `GET
    /v1/orders/:id` carries status, price, `courier.routing_code` and `courier.history[]`, so the
    tracking endpoint is not needed. `POST /v1/orders/:id/cancel` (reason code `change_courier` /
    `pickup_delay` / `change_address` / `others`; only in `confirmed` / `scheduled` / `allocated` /
    `picking_up`, else `40002053`; `DELETE` is deprecated). Full findings with sources: §15 Phase K
    "Biteship research".
  - Tracking (Phase K): statuses `confirmed`, `scheduled`, `allocated`, `picking_up`, `picked`,
    `in_transit`, `dropping_off`, `delivered`, `on_hold`, `return_in_transit`, `returned`,
    `rejected`, `cancelled`, `disposed`, `courier_not_found`. **Corrected 2026-10-22:** order
    statuses are snake_case; the tracking statuses page spells the same states in camelCase
    (`pickingUp`, `courierNotFound`); both are normalized.
  - Webhooks (Phase K): `order.status`, `order.price` (actual price differs after weighing),
    `order.waybill_id`, registered in the dashboard (separate test and live webhooks). **No body
    signature.** **Confirmed 2026-10-22** (help center, read through its public JSON API): the
    webhook form has optional "Headers Signature Key / Secret" fields sent as static HTTP headers
    on every request. **No automatic retries**: failed deliveries only show in the dashboard's
    Events Log with a manual "Resend".
  - **Labels (resolved 2026-10-22):** no label endpoint or label URL exists anywhere in the API
    docs or changelog (the pricing page's "Shipping Label API" looks unreleased), and dashboard
    labels come only as A6, 4x6 inch or A4. We print **our own 120 x 100 mm label** (decision 49).
  - **Test mode:** Maps, Rates and Tracking return real data and **are billed** even with a test
    key; the Order API is simulated (no courier pickup, no balance used). A test order is moved
    to "delivered" in Dashboard → Shipments → **Update Status**, one step at a time; the same menu
    (or our own cancel call) cancels it. Shipping costs are paid from the account
    balance (Bitepoints, top-up by QRIS or transfer; not withdrawable; refunds after a cancel
    depend on the courier's policy).
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
| D12 | **Address area from the shipping provider's area search (2026-10-21; Biteship Maps since D18).** The buyer picks a provider area (kecamatan, city, province, kode pos; Biteship has no kelurahan level, so the kelurahan is typed in the street address) from a search box; the chosen row is cached in **`shipping_areas`** (keyed by `provider_area_id`, renamed from `komerce_destination_id` by migration 0032) and the order and saved address point at it. Session 3's plain-text fields (no licensed dataset) are superseded for checkout; `@ammari/commerce/address` stays for validation, formatting and the snapshot. | A quote needs a provider area id; the area list comes with the provider subscription. |
| D13 | Unpaid expiry finalized by Midtrans `expire` notifications plus a **sweeper** route called every 5 minutes by a cron container on the VPS internal network. The same cron drives the Biteship tracking poller in Phase K (every 3 hours, decision 48). | No scheduler exists. |
| D14 | Transactional emails sent after commit with an `order_notifications (order_id, kind)` UNIQUE row as the idempotency guard. | Retries must not double-send; email failure never fails a webhook. |
| D15 | **Two separate links in guest order emails.** "Lihat pesanan": view-only access to that one order (§9.2). "Masuk ke akun": a magic login link (§9.3), implemented as a **small custom Better Auth plugin** on the customer instance (our own endpoint, Better Auth's session creation, cookie, rate limiter and CSRF middleware), not the stock `magic-link` plugin. | The stock plugin logs in on GET (email scanners prefetch links), does not invalidate older links, does not bind to a customer id, and exposes public issuance. A plugin keeps the login inside Better Auth's own HTTP router, so its rate limiter and origin checks apply (SPEC §10.1's reason for not calling `.api` from server actions). |
| D16 | **No card payments**, not enabled in Snap and not planned. | Decision 2. |
| D17 | **Shipping quotes are server-side only**, behind a `ShippingRateProvider` interface (`@ammari/commerce/shipping`; Biteship in production, a fake in tests and e2e). The browser never sends a price, a courier or a provider area id; the quote is recomputed in `placeOrder` and locked into the order. No quote, no order (§4.5.5). | Money rule; Ammari must never ship at an unknown cost. |
| D18 | **Shipping provider: Biteship, not Komerce (owner decision 2026-10-21, during session 8).** One Biteship account and key covers area search (Maps), rates, orders with pickup, and tracking with webhooks, all on the **same area id**; planned plan **Grow** (Rp149.000/month: 2,000 shipments, 10 active couriers, monthly quota Rates 10.000, Tracking 2.000, Maps 50.000; overage per request); **Starter** (Rp0, pay per request, 3 active couriers) for development. | Komerce's Shipping Cost destination ids are not documented as the ids its Delivery API accepts (two id spaces, two keys, different service codes), and booking/tracking needed its Enterprise plan (Rp249.000/month). Biteship documents one area id for rates and orders, at a lower plan price. |

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
  `komerce_destination_id text NULL` (renamed `provider_area_id` by 0032). UNIQUE `(province,
  city, district, postal_code)` (replaced in 0031). Empty in 0030.
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
`shipping_areas` is filled on demand from the provider's area search (Biteship Maps since D18) in Phase C (session 8,
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
  (e.g. `jne` / `reg`, as the provider names them; Biteship's `courier_code` /
  `courier_service_code`, which are also its order `courier_company` / `courier_type`),
  `shipping_courier_label text` (display, e.g. "JNE Reguler"), `shipping_weight_grams int`,
  `shipping_destination_id text` (the provider area id, snapshotted because `shipping_areas` rows
  can be re-synced), `shipping_quoted_at timestamptz`.
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
  were confirmed by the owner on 2026-10-21. (Written when the provider was Komerce; migration
  0032 renames the column for Biteship, below. With Biteship every area carries a kode pos, so the
  nullable `postal_code` path stays only as a defensive fallback, and `subdistrict` stays NULL.)
- **`customer_addresses`**: add `subdistrict text NULL`. The snapshot moves to `version: 2`
  (adds `subdistrict`, `shippingAreaId`, `providerAreaId`); v1 never reached an order.
- **`shipping_rate_cache`**: `origin_id text`, `destination_id text`, `weight_grams int`,
  `services_key text` (hash of the allowlist), `result jsonb` (allowlisted services and prices
  only), `fetched_at`; UNIQUE `(origin_id, destination_id, weight_grams, services_key)`, written
  with `INSERT ... ON CONFLICT DO UPDATE` (§4.5.4).
- No permission keys or other reference rows (the courier allowlist and the subsidy cap are code
  constants).

### Migration 0032 `shipping_provider_area_id` (session 8, added 2026-10-21 for D18)

- **`shipping_areas.komerce_destination_id` renamed to `provider_area_id`**, and its UNIQUE
  `shipping_areas_komerce_destination_id_key` renamed to `shipping_areas_provider_area_id_key`
  (owner decision 2026-10-21). It holds the Biteship area id (`IDNP...IDZ12250`). Safe as a rename
  rather than expand/contract: the table is empty on every environment and no released code (the
  session 7 image included) reads or writes the column, so a rollback to session 7 against the
  renamed schema behaves the same. Metadata-only (`RENAME` takes a brief ACCESS EXCLUSIVE lock on
  an empty table), with `SET LOCAL lock_timeout = '5s'` like 0030 and 0031.
- No other change. `orders.shipping_destination_id` and `shipping_rate_cache` already have
  provider-neutral names.

### Migration 0033 `customer_login_links` (session 14; was 0031, then 0032, before 2026-10-21)

- **`customer_login_links`**: `id`, `customer_id` (FK restrict), `email citext` (the address it
  was sent to), `token_hash text UNIQUE`, `order_id NULL` (which order email issued it),
  `expires_at` (issue + 24 h), `consumed_at`, `superseded_at`, `created_at`, `consumed_ip`.
  Partial UNIQUE on `(customer_id)` WHERE `consumed_at IS NULL AND superseded_at IS NULL`, so at
  most one live link per customer exists, enforced by the database.
- **As built (session 14):** `consumed_ip inet`; CHECKs `token_hash ~ '^[0-9a-f]{64}$'`,
  `expires_at > created_at`, a link ends one way (`consumed_at` or `superseded_at`, never both),
  `consumed_ip` only with `consumed_at`; indexes `(customer_id, created_at)` (the cap count),
  `order_id`, `expires_at` (retention). Also **`customers.contact_offer_resolved_at timestamptz
  NULL`** (decision 35). Hand edits: header and `lock_timeout` only. Purely additive; tested by
  `packages/db/test/migration-0033.test.ts` (upgrade from 0032 with rows, session 13 writes,
  idempotent re-run), applied to a copy of the local `ammari` database and to local `ammari`.

### Phase K migrations (numbers assigned at the time, expected 0034 and 0035)

- **`shipments`** (K2, **revised 2026-10-22** for booking attempts): **one row per booking
  attempt** (a shipment cancelled before pickup can be booked again), `attempt int` with UNIQUE
  `(order_id, attempt)`, and a **partial UNIQUE on `(order_id)` for every status other than
  `cancelled` and `failed`**, so the database allows at most one live shipment per order (never a
  double booking); `reference_id UNIQUE` (`shipmentReferenceId`: `<prefix><order_no>-K<attempt>`),
  `provider` (`biteship`), `provider_order_id UNIQUE NULL` (Biteship order `id`; NULL while the
  booking's answer is unknown), `provider_tracking_id`, `courier`, `service`, `awb NULL`
  (`courier.waybill_id`, may change), `routing_code` (printed on our label), `cost_amount` (what
  Ammari actually pays: the order `price`, updated by `order.price`; compare with the order's
  `shipping_cost_amount`), `status` (our booking states `booking` / `failed` plus the normalized
  `pickup_requested` / `picked_up` / `in_transit` / `delivered` / `cancelled` / `returning` /
  `returned` / `problem`), `provider_status text` (raw), pickup and driver fields,
  `delivered_at`, `last_polled_at`, `last_event_at`, timestamps. No `label_url` (no label API).
  The same migration widens the `needs_attention` CHECK with **`shipping_cost_over_quote`**
  (decision 47); K2 checks first that the current admin renders an unknown flag safely (rollback).
- **`shipment_events`** (K3): `shipment_id`, `occurred_at`, `provider_status`,
  `normalized_status`, `description`, `location`, `source` (`webhook` / `poll`), UNIQUE
  `(shipment_id, occurred_at, provider_status)` so replays and repeated polls never duplicate.
- **`shipping_webhook_events`** (K3): raw log like `payment_notifications` (was
  `komerce_webhook_events`).

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
2. **Alamat pengiriman.** Nama penerima, nomor HP penerima, **"Kecamatan atau kode pos"**
   search (one combobox, §4.5.1; the chosen area shows as a read-only line "Kecamatan, Kota,
   Provinsi 12345" with "Ganti"), Kode pos input only when the chosen area has none (never with
   Biteship, kept as a fallback), alamat lengkap with the hint "Jalan, nomor rumah, RT/RW,
   kelurahan" (Biteship areas stop at kecamatan, owner decision 2026-10-21), catatan untuk kurir
   (optional). Logged in
   with saved address: summary card with "Ganti alamat" (as built, round 2: one default address,
   replaced by every logged-in order, so no separate "Perbarui alamat tersimpan").
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

#### 4.5.1 Address: provider area search (Biteship Maps since D18)

- The combobox calls the flag-gated route handler **`GET /api/shipping/areas?q=`** (session 8:
  a route handler, not a server action, because the installed Next docs say Server Functions are
  for mutations and are dispatched one at a time, while a debounced search must be able to abort a
  stale request) after 3 characters and a 300 ms debounce. It accepts a kecamatan, city or kode
  pos fragment (Biteship areas are kecamatan + kode pos; there is no kelurahan level, so the
  kelurahan goes in the street address, owner decision 2026-10-21).
- The server calls Biteship `GET /v1/maps/areas?countries=ID&input=<q>&type=single`, **upserts
  every returned row into `shipping_areas`** (`ON CONFLICT (provider_area_id) DO UPDATE`,
  refreshing names, label, kode pos and `last_synced_at`; rows deduplicated by id first, since one
  INSERT cannot update the same row twice), and returns at most 10 rows as **our
  `shipping_areas.id`** plus the display label "Kecamatan, Kota, Provinsi 12345" (built from the
  parts, not Biteship's `name`). The browser never sends a provider area id: the form posts
  `shippingAreaId`, and the server reads the area fields from that row. An id not in
  `shipping_areas` is a validation error.
- `shipping_areas.search_text` (lowercased, accent-free label) stays for a later local-first
  search; v1 always asks Biteship, so names and ids stay current. `subdistrict` stays NULL.
- Rate limits on `claim_rate_limits`: **`area_search` 60 per 10 minutes per IP** (CF-Connecting-IP,
  same rules as `cart_write`), plus the global daily Maps budget (§4.5.4). Over the limit:
  "Terlalu banyak pencarian. Coba lagi sebentar lagi." A cross-site request (`Sec-Fetch-Site`
  present and not `same-origin`) is refused, so another site cannot spend the budget through
  visitors' browsers. Responses are `Cache-Control: private, no-store`.
- `@ammari/commerce/address` stays the one validator: `parseShippingAddress` takes the free fields
  (recipient, phone, address line, notes, and a kode pos only when the area has none) plus the
  loaded area row, keeps its cleaning, caps and all-errors-at-once messages, and refuses a missing
  area ("Pilih kecamatan dari daftar."). `formatShippingAddress` adds the kelurahan when an area has
  one (never with Biteship). `toShippingAddressSnapshot` writes `version: 2` (adds `subdistrict`,
  `shippingAreaId`, `providerAreaId`). `INDONESIAN_PROVINCES` is no longer used by the form (kept
  for admin manual orders if wanted).
- A saved address without `shipping_area_id` (none exist yet; possible only from a future
  import) shows "Pilih ulang kecamatan" and cannot be used until re-picked.

#### 4.5.2 Courier and service (decision 18)

Options considered: one fixed courier (simplest, often not cheapest outside Java, fails where it
has no service); buyer chooses from a list (more UI and more quotes to validate, and Java buyers
see several "Rp0" rows); **cheapest among an allowlist (chosen)**.

- `SHIPPING_SERVICE_ALLOWLIST` (code constant, `@ammari/commerce/shipping-rules`): regular,
  non-COD, non-instant, non-cargo services only, as Biteship's `courier_code` /
  `courier_service_code` (from its courier list docs, checked 2026-10-21): `jne`/`reg` "JNE
  Reguler", `jnt`/`ez` "J&T Reguler", `sicepat`/`reg` "SiCepat Reguler", `idexpress`/`reg` "ID
  Express Reguler", `anteraja`/`reg` "AnterAja Reguler", `pos`/`kilat_khusus` "POS Kilat Khusus"
  (POS's regular service; Biteship lists no "reguler" code for POS; POS keeps remote destinations
  covered). Six couriers fit Grow's 10 active couriers; on Starter (3 active couriers) only the
  ones activated in the dashboard answer, which is fine for development.
- One Rates call per quote (`couriers` = the allowlist's courier codes) returns every service of
  those couriers; the server filters to the allowlist and takes the **lowest `price`, ties broken
  by allowlist order** (deterministic). A price that is not a positive whole rupiah amount is never
  picked.
- The chosen courier and service are stored on the order. Before Phase K staff book exactly that
  service by hand; Phase K's `POST /v1/orders` sends them as `courier_company` / `courier_type`.
- No ETA is shown (decision 12), even though Biteship returns one.

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
  Sent to Biteship in grams as **one item** (`name` "Pakaian", `category` "fashion", `value` = the
  goods value at current prices, `weight` = the parcel weight, `quantity` 1, no dimensions); the
  courier applies its own kg rounding. Volume weight is ignored (folded gamis are small); revisit
  if a courier starts charging it (Biteship's `order.price` webhook would show it in Phase K).
- 20 pieces x ~800 g stays well inside regular-service limits.

#### 4.5.4 Quotes: server-side, cached, locked

- `quoteShipping(db, deps, { areaId, lines })` in `@ammari/commerce/shipping` (no transaction):
  loads weights and current prices for the lines, computes the parcel weight, reads
  `shipping_rate_cache` for `(BITESHIP_ORIGIN_AREA_ID, destination, weight, allowlist hash)`; a
  hit younger than `SHIPPING_QUOTE_CACHE_MINUTES` (default 360) is used, otherwise one Rates call
  refreshes the row (an empty "no service" answer is cached too). The goods value is not in the
  cache key: without insurance or COD it does not change the price. Returns `{ courierCode,
  serviceCode, label, costAmount, subsidyAmount, buyerAmount, weightGrams, destinationId, quotedAt }`
  or a typed refusal.
- **Checkout page (session 10):** quotes when the area or the cart changes (server action, never a
  client computed figure); shows the result in sections 3 and 4.
- **`placeOrder`:** calls `quoteShipping` again **before** opening the order transaction (no
  external call inside a DB transaction), from the cart lines it is about to lock. Inside the
  transaction it re-checks that the locked lines give the same weight (else rolls back with "Isi
  keranjang berubah. Cek ringkasan lagi.") and writes all eight `shipping_*` columns plus
  `shipping_amount = buyerAmount`. A different total than `expectedTotal` (price, voucher or
  ongkir changed) rolls back with "Harga, ongkir atau voucher berubah. Cek ringkasan lagi."
- **Locked:** once the order exists its shipping figures never change. A later tariff change, or a
  different actual cost at booking (Phase K `shipments.cost_amount`, updated by Biteship's
  `order.price` webhook), is Ammari's gain or loss, never charged to the buyer.
- **Rate limits:** `shipping_quote` 30 per 10 minutes per IP (session 10's quote action); and two
  **global daily provider budgets** (Biteship quotas are monthly and overage is billed per
  request, so a daily cap keeps a bot from spending a month in a day): every outgoing Biteship
  request (retries included) first inserts into `claim_rate_limits` with ip `0.0.0.0` (the column
  is `inet`, so not `*`; never a real client address) and action `shipping_maps` or
  `shipping_rates`, refused above `BITESHIP_DAILY_MAPS_BUDGET` (default 1.500, Grow Maps 50.000 /
  31) or `BITESHIP_DAILY_RATES_BUDGET` (default 300, Grow Rates 10.000 / 31) per Jakarta day.
  Refusal is treated as "provider down" (§4.5.5).
- Biteship calls: 5 s timeout (not retried), one retry after 300 ms on network errors and 5xx
  only, zod-parsed responses, typed errors (`unavailable` incl. 401/402/403/429 and unknown 4xx,
  `bad_response`, `budget_exhausted`; "no service" is an empty list, `40001010` included;
  `missing_weight` and `unknown_area` come from `quoteShipping`); `redirect: "error"`; keys never
  logged; only the area ids, the parcel weight and the total goods value go to Biteship at this
  stage (no name, phone or street).

#### 4.5.5 Failure handling (decision 20)

No quote, no order; never a fallback rate.

| Case | Section 3 shows | "Bayar sekarang" |
|---|---|---|
| Provider down, timeout, bad response, budget exhausted, key or balance problem | "Ongkir belum bisa dihitung. Coba lagi sebentar lagi." + "Coba lagi" button | refuses with the same message |
| No allowlisted service to the destination | "Pengiriman ke alamat ini belum tersedia lewat website. Hubungi kami lewat WhatsApp." + WhatsApp link (prefilled with the area label, no city named in our own copy) | refuses |
| A product without a weight | "Ongkir belum bisa dihitung untuk pesanan ini. Hubungi kami lewat WhatsApp." + error log naming the SKUs | refuses |
| `placeOrder` quote differs from the shown one | n/a | rolls back with the drift message, page re-quotes |

Every failure is logged with the typed reason (no key, no address); repeated `unavailable`
within an hour is worth an owner alert later (not v1). A 402 from Biteship (Starter pay per
request with an empty balance) is logged as such, so a dev check failing for money is recognizable.

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
4. Customer: session customer, or link-or-create by email (insert-first idiom). ~~New customer:
   stamp `pdp_consent_at`, `promo_consent_at` if ticked, phone only if free.~~ **Revised
   2026-10-21 (owner decision, session 9 security review):** a customer created by a guest
   checkout gets only the email and a display name (the recipient's); no phone, no
   `pdp_consent_at`, no `promo_consent_at`, because the email is unverified and anyone could
   otherwise record consent or tie up a phone number in someone else's name. The order keeps the
   evidence (`contact_phone`, `terms_accepted_at`, `promo_opt_in`); it moves to the customer once
   a login proves the email (the `/consent` gate asks for PDP consent then). Existing customer
   matched by an unverified email: never changes its name, phone or consent; the order carries its
   own contact snapshot and consent evidence. A session customer: missing `pdp_consent_at` (and
   `promo_consent_at` when ticked) stamped, the WhatsApp number becomes the account phone only when
   it has none and the number is free.
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

Bearer `INTERNAL_CRON_SECRET`, internal network only (Caddy answers 404 for `/api/internal/*` on
the public hosts; the route also refuses a request carrying `CF-Connecting-IP` or
`X-Forwarded-For`). Not behind the cart flag: it only acts on checkout orders that exist. One run at
a time (Postgres advisory lock; an overlapping call answers `{ skipped: "running" }`).
**As built (session 12):** every 5 minutes, checkout orders `awaiting_payment` with `payment_status
= 'pending'` whose 60-minute payment window is over (oldest first, 50 per run, 4-minute budget,
partial index `orders_checkout_awaiting_payment_idx`): **every open attempt** (`created` /
`pending` / `failed`) gets a status fetch through the state machine (a late settlement is paid, the
latest attempt's gateway expiry cancels, an older attempt's end never does). Inside the stock hold
(the order's own reservations decide, i.e. 75 minutes) nothing more happens. After the hold: an
attempt still `pending` at the gateway is **expired** (`POST /v2/{order_id}/expire`, decision 27)
and the answer (or a fresh status fetch when the gateway refused with 404/412) goes through the
state machine; then, if every open attempt is confirmed ended in this run (no transaction (404) or
`expire` / `cancel` / `deny` / `failure`), the order is **expired locally** (decision 28,
`expireOrderWithoutLiveTransaction`: re-checked under the order lock, attempts `expired`, order
cancelled through `transitionOrderStatus` with `payment_expired`, holds released, voucher restored).
A gateway that cannot be asked never ends an order (retried next run). Orders paid while stock was
short (`payment_status = 'paid'`) are never candidates. The route revalidates the affected product
pages and answers 500 / 502 when an order failed or the gateway was unreachable. Orders already
flagged for staff are swept last; an order still open 6 hours after its window is logged as an error
on every run. The Snap page ends with the payment window (`page_expiry`, session 12), so no payment
can start on an order the sweep ended locally. ~~`/account`, `/orders` and checkout also finalize the current customer's own stale orders
lazily~~ (not built; owner decision 41, session 15: the order pages show "Menunggu konfirmasi
pembayaran" until the sweep ends the order). Customers cannot cancel unpaid
orders themselves (decision 10).

Cron: the `cron` service in `deploy/docker-compose.yml` and `deploy-prod/docker-compose.yml`
(pinned `curlimages/curl:8.22.0`, `deploy*/cron/cron.sh`: sweep every 5 minutes, retention at start
and every 24 hours, straight to `http://web:3000` (prod's floating alias of the active slot) on the
`internal` network, secret from `env/cron.env`; runbooks `docs/deploy.md` "Internal cron service"
and `docs/deploy-prod.md` §3.4).

### 6.3a "Ganti metode pembayaran" (added 2026-10-21 after the owner's sandbox run)

The payment page stays locked to the method the buyer picked there (seen live: GoPay QR, closed,
"Lanjutkan pembayaran" reopened the same QR page). The finish page and `/orders/<no>` (session only,
like "Buka halaman pembayaran"; the finish page also accepts the checkout cookie, never the emailed
view cookie) show "Ganti metode pembayaran" under "Lanjutkan pembayaran" while the order is payable.
`changePaymentMethod` (`payments/attempts.ts`): (1) under the order lock it reserves the next attempt
(no page yet), so it is the latest attempt and no earlier attempt's end can cancel the order;
(2) outside any transaction every earlier open attempt (newest first) is asked at the gateway, a
pending one is expired (Midtrans Expire), and each answer goes through the state machine; a
settlement pays the order and ends the change ("paid", no new page); an attempt still pending or a
gateway that cannot be asked refuses it (the reservation is removed again, except after an expiry
whose answer was lost: then it stays, so the gateway's later expiry cannot cancel the order);
(3) under the order lock again everything is re-checked and the new page is requested for the rest
of the same window (12 s gateway budget, page in-flight window now measured from
`payments.updated_at`). At most 5 attempts per order; `payment_method_change` 5 per 10 minutes per
IP, counted before the ownership lookup. An earlier attempt with no transaction has nothing to expire:
a payment still started on its old page later is a second payment the state machine flags
`refund_due`. Tests: `notification.test.ts` ("changePaymentMethod" plus committed races with a
settlement of the old attempt and two taps at once), `reorder-actions.test.ts`, `e2e/checkout.spec.ts`.

### 6.4 Voucher reversal

On any `-> cancelled` of a web order, same transaction:
`UPDATE vouchers SET status = CASE WHEN expires_at > now() THEN 'active' ELSE 'expired' END,
used_order_id = NULL, used_at = NULL WHERE used_order_id = $order AND status = 'used'`.
`returned` never restores (decision 8).

### 6.5 Admin cancel of a web order

- `awaiting_payment` unpaid: asks the gateway for every open attempt and expires a pending one first
  (Midtrans Expire, like the sweep, decision 27; was "cancel"); refuses if the gateway reports it paid
  or cannot be asked; `cancel_reason = 'admin'`.
- Paid (`to_ship`, or stock short): allowed, flag `refund_due` until staff record the refund by hand
  ("Catat dana dikembalikan", decision 43) or the gateway reports it. The amount to refund is the
  full `total_amount`, ongkir included (§4.5.6). As built: session 16 in §15.

## 7. How web orders fit the existing admin flow

- **Statuses:** unchanged `ORDER_STATUSES`. `payment_status` separate, web only.
- **`/orders`:** payment badge, "Perlu dicek" filter (`needs_attention`), detail "Pembayaran"
  section (method, paid time, attempts, transaction id, refunds), contact and structured
  address, actions per §6.5, item edit blocked for web orders, and a "Pengiriman" section with the
  locked quote (§4.5.6); Phase K adds the booking and tracking to it (§15).
- **`/packing`:** paid web orders enter the `to_ship` queue showing the quoted service ("JNE
  Reguler"). Thank-you cards stay marketplace only (verify and enforce server-side). Before Phase
  K: staff book that service by hand, then manual "Tandai dikirim" (courier prefilled from the
  order) with the resi sends the "Pesanan dikirim" email. Since round 2 the courier and resi are
  required for a web order (server-side), bulk "Tandai dikirim" skips web orders, and the order page
  has "Tambah resi" / "Ubah resi". After Phase K: "Pesan kurir" books Biteship and prints
  the label; the manual path stays as fallback.
- **`/stock`:** read-only "Dipesan" figure from active reservations, reservation rows on
  `/stock/[sku]`, and a note on the count page that reserved pieces are still counted.
- **Revalidation** of affected product paths after reserve, release and sale.
- **Overview:** the 18% marketplace fee assumption must not apply to `web`; ongkir is not sales
  revenue and the subsidy is a shipping expense (§4.5.6).
- **Products:** "Berat kirim (gram)" on the product form, required to publish, badge on the list
  when missing (§4.5.3, session 7).

## 8. Emails (Resend, Indonesian, HTML with a plain-text part)

| Kind | Trigger | Content |
|---|---|---|
| `created` | order created | order no, lines, subtotal, ongkir (buyer's share, with "subsidi ongkir Rp20.000" when it applied), voucher, total, "Lanjutkan pembayaran" link, deadline in WIB, **"Lihat pesanan"** link; guest orders (`placed_with_session = false`) also **"Masuk ke akun"** |
| `paid` | to `to_ship` | "Pembayaran diterima", lines, address, next steps, "Lihat pesanan"; guest orders also a fresh "Masuk ke akun" (supersedes the earlier one) |
| `shipped` | manual "Tandai dikirim" or Biteship picked-up/in-transit, **only once the order has a resi** (round 2) | courier, resi, "Lihat pesanan" (tracking shows there) |
| `delivered` | Biteship delivered (Phase K) | "Pesanan sudah sampai", returns/exchange info link |
| `cancelled` | expire/cancel | reason in plain words, voucher restored note, "Pesan lagi" (button to the order page's token link, session 15; was "Belanja lagi" to the homepage) |
| `owner_paid` | paid (decision 11) | to `store_settings.support_email`: order no, lines, total, link to admin order |

Each customer email mints its own `order_access_tokens` row. Magic links are rate limited and
skipped silently when the limit is hit (§9.3). Idempotent via `order_notifications`, sent with
`after()`, failures recorded and never thrown into a webhook. Never the gateway name.

**Round 2 (2026-10-21):** every buyer email greets "Halo Kak <first name>," (first word of the
recipient name, capitalised normally, letters only), "Halo Kak," when the name is left out.

**2026-10-21 sandbox fixes:** the greeting uses the order's recipient name ("Halo Rina,"), never the
linked customer row's (an unverified guest never renames it, so it can be the placeholder
"Pelanggan Ammari"); a name that looks like a link or carries 5 or more digits is left out. The header
shows the storefront's own logo (`<siteOrigin>/logos/ammari-primary.png`, https only, 24x28,
alt "Ammari") next to "AMMARI". Totals show "Ongkir kurir" struck through, a highlighted "Subsidi
ongkir Ammari -Rp20.000" and "Ongkir" (or "Gratis ongkir Rp0"), as rows in the text part too. A
template change alters the payload: a send whose answer was lost before a deploy and retried after it
gets Resend's 409 and is recorded as permanent, so deploy when `order_notifications` has no failed
unsent rows. Admin shows the order's recipient name as "Pelanggan" for checkout orders.

**As built (session 13).** `@ammari/commerce/emails`: pure templates (`templates.ts`, table-based
inline-styled HTML in one 560px column plus a plain-text part, "Rp259.000", WIB, no em dash, never
the gateway or shipping provider, no cost data) and the dispatcher (`dispatch.ts`).
`dueOrderEmails(order)` reads what is due from the order's own state, so every caller sends only what
is still due: `created` (awaiting payment, window open), `paid` "confirmed" + `owner_paid` "paid"
(`to_ship` with `paid_at`), `paid` "review" + `owner_paid` "stock_short" (paid while stock short) or
"after_cancel" (`paid_after_cancel`), `cancelled` (`payment_expired` / `payment_cancelled`, never
paid), `shipped`; staff cancels (`admin`) and `delivered` are not sent yet. Claim: one `INSERT ... ON
CONFLICT (order_id, kind) DO UPDATE ... WHERE sent_at IS NULL AND lease over (10 min) AND created
under 23 h AND not terminal RETURNING id`. Resend `Idempotency-Key` = `order-email/<notification
id>`; the view token is `HMAC-SHA256(CUSTOMER_BETTER_AUTH_SECRET, purpose label + notification id)`
(only its sha256 stored, 120 days), so a retry renders the same payload; a payload that changed
meanwhile gets Resend's 409 and is recorded as permanent, never delivered twice. Failures go into
`error` as status + Resend error name only; Resend 4xx other than 408/409/429 is permanent; a kind no
longer due is marked `superseded`. Hooks (apps/web `lib/emails/order-emails.ts`, `after()`):
`placeOrderAction`, the notification route, the finish page's status check, the sweep route. The
cron's `POST /api/internal/emails/dispatch` (every 5 minutes after the sweep, shared cron lock,
150 s budget) retries and sends what no hook covers (staff's "Tandai dikirim" in apps/admin).
Subjects: "Pesanan ORD-... menunggu pembayaran", "Pembayaran pesanan ORD-... sudah kami terima",
"Pesanan ORD-... dibatalkan", "Pesanan ORD-... sudah dikirim", owner "Pesanan baru dibayar: ORD-...",
"Perlu dicek: ORD-... dibayar, stok kurang", "Perlu dicek: ORD-... dibayar setelah dibatalkan".

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
- **As built (session 14).** `@ammari/auth/customer`: `login-link.ts` (`issueOrReuseCustomerLoginLink`:
  an existing token hash is reused, a new link only when the caller allows it; customer row `FOR NO
  KEY UPDATE`, email must equal `customers.email`, cap 5 per 24 h, supersede + insert in one
  transaction; `findLiveCustomerLoginLink` read-only; `consumeCustomerLoginLink` one `UPDATE ... FROM
  customers ... RETURNING`; `releaseConsumedLoginLink` gives a link back when the login failed before a
  session existed) and `order-login-link-plugin.ts` (`POST /api/auth/order-login-link/consume`, form
  urlencoded only, `formCsrfMiddleware` plus a required trusted `Origin`, 10 per 10 minutes per IP,
  redirects 302 to `/orders` (`/account` before session 15) or `/login/link?status=invalid|error`). The
  customer instance sets `disableOriginCheck: false` explicitly (Better Auth 1.7.7 turns origin and
  CSRF checks off under a test runner otherwise). apps/web: `/login/link` (force-dynamic, noindex,
  **`Referrer-Policy: same-origin`** (decision 36), `frame-ancestors 'none'` + `X-Frame-Options: DENY`
  (also on `/account`), `login_link_view` 60 per 10 minutes per IP; states: confirm "Masuk sebagai
  a***@...", "Kamu sudah masuk", "Link sudah tidak berlaku", "Terlalu banyak percobaan", "Permintaan
  tidak bisa diproses", "Terjadi kesalahan"); the auth route maps a 403/429/other refusal of the POST
  to a 303 back to that page (`lib/auth/login-link-response.ts`). Emails: `dispatch.ts` `loginUrlFor`
  puts the link in the `created` and `paid` emails of guest orders (`placed_with_session = false`),
  token `HMAC-SHA256(CUSTOMER_BETTER_AUTH_SECRET, "ammari:order-email-login-link:v1:" +
  notification id)`; a new link only on the notification's first attempt (`xmax = 0` on the claim),
  a retry reuses the first attempt's link or stays without one, so the payload never changes; an
  issuer failure sends the email without the link (logged). Owner decision (34): the per-customer cap
  is the only issuance limit; `auth_email_throttle` is never written. After login, `/account` shows
  the contact offer (decision 35). Retention: 30 days after expiry (`runRetention`).

## 10. Security checklist

- Server recomputes prices, discount, shipping quote, totals and stock everywhere;
  `expectedTotal` only detects drift. The browser never sends a price, courier, weight or provider
  area id; areas are referenced by our own `shipping_areas.id` (§4.5).
- Atomic patterns only: SKU locks + reservations; conditional voucher UPDATE;
  `checkout_attempt_id` UNIQUE; webhook conditional updates; cart merge upsert; magic link
  consume UPDATE ... RETURNING; one live login link per customer by partial UNIQUE index.
- CSRF: server actions use Next's built-in Origin check; the magic-link POST uses Better Auth's
  CSRF middleware; webhooks and the sweep are authenticated by signature, secret path token or
  bearer secret.
- No silent login anywhere: checkout never creates a session; the magic link needs a POST.
- Rate limits: cart writes, checkout submit, area search, shipping quote, the global daily provider
  call budgets (Maps, Rates), order view, login link view/consume, magic link issuance.
- Outbound Biteship calls go only to the configured base URL (no user-controlled URL, so no SSRF),
  with a timeout; responses are zod-parsed and only allowlisted fields are cached.
- Inventory hoarding: 75-minute hold, 3 unpaid orders per email, 20-piece cap.
- Customer sessions never reach admin (unchanged).
- Secrets only in env; Midtrans server key and Biteship key never reach the browser.
- No cost data in storefront queries.
- Logs never include keys, signatures, raw tokens or full addresses.
- Reviewers: `security-reviewer` on sessions 5, 8, 9, 10, 11, 14 and K3; `silent-failure-hunter`
  on the Biteship rate client (session 8), the payment webhook, sweeper, emails and the Biteship
  webhook/poller.

## 11. Data retention

| Data | Retention |
|---|---|
| Paid orders, items, payments, address snapshots, shipments and tracking events | 10 years (bookkeeping, UU KUP), then contact fields anonymized |
| Expired/cancelled unpaid orders | contact and address anonymized after 90 days; rows kept for metrics |
| `payment_notifications.payload`, `shipping_webhook_events` | 12 months |
| `order_access_tokens` | deleted 30 days after expiry |
| `customer_login_links` | deleted 30 days after expiry/consume (audit rows stay in `audit_log`) |
| Guest carts / customer carts | 30 days / 180 days after last activity |
| `customer_addresses` | until the customer deletes them or the account is deleted |
| Rate limit rows (incl. `shipping_maps`, `shipping_rates`) | 1 day |
| `shipping_rate_cache` | rows older than 7 days deleted (only fresh rows are ever used) |
| `shipping_areas` | kept (public reference data, no personal data; re-synced on every search hit) |

Run daily by the same cron service through its own route, `POST /api/internal/retention`
(session 12, decision 29: payment notifications, rate-limit rows (incl. the `0.0.0.0` budgets and
per-cart quote rows), `shipping_rate_cache`, carts and `order_access_tokens`; `customer_login_links`
since session 14; the anonymization rows come later).

### 11.1 Privacy policy and terms changes (owner edits the live text in admin Konten before launch)

**Kebijakan Privasi**, add or update:
1. Data collected at checkout: name, email, WhatsApp number, recipient name and phone, shipping
   address, order contents, payment status and payment method type (we never receive or store
   card data or banking credentials; no card payments are offered).
2. Purposes: processing and delivering orders, payment confirmation, sending order and shipping
   emails, customer service, legal bookkeeping obligations, and promotions only with separate
   consent.
3. Shared with: a licensed payment processor (to process payment), **the shipping service
   provider and the courier** (updated 2026-10-21, provider Biteship): while the buyer searches,
   the typed search text (kecamatan, city or kode pos) goes to the shipping provider; at checkout
   only the chosen area (kecamatan, kode pos), the parcel weight and the total value of the goods
   are sent to calculate ongkir; once the order is paid and booked (Phase K), the recipient's
   name, phone and full address and the parcel contents go to the shipping provider and courier
   to deliver the package and provide tracking. And the email delivery provider. No sale of data.
   (The policy names the provider or not as the owner prefers; storefront UI never does.)
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
`CHECKOUT_STOCK_HOLD_MINUTES` (75, must be longer than the payment window),
`PAYMENT_PROVIDER` (session 9, owner decision 2026-10-21: `midtrans`, the default, or `fake`,
accepted only outside a production build and with `E2E_TEST_LOGIN=true`, like
`SHIPPING_RATE_PROVIDER`; since session 11 `midtrans` needs `MIDTRANS_SERVER_KEY` and
`MIDTRANS_IS_PRODUCTION`, otherwise checkout refuses before creating anything and notifications
answer 503), `INTERNAL_CRON_SECRET`, existing `STOREFRONT_CART_ENABLED`,
`RESEND_API_KEY`, `EMAIL_FROM`, `BETTER_AUTH_URL`, `CUSTOMER_BETTER_AUTH_SECRET` (also keys the
order email view tokens since session 13), `ADMIN_SITE_URL` (session 13, optional: apps/admin's
origin for the owner email's "Buka di admin" link). In production order emails need `RESEND_API_KEY`,
`EMAIL_FROM`, an https `BETTER_AUTH_URL` and a 32+ character `CUSTOMER_BETTER_AUTH_SECRET`; otherwise
nothing is claimed and the email pass answers 503 with the variable names.
apps/web Phase C shipping (session 8, Biteship since D18; replaces the earlier `KOMERCE_*`
names, which were never deployed): `BITESHIP_API_KEY` (one key for Maps, Rates and later Orders
and Tracking; `biteship_test.` or `biteship_live.`; a test key is refused when
`DEPLOY_ENV=production`), `BITESHIP_BASE_URL` (`https://api.biteship.com`; must be `https://`),
`BITESHIP_ORIGIN_AREA_ID` (Ammari's own Biteship area id, from a Maps search on the shop's
kecamatan and kode pos; never shown), `BITESHIP_DAILY_MAPS_BUDGET` (default 1500),
`BITESHIP_DAILY_RATES_BUDGET` (default 300), `SHIPPING_QUOTE_CACHE_MINUTES` (360),
`SHIPPING_RATE_PROVIDER` (`biteship`, the default, or `fake`, accepted only outside a production
build and with `E2E_TEST_LOGIN=true`, the e2e fixtures gate). The real client is built only when
the key, base URL and origin are all set; otherwise area search and quotes answer "unavailable"
(fail closed) and log which variable is missing (name only).
apps/admin: `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION`, `MIDTRANS_ORDER_ID_PREFIX`,
existing `MAIN_SITE_URL`; Phase K adds the **shipment runtime** (`shipmentRuntimeFromEnv`, K1, read
by apps/admin from K2 and apps/web from K3): `BITESHIP_API_KEY`, `BITESHIP_BASE_URL`,
`BITESHIP_ORIGIN_AREA_ID`, `BITESHIP_SHIPPER_NAME` (2 to 60 characters), `BITESHIP_SHIPPER_PHONE`
(an Indonesian mobile number), `BITESHIP_SHIPPER_ADDRESS` (10 to 300 characters; decision 50),
`BITESHIP_REFERENCE_PREFIX` (`A-Z0-9-`, at most 16; required outside production, e.g. `DEV-` /
`LOCAL-`; decision 51), `BITESHIP_DAILY_ORDERS_BUDGET` (default 60 order reads a day; order writes
have a fixed safety cap of 200), `SHIPPING_ORDER_PROVIDER` (`biteship`, the default, or `fake`,
e2e only like `SHIPPING_RATE_PROVIDER`), `DEPLOY_ENV`. **A live key is refused for bookings
outside `DEPLOY_ENV=production`** (it would call real couriers); a test key is refused in
production. The names go into the env examples when K2/K3 first read them (`set-env-var.sh` must
also refuse `SHIPPING_ORDER_PROVIDER`, like the other provider switches).
apps/web Phase K: the same shipment runtime (webhook re-fetch and poller), plus
`BITESHIP_WEBHOOK_PATH_TOKEN` (long random path segment), `BITESHIP_WEBHOOK_HEADER_NAME` and
`BITESHIP_WEBHOOK_HEADER_SECRET` (the key and the static value of Biteship's webhook "Headers
Signature Key / Secret" fields, confirmed to exist). **As built (K3, decision 54):** web uses a
read-only tracking runtime (`BITESHIP_API_KEY`, `BITESHIP_BASE_URL`, `BITESHIP_ORIGIN_AREA_ID`,
`BITESHIP_DAILY_ORDERS_BUDGET`, `DEPLOY_ENV`; no `BITESHIP_SHIPPER_*`, no reference prefix).
cron service: `INTERNAL_CRON_SECRET` (`env/cron.env`, same value as web's; added to
`deploy*/env/web.env.example` and the new `deploy*/env/cron.env.example` in session 12).
Added to `deploy/env/*.env.example` and `.env.example` in session 17 (names only); payment and
shipping code paths fail closed when their variables are missing.

## 13. Testing strategy

- **Unit (TDD for vouchers, payments, stock, login links, shipping money):** pricing, best
  voucher, signature, every row of §6.2, provider order id, phone normalization, area search
  parsing, subsidy split (0, 19.999, 20.000, 20.001, 200.000), cheapest-service pick with ties
  and non-allowlisted services, parcel weight with packaging, Midtrans item_details sum with and
  without an Ongkir line, Biteship response parsing against **hand-written fixtures copied from the
  documented examples** (never recorded from a real call), Biteship status normalization,
  retention cut-offs.
- **DB integration:** reservations, last-unit race, voucher double redeem, double submit, webhook
  replay and out-of-order, expiry release + voucher restore, expired voucher not restored,
  paid-after-cancel, stock-short-at-payment, cart merge caps, admin cancel, login link single use
  and supersede, shipment event dedupe and auto-complete.
- **Fakes:** `FakePaymentProvider` (with a gated local "Snap" page under `/api/test/...`),
  `FakeShippingRateProvider` (session 8: a handful of fictional areas, e.g. "Kecamatan E2E
  Murah" quoting Rp12.000 (buyer Rp0), "Kecamatan E2E Jauh" quoting Rp95.000 (buyer Rp75.000),
  one with no allowlisted service, one whose quote fails as unavailable, one without kode pos, and
  a search text that fails the search itself) and `FakeShipmentProvider` for Phase K (K1, below), all behind
  the existing e2e fixtures gate. Unit tests inject a stub `fetch` into the Biteship client;
  nothing in CI or e2e reaches Biteship or Midtrans.
- **e2e (Chromium + WebKit, 390 px and 1280 px):** add to cart, cart edits and sold-out line,
  guest checkout alert, guest checkout to fake payment to finish page, finish page OTP link,
  magic link (GET page, POST login, cart merged, "Pesanan saya"), "Lihat pesanan" token page,
  logged-in checkout with voucher, expiry and "Pesan lagi", order list/detail, admin sees the order
  in `/orders` and `/packing`, flag off 404. On `ammari_e2e` only.
- **e2e shipping (session 10):** area search and pick, Rp0 and Rp75.000 buyer shares in sections 3
  and 4, no-service and timeout states block "Bayar sekarang", the Ongkir line reaches the fake
  payment page, at 390 px and 1280 px.
- **Sandbox contract tests (opt-in with sandbox keys, skipped by default, run by hand):** Midtrans
  create/status/cancel; Biteship Maps and Rates (session 8; **billed even with a test key**, a
  few rupiah per run), orders create/retrieve/cancel and tracking (Phase K; orders are simulated in
  test mode).
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
- Before launch, shipping (added 2026-10-21, Biteship since D18): the Biteship account on the
  **Grow** plan (§15 "Biteship plan"; the new plan structure applies from 2 Nov 2026), the six
  allowlisted couriers activated in the dashboard, a `biteship_live.` key in the prod env,
  `BITESHIP_ORIGIN_AREA_ID` set to Ammari's own area, the two daily budgets at or below Grow's
  monthly quotas / 31, a balance top-up only if Phase K is live (rates and maps inside the quota
  cost nothing extra), **zero published products without "Berat kirim"**, the packaging allowance
  confirmed by weighing one packed order, a spot check of 3 quotes on dev (one in Java, one in
  Sumatra or Sulawesi, one in Papua) against Biteship's own dashboard rate check, the service
  codes the contract test printed matching the allowlist, and the announcement bar and Pengiriman
  page re-worded by the owner.
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
| 8 | **DONE 2026-10-21.** Shipping rates on **Biteship** (owner switched from Komerce mid-session, D18, decisions 22 to 26). Migration 0032 renames `shipping_areas.komerce_destination_id` to `provider_area_id` (and its UNIQUE; generated with the rename chosen at drizzle-kit's prompt, hand edits: header, `lock_timeout`, `RENAME CONSTRAINT` instead of DROP+ADD). `zod` 4.6.5 added to `@ammari/commerce` (owner approved). `@ammari/commerce/shipping-rules` (pure, client-safe): `SHIPPING_SERVICE_ALLOWLIST` (Biteship codes `jne/reg`, `jnt/ez`, `sicepat/reg`, `idexpress/reg`, `anteraja/reg`, `pos/kilat_khusus`), `splitShippingCost`, `parcelWeightGrams`, `allowlistedServices`, `pickCheapestService`, `normalizeProviderPostalCode`, `formatShippingAreaLabel`, `shippingAreaSearchText`. `@ammari/commerce/shipping` (server-only): `ShippingRateProvider` + typed `ShippingRateError` (`logFields()` logs reason, status, provider code and the cause's name/code only), `createBiteshipClient` (Maps `GET /v1/maps/areas`, Rates `POST /v1/rates/couriers`, raw-key `authorization` header, 5 s timeout not retried, one retry on network error/5xx, `redirect: "error"`, row-by-row zod parsing, 40001010 on a 400 = no service, Maps 404 = unavailable), `createFakeShippingRateProvider` (fictional "Kecamatan E2E ..." areas: Murah Rp12.000, Jauh Rp95.000, Tanpa Layanan, Gangguan, Tanpa Kode Pos; a query containing "gagal" fails the search), `consumeShippingCallBudget` (daily per Jakarta day, `shipping_maps` / `shipping_rates` rows under ip `0.0.0.0`), rate cache (allowlisted services only; an answer emptied by filtering is logged loudly and never cached; a failed cache write keeps the quote), `searchShippingAreas` (dedupe, upsert sorted by provider id against deadlocks, at most 10 options of our own ids) / `loadShippingArea`, `quoteShipping`, `shippingRuntimeFromEnv` (Biteship only with key + `https://api.biteship.com` + origin; fake only in a non-production build with `E2E_TEST_LOGIN=true`; a test key refused when `DEPLOY_ENV` is production, or unset in a production build). `@ammari/commerce/address` v2 (area row in, `version: 2` snapshot with `shippingAreaId` and `providerAreaId`; "Pilih kecamatan dari daftar."). apps/web: flag-gated `GET /api/shipping/areas?q=` (route handler, see §4.5.1; refuses cross-site `Sec-Fetch-Site`; `area_search` 60/10 min per IP with `Retry-After`; repeated queries answered from process memory for 6 h; `private, no-store`), `lib/shipping/runtime.ts` (logs a misconfiguration once per problem set), per-IP limits now bucket IPv6 by /64 (`lib/cart/ip-bucket.ts`, also applies to cart writes). The commerce test suite now refuses every non-local `fetch` (`packages/commerce/test/setup.ts`); the opt-in `biteship.contract.test.ts` (skipped unless `BITESHIP_CONTRACT_TEST=1`) prints the service codes a real test key returns. e2e: `SHIPPING_RATE_PROVIDER=fake` in `playwright.config.ts`, `e2e/shipping-areas.spec.ts` (route contract, both flag states; the combobox UI and its 390/1280 checks are session 10). Tests: `rules.test.ts`, `biteship.test.ts`, `shipping.test.ts`, `address.test.ts`, `route.test.ts`, `ip-bucket.test.ts`, `migration-0032.test.ts` (0031's test now stops at 0031) | 0032 | TDD (shipping money) + fixtures | typescript, database, security, silent-failure-hunter (no Critical; all High/Medium fixed except those deferred in the notes below) |
| 9 | **DONE 2026-10-21.** `placeOrder` backend (was 7). `@ammari/commerce/checkout` `placeOrder(db, deps, input)` (`checkout/place-order.ts`): validation (contact email from the session when logged in, `+62` WhatsApp, `parseShippingAddress` against our `shipping_areas` row, voucher only with a session, consent; all field errors at once in form order) -> repeat `checkoutAttemptId` answers with its order -> `deps.admit()` (the caller's rate limit, only for valid new submits) -> `resolveCart` (merges a guest cart) -> `quoteShipping` **outside** the transaction (typed refusals mapped exhaustively to the §4.5.5 messages; the quote's destination must still be the snapshot's) -> one transaction with `lock_timeout = 5s` (55P03 answers "Pesanan belum bisa diproses. Coba lagi sebentar lagi."): cart row `FOR NO KEY UPDATE`, re-check the attempt id, lines must equal the quoted lines (merged by SKU), active/published/variant active, 10/line, 20/order, parcel weight equal to the quote's, unpaid cap (3 in 2 hours; per contact email for guests, per customer for logged-in orders, so guest orders typed with someone's email never lock that customer out; two-key advisory lock), customer (session: missing consent stamped, phone only if empty and free via a savepoint on `customers_phone_unique`; guest: insert-first link-or-create, a new row gets only email + name, owner decision, §5 step 4), `generateOrderNumber`, order with the 8 `shipping_*` columns, snapshot v2, `payment_expires_at = now() + 60 min`, items `unit_cost = 0`, `reserveStockForOrder` (75 min), conditional voucher `UPDATE ... RETURNING` then totals (goods only), `expectedTotal` drift and total > 0 checks, `buildPaymentLines` (sum = gross), `payments` attempt 1 (`provider` `midtrans`, `<prefix><order_no>-1`, `created`), one `order_access_tokens` row (sha256 only, 120 days), cart items deleted, audit `web_checkout` without contact/address. After commit: `provider.createPayment` (15 s cap, `signal` passed), token + redirect URL stored; any failure keeps the order pending with `redirectUrl: null`, logged with order no. A submit that lost a race to its own twin (cart already empty, or 23505 on the attempt id) answers with the twin's order. Replay returns the payment page only while `awaiting_payment` + `pending`, and for a guest only with the checkout cookie's matching token. Returns `clearGuestCookie` on every outcome (true once the merge ran) and the product slugs to revalidate. `@ammari/commerce/checkout-messages` (client-safe texts), `access-token.ts`. `@ammari/commerce/payments`: `PaymentProvider` + `PaymentProviderError`, `createFakePaymentProvider` (redirect to `/api/test/payments/<providerOrderId>`, page not built yet), pure `buildPaymentLines` / `providerOrderId`, `paymentRuntimeFromEnv` (`PAYMENT_PROVIDER`, §12; owner decision 2026-10-21). `updateOrderItems` also refuses any order with a quote, locks the order row, and maps a 23514 on the quote/total CHECKs to "Item dan ongkir pesanan dari checkout website tidak bisa diubah.". apps/web: `lib/checkout/actions.ts` `placeOrderAction` (flag, IP, zod caps, provider runtimes fail closed before anything is written, `checkout_submit` 10/10 min through `admit`, httpOnly `ammari_checkout_order` cookie on path `/checkout` for 7 days, `revalidatePath('/products/<slug>')` + homepage tag `max`, every post-commit step best-effort; errors logged by name and Postgres code only, never a query message), `lib/payments/runtime.ts`. Tests: `checkout/place-order.test.ts` (happy path field by field, subsidy at 19.999 / 20.000 / 20.001 / 200.000 and a Rp0 price never picked, voucher with a Rp75.000 ongkir share and the payment lines, voucher refusals, drift, quote refusals create nothing and hold nothing, missing weight with SKUs, unpublished / inactive / over the cap, short stock naming the item, cart and weight change between quote and transaction, unpaid cap and its session exemption, provider failure, replay rules, cookie clearing, rate-limit hook, unit cost locked at payment; committed races: **two buyers for the last piece**, double submit, the same voucher in two tabs, lock timeout), `payments/payments.test.ts`, `stock/reservations.test.ts` (quote lock), apps/web `lib/checkout/actions.test.ts` | none | TDD vouchers, stock, shipping, concurrency | security, database, typescript, silent-failure-hunter (no Critical; High/Medium fixed, see notes) |
| 10 | **DONE 2026-10-21.** Checkout UI + finish page. `/checkout` (`app/checkout/page.tsx`, `force-dynamic`, `notFound()` with the flag off, `noindex`; one `checkoutAttemptId` per page load) renders `components/checkout/checkout-form.tsx`: 1 Kontak (guest email + WhatsApp, "Sudah punya akun? Masuk"; logged in: locked email card, locked phone when the account has one, "Bukan kamu? Keluar" signs out to `/login?next=/checkout`), 2 Alamat pengiriman (recipient, phone, `AreaCombobox` "Kecamatan atau kode pos" over `GET /api/shipping/areas` with 3 characters, 300 ms debounce, abort per keystroke, ARIA 1.2 combobox, results unroll with the Curtain, chosen line + "Ganti"; Kode pos only for an area without one; alamat lengkap hint "Jalan, nomor rumah, RT/RW, kelurahan"; optional courier note), 3 Pengiriman (`shipping-section.tsx`: one fixed row with the service and the buyer's share, "Ongkir RpX, subsidi Ammari -RpY." / "ditanggung penuh subsidi Ammari.", the resi line; failure states per §4.5.5 with "Coba lagi" or a WhatsApp link prefilled with the area label), 4 Ringkasan (lines, voucher: guests "Masuk untuk pakai voucher", logged in a dropdown of usable vouchers best first with ×; Subtotal, Ongkir "-" until quoted, Voucher, Total; required consent with S&K and privacy links, optional promo; "Bayar sekarang" `#F07A1A` / `#1E1A1A`, 54 px, always enabled, one alert listing what to fix, focused; the payment-method note). Client checks reuse `parseShippingAddress` and placeOrder's messages (`lib/checkout/form.ts`). Quote: server action `quoteShippingAction` (`lib/checkout/quote-actions.ts`): browser sends only our area id; lines from the visitor's cart; `shipping_quote` 30/10 min per IP plus **20/10 min per cart** (`claim_rate_limits`, ip `0.0.0.0`, action `shipping_quote_cart:<cart id>`, `lib/checkout/cart-quote-limit.ts`); returns display figures and a cart fingerprint, and the page never shows a quote made for other lines than it shows (re-reads, quotes again). Submit calls `placeOrderAction`, then `announceCartCount(0)` and a full load of the payment page (https or same-site only, `lib/checkout/navigate.ts`) or the finish page; drift/short-stock refusals re-read the page and re-quote; a lost answer says pressing again is safe (same attempt id). `/checkout/finish?order=` (`lib/checkout/queries.ts` `loadFinishOrder`): shown to the session customer who placed it while logged in, or with the `ammari_checkout_order` cookie's token; anyone else (unknown number included) gets the same "Lihat pesanan, masuk" page; states from our DB only: "Pembayaran berhasil", "Menunggu pembayaran" (deadline in WIB, "Lanjutkan pembayaran" = stored redirect URL), "Menunggu konfirmasi pembayaran" (past the window, not finalized), "Pembayaran gagal atau kedaluwarsa"; guest orders offer "Masuk untuk melihat semua pesanan" (email OTP; the contact email handed to the login form through sessionStorage, never the URL; lands on `/account` until `/orders` exists). e2e-only fake payment page `GET /api/test/payments/<providerOrderId>` (fixtures gate + flag, read-only HTML with `buildPaymentLines`, "Kembali ke toko" to the finish page; never marks anything paid). `PAYMENT_PROVIDER=fake`, `MIDTRANS_ORDER_ID_PREFIX=E2E-` in `playwright.config.ts`. Owner decision 2026-10-21: saved addresses (`customer_addresses`, "Ubah"/"Ganti alamat"/"Perbarui alamat tersimpan") deferred to a later session; everyone types the address, logged-in name/phone prefilled. Tests: `quote-actions.test.ts`, `queries.test.ts`, `form.test.ts`, `navigate.test.ts`, `api/test/payments/.../route.test.ts`, `checkout-form.test.tsx`, `area-combobox.test.tsx`, `login-form-prefill.test.tsx`, `e2e/checkout.spec.ts` (390/1280, Chromium + WebKit: flag off 404s; PDP to cart to checkout to fake payment page (Ongkir line) to finish page, a stranger's view, the login prefill; Rp0 area, empty-submit alert, landline refused, "Ganti"; provider down; no service; missing weight; logged-in voucher (Voucher line reaches the payment page); last piece sold out during checkout; submit and quote limits), `e2e/helpers/checkout-db.ts` | none | e2e guest + logged-in + shipping states | react, security, typescript, silent-failure-hunter (no Critical; High/Medium fixed, see notes) |
| 11 | **DONE 2026-10-21.** Midtrans provider + webhook + mapping + sandbox contract test (was 9). Midtrans public docs read 2026-10-21 (sources in `payments/midtrans.ts` and `payments/status.ts`). `@ammari/commerce/payments`: `createMidtransPaymentProvider` (Snap `POST /snap/v1/transactions` with Basic auth, `item_details` = `buildPaymentLines` 1:1 (Ongkir line only when the buyer's share is above 0, negative Voucher line, sum = `gross_amount`), `enabled_payments` exactly `other_qris, gopay, shopeepay, bca_va, bni_va, bri_va, echannel, permata_va`, `customer_details.first_name` cut to 30 (BCA VA), `callbacks.finish`, `expiry { start_time (Jakarta, always sent: without it an async method's window starts only when the buyer picks it), unit minute, duration }`, `X-Override-Notification` from `MIDTRANS_NOTIFICATION_URL`; 201 parsed, `redirect_url` must be https on Snap's host for the mode; errors logged by status and message count only; never retried (a used order id answers 406)); status `GET /v2/{order_id}/status` (5 s, one retry on network error/5xx, body `status_code` 404 = no transaction yet, 401/5xx in the body = unavailable, another order's body = bad_response); `verifyMidtransSignature` (SHA-512 of order_id + status_code + gross_amount + key over the strings exactly as sent, 128-hex check, `timingSafeEqual`). `paymentRuntimeFromEnv` / `paymentProviderFromEnv`: Midtrans needs `MIDTRANS_SERVER_KEY` and an explicit `MIDTRANS_IS_PRODUCTION`; production mode only with `DEPLOY_ENV=production` (or a production build without `DEPLOY_ENV`), and required there; an `SB-` key refused in production mode; `DEPLOY_ENV` other than production/dev/development/test fails closed; `MIDTRANS_NOTIFICATION_URL` optional, one https URL. **State machine** `applyPaymentStatus` (`payments/apply-status.ts`), fed only by a status the server fetched itself: order `FOR UPDATE`, then the attempt; settlement with the attempt's exact amount, IDR and fraud `accept` -> `transitionOrderStatus(..., "to_ship", null)` in a savepoint (sale movements, unit_cost at the moving average, holds consumed, audit without actor) + `payment_status = 'paid'`; a refused sale (`FieldError`, stock short) keeps the payment, order stays `awaiting_payment`, flag `stock_short_at_payment`; paid for a cancelled order -> `paid_after_cancel` + `refund_due` (owner decision 2026-10-21), nothing sold; a second paid attempt -> `refund_due`; expire/cancel of the **latest** attempt cancels an unpaid order (holds released, voucher restored, `cancel_reason`), an older attempt's end never does; deny/failure -> attempt `failed`; refunds monotonic and attempt-aware (a refunded duplicate keeps the order paid; a refund of an attempt never seen paid flags `payment_anomaly`); chargeback flagged; `capture`/`authorize`/`credit_card`, amount or currency mismatch, fraud other than `accept` and unknown statuses flagged, never paid. **Voucher restore on every cancel** lives in `transitionOrderStatus` (`actorStaffUserId` may now be null for system callers), so admin cancels restore too; `returned` never does. **Notification** `handlePaymentNotification` (`payments/notification.ts`): row in `payment_notifications` first (verified: payload without `signature_key`; unverified: four identifying fields only, capped per IP by the route), then signature, attempt, status fetch, state machine; answers by Midtrans' retry policy: 200 handled (and unknown attempts), 403 bad signature (logged as an error: a stream of them means a key mismatch), 400 malformed or oversized (still logged), 503 when it could not be handled yet (provider not configured, status fetch failed or 404, database error; Midtrans retries 503 four times). apps/web `POST /api/payments/midtrans/notification` (not behind the cart flag, owner decision 2026-10-21, plan §14; 32 KB streamed cap; `payment_notification_unverified` 30/10 min per IP for unverified rows; generic answer bodies; revalidates sold or released products). Finish page: `PaymentStatusCheck` (one server-side status check per load through `checkPaymentStatusAction` -> `syncLatestPaymentStatus`, `payment_status_check` 30/10 min per IP counted only when the gateway is asked, `router.refresh()` on a change; render stays read-only because `revalidatePath` is not allowed during render), `ReopenPaymentButton` "Buka halaman pembayaran" (`reopenPaymentPageAction` -> `reopenPaymentPage`: a new attempt `<prefix><order_no>-<n>` for the rest of the order's window, at most 5, refused as busy while the previous attempt's page request may still be answered, `payment_retry` 10/10 min per IP counted before the ownership lookup), new state `refund_pending` ("Pesanan dibatalkan") for paid-after-cancel. placeOrder replays now return the latest attempt's page. e2e fake gateway: the gated fake page has "Bayar (uji)" / "Kedaluwarsa (uji)" buttons that record the fake gateway's answer (process-wide map) and post a notification signed with the fake key through the real route (never a direct DB write). apps/web tests now refuse non-local fetch too (`test/setup.ts`). Opt-in `payments/midtrans.contract.test.ts` (`MIDTRANS_CONTRACT_TEST=1`, `SB-` key only; never run in this session). Tests: `payments/midtrans.test.ts`, `payments/notification.test.ts` (every §6.2 row, duplicate and out-of-order notifications, bad signature, paid after hold expiry / release / order expiry, stock short, voucher restore on expire, gateway cancel, admin cancel unpaid and paid, never on return; committed races: two notifications at once, an expire/settlement interleave, two retry taps), `payments/payments.test.ts`, apps/web `api/payments/midtrans/notification/route.test.ts` (route, finish actions, fake buttons), `queries.test.ts`, `e2e/checkout.spec.ts` (fake pay -> "Pembayaran berhasil" and sold; fake expire -> cancelled and released; 390/1280, Chromium + WebKit) | none | TDD payments | security, database, typescript, silent-failure-hunter, react (no Critical; High/Medium fixed, see notes) |
| 12 | **DONE 2026-10-21.** Sweeper + cron service + retention job (was 10). Midtrans Expire API read 2026-10-21. `PaymentProvider.expirePayment` (Midtrans `POST /v2/{order_id}/expire`: 200 + `status_code` 407 is a status report, 404/412 null so the caller re-reads the status, 401/5xx unavailable, one retry on network error/5xx; `getPaymentStatus` and it now share one request helper; the fake expires only a pending transaction it recorded). `@ammari/commerce/payments` `sweepExpiredPayments` (`payments/sweep.ts`, §6.3 "As built") and `expireOrderWithoutLiveTransaction` (`apply-status.ts`). `@ammari/commerce/maintenance`: `withExclusiveRun` (`pg_try_advisory_xact_lock` in a transaction of its own for the whole run, the job on other connections; never waits) and `runRetention` (§11: batches of 5.000 with the age condition repeated in the outer DELETE, per-table failure logged and the rest still run). apps/web: `POST /api/internal/payments/sweep` and `POST /api/internal/retention` (`lib/internal/cron-auth.ts`: `INTERNAL_CRON_SECRET` at least 32 characters or 503, proxy headers 404, bearer compared as SHA-256 digests in constant time or 401; not behind the cart flag; sweep 503 without a payment provider; JSON counts only). Deploy: `cron` service in both compose files (`curlimages/curl:8.22.0`, `deploy*/cron/cron.sh`, script directory mounted whole, `env/cron.env` with only the secret, prod `mem_limit: 32m`), Caddy 404 for `/api/internal/*` on the public web hosts, both `remote-deploy.sh` create an empty `env/cron.env` when missing (a deploy never fails on it; empty idles the loop) and recreate `cron` each deploy (prod: after the web flip; failure only warns), `upload-prod-env.sh` uploads an optional `prod-cron.env`, env examples, runbooks. Tests: `payments/sweep.test.ts` (window open, inside the hold, late settlement, gateway expiry with voucher restore and revalidation slugs, local expiry with an expired voucher, every attempt checked, older pending attempt expired then local expiry, latest attempt's expiry, expire refused then paid, refused and still pending, gateway down never ends, stock-short paid never touched, manual orders untouched, batch/time budget; lock tests; committed races: **two sweeps at once** (one skipped, one cancel audit row; also without the lock), **a settlement notification racing the local expiry** (sold, or cancelled + `paid_after_cancel` + `refund_due`, never a mix)), `maintenance/retention.test.ts` (every rule's boundary, batching, one table failing), `midtrans.test.ts` (expire), apps/web `api/internal/payments/sweep/route.test.ts` (auth matrix for both routes, flag off, fake gateway expiry, no provider, lock skip, retention). The cron container was smoke-tested locally against a stub `web` (authorized calls, idle without a secret, 401 logged with its cause, a secret with a trailing space/CR still works, stops on TERM at once). **Review fixes:** Snap `page_expiry` = the payment window (the page lived 24 h by default, so a buyer could otherwise start paying an order the sweep had ended locally; `midtrans.ts`, session 11 code); one advisory lock shared by all cron jobs (cron never holds more than 2 of the 5 pool connections), `idle_in_transaction_session_timeout = 0` on the lock transaction and a finished run's result kept if only the lock's commit fails; the time budget also checked inside an order (`deferred`); orders already flagged for staff swept last so stuck orders never fill the batch, and any order still open 6 hours after its window logged as an error every run (`stuck` count); results `expired_locally` / `finalized_elsewhere`; the local expiry re-checks the hold under the order lock; the sweep route answers 500 (an order failed) or 502 (gateway not reachable) so the cron logs an `ERROR`; retention batches picked `FOR UPDATE SKIP LOCKED` and deleted `USING` the pick (each statement bounded by the batch, not the backlog); `errorLogFields` in `@ammari/commerce/errors`; cron script: secret trimmed, curl exit code and the likely cause of 401/503 logged, retention retried after an hour when it failed, an `ALERT` line after 3 failed sweeps in a row; dev deploy recreates `cron` with `--no-deps`; prod Caddy's internal `:8080` listener also 404s `/api/internal/*`; `.gitignore` covers `deploy*/env/*.env` | none | integration + concurrency | silent-failure-hunter, database, security, typescript (no Critical; High/Medium fixed) |
| 13 | **DONE 2026-10-21.** Emails (was 11), see §8 "As built". `@ammari/commerce/emails` (templates, `dueOrderEmails`, `dispatchOrderEmails`, `dispatchPendingOrderEmails`, `deriveOrderEmailAccessToken`), `@ammari/auth` `EmailSender` with optional `html` + `idempotencyKey`, `ResendEmailSender` with a 10 s timeout, `redirect: "error"` and `EmailDeliveryError` (status + Resend error name, never the body); auth tests now refuse non-local fetch (`test/no-network.ts`). apps/web: `lib/emails/order-emails.ts` (`getOrderEmailConfig`: Resend, the e2e discarding sender, console locally; `scheduleOrderEmails` via `after()`; test-only sender override), hooks in `placeOrderAction`, the notification route, `checkPaymentStatusAction`, the sweep route; `POST /api/internal/emails/dispatch` (cron auth, `orderEmails` on the shared lock, 503 with variable names, 500 on failed/permanent/abandoned, warning only for a missing owner address). `deploy*/cron/cron.sh`: email pass after each sweep, `ALERT` after 3 failures in a row. Env examples: `ADMIN_SITE_URL`. The manual-shipped hook is the cron pass (no admin change: the HMAC secret and Resend stay in apps/web). Tests: `emails/emails.test.ts` (due matrix, templates without dashes or provider names, escaping, subsidy lines, token, created/paid/stock-short/paid-after-cancel/shipped/manual order, no recipient, **Resend failure never touching the order and retried with the identical payload**, permanent refusals, superseded, 23 h stop, **sweep expiry sending `cancelled` once**, **five duplicate dispatches at once sending one email**), apps/web `lib/emails/order-emails.test.ts` (**duplicate notifications through the route: one paid + one owner email**, Resend down through the route then the cron retry, sweep route + email pass, cron auth, config), `resend-email-sender.test.ts`, checkout action schedules `created` | none | unit + integration | typescript, security, silent-failure-hunter (no Critical; High/Medium fixed: superseded rows, production origin check, permanent vs retryable, `no_recipient` apart from failures, new orders before retries, per-kind load failure, `after()` try/catch, 503 logged each run, cron `ALERT`, 150 s budget, idempotency key per row, customer text cleaned) |
| 14 | **DONE 2026-10-21.** Magic login link (was 12), see §9.3 "As built" and decisions 34 to 37. Migration 0033 (`customer_login_links`, `customers.contact_offer_resolved_at`). `@ammari/auth/customer` `login-link.ts` + `order-login-link-plugin.ts` (wired into `createCustomerAuth`); `@ammari/commerce/emails` `deriveOrderEmailLoginToken`, `OrderEmailDeps.loginLinks`, login link in guest `created`/`paid` emails; retention rule. apps/web: `/login/link` page + `login-link-form.tsx`, auth route refusal mapping, `next.config.ts` headers, `lib/account/contact-offer.ts` + `ContactOfferCard` on `/account`, issuer wired in `lib/emails/order-emails.ts`, `login_link_view` action key. Tests: `packages/auth/test/customer-login-link.test.ts` (issue/supersede/cap/race, consume via the real router: once, existing account, foreign customer, superseded, expired, email changed, CSRF matrix, form-only, no `.api` login, 10/10 min, release after a failure), `emails.test.ts` (links in created/paid only, retry identical, cap, issuer failure), `retention.test.ts`, apps/web `order-emails.test.ts` (real issuer: created then paid supersedes), `contact-offer.test.ts`, `login-link-response.test.ts`, `migration-0033.test.ts`, `e2e/login-link.spec.ts` (390/1280, Chromium + WebKit, flag off and on: GET does not log in, Masuk once, used twice, expired, second link revokes the first, scanner prefetch, CSRF, consent gate, contact offer, cart merge with the flag on). Also fixed a `sql-correlation-guard` hit in `payments/attempts.ts` (session 11 code; `eq()` instead of a bare correlation, same SQL) that failed `@ammari/db`'s tests | 0033 | TDD + e2e | security, database, typescript, silent-failure-hunter, react (no Critical/High; Mediums fixed: link given back when the login fails before a session, framing blocked, the offer saves only what was shown, `FOR NO KEY UPDATE`, logging of every dropped link and refused POST, typed issue outcome, bfcache reset, focus) |
| 15 | **DONE 2026-10-21.** "Pesanan saya" (was 13), decisions 38 to 42. **Visibility rule** (apps/web `lib/orders/access.ts`, one place): a session sees orders with its `customer_id` that are staff-entered/marketplace (`payment_status` NULL), placed while logged in, or guest checkout orders whose `contact_email` equals the account's current, **verified** email (citext); the finish page, its payment actions, the /account list and the contact offer use it too. A token (sha256 lookup, unexpired, that order) opens that one order. **"Lihat pesanan" link**: `next.config.ts` `beforeFiles` rewrite of `/orders/:orderNo` with `?t=` to `app/api/orders/[orderNo]/view` (no proxy file): `order_view` 60/10 min per IP counted first, one `UPDATE order_access_tokens SET last_used_at ... RETURNING expires_at`, then a bodyless 303 to the clean URL with `Referrer-Policy: no-referrer`; a match also sets `ammari_order_view` (httpOnly, SameSite=Lax, Secure in production, `Path=/orders/<orderNo>`, expires with the token; multi-use for its 120 days). Every refusal redirects the same way without a cookie (`?status=limited|error` only for those two). **Pages** (force-dynamic, noindex, `Referrer-Policy: same-origin`, `frame-ancestors 'none'` + `X-Frame-Options: DENY` via `next.config.ts`; `/orders` regardless of the query): `/orders` (`requireConsentedSession`, 10 per page, contact offer card on top since the login lands here, empty state to the collection), `/orders/[orderNo]` (session or view cookie; status from `lib/orders/status.ts`: the six labels plus "Menunggu konfirmasi pembayaran" past the window and the paid-after-cancel note; timeline in WIB; "Lanjutkan pembayaran" = stored payment URL only if https or this site; "Buka halaman pembayaran" only for a session; status check; "Lacak pengiriman" with courier + resi; lines, Subtotal, Ongkir as paid, Voucher, Total for checkout orders only; address line; one `not-found.tsx` "Pesanan tidak bisa ditampilkan" (404) for unknown, foreign, wrong or expired; `orders/error.tsx`). Works with the cart flag off (decision 40); "Pesan lagi", the status check and the reopen button need it. `/account` with the flag on: newest 5 (stacked) + "Lihat semua pesanan"; flag off: unchanged. **"Pesan lagi"** (decision 39): `@ammari/commerce/cart` `addLinesToCart` (one transaction under the cart row lock; caps 10/line and 20/cart may cut a line; short stock skips a line whole so a quantity never reveals stock; nothing added = rolled back, no empty cart) + `lib/orders/reorder-actions.ts` (flag, `cart_write`/`cart_create` per IP before the ownership lookup, session or view cookie or checkout cookie, only cancelled never-paid checkout orders whose lines add up to the subtotal; cookie write failures never hide a committed refill) + `ReorderButton` (named skipped lines, header count announced, button gone after a refill) on the order page and the finish page's failed state. Login link and finish-page OTP login land on `/orders` (`LOGIN_LINK_SUCCESS_PATH`, `createCustomerAuth` default, `LOGIN_FOR_ORDERS_HREF`). Cancelled email: "Pesan lagi" to the order link. `reopenPaymentPageAction` refuses the view cookie (plan §9.2). Tests: `cart.test.ts` (addLinesToCart: add on top, sold out, unavailable, short stock skipped whole, caps, cap reason before stock, duplicates, nothing added, merge, concurrent refills), `lib/orders/orders.test.ts` (labels, visibility incl. changed and unverified email, tokens, redeem, list/pagination/detail without cost, reorder eligibility), `lib/orders/reorder-actions.test.ts` (token route: cookie and headers, every refusal alike, limit; Pesan lagi via each proof, refusals, flag off, rate limit; view cookie cannot reopen payment), updated `checkout/queries.test.ts`, `contact-offer.test.ts`, `emails.test.ts`, auth `customer-login-link.test.ts`; `e2e/orders.spec.ts` (390/1280 list + detail + /account, flag off and on: token link on another device, expired/wrong/unknown alike, another customer's order 404, Pesan lagi with a sold-out item and the header count), `login-link.spec.ts` and `checkout.spec.ts` now expect `/orders` | none | TDD stock (refill) + e2e 390/1280 | security, typescript, silent-failure-hunter, react, database (no Critical/High except two fixed: React "Pesan lagi" could be tapped again and double the cart; silent-failure order pages had no error boundary. Mediums fixed: `/orders?t=` lost its framing headers, the view cookie could open new payment attempts, cap reason reported as stock, cookie failure after a committed refill, lines not adding up, payable order without a usable payment link, `/account` layout, touch targets, focus, payment URL check, h1 names the order) |
| 16 | **DONE 2026-10-21.** Admin for checkout orders (was 14), decisions 43 to 45. `@ammari/commerce/payments` `staff.ts`: `cancelCheckoutOrderByStaff` (unpaid: every open attempt's status fetched and a pending one expired at the gateway, one 20 s budget for all calls, outside any transaction; a settlement is applied through the state machine and the cancel refused, any other non-ended status refused with its own message, an unreachable gateway refused; then under the order lock `cancelUnpaidCheckoutOrder` (shared with the sweep's local expiry, `apply-status.ts`) ends the attempts with the gateway's snapshot, cancels through `transitionOrderStatus` and sets `payment_status = 'cancelled'`, `cancel_reason = 'admin'`; paid (`to_ship`, or stock short): no gateway call, stock restored or hold released, voucher back, `refund_due` added and `stock_short_at_payment` resolved; a second press answers `already_cancelled`; audit `cancel_checkout_order` with the gateway's answer per attempt), `recordManualRefund` (one paid attempt in full, a 3 to 200 character note; only on a `refund_due` order and never the last paid attempt of an order going ahead; attempt `refunded`, order `refunded` once a cancelled order holds no paid attempt; `refund_due` and `paid_after_cancel` cleared when nothing is owed (`refundsOwed`); audit `record_refund` with amount and note), `clearAttentionFlag` (one flag under the order lock, `array_remove`, audit `clear_attention_flag`; refused for `stock_short_at_payment` while the order waits and for `refund_due` / `paid_after_cancel` while money is owed). `transitionOrderStatus`: staff may not move an unpaid checkout order to `to_ship` nor cancel a checkout order outside the staff cancel; "Proses" of a stock-short paid order clears `stock_short_at_payment` in the same update. Emails: `dueOrderEmails` sends `cancelled` for staff cancels (`admin_unpaid`: nothing charged, "Pesan lagi"; `admin_paid`, only when paid before the cancel: full refund incl. ongkir, WhatsApp follow-up, no "Pesan lagi"); the cron pass sends it. apps/admin: `lib/payments/provider.ts` (`MIDTRANS_*` / `DEPLOY_ENV` like apps/web, `PAYMENT_PROVIDER=fake` only in e2e; fails closed: unpaid web orders cannot be cancelled without it), `/orders` payment badge + "Perlu dicek (N)" tab (`?status=perlu-dicek`, `cardinality(needs_attention) > 0`), order detail for checkout orders: "Perlu dicek" panel (each flag with its meaning, "Catat dana dikembalikan", "Tandai beres"), web-aware actions ("Proses" only when paid, "Batalkan pesanan" / "Batalkan dan kembalikan dana" with a confirm), Pembayaran (status, method, paid time, every attempt with transaction id, gateway status and refund), Pengiriman (service, weight, destination, ongkir kurir and subsidi for `finance.view_profit` only, dibayar pembeli, quote time, courier and resi), Kontak dan alamat (snapshot), Voucher dan email (`order_notifications`), the "item dan ongkir tidak bisa diubah" note (no edit UI existed; `updateOrderItems` already refuses). `/packing`: quoted service per web order, "Tanpa kartu", web orders never printed (server refuses minting a card for a checkout order; no "belum ada kartu" warning; sticker preview ignores them), "Tandai dikirim" courier prefilled with the service. apps/web: the paid-then-cancelled wording on the order and finish pages now fits a staff cancel too. Tests: `payments/staff.test.ts` (guards, manual orders unchanged, Proses, cancel unpaid with no transaction / pending (expired at the gateway) / paid meanwhile / unknown status / unreachable / deadline / no provider, cancel paid and stock short, late payment after a staff cancel, refunds incl. a duplicate payment, flags; committed races: **staff cancel vs settlement notification** (both outcomes seen, never a mix), **two staff clearing a flag**, two cancels and two refunds at once), `emails.test.ts` (due rules, both templates, late payment then refund stays `admin_unpaid`), admin `orders/queries.test.ts`, `packing/queries.test.ts`, `e2e/checkout-orders.spec.ts` (390/1280: filter and badges, packing service and card-free rows, paid cancel then refund, unpaid cancel, Proses, Tandai beres; orders seeded in `global-setup.ts`) | none | TDD payments + admin e2e 390/1280 | database, security, typescript, silent-failure-hunter, react (no Critical; High/Medium fixed: a late payment after a staff cancel could later send the paid-cancel email; "Tandai beres" could hide money owed; non-ended gateway statuses were reported as paid; no overall gateway deadline; log fields and the step that failed; unknown payment state on the paid path; per-button spinners, focus after the panel closes, hint when web orders are skipped for printing, refresh after a refused refund) |
| 17 | **DONE 2026-10-21** (code, tooling and runbooks; the sandbox run and the launch are the owner's, by the runbooks). Launch readiness (was 15). Runbooks in **`docs/launch/`** (owner's choice of folder over `docs/runbooks/`): `checkout-dev.md` (sandbox keys on dev, Cloudflare Access bypass / Bot Fight Mode / cache / log checks, cron, store data, flag on, the §13 manual checklist, rollback, and a proposal for zone-level AOP on dev, which uses Global AOP today), `checkout-prod.md` (part 1: deploy 0030 to 0033 flag off with backup, `restore-drill-local.sh --migrate`, verification and rollback; part 2: Midtrans production, Biteship Grow, cron secret, settings, legal pages, a real refunded payment through a Midtrans payment link; part 3: launch day flag on, revalidation through Konten → Pengaturan → Simpan, smoke test, monitoring, rollback), `legal-drafts.md` (Kebijakan Privasi and Syarat & Ketentuan per §11.1, no gateway or provider names, no city). Code: `@ammari/commerce/deploy-env` (`readDeployEnv`: one `DEPLOY_ENV` allowlist for payments and shipping; the shipping guard was a denylist, so `prod`/`Production` let a Biteship test key run in prod). Tooling: `deploy/set-env-var.sh` (sets one env key from stdin or a hidden prompt, never prints a value, refuses `NODE_ENV`/`E2E_TEST_LOGIN`; `--check`, `--same`; synced to the dev server; `deploy/tests/set-env-var.test.sh`), `deploy-prod/recreate-active-slot.sh` (**fixes a real gap**: `docs/deploy-prod.md` §3.2/§3.4 recreated the web slot with a bare `docker compose up --force-recreate`, which drops the floating `web` alias that `remote-deploy.sh` attaches with `docker network connect`, so cron and admin revalidation would have broken after any env change, the launch flip included; reproduced and fixed on a local copy of the compose layout; runbook sections updated), `go-live-check.sh --checkout=off|ready|live` (checkout config by state/kind/match only, fake providers and order-id prefix refused, cron log, internal alias, `cron.env` in the forbidden-key check). Env examples: checkout variables (names only) in `deploy*/env/{web,admin}.env.example` and `apps/web/.env.example`; `DEPLOY_ENV` in both admin examples. Footer chips were already done (no "Kartu kredit"). | none | unit (deploy-env, shipping config) + bash tests (`set-env-var`, bash 3.2 and 5.2) + local compose harness for `recreate-active-slot.sh` + manual checklist | security, silent-failure-hunter (no Critical. Fixed: runbook key checks that printed STOP but kept going, now positive-prefix `&&` chains; flag flips and rollbacks chained with the flag verified on Mac and server; the config-log check ran before anything had been logged; `--checkout=live` could pass without seeing the cart (`/cart`, `/checkout` now checked, skips fail in live); the web alias is re-attached before the health wait, cron verified running/idle after a recreate; `set-env-var.sh` refuses symlinks, compose-special characters, `PAYMENT_PROVIDER`/`SHIPPING_RATE_PROVIDER` and a `DEPLOY_ENV` typo, and reads `export`/indented lines; the remote env reader reads like compose (last line, quotes); Midtrans key kind positive (`Mid-server-`); `prodsql` read-only by `PGOPTIONS`; Mac and server env copies compared before the first upload; loose prod key files deleted; dev Global-AOP wording corrected) |

Sessions 7 and 8 can overlap only in their pure parts (8's DB-touching code needs 0031); 14 can run
any time after 13. **Renumbering 2026-10-21:** old 7 to 15 are now 9 to 17 (add 2). Code comments
written before then (e.g. `packages/commerce/src/cart/cart.ts` "placeOrder in session 7",
`stock/reservations.ts` "session 9" for the payment webhook) use the old numbers; the session
notes below are already renumbered. Schedule risk: two more sessions inside the ~20 Nov target;
sessions 7 and 8 are small; if session 10 is not done by ~10 Nov, raise it with the owner then.

### Sandbox fixes, round 2 (2026-10-21, owner's dev sandbox run with the flag on)

No migration. All behind the cart flag except the resi rule, the greeting, the account name and the
stale-deploy handling.

1. **Resi (bug).** Root cause: bulk "Tandai dikirim (N)" on /packing shipped a web order with no
   dialog at all (and the per-order dialog marked the resi "Opsional", the server accepted both; the
   email then fell back to the quoted service label, hence "Kurir J&T Reguler" only). Now
   `@ammari/commerce/shipment-details` `parseShipmentDetails`: a web checkout order needs courier and
   resi (`[A-Z0-9-]{6,40}`, spaces dropped, upper-cased), checked in `transitionOrderStatus` before
   any side effect; manual and marketplace orders keep both optional (free text, capped at 60 / 100).
   Bulk refuses web orders before anything ships and the UI leaves them out of the count;
   `updateShipmentDetails` (order row lock, audit `update_shipment_details` with old/new values only)
   backs "Tambah resi" / "Ubah resi" in the order page's new "Resi" section (shipped or completed,
   any channel); the order page's "Dikirim" for a web order opens the same dialog
   (`apps/admin/src/components/orders/shipment-details-dialog.tsx`). `dueOrderEmails` sends
   `shipped` only once the order has a resi; an unsent `shipped` row of a resi-less shipped order is
   never superseded, and the cron pass logs `waitingForResi`. An already-sent email is not resent
   after a correction (the order page shows the current resi). Manual and marketplace orders were not
   affected by the bug (resi optional by the owner's own rule, and they get no emails).
2. **"Menunggu pembayaran" reminder.** `lib/checkout/pending-order.ts`: the visitor's newest payable
   checkout order (status awaiting_payment, payment pending, inside its window) through the session
   visibility rule or the checkout cookie's token only. Shown on /cart and /checkout (server-rendered)
   and on the product pages of its items (client fetch of `GET /api/checkout/pending-order`,
   `private, no-store`, flag-off 404, since PDPs are ISR) with "Lanjutkan pembayaran", "Ganti metode
   pembayaran" and "Lihat detail pesanan". No stock counts. The checkout cookie is now
   `ammari_checkout_order_v2` on path `/` (was `ammari_checkout_order` on `/checkout`): the reminder
   and its "Ganti metode pembayaran" need it outside /checkout; a new name because a same-name cookie
   on the old path would shadow the new token (security review). The old name is still read as a
   fallback (it expires within 7 days).
3. **Saved address.** `placeOrder` saves the order's address as the session customer's single default
   `customer_addresses` row (one `INSERT ... ON CONFLICT (customer_id) WHERE is_default DO UPDATE`,
   last step of the order transaction, under a savepoint that drops only 22xxx/23xxx data errors;
   never for a guest). `/checkout` (session only) shows it as a card with "Ganti alamat" (normal
   form, prefilled; "Pakai alamat tersimpan" goes back) and quotes its area afresh on arrival;
   placeOrder quotes again as always. Follow-up: a way for the buyer to delete the saved address
   (the privacy draft lists deletion of saved addresses as a right; today only by request).
4. **"Beli sekarang"** (flag on): primary "Beli sekarang", outlined "Tambah ke keranjang", small text
   link "Tanya via WhatsApp". Decision: it checks out the **whole cart** (simpler and safe: the buyer
   sees every line on /checkout before paying, no second cart or checkout mode). `ensureCartItem`
   adds one piece only when the cart lacks the SKU, so a repeat tap never stacks a second piece.
   Flag off: unchanged (WhatsApp primary).
5. **Stale deploys.** `lib/stale-deployment.ts`: an `UnrecognizedActionError` (Next's reply to an
   action id the new build does not know) or a lost chunk shows "Halaman sudah diperbarui. Coba
   lagi." and reloads once (30 s loop guard; a manual-reload message after that). New `app/error.tsx`
   and `app/global-error.tsx` (there was no root boundary: that was the blank page), the segment
   boundaries and every call site with its own catch. Next 16's `deploymentId` / `NEXT_DEPLOYMENT_ID`
   (docs: `next-config-js/deploymentId`) adds `?dpl=` to assets and turns navigations across a
   version change into full reloads, but it does not keep an old build's server actions working on a
   single replaced container (Next does not route by deployment), so it complements this handling,
   not replaces it. Not wired yet: it needs `ARG NEXT_DEPLOYMENT_ID` in `apps/web/Dockerfile` and the
   commit SHA as a build arg in both deploy workflows (owner's call).
6. **Account name.** /account shows the name with "Ubah nama" ("Isi nama" while it is the
   placeholder `CUSTOMER_PLACEHOLDER_NAME`, now exported by `@ammari/auth/customer`); the contact offer
   also offers the guest order's recipient name while the account has the placeholder (ticked by
   default, saved only with "Simpan", never over a name set meanwhile). Checkout never prefills the
   placeholder as the recipient.
7. **Greeting:** see §8 "Round 2".

Tests: commerce (lifecycle, emails, cart, placeOrder), web (pending order, saved address, name,
stale deployment, PDP, checkout form, contact offer), e2e `apps/web/e2e/checkout-return.spec.ts`,
`account.spec.ts`, `apps/admin/e2e/checkout-orders.spec.ts` (two new seeded orders `ship`,
`noresi`).

Notes from session 17 for later sessions:
- **Owner, before 1 Mar 2027:** the privacy policy draft promises the 90-day anonymization of
  unpaid checkout orders (§11); build that job before the first launch orders reach 90 days, or
  change the sentence.
- **Allowlist check:** run the opt-in Biteship contract test with the Grow account (six couriers
  active) and compare the printed service codes with `SHIPPING_SERVICE_ALLOWLIST`; a mismatch is a
  code change in `shipping/rules.ts` before launch.
- **Packaging allowance** (`SHIPPING_PACKAGING_GRAMS`, 100 g) and the Snap `other_qris` window (60
  vs 15 minutes) are confirmed only by the owner's dev run (`checkout-dev.md` G1, G9).
- `deploy-prod/cloudflare/README.md` §2 still says the zone-level toggle is OFF; prod could not
  serve through Caddy's `client_auth` with our CA if that were true, and `go-live-check.sh`
  proves the boundary; correct the README once the owner confirms in the dashboard.

Notes from session 16 for later sessions:
- **17 (launch):** apps/admin needs `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION` and `DEPLOY_ENV` in
  `deploy*/env/admin.env.example` and on dev/prod (same values as web; `DEPLOY_ENV=production` with
  `MIDTRANS_IS_PRODUCTION=true` in prod), otherwise staff cannot cancel unpaid web orders (they get a
  message; paid orders work). Only `apps/admin/.env.example` lists them so far. Staff cancel emails go
  out through the cron email pass (5 minutes), so `INTERNAL_CRON_SECRET` must be set for them too.
- **Known and accepted (reviewers, Medium):** an unpaid attempt the gateway does not know yet (buyer
  never picked a method) is not closed at the gateway; if the buyer still pays on that page after the
  staff cancel, the order is `paid_after_cancel` + `refund_due` (the confirm dialog says so). The same
  window exists for the sweep. A refund is recorded as the attempt's full amount on the staff
  member's word (note in the audit log); nothing checks the bank transfer.
- **Reviewer notes not fixed (Low):** the `checkoutCancelByStaff` option of `transitionOrderStatus` is
  a plain option (only `cancelUnpaidCheckoutOrder` and the paid cancel pass it; the admin action never
  does); staff can still mark a checkout order `returned` without a refund flag (returns follow the
  returns page, as today); `getOrderDetail` reads the order row twice; bulk "Tandai dikirim" sets no
  courier (same as manual orders).
- **K2/K4:** the order page's "Pengiriman" section is where the booking and the actual cost go.

Notes from session 15 for later sessions:
- **16 (admin):** staff can see every order; nothing in admin changed. The order page's "Lacak
  pengiriman" shows `orders.courier` + `tracking_number` from "Tandai dikirim" (falls back to the
  quoted service label when the courier field is empty).
- **17 (launch):** before deploying session 15, check that no `order_notifications` row of kind
  `cancelled` is unsent (`sent_at IS NULL`) on that environment: its retry renders the new "Pesan
  lagi" email, Resend answers the changed payload with a conflict and the row is recorded as
  permanent (no real Resend key is on any server yet, so none should exist). Cloudflare logs may
  keep full URLs (the `?t=` of the first hop); check the zone's logging settings; Caddy has no
  access log configured.
- **K4 (tracking UI):** the "Lacak pengiriman" block on `/orders/[orderNo]` is where the
  `shipment_events` timeline goes.
- **Reviewer notes not fixed (Low, owner's call):** the `order_view` limit counts every cookie
  page render per IP (60/10 min; shared CGNAT could hit it); "Pesan lagi" messages tell "Habis"
  from "Stok tidak cukup" (same as the PDP add); the finish page looks the order up twice;
  `addLinesToCart` does a few queries per line under the cart lock (at most 20 lines); a token
  route refusal is not logged (on purpose, no oracle), so a mass failure of email links would only
  show as buyers asking.

Notes from session 14 for later sessions:
- **15 ("Pesanan saya"):** switch the login link's landing page to `/orders` in both places
  (`createCustomerAuth` `orderLoginLink.successPath` default and apps/web `lib/auth/login-link-paths.ts`
  `LOGIN_LINK_SUCCESS_PATH`), with `LOGIN_FOR_ORDERS_HREF`. The `/orders/<orderNo>` page should send
  `frame-ancestors 'none'` too.
- **Reviewer notes not fixed (Low, owner's call):** anyone can place a guest order with someone's
  email, so (a) each of its emails supersedes that person's live link and counts toward the cap (they
  keep OTP login), and (b) the /account offer can show a stranger's number (only saved when the owner
  presses "Simpan"; the card asks whether it is theirs). A retried email whose first attempt's link was
  superseded meanwhile carries that dead link (kept on purpose: changing the payload would make Resend
  refuse the retry). The audit row is written after the session (best effort, logged if it fails).
  `customer_login_links` FKs are `ON DELETE RESTRICT`: a future account deletion must delete the
  customer's links first.
- **17 (launch):** confirm Resend click tracking is off for the sending domain (it would rewrite the
  login link through a third-party redirector); the origin must accept only Cloudflare traffic (the
  login POST's rate limit and `consumed_ip` trust `CF-Connecting-IP`). Privacy policy §11.1 item 4
  already describes the 24-hour link.

Notes from session 13 for later sessions:
- **14 (login link):** fill `CustomerOrderEmailView.loginUrl` for guest orders (`placed_with_session =
  false`) in `dispatch.ts` `prepare()`; the templates already render "Masuk ke akun" when it is set.
  Derive the raw link token from the notification id like `deriveOrderEmailAccessToken` (own purpose
  label), or the retried payload changes and Resend refuses it as a conflict (recorded as permanent).
  Issuing a link supersedes the live one, so issue it once per notification row (insert keyed by the
  derived hash, `ON CONFLICT DO NOTHING`).
- **15 ("Pesanan saya"):** the emails already link `/orders/<orderNo>?t=<token>` (404 until then).
  The page must send `Referrer-Policy: no-referrer` (metadata and header), move the token to the
  order-scoped cookie and redirect to a token-free URL before rendering anything else, load no
  third-party assets, and keep the query string out of logs (security review, session 13). "Belanja
  lagi" in the cancelled email goes to the homepage; switch it to "Pesan lagi" when that exists.
- **16 (admin):** staff cancels (`cancel_reason = 'admin'`) send no email yet (`dueOrderEmails`); add
  the wording there. A stock-short order processed by staff gets no second paid email (owner decision
  2026-10-21: the short note was its `paid` email; the next one is "sudah dikirim"). Showing
  `order_notifications` (sent / error) on the order page would help staff answer "I got no email".
- **17 (launch):** `ADMIN_SITE_URL` in both web env files (optional); `store_settings.support_email`
  set in admin before launch (owner emails wait with a warning until it is); check `docker compose
  logs cron` shows `/api/internal/emails/dispatch -> 200`. The local `apps/web/.env` has a Resend key,
  so a local `pnpm dev` checkout sends real order emails to whatever address is typed.
- **K3 (tracking):** `delivered` has no template or due rule yet; add both with the Biteship delivered
  event. Biteship picked-up/in-transit moves the order to `shipped`, which the cron pass already turns
  into the `shipped` email.

Notes from session 12 for later sessions:
- **13 (emails):** a sweep expiry is a `cancelled` email too: `sweepExpiredPayments` returns per
  order only the order number and the outcome (`expired` from the gateway or locally); hook the
  email where the route has them (or return the order ids), never inside the sweep's transaction.
- **15 ("Pesanan saya"):** §6.3's lazy finalize of the customer's own stale orders on `/account` /
  `/orders` was not built; the 5-minute sweep plus the finish page's `confirming` state cover it.
  Add it there only if buyers see "Menunggu pembayaran" too long. **Session 15: not built (decision
  41);** past-window orders show "Menunggu konfirmasi pembayaran" on the order pages.
- **16 (admin):** admin cancel of an `awaiting_payment` web order (§6.5) can use
  `provider.expirePayment` (or a cancel call) and `applyPaymentStatus` the same way the sweep does.
  `expired` attempts set by the local expiry have no `last_status` from the gateway (none existed).
- **17 (launch):** set `INTERNAL_CRON_SECRET` in `env/web.env` and `env/cron.env` on dev and prod
  (runbooks), check `docker compose logs cron` shows 200s; with `MIDTRANS_*` unset the sweep answers
  503 (logged as `ERROR` by the cron) until the keys are in. The 90-day anonymization of unpaid
  orders (§11) is still to build (owner decision 2026-10-21: not in session 12).
- **K3 (tracking poller):** add the daily poll as another call in `deploy*/cron/cron.sh` and a
  `CRON_JOBS` key in `@ammari/commerce/maintenance` for its lock.

Notes from session 11 for later sessions:
- **12 (sweeper, retention):** the sweep must fetch the status of **every** open attempt of an
  order (not only the latest: the finish page checks only the latest one), run it through
  `applyPaymentStatus`, and cancel through Midtrans (`POST /v2/{order_id}/cancel`; an expired order
  id may also be closed with `POST /v2/{order_id}/expire`) only when the gateway still says pending;
  then the state machine finalizes it. It must skip orders whose `payment_status` is `paid` while
  still `awaiting_payment` (stock short at payment): never release their holds or cancel them.
  Prune `payment_notifications` (12 months; unverified rows are already capped per IP but still
  accumulate) and the new `claim_rate_limits` actions `payment_status_check`, `payment_retry`,
  `payment_notification_unverified` (1 day). `revalidateProductPages` (apps/web
  `lib/payments/revalidate.ts`) after releases.
- **13 (emails):** hook `paid` and `owner_paid` after `applyPaymentStatus` returns `paid` (and
  `paid_stock_short`, with different wording for the owner), `cancelled` after `expired` /
  `cancelled`; the notification route is the natural `after()` place. Never fail the 200.
- **16 (admin):** show `needs_attention` flags with their meaning; "Proses" on a stock-short paid
  order is the existing staff `transitionOrderStatus(..., "to_ship")`, then clear
  `stock_short_at_payment` by hand. Admin cancel of a web order restores the voucher already
  (`transitionOrderStatus`); confirm with the owner that a paid, cancelled and refunded order
  should give the voucher back (plan §6.4 says any cancel). Show all payment attempts
  (`payments` rows) with `last_status`.
- **17 (launch):** Midtrans Sandbox dashboard: Payment Notification URL
  `https://<dev host>/api/payments/midtrans/notification` (and `MIDTRANS_NOTIFICATION_URL` per
  environment, since local cannot receive it), Finish redirect URL (callbacks.finish overrides it per
  transaction), enable exactly the 8 methods, no card. The Cloudflare Access bypass for exactly that
  path on dev. The rule that sandbox server keys start with `SB-` (production keys do not) came from Midtrans' key convention, not
  their docs, and **turned out false** (dev sandbox run, 2026-10-21): newer Sandbox accounts issue
  `Mid-server-` keys (35 characters) like production. The config now refuses only an explicit `SB-`
  key in production mode; the real protection is `MIDTRANS_IS_PRODUCTION` (tied to `DEPLOY_ENV`)
  plus Midtrans answering 401 to a wrong-environment key, logged as `keyRejected` (checkout fails
  closed). The runbooks verify a key with a status call for a non-existent order id (404 valid,
  401 wrong key or environment). Snap's `page_expiry` was not set (the token
  page lives 24 h by default; the transaction itself expires after 60 minutes); revisit if buyers
  reopen dead pages. `other_qris` has its own 15-minute default; confirm in the Sandbox that the
  Snap `expiry` (60 minutes) wins. The shipping config's `DEPLOY_ENV` check is still a denylist
  (session 11 made the payment one an allowlist).

Notes from session 10 for later sessions:
- **11 (payments):** the finish page reads only our DB; add the one server-side status fetch for a
  pending order (§4.4) there (`lib/checkout/queries.ts` `loadFinishOrder`, state `confirming` is
  the natural place). The fake payment page (`app/api/test/payments/[providerOrderId]`) only links
  back; if e2e should reach "Pembayaran berhasil", add a gated button that posts a correctly
  signed fake notification through the real webhook path, never a direct DB write. Validate the
  Midtrans `redirect_url` scheme in the provider adapter too (the browser already refuses
  anything but https or same-site, `lib/checkout/navigate.ts`). A pending order whose payment page
  could not be created shows "Halaman pembayaran belum bisa dibuka" with no retry button yet: a
  "create the payment page again" action belongs with the real provider (attempt numbering).
- **12 (sweeper, retention):** `claim_rate_limits` now also holds `shipping_quote` (per IP) and
  `shipping_quote_cart:<cart id>` under ip `0.0.0.0` (one row per quote); the 1-day prune covers
  them. Orders past the window stay `confirming` on the finish page until the sweep finalizes them.
- **15 ("Pesanan saya"):** the guest finish page's login link lands on `/account`
  (`LOGIN_FOR_ORDERS_HREF` in `lib/auth/login-prefill.ts`); switch it to `/orders`. "Pesan lagi"
  on a failed order is not built (the finish page links to the collection). The finish page shows
  a session customer only orders placed while logged in; guest orders linked by email stay behind
  the cookie or a login (the session 9 question for "Pesanan saya").
- **Saved addresses (owner decision 2026-10-21, session 10):** deferred. Needs: placeOrder (or a
  separate action) writing `customer_addresses` with the atomic default switch, the summary card
  with "Ubah" / "Ganti alamat" / "Perbarui alamat tersimpan", and the "Pilih ulang kecamatan" case.
- **17 (launch):** the per-cart quote limit can be sidestepped by starting new carts (bounded by
  `cart_create` 20/hour and the per-IP limits); the daily Rates budget is the real cap, so watch
  `budget_exhausted` logs after launch. Ensure `E2E_TEST_LOGIN` is in no deployed env file (it
  unlocks the fake providers and the `/api/test/*` routes behind Caddy's block).

Notes from session 9 for later sessions:
- **10 (checkout UI):** call `placeOrderAction` with a `checkoutAttemptId` generated once per page
  load (`crypto.randomUUID()`), `expectedTotal` from the shown summary and `voucherId` only for a
  session; on `ok` send the browser to `redirectUrl`, or to `/checkout/finish?order=<orderNo>` when
  it is null (provider failure, or a guest repeat without the cookie). `fieldErrors` use the
  address field names plus `contactEmail`, `contactPhone`, `termsAccepted`, `voucherId`, or a SKU
  for short stock; show them in the one alert. Run `parseShippingAddress` client-side first so a
  submit rarely fails validation. The finish page reads the `ammari_checkout_order` cookie (path
  `/checkout`, 7 days; hash it with `hashOrderAccessToken` and match `order_access_tokens` for that
  order, unexpired). Build the gated fake payment page at `/api/test/payments/<providerOrderId>`
  behind the same gate as the fixtures route (`NODE_ENV !== production` and `E2E_TEST_LOGIN=true`);
  it must never set "paid" itself from a browser request: it calls the same notification state
  machine (session 11) or only simulates the redirect back. Set `PAYMENT_PROVIDER=fake` in
  `playwright.config.ts`'s web server env. `announceCartCount(0)` after a successful order if the
  client stays on the page.
- **11 (payments):** **requirement (owner, 2026-10-21): the real unit cost must be locked when the
  order is paid.** The webhook must move the order with `transitionOrderStatus(..., "to_ship")`,
  which writes the `sale` movements and sets each `order_items.unit_cost` to the moving average at
  that moment (same as manual orders), and consumes the holds; never set `payment_status = 'paid'`
  through a separate path that skips it. Session 9 already tests this for a `placeOrder` order
  (`place-order.test.ts` "when the order is paid, unit_cost is locked ..."); session 11 must add the
  same assertion to its webhook test (`unit_cost` = moving average, holds `consumed`, `sale`
  movements written), including the "paid after release" case. `transitionOrderStatus` needs a
  null-actor path for it. Implement `PaymentProvider` for Midtrans in `@ammari/commerce/payments`
  (honour `input.signal`; map aborts/5xx to `PaymentProviderError("unavailable")`), add it to
  `paymentRuntimeFromEnv`, and map `buildPaymentLines` 1:1 to `item_details`. `payments.provider` is
  `midtrans` for fake attempts too: the webhook must trust only the signature + status re-fetch,
  never that column.
- **11/12 (cancel, expiry):** the voucher is `used` from order creation; every unpaid
  `-> cancelled` must restore it atomically (§6.4) with a test, and the sweeper must too.
  `revalidatePath` the products of released holds (`placeOrder` returns the slugs the same way).
- **14/15 (login, account):** a guest-created customer has no phone and no consent (§5 step 4,
  revised): after a verified login, offer to copy the latest order's `contact_phone` (only if free)
  and its `promo_opt_in` (with the consent wording again) to the account; the `/consent` gate already
  covers PDP consent. Guest orders typed with an existing customer's email link to that customer
  (plan as written; the security review notes anyone can make an order appear in someone's
  history): decide in session 15 whether "Pesanan saya" shows guest-linked orders only after the
  email was verified.
- **16 (admin):** `updateOrderItems` already refuses quoted orders with an Indonesian message; the
  admin UI should not offer item or ongkir edits on checkout orders at all.
- **17 (launch):** `PAYMENT_PROVIDER` and `CHECKOUT_*` minutes in the env examples; confirm
  Next's server action Origin check works behind Cloudflare/Caddy (forwarded Host) on dev.

Notes from session 8 for later sessions:
- **9 (placeOrder):** build deps with `getShippingRuntime()` (apps/web `lib/shipping/runtime.ts`; null means "Ongkir belum
  bisa dihitung"). `quoteShipping(db, runtime, { areaId, lines })` returns typed refusals; map `unavailable`,
  `bad_response`, `budget_exhausted` to the §4.5.5 retry message, `no_service` to the WhatsApp message,
  `missing_weight` to its message, `unknown_area` to "Pilih kecamatan dari daftar.". Database errors propagate
  from `quoteShipping` by design: catch them in the action and show the retry message. Load the area with
  `loadShippingArea`, validate with `parseShippingAddress(input, area)` and write `toShippingAddressSnapshot`
  (v2); `orders.shipping_destination_id` = `quote.destinationId`. The admin e2e seed
  (`apps/admin/e2e/global-setup.ts`) still writes the old `REG` service code on its quoted order, harmless.
- **10 (checkout UI):** the combobox calls `GET /api/shipping/areas?q=` with an `AbortController` per keystroke
  (300 ms debounce, 3 characters), shows `label`, posts `id`, and shows the Kode pos input when
  `hasPostalCode` is false. Labels come from the provider's casing. The quote server action needs the
  `shipping_quote` per-IP limit (30/10 min) **and a per-cart limit** (security review: Rates is the scarcer
  budget, 300/day by default, and an anonymous caller can vary area and weight to miss the cache).
  `budget_exhausted` shows the same retry message.
- **12 (retention):** prune `shipping_rate_cache` older than 7 days (`fetched_at` index exists) and
  `claim_rate_limits` (1 day, includes `shipping_maps` / `shipping_rates`; the probabilistic cleanup only runs
  from per-IP writes). Each area search rewrites the returned `shipping_areas` rows (`last_synced_at`); accepted
  for now (review note), revisit with `IS DISTINCT FROM` if the table gets hot.
- **17 (launch):** `DEPLOY_ENV=production` must be set in the prod web env (the test-key guard and robots use
  it); confirm the origin only accepts Cloudflare traffic (per-IP limits trust `CF-Connecting-IP`); run the
  contract test once with the test key and adjust the allowlist to the codes it prints (JNE `reg`, POS
  `kilat_khusus` and AnterAja are the ones to watch); set `BITESHIP_ORIGIN_AREA_ID` from a Maps search for the
  shop's own kecamatan and kode pos; activate the six couriers in the Biteship dashboard (Grow allows 10).
- **K1/K2:** the label API question and the webhook header secret (§15 "What to confirm with Biteship").

Notes from session 7 for later sessions:
- **8 (rates, area search):** import the constants from `@ammari/commerce/shipping` (add the
  server-only rate code there; keep the constants file free of server-only if a client needs it).
  Upsert areas with `ON CONFLICT (komerce_destination_id) DO UPDATE` (`provider_area_id` since
  migration 0032, D18) and always write `label` and
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

### Phase K: Biteship courier booking and tracking (required; Komerce until 2026-10-21, D18)

Not a launch blocker for 1 Dec (manual courier + resi and manual "Selesai" cover the gap), but
required: target live within the first weeks of December. **Prerequisite: the Biteship account
on Grow with the live Order API activated** (live keys need an activation request; test keys have
the Order API on by default, simulated without pickup). No separate plan or key: the same
`BITESHIP_API_KEY` session 8 uses for Maps and Rates. **Breakdown confirmed by the owner
2026-10-22** with decisions 46 to 51 (§16).

| # | Session | Migration | Tests / reviewers |
|---|---|---|---|
| K1 | **DONE 2026-10-22.** Order client, fake, shipment config, Code 128 and our own label (as built below). | none | TDD; typescript, security, silent-failure-hunter |
| K2 | **DONE 2026-10-22** (as built below). **0034:** `shipments` per §3 (attempts, partial UNIQUE for the one live shipment, `reference_id` UNIQUE, `provider_order_id` UNIQUE NULL) and the `shipping_cost_over_quote` flag. `@ammari/commerce` booking: `bookShipment` (transaction: lock the order, paid web order in `to_ship` with a quote, no live shipment, insert the attempt `booking`; outside any transaction `createShipment`; transaction: store id, waybill, tracking id, price, status; `failed` only on a clear refusal), `recheckBooking` (re-sends the **same** reference: booked now, or `duplicate_reference` recovered through `existingOrderId` + `getShipment`), `cancelShipment` (before pickup only; the attempt ends `cancelled`, a new attempt may follow). Destination from the order's snapshot (recipient, phone, street line, courier note) and `shipping_destination_id`; one item "Pakaian" with the goods value and `shipping_weight_grams`; never the buyer's email. Admin: **"Pesan kurir"** on the `/packing` row and the order page, "Cek ulang pemesanan", "Batalkan pengiriman", "Cetak label" (the K1 PDF, one page per order), "Pengiriman" with booking, pickup state ("Menunggu kurir" / "Kurir menuju lokasi" / "Sudah dijemput"), driver when sent, the cut-off hint, actual cost next to the quote (`finance.view_profit`). Permission `orders.manage` (no new key). Manual resi path unchanged. Env examples and `set-env-var.sh` (refuse `SHIPPING_ORDER_PROVIDER`). | 0034 | TDD, committed race (two "Pesan kurir" at once: one booking), admin e2e 390/1280 with the fake; database, security, react |
| K3 | **DONE 2026-10-22** (as built below). **0035:** `shipment_events` (UNIQUE `(shipment_id, occurred_at, provider_status)`) and `shipping_webhook_events`. Webhook route in apps/web (path token + header secret, always 200, debounced re-fetch, §"Webhook vs polling"), `applyShipmentSnapshot` (status mapping below, `order.price`, waybill changes, both flags), poller route + `CRON_JOBS` key + the 3-hour block in both `cron.sh`, `delivered` email template and due rule, 12-month retention for webhook events, gated fake "advance shipment" test route posting through the real webhook route. | 0035 | TDD + replay, out-of-order, concurrency; security, silent-failure-hunter, database |
| K4 | Buyer timeline in the "Lacak pengiriman" block (`/orders/[orderNo]`, latest on top, courier names only, never the provider's name), admin timeline, manual fallback polish (manual resi vs booked waybill), e2e both apps 390/1280. Runbook `docs/launch/shipping-dev.md`: env values to set (shipper, prefix, budget, webhook token and header secret), test webhooks, the two activation test orders (one delivered through Update Status, one cancelled through our "Batalkan pengiriman"), **print a label on the thermal printer at 100% and scan its barcode with a phone**, then go live. | none | react, e2e 390/1280 |

**K1 as built (2026-10-22).** `@ammari/commerce/shipment-rules` (pure, client-safe):
`BITESHIP_ORDER_STATUSES`, `canonicalBiteshipStatus` (camelCase, upper case, spaces and hyphens to
the documented snake_case; anything else null), `normalizeBiteshipStatus` (mapping below; unknown
is null, never a state), `BITESHIP_CANCELLABLE_STATUSES`, `BITESHIP_FINAL_STATUSES`,
`shipmentReferenceId(prefix, orderNo, attempt)` (`<prefix><order_no>-K<attempt>`, attempt 1 to 99),
`toBiteshipPhone` (`+628...` to `08...`), `SHIPPING_PICKUP_CUTOFFS` / `pickupCutoffFor` (WIB:
JNE 14.00, J&T 15.59, SiCepat 17.00, AnterAja 14.00, ID Express 15.00, POS 16.00; hint only),
`SHIPPING_COST_OVER_QUOTE_THRESHOLD` (5.000) / `isShippingCostOverQuote`. `@ammari/commerce/shipping`
(server-only): `ShipmentProvider` (`createShipment`, `getShipment`, `cancelShipment`) and
`ShipmentProviderError` (`unavailable`, `refused`, `duplicate_reference` with `existingOrderId`,
`not_found`, `not_cancellable`, `bad_response`, `budget_exhausted`; `outcomeUnknown` on any write
(booking or cancel) whose answer was lost or unreadable: timeout, network error, 5xx, an unreadable
2xx, a 4xx without Biteship's error envelope; `logFields()` never carries the body); `createBiteshipOrdersClient` (`biteship-orders.ts`: `delivery_type: now`,
`origin_collection_method: pickup`, shipper = origin = Ammari, one `fashion` item, no email,
insurance or COD; bookings and cancels never retried, reads retried once on network error/5xx;
timeouts 15 s / 15 s / 10 s; 401/403/404/408/425/429 unavailable; `refused` only for Biteship's
own envelope (`success: false` + numeric code, a numeric string accepted); 40002060 duplicate,
40002053 not cancellable, 40002054 to 56 retryable; free text cleaned to one line and capped
before it is sent; lenient parsing: only `success` and `id` required, odd fields null and logged
by field name (never the value), undocumented statuses logged as sent, history rows parsed one by
one, a time without offset read as WIB, sorted oldest first, https links only; a booking answer
naming another reference, or any answer for another order id, is a bad response; a malformed
stored id is a RangeError, never `not_found`; a failed budget record is `unavailable`); `canceled` is read as `cancelled`; `createFakeShipmentProvider` (`fake-shipments.ts`: in-memory, process-wide store,
unique references, waybill `E2E` + 13 digits, quoted fake-area price, cancel only before pickup,
controls `advance` / `setPrice` / `setWaybill`; "Kecamatan E2E Gangguan" books but loses the answer
once, "Kecamatan E2E Tanpa Layanan" is refused); `shipmentRuntimeFromEnv` (`shipment-config.ts`,
§12; shares `readBiteshipConnection` with the rate runtime, now in `biteship-env.ts`); budgets
`shipping_orders` (reads, default 60) and `shipping_order_writes` (200) in `budget.ts`
(`ShippingBudgetKind`). Opt-in `biteship-orders.contract.test.ts` (`BITESHIP_CONTRACT_TEST=1` and
`BITESHIP_ORDER_CONTRACT_TEST=1`, test key only: book, re-send the reference (must be a duplicate
naming the same order), read, cancel, read; prints what Biteship returns; never run in this
session). apps/admin `lib/shipping/code128.ts` (hand-written Code 128, sets B and C with the usual
switching rule, check symbol; refuses non-printable ASCII) and `lib/shipping/label-pdf.ts`
(`planBarcode`: module 4, 3 or 2 printer dots at 203 dpi, the widest that fits, bars on the dot
grid, quiet zones of 10 modules inside 4 mm margins, 16 mm bars, `LabelBarcodeError` (`invalid`: not 1 to 40 printable ASCII without spaces, since the
barcode must encode the stored waybill exactly, never a cleaned copy; `too_long`);
`layoutShippingLabel` returns the draw operations and **warnings** (`characters_replaced`,
`recipient_name_cut`, `recipient_address_cut`, `recipient_area_cut`, `sender_cut`, `note_cut`):
courier label, routing code, order number, "NON COD", barcode and the same waybill text (shrunk to
fit), "PENERIMA" (name, phone, street at 8 pt in 4 lines or 7 pt in 5 before anything is cut, area
line), "PENGIRIM", "Berat 1,4 kg Isi: Pakaian x N", "Catatan"; WinAnsi-safe text (smart quotes and
dashes as ASCII, invisible characters dropped, other scripts "?" with a warning, capped at 500);
weight and pieces must be positive whole numbers; `buildShippingLabelPdf` returns `{ pdf, warnings
}`, one 120 x 100 mm page per label; `shippingLabelPdfFilename`). Shared: `readBiteshipConnection`
now also refuses a path in `BITESHIP_BASE_URL`; the shipment config refuses `DEV-` / `LOCAL-` /
`E2E-` / `CT-` / `TEST-` as the reference prefix in production; the budget fails closed on an
unreadable count. Tests: `shipment-rules.test.ts`, `biteship-orders.test.ts`,
`shipments.test.ts` (fake, runtime, budgets on the test database), `code128.test.ts` (table length,
widths, bar/space parity, uniqueness, known symbols, hand-computed values, round trip through an
independent decoder), `label-pdf.test.ts` (dot grid, quiet zones, step-down, refusal, contents,
everything inside the page, wrapping, odd characters, warnings). **Barcode checked outside the
suite:** labels for six waybills (16 digits, letters + digits, hyphens, 32 letters at 2 dots, an
odd digit count, 30 wide letters) rasterized at 203 dpi to pure black and white and decoded by
macOS Vision: all six read back exactly. Reviews (typescript, security, silent-failure-hunter):
no Critical; fixed: a duplicate reference hidden by an odd error body could read as "not booked"
(now `refused` only for Biteship's own envelope, anything else `outcomeUnknown`), a waybill with
odd characters printed as a different barcode, cancels with a lost answer, strict parsing of
`courier` / notes / `code`, silent nulls, smart quotes printed as "?", silent truncation on the
label, `wrapText` loop guard, prefix rule in production, base URL path, budget NaN. The printed check on the real printer and a phone stays in the K4 runbook.

**K2 as built (2026-10-22).** Owner decisions this session: (52) a resi staff type that differs
from the booked waybill raises a new flag **`tracking_number_mismatch`** ("Resi beda dengan pesanan
kurir"), added to the CHECK in 0034 with `shipping_cost_over_quote`; (53) **the admin renders any
unknown flag safely from K2 on** and both new flags are written from K2 (a dev rollback to the K1
image would show its error page for an order carrying one; prod's image predates
`needs_attention`, so a prod rollback is safe). Rollback check done: apps/web never reads
`needs_attention`, the admin list only counts flags, the K1 order page threw on an unknown flag.
- **0034 `shipments`** (`packages/db/src/schema/shipments.ts`, `SHIPMENT_STATUSES` =
  `booking` / `failed` + the normalized tracking states): one row per attempt, UNIQUE `(order_id,
  attempt)` (1 to 99), partial UNIQUE `shipments_live_order_id_key` on `order_id` where status is
  not `cancelled` / `failed`, `reference_id` UNIQUE, `provider_order_id` UNIQUE NULL (required
  once booked), `provider_tracking_id`, `courier`, `service`, `awb`, `routing_code`,
  `tracking_link`, `cost_amount`, `status`, `provider_status`, `last_error` (reason and code only),
  driver name / phone / plate, `booked_at`, `picked_up_at`, `delivered_at`, `cancel_requested_at`,
  `cancelled_at`, `failed_at`, `last_polled_at`, `last_event_at` (K3), booked / cancelled by staff,
  timestamps; CHECKs for the state consistency; poller index for K3. Hand edits: header and
  `lock_timeout`. `migration-0034.test.ts` (upgrade from 0033 with a flagged order, every rule, K1
  writes, idempotent re-run); applied fresh, to a copy of local `ammari`, then to local `ammari`.
- **`@ammari/commerce/shipping` `bookings.ts`:** `bookShipment` (order lock, paid web order in
  `to_ship`, no live attempt, attempt reserved `booking`, provider called outside any transaction,
  then stored under the order lock), `recheckBooking` (a `booking` attempt re-sends the same
  reference: booked, or the duplicate adopted only when its reference is ours; a re-send never ends
  the attempt: a refusal, a duplicate without an order id or with another reference, or an order
  that moved on (shipped by hand, cancelled) leaves it "perlu dicek manual" with the reference id;
  a booked attempt is read again), `cancelShipment` (before pickup only; a lost or 40002053 answer
  is read first; the attempt ends and attempt N+1 may follow), `refreshShipmentForLabel` (one read
  when the routing code is missing; a failed read becomes a label warning). Never a status moved
  backwards and never an ended attempt revived by a late read. Over-quote flag on every price change
  (decision 47). A booked order that fails to be stored keeps the attempt open (logged with the
  provider id) instead of reading as "not booked". Refusal messages: balance (40002039, 40009003),
  inactive key (40002002), budget, unavailable. Destination from the snapshot (name, phone, street
  line, note), one "Pakaian" item with the subtotal and the quoted weight; never the email.
  `orders/attention.ts` (flag set helpers, shared with payments). `transitionOrderStatus` /
  `updateShipmentDetails` flag `tracking_number_mismatch` when the resi differs from the live
  booking's waybill (and when shipping by hand while a booking is unsettled), and clear it when the
  resi matches again; a waybill arriving later is checked too. Staff cancel of a paid order is
  refused while a live booking exists ("Batalkan pengiriman dulu").
- **apps/admin:** `lib/shipping/runtime.ts` (`shipmentRuntimeFromEnv`, fails closed with variable
  names logged), `app/(shell)/orders/shipment-actions.ts` (`orders.manage`; cost stripped from the
  answer without `finance.view_profit`), `components/orders/courier-booking.tsx` ("Pesan kurir",
  "Cek ulang pemesanan", "Batalkan pengiriman" with a reason, "Cetak label" with the warnings
  dialog before the download; same base64 route as the stickers, helpers moved to
  `lib/client/pdf-download.ts`), `lib/shipping/label-data.ts`, `lib/orders/shipment-labels.ts`.
  /packing rows show the booking state and waybill; the order page's "Pengiriman" shows status,
  reference, waybill, pickup state, routing code, driver, actual cost next to the quote
  (`finance.view_profit`), the cut-off hint and earlier attempts. "Tandai dikirim" / "Ubah resi"
  prefill the waybill and warn on a different resi. Unknown flags get a generic copy and no "Tandai
  beres".
- **Env:** admin examples (local, dev, prod) list the shipment runtime names; `set-env-var.sh`
  refuses `SHIPPING_ORDER_PROVIDER`; the prod go-live check fails a fake `SHIPPING_ORDER_PROVIDER`
  in admin.env. Admin e2e runs `SHIPPING_ORDER_PROVIDER=fake`.
- **Tests:** `bookings.test.ts` (booking, refusals, over-quote, late price, lost answer and
  recovery, re-send rules, cancel paths, staff cancel guard, resi mismatch, stale reads, committed
  race: two "Pesan kurir" at once give one booking), `shipment-rules.test.ts`, admin
  `checkout-labels.test.ts`, `queries.test.ts`, e2e `courier-booking.spec.ts` (390/1280). Reviews:
  database, security, react, silent-failure-hunter; no Critical; High/Medium fixed (stale read
  reviving a cancelled attempt, re-send for an order shipped by hand, booking stored-failure read
  as "not booked", cost in the action answer, long error text in the table cell, label download
  errors, permanent provider faults shown as "try again").
- **Known, not fixed (Low):** two cancels at once both reach the provider (the second is settled by
  reading); `audit_log` rows carry the booked cost (like the order rows already logged; no audit
  viewer exists); the label refreshes only when the routing code is missing, so a waybill change
  after booking reaches the label once K3 applies `order.waybill_id`; a manually cleared
  `tracking_number_mismatch` stays cleared after a rebook.
- **For K3/K4:** apply the poller and webhook through the same stored-state rules (never backwards,
  never revive an ended attempt); flag `delivery_problem` for a cancel we did not ask for (now only
  logged as an error); the K4 runbook sets the admin env values below.

**K3 as built (2026-10-22).** Owner decisions this session: (54) **apps/web reads with its own
read-only runtime** (`trackingRuntimeFromEnv`: key, base URL, origin, `BITESHIP_DAILY_ORDERS_BUDGET`,
`SHIPPING_ORDER_PROVIDER`, the same test/live key rules as admin; no sender, no reference prefix in
web.env); (55) session rules confirmed with the plan: `delivery_problem` also for an undocumented
status, a waybill that fails the resi rule, a parcel moving for a cancelled order and a read that
keeps failing (not found, unreadable, another order); flags raised only on change; the "sudah sampai"
email only when the courier reported delivery (staff's own "Selesai" sends none); staff's "Cek
ulang" goes through the same apply path, so it can ship or complete the order too.
- **0035 `shipment_tracking`** (`schema/shipments.ts`): `shipment_events` (`provider_status` NOT NULL,
  `normalized_status` NULL for an undocumented status, `description`, `location`, `source` `webhook` /
  `poll` / `staff`; UNIQUE `(shipment_id, occurred_at, provider_status)`, FK restrict),
  `shipping_webhook_events` (`event`, `provider_order_id`, `shipment_id` FK set null, `payload jsonb`
  or `raw_text`, `body_bytes`, `processed_at`, `result`; index on `received_at` for retention), and
  on `shipments` `refetch_requested_at` (a webhook arrived while its read was debounced or failed) and
  `stale_flagged_at` (`tracking_stale` once per quiet spell). Hand edits: header and `lock_timeout`.
  `migration-0035.test.ts` (upgrade from 0034 with a booked shipment, every rule, K2 writes,
  idempotent re-run); applied to `ammari_test`, `ammari_e2e` and local `ammari`.
- **`@ammari/commerce/shipping` `tracking.ts`:** `applyShipmentSnapshot` (order lock, then shipment
  lock; history to `shipment_events` ON CONFLICT DO NOTHING; a read whose newest history entry is
  older than `last_event_at` only adds events; courier times more than 5 minutes in the future are
  clamped; never backwards along pickup, transit, delivered; delivered / returned / ended final;
  another provider order or reference refused; status mapping and flags per the table above;
  `to_ship -> shipped` with no staff actor, the quoted courier label and the waybill as resi, then
  `completed`; a refused move (or a constraint it trips) is a flag, never a rolled-back read; a new
  waybill follows a resi that came from the booking, a different staff resi is flagged; audit row only
  when something changed). `claimShipmentRead` (one conditional UPDATE: at most one read per shipment
  per 2 minutes, shared by webhook and poller), `readClaimedShipment` (budget and unavailable ask for a
  re-read and set `last_error` `read:<reason>`, shown on the admin order page; a permanent failure
  flags `delivery_problem` once), `refetchShipmentForWebhook`, `flagStaleShipments` (2 days no pickup,
  5 days no event; only orders in `to_ship` / `shipped`), `pollShipments` (re-fetch requests first,
  then waiting for pickup (unless its reads fail for good), then quiet over 6 hours; 100 a run, 150 s;
  stops at `budget_exhausted` and marks the rest; one shipment's DB error never ends the run).
  `webhook.ts`: `parseShippingWebhookBody` (only `event` and `order_id` read), `recordShippingWebhook`
  (a payload jsonb refuses is kept as text), `processShippingWebhook`. `shipment-config.ts`
  `trackingRuntimeFromEnv`; the fake's `adopt` control. Emails: `delivered` due rule
  (`deliveredByCourier`, an EXISTS on a delivered shipment) and `renderDeliveredEmail` ("Pesanan sudah
  sampai", link to `/returns-exchange`). Retention: `shipping_webhook_events` after 12 months.
  `CRON_JOBS` gets `shipmentPoll`. K2's bookings now apply every read through `applyShipmentSnapshot`.
- **apps/web:** `POST /api/shipping/biteship/webhook/[token]` (path token and static header from env,
  constant time, both always checked; always 200 "ok"; only authenticated posts logged, body up to 16
  KB; re-fetch and apply in `after()`, then the order's emails), `POST /api/internal/shipping/poll`
  (cron auth; 200, 503 not configured, 429 budget used up, 502 Biteship down, 500 a read failed),
  gated `POST /api/test/shipments/advance` (adopts the stored booking into web's fake, moves it,
  resets the debounce, calls the real webhook handler). Caddy unchanged (the path is not caught by the
  `/api/internal`, `/api/test`, `/api/revalidate` 404s); dev's Cloudflare Access needs a bypass for
  `api/shipping/biteship/webhook` (K4 runbook). Env names in the three web env examples.
- **cron:** both `cron.sh` (identical) call the poll at start and every 3 hours after the email pass;
  a call with no answer at all is retried after 10 minutes, any answer waits 3 hours.
- **apps/admin:** wider copy for `delivery_problem` and `tracking_stale`; "Pelacakan otomatis tertunda
  / gagal" under a live booking whose last read failed.
- **Tests:** `tracking.test.ts` (every mapping row, flags on change only, waybill rules, replay,
  out of order, no-history rank, future times, ended attempts, mismatch, claim and debounce, read
  failures, poll selection, budget stop, mismatch and DB-error robustness, stale flags; committed race:
  two webhooks, a staff read and a poll at once ship the order once), `webhook.test.ts` (parse, escaped
  NUL kept as text, re-fetch applies only Biteship's answer, replay debounced, unknown order),
  `shipments.test.ts` (tracking runtime, adopt), `emails.test.ts` (delivered rule, template, tracking to
  emails end to end), `retention.test.ts`, web route tests, `webhook-auth.test.ts`, web e2e
  `shipment-tracking.spec.ts` (390/1280: forged webhook changes nothing, picked to Dikirim with the
  waybill, delivered to Selesai).
- **Reviews** (security, silent-failure-hunter, database, typescript): no Critical. Fixed: a DB error on
  one shipment ended the whole poll (High), a read naming another order raised no flag (High), escaped
  NUL lost the webhook row, a future courier time froze the stale-read rule, refused moves on later
  reads were silent, a constraint error in a move rolled back the whole read forever, a permanently
  failing pickup read every run, cron losing a poll to a restart, secrets equal or placeholder-like,
  body cap 32 to 16 KB, stale flags on finished orders.
- **Known, not fixed (Low / by design):** the raw webhook payload (it may carry the courier driver's
  name and phone) is kept 12 months as the plan's retention says; authenticated posts are not rate
  limited (they need both secrets); one log line per refused post; the path token is in the URL, so
  Cloudflare and Biteship's Events Log see it (rotate token and header secret together: env first,
  then the dashboard); a read without history can still overwrite price, driver and waybill with
  older values (the status is protected by rank); a delivered shipment whose order move was refused is
  not read again (its `delivery_problem` flag is the signal; staff ship and complete by hand); a
  debounced webhook waits for the next poll (up to 3 hours); the K2 race test's leftovers in
  `ammari_test` were cleaned by hand once.
- **For K4:** the buyer timeline reads `shipment_events` (latest first, `description` is the courier's
  text: escape it, never in emails); admin timeline; runbook steps below.

Notes from K1 for later sessions:
- **K2 (booking safety):** any error with `outcomeUnknown` keeps the attempt `booking` (never
  `failed`, never a new attempt); only `refused` and `budget_exhausted` / `unavailable` without
  `outcomeUnknown` may end it. On `duplicate_reference`, read `existingOrderId` with `getShipment`
  and adopt it **only if its `referenceId` equals the one sent**. Without `existingOrderId` (no
  `details`) it cannot be recovered automatically: keep `booking` and show it as "perlu dicek
  manual" with the reference id. A RangeError from the client is our own data or code error.
- **K2 (cancel):** after `outcomeUnknown` or `not_cancellable`, read the order before telling staff
  anything: a cancel that worked but lost its answer is re-answered 40002053.
- **K2 (label):** show `warnings` before printing ("Sebagian teks di label dipotong atau diganti,
  cek sebelum dicetak"); `LabelBarcodeError` means "print Biteship's label from the dashboard". Print through the same
  base64 server-action route as the sticker sheets.
- **K2 (messages and price):** treat `refused` codes for balance (40002039, 40009003) and an
  inactive key (40002002) with their own Indonesian messages. A booked price can be null (not
  sent, logged by the client): store null, show "biaya belum diketahui" and let the next read fill
  it; the over-quote check runs when a price arrives.
- **K3:** use `knownStatus` for decisions and `providerStatus` for display; an entry with a null
  `status` is stored and flagged, never applied. Check the webhook's path token and header secret
  **before** spending the `orders` budget on a re-fetch. The budget counts every HTTP attempt (a
  retried read costs 2): treat `budget_exhausted` as "try again tomorrow" and make it visible (a
  log line per run and an admin hint), never as "no change". `BITESHIP_FINAL_STATUSES` decides what the poller
  stops reading. The fake's `controls` back the gated "advance shipment" route.
- **K2/K3:** the shipment runtime is not wired into either app yet; add the env names to the
  examples in the session that first reads them.

**Status mapping** (normalized `shipments.status`, decision 48's flags; K3 applies it):

| Biteship status | State | Order effect (K3) |
|---|---|---|
| `confirmed`, `scheduled`, `allocated`, `picking_up` | `pickup_requested` | none; no pickup 2 days after booking flags `tracking_stale` |
| `picked` | `picked_up` | `to_ship -> shipped` (no staff actor, courier + Biteship waybill as resi; the cron email pass sends "Pesanan dikirim") |
| `in_transit`, `dropping_off` | `in_transit` | same as `picked` when pickup was missed |
| `delivered` | `delivered` | `shipped -> completed` (through `shipped` first if needed), `delivered` email |
| `return_in_transit` / `returned` | `returning` / `returned` | flag `delivery_problem`, never an automatic `returned` (staff confirm; stock follows) |
| `on_hold`, `rejected`, `disposed` | `problem` | flag `delivery_problem` |
| `courier_not_found`, `cancelled` we did not ask for | `cancelled` | flag `delivery_problem`; the order can be booked again |
| unknown | stored raw, no state | flagged, never applied |

Also: a waybill change updates `shipments.awb` and `orders.tracking_number`; a waybill that fails
the resi rule (`[A-Z0-9-]{6,40}`) is flagged and the order not moved; no new event for 5 days on an
open shipment flags `tracking_stale`; a manual resi that differs from the booked waybill is flagged.

**Webhook vs polling** (decision 48). Biteship webhooks carry no body signature, are not retried,
and are registered in the dashboard. So:
- The webhook is a **hint only**: URL `/api/shipping/biteship/webhook/<BITESHIP_WEBHOOK_PATH_TOKEN>`
  plus the static header from the "Headers Signature Key / Secret" fields, compared in constant
  time; any POST answers 200 at once (an empty or odd body too); the payload goes to
  `shipping_webhook_events`; an unknown Biteship `order_id` is logged and nothing is fetched; a
  known one is **re-fetched with `GET /v1/orders/:id`, at most once per shipment every 2 minutes**,
  and only that response is applied (same rule as Midtrans).
- **Polling is the backstop:** the cron calls the poller **every 3 hours**; a shipment is read only
  when both its last event and its last poll are older than **6 hours**, and booked-but-not-picked
  shipments are always read; shipments in a final status are never read. Every read (webhook or
  poll) draws on the shared daily budget `shipping_orders` (default 60, Grow's Tracking quota
  2.000 / 31, assuming order reads count against it).
- **Auto-complete** only on a normalized `delivered`, through `transitionOrderStatus` (no staff
  actor, audit-logged). **Manual fallback:** staff can still "Tandai dikirim" and "Tandai selesai".

**Biteship research (public docs, read 2026-10-22; no API calls).**
- Create order, required and optional fields, `delivery_type` `now` / `scheduled`
  (`delivery_date` `YYYY-MM-DD`, `delivery_time` `HH:mm`, WIB inferred from the example),
  `origin_collection_method` `pickup` / `drop_off`, `reference_id` unique:
  https://biteship.com/id/docs/api/orders/create. Error codes (40002060 duplicate with `details`,
  40002053 not cancellable, 40002013 time passed, 40002039 / 40009003 payment, 40002002 key not
  activated): https://biteship.com/id/docs/api/orders/error.
- Retrieve (all fields nullable, `routing_code`, `history[]`, driver):
  https://biteship.com/id/docs/api/orders/retrieve. Cancel: https://biteship.com/id/docs/api/orders/delete.
  Statuses and the "Deletable" column: https://biteship.com/id/docs/api/orders/overview. Tracking
  status spellings: https://biteship.com/id/docs/api/trackings/status.
- Webhooks (payloads `order.status`, `order.price`, `order.waybill_id`; "return 200 immediately"):
  https://biteship.com/en/docs/api/webhook/overview; header key/secret, no retries, Events Log
  "Resend": https://help.biteship.com/hc/en-us/articles/58382055713689; test-mode webhook button:
  https://biteship.com/id/docs/api/webhook/play_webhook.
- Labels: "Biteship does not provide a Shipping Label API" and the required contents:
  https://biteship.com/id/docs/shipping_label; dashboard sizes A6 / 4x6 inch / A4, PDF or ZPL:
  https://help.biteship.com/hc/id/articles/43305470200473; pricing page row:
  https://biteship.com/en/pricing.
- Test mode and activation (simulated orders, Update Status to delivered, cancel; the form asks for
  one delivered and one cancelled test order id, couriers, optionally our own label):
  https://biteship.com/id/docs/sandbox, https://help.biteship.com/hc/en-us/articles/58597705576985,
  https://biteship.com/id/docs/go_live/submit-activation-request.
- Pickup cut-offs: https://help.biteship.com/hc/id/articles/48424915220377. Price changes after
  re-weighing (volumetric L x W x H / 6000, deducted from the balance):
  https://help.biteship.com/hc/en-us/articles/58290967440153.
- Not documented anywhere: rate limits, webhook timeout or source IPs, an install-time test request,
  whether `GET /v1/orders/:id` counts against the Tracking quota.

**Biteship plan: Grow** (owner decision 2026-10-21, D18; replaces the Komerce Enterprise plan).
- **Grow, Rp149.000/month** (structure effective 2 Nov 2026, https://biteship.com/id/harga):
  2.000 shipments/month, 10 active couriers, monthly API quota Rates 10.000, Tracking 2.000, Maps
  50.000; overage Rates Rp5, Tracking Rp10, Maps Rp2 per request. Orders, tracking and webhooks are
  included, so Phase K needs no plan change.
- **Starter (Rp0)** is fine for development: 100 shipments/month, 3 active couriers, Maps/Rates/
  Tracking billed per request from the first one (also with a test key: test-mode Maps, Rates and
  Tracking are real data and billed; only orders are simulated). The dev account needs a small
  balance top-up for the opt-in contract test and dev checks.
- **Cost:** Rp149.000/month from launch, plus the courier fees for each shipment (Ammari pays the
  full courier cost; the buyer's share above the Rp20.000 subsidy is collected at checkout, D11),
  paid from the Biteship balance (Bitepoints, top-up by QRIS up to Rp1.000.000 or by bank
  transfer; not withdrawable). Ask Biteship about invoice billing if the balance becomes a chore.
- Ammari does not use Biteship COD or insurance; online payment stays on Midtrans (D5).

What to confirm with Biteship when subscribing (not owner decisions):
1. Live Order API activation for the account (form: one delivered and one cancelled test order id
   from our integration, the couriers, optionally our own label; K4 runbook).
2. ~~Labels~~ (resolved 2026-10-22: our own label, decision 49). Optionally upload it with the
   activation form.
3. ~~Webhook authentication options~~ (resolved: static header key/secret, no retries).
4. Whether `GET /v1/orders/:id` counts against the Tracking quota.
5. That the six allowlisted couriers can all be active at once on Grow, and their service codes
   (the contract test prints them).
6. Invoice billing instead of balance top-ups, if wanted, and how cancellation refunds reach the
   balance.

**Risks:**
- **Phase C depends on Biteship Maps and Rates** (2026-10-21): without a working key checkout
  refuses every order (§4.5.5), so the key is a hard launch prerequisite and an outage stops web
  sales (the WhatsApp path stays open). An empty balance does not matter inside the Grow quota,
  but on Starter (dev) it answers 402, which shows as "unavailable".
- The quoted price and the actual booking price can differ (tariff updates, re-weighing reported
  by `order.price`); Ammari carries the difference, visible per order from K2.
- Tracking quota (2.000/month) is tight for polling; the webhook is the primary signal and the
  poller reads a shipment at most every 6 hours within a daily budget of 60 (decision 48). If it is
  still too low, lengthen the interval or lower the budget before raising the plan question.
- One provider for everything: a Biteship outage blocks both quotes and bookings. The manual path
  (staff book with the courier directly, "Tandai dikirim" with courier + resi, manual "Selesai")
  stays available.

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
12. No delivery estimate at checkout until courier rates are live. **Kept in v1 (2026-10-21)**
    even though the provider's rates (which carry an estimate) are now used at checkout.
13. Area dataset licence checked in session 3; plain-text fields if not clean. **Result
    (2026-10-20): not clean; plain-text fields** (§3). **Superseded 2026-10-21:** the area is
    picked from the shipping provider's area search (Komerce at first, Biteship Maps since
    decision 23; D12, §4.5.1).
14. Privacy policy and terms updated before launch by the owner in admin; exact changes in §11.1.
15. **Courier tracking is required.** ~~The owner subscribes to the Komerce Enterprise plan
    when Phase K starts.~~ **Superseded 2026-10-21 by decision 23:** Biteship on the Grow plan
    covers booking and tracking (§15). Web orders move to `completed` automatically when tracking reports delivered, with a manual
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
20. **Shipping provider down or no service: checkout refuses**, with a retry or the WhatsApp link; never a
    fallback rate (§4.5.5).
21. **Migration numbering:** the shipping migration takes 0031; the login-link migration becomes
    0032; Phase K's expected 0033 and 0034. **Revised by decision 24.**

Owner decisions 2026-10-21 (shipping provider, during session 8):

22. ~~Build session 8 on Komerce Shipping Cost (RajaOngkir) ids; K1 confirms whether Store Order
    accepts them.~~ Superseded the same day by decision 23.
23. **Biteship replaces Komerce** for area search, rates, orders, pickup and tracking (D18): one
    area id across all of them; **Grow** plan (Rp149.000/month) before launch, Starter (Rp0, pay
    per request) for development.
24. **Migration 0032 renames `shipping_areas.komerce_destination_id` to `provider_area_id`**
    (and its UNIQUE). The login-link migration becomes **0033**; Phase K's expected **0034 and
    0035**.
25. **No kelurahan field:** Biteship areas stop at kecamatan + kode pos; the search is "Kecamatan
    atau kode pos" and the buyer types the kelurahan in the street address (hint "Jalan, nomor
    rumah, RT/RW, kelurahan").
26. `zod` (4.6.5, already used by both apps) is a dependency of `@ammari/commerce` for parsing
    provider responses.

Owner decisions 2026-10-21 (session 12):

27. **The sweep closes a still-pending attempt with Midtrans' Expire API** (`POST
    /v2/{order_id}/expire`), not Cancel, so the order ends as `payment_expired` like a gateway
    expiry notification (§6.3 said cancel before).
28. **An order with no live gateway transaction is expired locally after the stock hold**: when
    every open attempt was answered 404 (the buyer never picked a method) or as ended in the same
    run, re-checked under the order lock; a payment that still arrives is `paid_after_cancel`.
29. **Retention scope for session 12:** payment notifications (12 months), rate-limit rows (1 day,
    incl. `0.0.0.0` budgets and per-cart rows), `shipping_rate_cache` (7 days), guest / customer
    carts (30 / 180 days) and `order_access_tokens` (30 days after expiry). The 90-day
    anonymization of unpaid orders waits for a later session.

Owner decisions 2026-10-21 (session 13):

30. **"Lihat pesanan" links ship now** (token minted per email, page in session 15); "Masuk ke akun"
    is a slot session 14 fills. No migration.
31. **Paid but stock short, or paid after cancel:** the buyer gets a short "Pembayaran sudah kami
    terima" note (no shipping promise, staff follow up by WhatsApp) as the order's `paid` email; no
    second paid email later.
32. **View tokens are derived** (HMAC with `CUSTOMER_BETTER_AUTH_SECRET` and a purpose label, per
    notification row), so retries are byte-identical for Resend's idempotency key; no new env var.
33. (Session decision, not asked) The safety net is a cron email pass every 5 minutes, which also
    sends "Pesanan dikirim" after staff's manual "Tandai dikirim"; apps/admin sends no email itself.

Owner decisions 2026-10-21 (session 14):

34. **Login link issuance limit: the per-customer cap only** (5 per customer per 24 hours, counted
    in `customer_login_links`). The OTP email throttle (`auth_email_throttle`) is never written by an
    order email, so a buyer's own login code right after checkout is never delayed (§9.3 said the
    per-email throttle and circuit breaker apply).
35. **Phone and promo consent from guest orders are offered, never copied**: after any login,
    `/account` shows the newest guest order's WhatsApp number (if the account has none and no other
    account uses it) and, unticked, the promo consent wording; "Simpan" / "Lewati" stamps
    `customers.contact_offer_resolved_at`, and only later guest orders are offered again.
36. **`/login/link` sends `Referrer-Policy: same-origin`, not `no-referrer`** (under `no-referrer`
    browsers send `Origin: null` on the page's own form POST, which the CSRF check would then have to
    guess behind the proxy).
37. (Session decision, not asked) The login link lands on `/account` until `/orders` exists, and only
    the `created` and `paid` emails carry it (§8 table).

Owner decisions 2026-10-21 (session 15):

38. **`/orders/<no>?t=<token>`: the token hop sends `Referrer-Policy: no-referrer` and renders
    nothing; the token-free pages send `same-origin`** (their server actions need a real Origin;
    Next aborts an action whose Origin is `null`).
39. **"Pesan lagi" only on cancelled, never-paid checkout orders; adds what fits** (caps may cut a
    line, short stock skips it whole) and names the rest; on the order page and the finish page's
    failed state. It works with the "Lihat pesanan" cookie too (the cancelled email sends buyers
    there for it); it only writes the visitor's own cart.
40. **`/orders/*` stays on with the cart flag off** (§14 rollback: email links keep working); with
    the flag off `/account` is unchanged and "Pesan lagi" is hidden and refused.
41. **No lazy finalize of stale orders on page load**: past the window the order pages show
    "Menunggu konfirmasi pembayaran"; the sweep ends the order.
42. **"Pesanan saya" shows guest orders linked by email only while their contact email is the
    account's current (verified) email.** Same rule for the finish page and the contact offer.
    (Session decision after the security review, not asked: the emailed view cookie may not open a
    new payment attempt; a session or the checkout cookie can.)

Owner decisions 2026-10-21 (session 16):

43. **Refunds are made by hand outside the app and recorded in admin** ("Catat dana dikembalikan",
    with a note): Midtrans' Refund API covers QRIS, GoPay and ShopeePay only, not the virtual accounts
    or Mandiri Bill, so a bank transfer is needed anyway; a refund made in the Midtrans dashboard is
    still recorded by the existing notification state machine (`refund_received`).
44. **The voucher comes back on every cancel, paid and refunded orders included** (as built, §6.4,
    S&K §11.1 item 5).
45. **Staff cancels email the buyer** without naming a reason: unpaid "Tidak ada dana yang ditarik"
    with "Pesan lagi"; paid "Dana RpX (termasuk ongkir) akan kami kembalikan penuh. Tim kami akan
    menghubungi kamu lewat WhatsApp untuk proses pengembaliannya."
    (Session decisions, not asked: "Proses" clears `stock_short_at_payment` itself; a cancel of a
    stock-short order resolves that flag too; `refund_due` / `paid_after_cancel` cannot be dismissed
    while money is owed; the courier cost and subsidy on the order page need `finance.view_profit`.)

Owner decisions 2026-10-22 (Phase K breakdown K1 to K4 confirmed, §15 Phase K):

46. **Pickup: `delivery_type: now` only, `origin_collection_method: pickup`**, with a per-courier
    cut-off hint for staff; no scheduled pickup window.
47. **New flag `shipping_cost_over_quote`** when the actual courier price is more than Rp5.000 above
    the locked `shipping_cost_amount`, checked at booking and on every price update. Ammari pays the
    difference either way; the buyer is never charged.
48. **Polling:** the cron calls the poller every 3 hours; each open shipment is read at most every
    6 hours (booked but not picked up: always), within a shared daily budget `shipping_orders`
    (default 60). Webhooks are hints that trigger a re-fetch.
49. **Label: our own 120 x 100 mm PDF** (the 100 x 120 mm sticker roll used landscape) with a
    hand-written, fully tested Code 128 encoder (no new package), quiet zones and a module width a
    203 dpi thermal printer and a phone can read; K4's runbook includes printing it and scanning
    the barcode with a phone.
50. **Sender contact from env:** `BITESHIP_SHIPPER_NAME`, `BITESHIP_SHIPPER_PHONE`,
    `BITESHIP_SHIPPER_ADDRESS` plus `BITESHIP_ORIGIN_AREA_ID`; values never in the repo (the runbook
    says what to set).
51. **`BITESHIP_REFERENCE_PREFIX`** (e.g. `DEV-` on dev, empty or a prod prefix on prod), failing
    closed like the Midtrans prefix; required outside production because dev and local share one
    test account.

Owner decisions 2026-10-22 (K2):

52. **New flag `tracking_number_mismatch`** when a resi staff type differs from the booked waybill
    (also raised when shipping by hand while a booking is unsettled); added to the CHECK in 0034.
53. **Rollback:** the admin renders any unknown flag safely from K2 on, and K2 writes both new flags
    at once (a dev rollback to the K1 image shows its error page for an order carrying one; prod is
    unaffected).

Owner decisions 2026-10-22 (K3):

54. **apps/web tracks with a read-only runtime** (`trackingRuntimeFromEnv`): no sender contact or
    reference prefix in web.env; the same key rules and shared read budget as admin.
55. **K3 session rules (confirmed with the plan):** `delivery_problem` also for an undocumented status,
    a waybill failing the resi rule, a parcel moving for a cancelled order and a read that keeps
    failing; flags only on change (`shipments.refetch_requested_at` and `stale_flagged_at` added in
    0035); the "sudah sampai" email only on courier delivery; staff's "Cek ulang" uses the same apply
    path.

Remaining small items to confirm with third parties (not owner decisions): the Biteship items in
§15 "What to confirm with Biteship" (live Order API activation, Tracking quota use, six active
couriers and their service codes, billing; labels and webhook authentication resolved 2026-10-22); whether the Midtrans
merchant review requires naming the processor on the privacy page.
