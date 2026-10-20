# Plan: Storefront cart, checkout, online payment and web orders (`apps/web`)

**Status:** **Approved by the owner, 2026-10-20** (all §16 decisions are final). **Session 0 done**
(SPEC.md §3.4, §5.2, §5.3, §8, §10.2, §10.3, §11 and docs/design/storefront.md §4, §7 updated to
match this plan). **Session 1 done 2026-10-20** (`@ammari/commerce` extracted, no behavior
change; see the session table). **Session 2 done 2026-10-20** (migration 0030 `checkout_core`,
schema only). Next: session 3.

**Go-live:** 1 Dec 2026. Everything ships dark behind `STOREFRONT_CART_ENABLED` (already exists,
`apps/web/src/lib/cart-flag.ts`, default off) until launch day.

**Courier integration (Komerce) is required** but is a separate phase (Phase K, §15) because the
sandbox key is not available yet. It needs the **Komerce Enterprise plan** (Rp249.000/month,
cheaper annually), the only plan with the Shipping Delivery API; Ammari subscribes when Phase K
starts (§15). Checkout, totals and payment never depend on it. Until Phase K ships, staff enter
courier and resi by hand (existing "Tandai dikirim") and mark orders "Selesai" by hand.

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
  The mockup's courier list is superseded by free shipping (see §4.3). The footer's payment chips
  (design §4) list "Kartu kredit", which must go (D16).
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
| D11 | Free shipping: `orders.shipping_amount = 0` always; the courier cost Ammari pays is stored on `shipments` in Phase K. | Owner decision. |
| D12 | Address area lookup from our own **`shipping_areas`** table (province, city, kecamatan, postal code) loaded by migration, nullable `komerce_destination_id` filled in Phase K. Plain-text fields as the fallback if the dataset licence is not clean. | Works now without Komerce; decision 13. |
| D13 | Unpaid expiry finalized by Midtrans `expire` notifications plus a **sweeper** route called every 5 minutes by a cron container on the VPS internal network. The same cron drives Komerce tracking polls in Phase K. | No scheduler exists. |
| D14 | Transactional emails sent after commit with an `order_notifications (order_id, kind)` UNIQUE row as the idempotency guard. | Retries must not double-send; email failure never fails a webhook. |
| D15 | **Two separate links in guest order emails.** "Lihat pesanan": view-only access to that one order (§9.2). "Masuk ke akun": a magic login link (§9.3), implemented as a **small custom Better Auth plugin** on the customer instance (our own endpoint, Better Auth's session creation, cookie, rate limiter and CSRF middleware), not the stock `magic-link` plugin. | The stock plugin logs in on GET (email scanners prefetch links), does not invalidate older links, does not bind to a customer id, and exposes public issuance. A plugin keeps the login inside Better Auth's own HTTP router, so its rate limiter and origin checks apply (SPEC §10.1's reason for not calling `.api` from server actions). |
| D16 | **No card payments**, not enabled in Snap and not planned. | Decision 2. |

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
  on a line that still holds stock (session 14 blocks item edits on checkout orders anyway).
- **`order_access_tokens`** (the "Lihat pesanan" links): `id`, `order_id`, `token_hash UNIQUE`,
  `expires_at`, `created_at`, `last_used_at`. One row per email sent, so every email has its own
  working link (raw tokens are never stored, so a later email cannot reuse an earlier one).
- **`order_notifications`**: `order_id`, `kind` (`created` / `paid` / `shipped` / `delivered` /
  `cancelled` / `owner_paid`), `sent_at`, `error`; UNIQUE `(order_id, kind)`.
- Rate limiting reuses `claim_rate_limits` with new action keys `cart_write`,
  `checkout_submit`, `area_search`, `order_view`, `login_link_view`.
- No permission keys or other reference rows.

### Migration 0031 `shipping_areas_data` (reference data, session 3)

Idempotent `INSERT ... ON CONFLICT DO NOTHING` of the kecamatan + kode pos dataset (estimated
10k to 15k rows), generated by a committed script from a pinned dataset version, the SQL read
before committing. Licence checked first; if not clean, this migration is skipped and the address
form uses plain-text province/city/kecamatan/postal code fields (D12). Later migration numbers then
shift down by one; numbers are assigned by `drizzle-kit generate` at the time, the order below is
what matters.

### Migration 0032 `customer_login_links` (session 12)

- **`customer_login_links`**: `id`, `customer_id` (FK restrict), `email citext` (the address it
  was sent to), `token_hash text UNIQUE`, `order_id NULL` (which order email issued it),
  `expires_at` (issue + 24 h), `consumed_at`, `superseded_at`, `created_at`, `consumed_ip`.
  Partial UNIQUE on `(customer_id)` WHERE `consumed_at IS NULL AND superseded_at IS NULL`, so at
  most one live link per customer exists, enforced by the database.

### Phase K migrations (numbers assigned at the time, expected 0033 and 0034)

- **`shipments`** (K2): `order_id UNIQUE` (one shipment per order in v1), `provider`
  (`komerce`), `provider_order_no UNIQUE`, `courier`, `service`, `awb UNIQUE NULL`, `cost_amount`
  (what Ammari pays), `label_url`, `status` (normalized: `created` / `pickup_requested` /
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
  "N barang", Subtotal, "Ongkir: Gratis", primary "Lanjut ke checkout", text link "Lanjut
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
2. **Alamat pengiriman.** Nama penerima, nomor HP penerima, area field "Kecamatan atau kode pos"
   (debounced server search, min 3 characters, rate limited; or plain fields per D12), alamat
   lengkap, catatan untuk kurir (optional). Logged in with saved address: summary card with
   "Ubah" / "Ganti alamat" and "Perbarui alamat tersimpan". No map pin.
3. **Pengiriman.** One fixed row, no choice and no delivery estimate (decision 12):
   "Gratis ongkir ke seluruh Indonesia. Nomor resi dikirim lewat email setelah pesanan dikirim."
4. **Ringkasan.** Lines, voucher field, Subtotal, Ongkir "Gratis", "Voucher -Rp20.000" (no
   "Hemat" badge, decision 5), Total.
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

## 5. Order creation (`placeOrder`, in `@ammari/commerce`)

All in one transaction, trusting the client only for cart identity, form fields, chosen voucher
id, consent booleans, a `checkoutAttemptId`, and an `expectedTotal` used only to detect drift.

1. Rate limits: `checkout_submit` per IP (10 per 10 min) and at most 3 unpaid web orders per
   contact email in 2 hours.
2. Zod validation (email, `+62` phone, area id or plain fields, lengths, consent true).
3. Re-read cart lines, products/variants (active, published) and current `products.base_price`;
   compute subtotal; enforce 10 per line and 20 per order.
4. Customer: session customer, or link-or-create by email (insert-first idiom). New customer:
   stamp `pdp_consent_at`, `promo_consent_at` if ticked, phone only if free. Existing customer
   matched by an unverified email: never changes its name, phone or consent; the order carries its
   own contact snapshot and consent evidence.
5. `generateOrderNumber(tx)` (`ORD-YYYYMM-NNNN`, decision 6).
6. Insert `orders` (`channel_id = 'web'`, `awaiting_payment`, `payment_status = 'pending'`,
   `shipping_amount = 0`, snapshots, `placed_with_session`, `payment_expires_at = now + 60 min`)
   and `order_items` (`unit_cost = 0` until paid).
7. Reserve stock per SKU (sorted, `lockVariantForUpdate`, `physical - active reservations >=
   qty`), `expires_at = now + 75 min` (decision 1). Error names product, colour and size.
8. Voucher (session only): `UPDATE vouchers SET status='used', used_order_id, used_at WHERE id
   AND customer_id AND status='active' AND expires_at > now() RETURNING amount`; zero rows rolls
   back with "Voucher tidak bisa dipakai". Discount = `min(amount, subtotal)`.
9. `total = subtotal - discount`; drift from `expectedTotal` rolls back with "Harga atau voucher
   berubah. Cek ringkasan lagi."
10. Insert `payments` attempt 1, insert one `order_access_tokens` row for the checkout cookie,
    delete cart items, audit log (`action = 'web_checkout'`, no staff actor).
11. After commit: Snap `POST /snap/v1/transactions` with `transaction_details`, `item_details`
    (plus a negative "Voucher" line), `customer_details`, `enabled_payments = ["other_qris",
    "gopay", "shopeepay", "bca_va", "bni_va", "bri_va", "echannel", "permata_va"]` (decision 2;
    `echannel` is Mandiri Bill), `expiry` 60 minutes, `callbacks.finish`,
    `X-Override-Notification`. Snap failure keeps the order pending with a retry button; the
    sweeper expires it if never paid. Ammari absorbs the fee (decision 3): no fee line.

Concurrency tests: last unit with two buyers, the same voucher in two tabs, double submit
(`checkout_attempt_id` UNIQUE returns the same order).

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
  `refund_due` until a refund notification arrives or staff clears it.

## 7. How web orders fit the existing admin flow

- **Statuses:** unchanged `ORDER_STATUSES`. `payment_status` separate, web only.
- **`/orders`:** payment badge, "Perlu dicek" filter (`needs_attention`), detail "Pembayaran"
  section (method, paid time, attempts, transaction id, refunds), contact and structured
  address, actions per §6.5, item edit blocked for web orders. Phase K adds a "Pengiriman"
  section (§15).
- **`/packing`:** paid web orders enter the `to_ship` queue. Thank-you cards stay marketplace only
  (verify and enforce server-side). Before Phase K: manual "Tandai dikirim" with courier + resi
  sends the "Pesanan dikirim" email. After Phase K: "Buat pengiriman" books Komerce and prints
  the label; the manual path stays as fallback.
- **`/stock`:** read-only "Dipesan" figure from active reservations, reservation rows on
  `/stock/[sku]`, and a note on the count page that reserved pieces are still counted.
- **Revalidation** of affected product paths after reserve, release and sale.
- **Overview:** the 18% marketplace fee assumption must not apply to `web`.

## 8. Emails (Resend, Indonesian, plain text first)

| Kind | Trigger | Content |
|---|---|---|
| `created` | order created | order no, lines, total, "Lanjutkan pembayaran" link, deadline in WIB, **"Lihat pesanan"** link; guest orders (`placed_with_session = false`) also **"Masuk ke akun"** |
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
- `/orders/[orderNo]`: lines, totals, address, status timeline, "Lanjutkan pembayaran" while
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

- Server recomputes prices, discount, totals and stock everywhere; `expectedTotal` only detects
  drift.
- Atomic patterns only: SKU locks + reservations; conditional voucher UPDATE;
  `checkout_attempt_id` UNIQUE; webhook conditional updates; cart merge upsert; magic link
  consume UPDATE ... RETURNING; one live login link per customer by partial UNIQUE index.
- CSRF: server actions use Next's built-in Origin check; the magic-link POST uses Better Auth's
  CSRF middleware; webhooks and the sweep are authenticated by signature, secret path token or
  bearer secret.
- No silent login anywhere: checkout never creates a session; the magic link needs a POST.
- Rate limits: cart writes, checkout submit, area search, order view, login link view/consume,
  magic link issuance.
- Inventory hoarding: 75-minute hold, 3 unpaid orders per email, 20-piece cap.
- Customer sessions never reach admin (unchanged).
- Secrets only in env; Midtrans server key and Komerce key never reach the browser.
- No cost data in storefront queries.
- Logs never include keys, signatures, raw tokens or full addresses.
- Reviewers: `security-reviewer` on sessions 5, 7, 8, 9, 12 and K3; `silent-failure-hunter` on
  the payment webhook, sweeper, emails and the Komerce webhook/poller.

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
| Rate limit rows | 1 day |

Run daily from the same internal sweep route.

### 11.1 Privacy policy and terms changes (owner edits the live text in admin Konten before launch)

**Kebijakan Privasi**, add or update:
1. Data collected at checkout: name, email, WhatsApp number, recipient name and phone, shipping
   address, order contents, payment status and payment method type (we never receive or store
   card data or banking credentials; no card payments are offered).
2. Purposes: processing and delivering orders, payment confirmation, sending order and shipping
   emails, customer service, legal bookkeeping obligations, and promotions only with separate
   consent.
3. Shared with: a licensed payment processor (to process payment), shipping/courier partners
   (name, phone and address to deliver the package and provide tracking), and the email delivery
   provider. No sale of data.
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
3. Prices in rupiah, free shipping to all of Indonesia, no extra fees at checkout.
4. Limits: maximum 10 per item and 20 pieces per order.
5. Vouchers: Rp20.000, one per order, no minimum, cannot be cashed out or exceed the subtotal;
   returned when an order is cancelled or its payment expires (if still valid), not after a
   return.
6. Stock: if an item turns out to be unavailable after payment, Ammari contacts the buyer and
   refunds in full.
7. Shipping: Ammari chooses the courier; tracking is available in "Pesanan saya"; an order is
   marked complete when the courier reports it delivered.
8. Cancellation by the buyer of a paid order and refunds go through customer service; returns and
   exchanges follow the "Pengembalian & penukaran" page.

The checker for the payment processor's merchant review may also want the processor named on the
policy page; if so, that is the one allowed exception to the "never name the gateway" rule,
confirmed by the owner.

## 12. Environment variables (names only)

apps/web: `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION`, `MIDTRANS_ORDER_ID_PREFIX`,
`MIDTRANS_NOTIFICATION_URL`, `CHECKOUT_PAYMENT_EXPIRY_MINUTES` (60),
`CHECKOUT_STOCK_HOLD_MINUTES` (75), `INTERNAL_CRON_SECRET`, existing `STOREFRONT_CART_ENABLED`,
`RESEND_API_KEY`, `EMAIL_FROM`, `BETTER_AUTH_URL`, `CUSTOMER_BETTER_AUTH_SECRET`.
apps/admin: `MIDTRANS_SERVER_KEY`, `MIDTRANS_IS_PRODUCTION`, `MIDTRANS_ORDER_ID_PREFIX`,
existing `MAIN_SITE_URL`; Phase K adds `KOMERCE_API_KEY`, `KOMERCE_BASE_URL`,
`KOMERCE_ORIGIN_ID` (pickup origin), `KOMERCE_SHIPPER_*` (name, phone, address as Komerce needs).
apps/web Phase K: `KOMERCE_API_KEY`, `KOMERCE_BASE_URL`, `KOMERCE_WEBHOOK_PATH_TOKEN`.
cron service: `INTERNAL_CRON_SECRET`.
Added to `deploy/env/*.env.example` and `.env.example`; payment and Komerce code paths fail
closed when their variables are missing.

## 13. Testing strategy

- **Unit (TDD for vouchers, payments, stock, login links):** pricing, best voucher, signature,
  every row of §6.2, provider order id, phone normalization, area search parsing, Komerce status
  normalization, retention cut-offs.
- **DB integration:** reservations, last-unit race, voucher double redeem, double submit, webhook
  replay and out-of-order, expiry release + voucher restore, expired voucher not restored,
  paid-after-cancel, stock-short-at-payment, cart merge caps, admin cancel, login link single use
  and supersede, shipment event dedupe and auto-complete.
- **Fakes:** `FakePaymentProvider` (with a gated local "Snap" page under `/api/test/...`) and
  `FakeShippingProvider` for Phase K, both behind the existing e2e fixtures gate.
- **e2e (Chromium + WebKit, 390 px and 1280 px):** add to cart, cart edits and sold-out line,
  guest checkout alert, guest checkout to fake payment to finish page, finish page OTP link,
  magic link (GET page, POST login, cart merged, "Pesanan saya"), "Lihat pesanan" token page,
  logged-in checkout with voucher, expiry and "Pesan lagi", order list/detail, admin sees the order
  in `/orders` and `/packing`, flag off 404. On `ammari_e2e` only.
- **Sandbox contract tests (opt-in with sandbox keys):** Midtrans create/status/cancel; Komerce
  destination search, store order, detail, history AWB, cancel.
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
| 3 | Shipping areas: licence check, dataset script, data migration, search (or plain-field fallback) | 0031 | unit + db | database |
| 4 | Reservations + storefront availability + admin "Dipesan" | none | TDD stock + admin e2e 390/1280 | database, typescript, react |
| 5 | Cart backend: cookie, `resolveCart`, actions, caps, merge, rate limits | none | TDD integration | security, typescript, database |
| 6 | Cart UI: PDP, header count, `/cart`, flag 404 | none | e2e 390/1280 | react, typescript |
| 7 | `placeOrder` backend with `FakePaymentProvider` | none | TDD vouchers, stock, concurrency | security, database, typescript |
| 8 | Checkout UI + finish page (incl. "Masuk untuk melihat semua pesanan" OTP link) | none | e2e guest + logged-in | react, security |
| 9 | Midtrans provider + webhook + mapping + sandbox contract tests | none | TDD payments | security, silent-failure-hunter, typescript |
| 10 | Sweeper + cron service + retention job | none | integration | silent-failure-hunter, database |
| 11 | Emails: templates, `order_notifications`, `order_access_tokens` minting, owner paid alert, manual-shipped email hook | none | unit + integration | typescript, silent-failure-hunter |
| 12 | Magic login link: `customer_login_links`, `orderLoginLink` plugin, `/login/link` page, issuance in emails, audit, rate limits | 0032 | TDD + e2e | security, typescript, database |
| 13 | "Pesanan saya", `/orders`, `/orders/[orderNo]`, "Lihat pesanan" token access, "Lacak pengiriman" block (courier + resi) | none | e2e list 390/1280 | react, security |
| 14 | Admin: payment section, "Perlu dicek", web cancel via Midtrans, item edit block, thank-you cards marketplace-only | none | admin e2e 390/1280 | react, security, database |
| 15 | Launch readiness: env examples, runbook (Cloudflare Access bypass, cron), full sandbox run on dev, footer chips, launch/rollback checklist in `docs/runbooks/` | none | manual checklist | none |

Sessions 3 and 4 can swap; 6 and 7 can swap after 5; 12 can run any time after 11.

### Phase K: Komerce courier booking and tracking (required; starts when the sandbox key arrives)

Not a launch blocker for 1 Dec (manual courier + resi and manual "Selesai" cover the gap), but
required: target live within the first weeks of December. **Prerequisite: a Komerce Enterprise
subscription**, started when Phase K starts (see "Komerce plan" below).

| # | Session | Migration | Notes |
|---|---|---|---|
| K1 | Komerce client (`@ammari/commerce/shipping`): destination search, detail order, history AWB, typed errors, sandbox contract tests; script to fill `shipping_areas.komerce_destination_id`, report unmatched rows for manual review | none | read-only APIs first |
| K2 | `shipments` table; admin "Buat pengiriman" on `/packing` and order detail: Store Order (Ammari as payer, free shipping), Pickup Request, Print Label; AWB written to `orders.tracking_number`/`courier` and `shipments`; courier cost stored as `cost_amount`; cancel shipment | expected 0033 | security, database |
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
  courier fees Ammari pays per shipment (free shipping, D11). Nothing is paid to Komerce before
  Phase K.
- **When:** the owner subscribes to Enterprise when Phase K starts; K1 to K3 build against the
  sandbox key.

What Phase K needs from that plan (confirm each with Komerce when subscribing):
1. Shipping Delivery API (Komship) production access: Store Order, Cancel Order, Detail Order,
   Pickup Request, Print Label, History AWB.
2. Webhook registration for order status updates.
3. Search Destination (and Calculate, to record the cost Ammari pays).
4. A daily request quota covering destination search at checkout (if switched to Komerce in K1)
   plus polling: roughly orders in transit x 8 polls/day. Confirm Enterprise's quota covers it.
5. Universal waybill tracking (RajaOngkir track waybill) only if some web orders will ship
   outside Komship; recommendation: ship every web order through Komship so one tracking source
   covers all.
6. Billing for shipments (deposit/balance or invoice), since Ammari pays every shipment.
7. A sandbox key for K1 to K3.

**Risks:**
- Subscribing to Pro (or no plan) would block K2 and K3 entirely: no booking, labels or
  tracking. Check the subscription is Enterprise before K2 starts.
- If Enterprise is not subscribed in time, the manual path (staff "Tandai dikirim" with courier
  + resi, manual "Selesai") stays the only path; nothing in Phase C depends on Komerce.
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
12. No delivery estimate at checkout until Komerce.
13. Area dataset licence checked in session 3; plain-text fields if not clean.
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

Remaining small items to confirm with third parties (not owner decisions): Komerce Enterprise's
daily request quota and the meaning of "Selesai" (the plan itself is settled: Enterprise); whether
the Midtrans merchant review requires naming the processor on the privacy page.
