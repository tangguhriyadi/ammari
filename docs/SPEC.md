# Ammari — Product & Technical Specification

Ammari is a syar'i gamis (modest Muslim dress) brand based in Bandung, Indonesia, run by a
husband (former software engineer) and his wife (non-technical, handles day-to-day operations).
This document is the source of truth for scope, architecture, data model, and business rules for
v1. `CLAUDE.md` at the repo root points here for details and should stay in sync with this file.

## Status

As of 2026-10-21 (cart plan session 17).

**Built:**

- Schema (`packages/db`): products/fabrics/catalog, orders & finance, customers & vouchers, RBAC,
  staff and customer auth tables, suppliers/purchases/receipts, and the checkout schema
  (migrations 0030 to 0033: carts, stock holds, payments, shipping areas and quotes, order emails,
  login links).
- Staff auth + RBAC (`apps/admin`): email OTP + Google login, server-side permission checks (§9,
  §10.1); admin shell with permission-aware navigation.
- Products, fabrics, fabric colors, product photos (`packages/storage`, Cloudflare R2), the
  storefront CMS (homepage sections, info pages, store settings) and product shipping weight.
- Stock, production and raw-material stock on append-only, moving-average ledgers (§5.1);
  suppliers, purchase documents with goods receipts, production output receipts, defect stock and
  dispositions (§5.1a; docs/plans/suppliers-goods-receipt.md).
- Supplier payments with mandatory proof on purchases and posted production batches, voids with
  reason, supplier notas, "Total utang" per supplier, proofs in a private bucket with a nightly
  backup (§5.1a; docs/plans/purchase-payments.md, migration 0038).
- Orders (`/orders`), packing with printable QR thank-you cards (`/packing`), the shared order,
  stock and card write paths in `packages/commerce` (`@ammari/commerce`).
- Main site (`apps/web`): catalog, product pages, customer login and account (§10.3), voucher
  claim flow (`/claim/[token]`), info pages.
- **Cart, checkout, online payment and web orders** (docs/plans/cart-checkout.md Phase C, sessions
  1 to 17): cart, checkout with Biteship shipping quotes and the Rp20.000 shipping subsidy,
  Midtrans Snap payments (verified webhook, expiry sweep), order emails, the order login link,
  "Pesanan saya", and admin handling of checkout orders. **Dark behind `STOREFRONT_CART_ENABLED`**:
  built and tested; on dev only after `docs/launch/checkout-dev.md`; prod still runs the release
  from before the checkout sessions (migration 0029) with the flag off.
- Dev and prod deploy pipelines, backups, monitoring (`docs/deploy.md`, `docs/deploy-prod.md`).

**Next:**

- Checkout launch: `docs/launch/checkout-dev.md` (sandbox run on dev), then
  `docs/launch/checkout-prod.md` (deploy 0030 to 0033 with the flag off, pre-launch setup, launch on
  **1 Dec 2026**); owner texts in `docs/launch/legal-drafts.md`.
- Phase K: Biteship courier booking and tracking (plan §15; target the first weeks of December).
- The 90-day anonymization of unpaid checkout orders (plan §11; the privacy policy promises it,
  first due 1 Mar 2027) and saved addresses at checkout (deferred, plan session 10 notes).
- Orders import (`/import`, Shopee/TikTok Shop exports): placeholder today.
- Overview dashboard (§6; docs/plans/dashboard-overview.md): session 1 done (omzet / laba kotor
  definitions and queries, `sales_goal`, migration 0039); the page itself is still a placeholder
  (sessions 2 to 5).

## 1. Goals

- **Revenue target:** IDR 1,000,000,000 in the first year — roughly 310–335 pieces/month at a
  selling price of IDR 249,000–269,000.
- **Launch:** 1 November 2026.
- **Own checkout** on the main site targeted for 1 December 2026 (v1 launches without it — see
  §3).

## 2. Architecture

### 2.1 Monorepo layout

pnpm workspaces + Turborepo:

- `apps/web` — the **"main site"** (Indonesian: *"halaman utama"*).
  - Production: `ammari.id`
  - Dev: `ammari.my.id`
- `apps/admin` — the admin dashboard.
  - Production: `admin.ammari.id`
  - Dev: `admin.ammari.my.id`
- `packages/db` — Drizzle schema + migrations, shared by both apps.

### 2.2 Stack

- Next.js (App Router), strict TypeScript.
- PostgreSQL **16** + Drizzle ORM. Local, dev, and prod all run the same major version (16).
- The `pgvector` extension may be enabled on the database but is **not used in v1**.

### 2.3 Deployment

- Branch-based deploys via GitHub Actions:
  - `dev` branch → auto-deploys to the dev environment (`ammari.my.id`, `admin.ammari.my.id`,
    Sumopod dev database) on every push.
  - `main` branch → does **not** auto-deploy. Prod (`ammari.id`, `admin.ammari.id`, prod
    database) only ever deploys via a human manually running the "Deploy (prod)"
    `workflow_dispatch` workflow against `main` — there is no `push` trigger for it at all. A
    rollback is the same workflow dispatched with an older `sha` and `skip_migrate` ticked. Full
    procedure: `docs/deploy-prod.md` §1–2.
  - All work happens on `dev` (small features may use short-lived branches merged into `dev`).
    A release is a merge from `dev` into `main`, fast-forwarded (never a merge commit).
  - `main` is protected on GitHub: no direct pushes.
- Two separate Docker images, one per app, built in GitHub Actions and pushed to GHCR.
- Runtime: a VPS running Docker Compose + Caddy.
- Only the app whose code changed is rebuilt; a change to `packages/db` rebuilds **both** images.
- Database migrations run as a **separate step** before the new containers start (not inside
  container startup).
- **Never build on the VPS** — it has 2 GB RAM and cannot reliably run a Next.js production
  build.

### 2.4 Hosting (Sumopod)

- **Dev:** a managed Postgres 16 + pgvector instance on Sumopod (already created) — not
  self-hosted in a container.
- **Prod:** a self-hosted `pgvector/pgvector:pg16` container on the prod VPS itself (separate
  from dev's managed instance above), not exposed publicly — reachable only from other
  containers on the same VPS's internal Docker network. Nightly encrypted `pg_dump` (AES-256,
  encrypted client-side before it ever leaves the VPS) to a **dedicated, private** prod backups
  bucket (`ammari-prod-backups`), with its own access key, separate from the media bucket's
  (see `docs/plans/storage-r2.md`). Documented restore drill. Dev and prod databases are always
  separate. Full operational runbook: `docs/deploy-prod.md`; design: `docs/plans/prod-deploy.md`.
- **Local:** Postgres 16 + pgvector via the root `docker-compose.yml`, for local development and
  automated tests only. A laptop never connects to the Sumopod dev database directly — local
  work always talks to the local container.
- **Object storage:** Cloudflare R2 (S3-compatible), with separate dev and prod media buckets
  plus a dedicated, private prod backups bucket (see `docs/plans/storage-r2.md`). Payment proofs
  and supplier notas live in separate **private** buckets (`ammari-dev-private`,
  `ammari-prod-private`: no custom domain, never public, own tokens), served only through the
  admin's permission-checked `/api/private-files/<id>`; prod's are copied nightly, read-only,
  into the backups bucket's `private-files/` (docs/plans/purchase-payments.md §5, A7).
- **DNS:** Cloudflare.
- Dev domains (`ammari.my.id`, `admin.ammari.my.id`) sit behind a login and are marked `noindex`.

### 2.5 Responsiveness

- Every page must be responsive across phone, tablet, and laptop.
- The admin pages the wife fills in day-to-day — **Orders, Packing, Stock, Production** — are
  **mobile-first**: single column, large tap targets, no wide/scrolling tables.

## 3. Pages

### 3.1 Admin — v1 (1 November 2026)

- Login (email OTP)
- Overview (see §6 for metrics)
- Orders
- Import — upload Shopee/TikTok Shop order and income exports; preview before saving; merges
  duplicate SKU rows within one order before inserting (see `order_items` in §5.2)
- Packing — queue view + print a QR thank-you card per order, or in bulk
- Products & SKUs
- Stock
- Production
- Suppliers and Purchases — purchase documents and goods receipts (§5.1a)
- Penerimaan (`/receipts`) — every goods receipt, both sources, read-only (§5.1a)
- Settings — targets, cost assumptions, staff

### 3.2 Admin — first week of November 2026

- Ads & expenses
- Customers & vouchers
- Roles & staff — see §9

### 3.3 Main site — v1 (1 November 2026)

- Home (company profile) — `/`
- Catalog — `/products`
- Product detail — `/products/[slug]` — the buy button temporarily links out to Shopee/TikTok
  Shop (no cart yet)
- Voucher claim — `/claim/[token]` (the QR itself encodes this path directly; see §4.2)
- OTP login — `/login`
- My account — `/account` — vouchers + their expiry dates
- Privacy policy — `/privacy-policy`
- Terms of service — `/terms-of-service`

### 3.3a Main site: announcement bar, social previews, homepage meta

- **Announcement bar.** A one-line, full-width bar above the main navigation on every storefront
  page (brand background `#695A5A`, white text, 36px tall on phones, 40px from 1024px). It is
  not sticky: it scrolls away while the header stays sticky. Text and an on/off switch live in
  admin Konten > Pengaturan Toko (`store_settings.announcement_bar_enabled` /
  `announcement_bar_text`, migration 0029). Default on, default text "Gratis Ongkir Ke Seluruh
  Indonesia" (the column default from migration 0029; since the 2026-10-21 shipping subsidy the
  owner re-words the live text in admin, the default is left as is), max 40 characters (fits one
  line on a 360px phone; backed by a CHECK). Off or empty
  renders no bar and no gap. Saving revalidates the whole storefront (root layout path plus the
  homepage cache tag), so the ISR-cached product pages pick it up too.
- **Open Graph image.** Product pages use the product's main photo (unchanged). The homepage and
  every other page (info pages, account/login, not-found) use a 1200x630 JPEG (under ~300 KB)
  that admin generates from the published Hero image when the homepage is published ("Terbitkan"),
  stored in object storage next to the Hero's own WebP sizes (`<storageKey>/og.jpg`) and
  referenced by `storefront_homepage_sections.published_og_image_key` (Hero row, migration 0029).
  Tags: `og:image` (absolute URL on the public image domain) with width/height/alt, and
  `twitter:card = summary_large_image`. No published Hero image (or a failed generation, which
  never fails the publish) falls back to the static placeholder `/images/product-placeholder-og.jpg`.
- **Homepage meta.** "/"'s `<title>`, meta description, `og:title` and `og:description` are
  editable in Pengaturan Toko (`store_settings.homepage_meta_title` /
  `homepage_meta_description`; empty = the code default in `@ammari/db/storefront-settings`).
  Guidance about 60 / 160 characters with live counters, hard caps 80 / 200. Lives in Pengaturan
  Toko rather than the Beranda editor because it is a save-is-live setting, not part of the
  Hero/grid layout that Beranda's draft/publish exists to protect, and it sits next to the other
  storefront-wide settings. Other pages keep their "Name | Ammari" titles.

### 3.4 Main site — 1 December 2026

Approved plan: docs/plans/cart-checkout.md (owner decisions in its §16 are final). Everything
below ships behind `STOREFRONT_CART_ENABLED` (default off; with the flag off `/cart`, `/checkout`
and `/checkout/*` return not-found and the WhatsApp CTA stays primary).

- Cart — `/cart`. Stored in the database (guest: httpOnly cookie holding a random token, only its
  hash is stored; logged in: keyed by customer, merged after any login). Limits: 1 to 10 per line,
  at most 20 pieces per cart and per order. No prices are stored on cart lines. "Ongkir: Dihitung
  saat checkout".
- Checkout — `/checkout`, one page: Kontak, Alamat pengiriman, Pengiriman, Ringkasan. Guest
  checkout is allowed (email and WhatsApp number). **Checkout never signs anyone in**: a guest's
  `customers` row is linked or created by email, but the email is unverified at that point, so no
  session is created (account-takeover risk).
- **Shipping subsidy (owner decision 2026-10-21, replaces free shipping).** Ammari covers at most
  **Rp20.000** of the courier cost per order; the buyer pays `max(0, cost - 20.000)` as a separate
  "Ongkir" line. Product prices are the same for every location. Details: plan §4.5.
  - Address: the buyer picks a shipping-provider area (Biteship Maps; search by kecamatan, city
    or kode pos); it is cached in `shipping_areas`. Areas stop at kecamatan + kode pos, so the
    kelurahan is typed in the street address. Free-typed kecamatan/kode pos are gone.
  - Courier: the server picks the cheapest service from a code allowlist of regular services;
    one fixed row, no buyer choice, no delivery estimate.
  - Weight: `products.shipping_weight_grams` (one packed piece, required to publish) times qty,
    plus a packaging allowance per order.
  - The quote is computed only on the server (Biteship Rates, cached up to 6 hours),
    recomputed in order creation and **locked into the order** (`shipping_amount` = buyer's
    share, plus the quoted cost, subsidy, courier/service, weight, destination id and quote
    time). A later tariff change or a different booking price is Ammari's, never the buyer's.
  - Shipping provider down, or no service to the destination: checkout refuses with a retry or a WhatsApp
    link; there is no fallback rate.
  - Vouchers apply to goods only (never to ongkir). A paid order cancelled before shipping is
    refunded in full, ongkir included.
- Payment — Midtrans Snap in redirect mode, with exactly these methods: QRIS, GoPay, ShopeePay,
  and virtual accounts / bill payment for BCA, BNI, BRI, Mandiri and Permata. **No card
  payments**, not enabled and not planned. Ammari absorbs gateway fees (no fee line). Payment
  window 60 minutes. The gateway name is never shown to customers (the only possible exception
  is the privacy page, if the merchant review requires it and the owner confirms).
- Order creation reserves stock for 75 minutes (physical stock minus active reservations); the
  real `sale` movement is written only when payment is confirmed. Unpaid orders expire
  automatically (gateway `expire` notification plus a sweeper run every 5 minutes). Customers
  cannot cancel unpaid orders themselves.
- "Paid" is set only after a verified payment notification (SHA512 signature check) **and** a
  server-to-server status re-fetch from the gateway, never from the browser redirect or the
  finish page. See also CLAUDE.md "Security".
- Voucher redemption — logged-in customers only, one per order, applied atomically inside the
  order transaction. Restored only when the order is cancelled or its payment expires (and the
  voucher has not itself expired), never after a return. Guests see "Masuk untuk pakai voucher".
- Order status and "Pesanan saya" — `/account` (list), `/orders` (full list), `/orders/[orderNo]`
  (detail with status timeline and a "Lacak pengiriman" block). Access is by customer session, or
  for guests by the view-only "Lihat pesanan" link (one order, 120 days; see §10.3).
- Transactional email (Resend, Indonesian): order created, paid, shipped, delivered, cancelled,
  plus an alert to the owner on every paid order (§10.2).
- Courier booking and tracking via **Biteship** (Phase K, required; target live in the first
  weeks of December), with the same account, key and area ids as checkout's rates. Biteship
  replaced Komerce on 2026-10-21 (plan D18): Komerce's rate ids were not documented as the ids
  its booking API accepts, and booking needed its Enterprise plan (Rp249.000/month); Biteship's
  **Grow** plan (Rp149.000/month: 2.000 shipments, Rates 10.000 / Tracking 2.000 / Maps 50.000
  requests a month) covers rates, orders with pickup and tracking. Starter (Rp0, pay per
  request) is used for development. Until Phase K ships, staff book the order's quoted service
  by hand, enter courier and resi ("Tandai dikirim") and mark orders "Selesai" by hand. Checkout
  **does** depend on Biteship Maps and Rates from launch (a Grow subscription and live key are a
  launch prerequisite), but never on booking. Once live, web orders
  move `to_ship -> shipped -> completed` automatically from tracking (a returned-to-sender
  status only raises a flag, staff confirm the return), with the manual actions kept as a
  fallback, and customers see the tracking timeline in "Pesanan saya". Phase K as confirmed by
  the owner on 2026-10-22 (plan §15 Phase K, decisions 46 to 51): staff press **"Pesan kurir"**
  on a paid web order, which books exactly the locked courier and service with pickup requested
  at once (`delivery_type: now`, no scheduled window, a per-courier cut-off hint), idempotent per
  attempt (`reference_id` = `BITESHIP_REFERENCE_PREFIX` + order number + `-K<attempt>`); an actual
  price more than Rp5.000 above the quote flags `shipping_cost_over_quote` (Ammari pays the
  difference); the label is **our own 120 x 100 mm PDF** with a Code 128 waybill barcode (Biteship
  has no label API); webhooks are hints that trigger a re-fetch, and a cron poll every 3 hours
  re-reads open shipments at most every 6 hours (budget 60 reads a day). The buyer's "Lacak
  pengiriman" shows the courier, the resi (copyable) and the courier timeline, latest on top, in
  Indonesian and WIB, never the provider's name; no timeline while the order's resi differs from
  the booked waybill (K4). Staff's "Tandai selesai" for a parcel the courier never reported
  delivered sends no "sudah sampai" email, not even after a later courier report, and the poll
  stops reading it (owner 2026-10-22).

## 4. Voucher & QR thank-you card program

### 4.1 Purpose and scope

A thank-you card with a unique QR code is printed **per order** during packing, **only** for
Shopee/TikTok Shop orders. The card must never invite the buyer to leave the marketplace (no
"follow us" / "order direct next time" language) — it exists to drive account creation and repeat
purchases on the main site without violating marketplace policy.

### 4.2 Token

- The QR encodes `https://ammari.id/claim/<token>` directly — no separate short-path redirect.
- The token is random with **≥128 bits of entropy**.
- Only a **hash** of the token is stored — never the raw token.
- Reprinting a card generates a **new** token and **invalidates** the old one (the old token must
  no longer validate).

### 4.3 Claim flow

1. Validate the token:
   - exists
   - not yet claimed
   - source order is not cancelled or returned
   - claim deadline has not passed
2. Buyer enters name, phone, email, and ticks **two separate checkboxes**:
   - data-processing consent (required — Indonesian PDP Law / UU PDP)
   - promo consent (optional)
3. OTP verification.
4. On success:
   - a new account is created automatically, **or**
   - the voucher is attached to an existing account matched by phone or email.
   - In the **same transaction**: mark the card claimed (`claimed_by_customer_id`,
     `claimed_at`), create the voucher, and set the source order's `customer_id` to the
     claiming customer if it is still null.
5. Login is passwordless (OTP-based) throughout — there is no password to set.
6. The QR contains only the random token, never the order number.

### 4.4 Deadlines and validity

- **Claim deadline:** 1 calendar month after the marketplace checkout date, until 23:59 WIB.
- **Voucher value:** IDR 20,000.
- **Voucher validity:** 3 calendar months from the claim date, until 23:59 WIB.

### 4.5 Redemption rules

- One voucher per source order (e.g. 3 marketplace orders → 3 vouchers).
- No minimum spend requirement.
- Redeemable **only** at the main site's checkout.
- At most **one voucher per checkout**.
- The discount can never exceed the product subtotal and cannot be cashed out (no change given,
  no cash equivalent).

## 5. Database schema (summary)

Full column-level detail lives in `packages/db` migrations; this is the conceptual summary.

### 5.1 Products & production

- `fabrics` — deletable only while unused by any `products` row (`ON DELETE RESTRICT`).
  `price_amount`/`price_unit` (`meter` / `yard`) store exactly what the owner entered and its
  unit — never a silently-converted per-meter value (Pasar Baru shops often quote per yard; the
  admin UI shows both, converting live, and marks the derived one with "≈"). Both null or both
  set. `care_instructions` (shown on the fabric form, will appear on the main-site catalog later).
- `fabric_colors` — a fabric's named colors (e.g. "Sage"), belonging to the fabric, not to any
  one product: two products sharing a fabric share its color palette. `name` is `citext` and
  unique per fabric (`(fabric_id, name)`), so "Sage"/"sage" collide. `supplier_color_code` is the
  supplier's own code/name for the color (e.g. "No. 23"), distinct from Ammari's own name.
  `hex` (optional, `^#[0-9A-F]{6}$`, normalized uppercase) — a variant with no hex shows a
  neutral placeholder swatch. `is_active` (default true) replaces hard delete — a color
  referenced by any variant (`ON DELETE RESTRICT`) can only be deactivated; a deactivated color
  can't be picked for a *new* variant but stays visible on variants that already use it. Fabric
  stock per color (meters on hand) can later attach here.
- `products` — `code` (unique, uppercase, derived from name, immutable once set) feeds SKU
  generation; `size_mode` (`sized` / `all_size`) is chosen at creation and not editable once the
  product has variants. A product's `fabric_id` AND `closure` cannot change once it has a
  variant — guaranteed at the DB level (not just the UI) via a composite FK from
  `product_variants(product_id, fabric_id, closure)` to `products(id, fabric_id, closure)` with
  `ON UPDATE RESTRICT` (closure is locked for the same reason fabric is: it's baked into every
  SKU). `shipping_weight_grams` (migration 0031, nullable, 50 to 30000): the weight of one packed piece
  in grams, used for shipping quotes; required when a product goes from hidden to published, and
  cannot be cleared while it is published (plan §4.5.3). Products published before 0031 stay
  published without one and carry a "Berat kirim belum diisi" badge in the admin list.
  Per-product discount (migration 0036, [plan](plans/product-discount.md)):
  `discount_price_amount` (the sale price in whole rupiah, the source of truth; the percent is
  derived), `discount_enabled`, optional `discount_starts_at` / `discount_ends_at`. Active only
  when enabled and now is in `[start, end)`; applies to every variant. CHECKs: sale price above
  Rp0, below `base_price`, and at least 1% off. Every price read goes through
  `@ammari/db/pricing`'s `resolveUnitPrice`.
- `product_variants` — `sku` is the primary key; unique on `(product, fabric_color_id, size)`;
  sizes XS–XL, plus `ALLSIZE` for `size_mode = 'all_size'` products (a `sized` product may only
  have XS–XL variants, an `all_size` product only an `ALLSIZE` variant — enforced in a DB trigger
  and in application code). `is_active` (default true) replaces hard delete — a variant
  referenced anywhere (stock, orders, production) can only be deactivated, never removed.
  `fabric_color_id` must belong to the SAME fabric as the variant's own product — guaranteed at
  the DB level via a second composite FK to `fabric_colors(id, fabric_id)` (both FKs share the
  variant's own denormalized `fabric_id` column, which is what makes the cross-table "same
  fabric" check possible at all). The SKU is built from the color's name and the product's
  closure at the moment the variant is created and stays immutable even if the color is renamed
  afterward. Creating variants for several colors at once is one atomic transaction
  (all-or-nothing), with a single `audit_log` entry for the whole batch.
- `product_images` — `fabric_color_id` (optional FK to `fabric_colors`; null = applies to all
  colors). **Photo rules:**
  - Photos never gate activation. New variants are created **active**, and activating a variant
    or a product never requires a photo: production batches, stock and orders need active SKUs
    before photos exist. A color with active variants but no photo of its own only gets a
    non-blocking "Belum ada foto" badge in admin (product page and product list).
  - The one hard rule is publishing: a product needs **at least one photo** (general or any
    color) to be published on the storefront, and the last photo of a published product cannot
    be deleted. Every photo also needs alt text to publish. From plan session 7 a product also
    needs its shipping weight to go from hidden to published (an already published product
    without one stays published and can still be saved).
  - Alt text defaults to `<product name> warna <color name>` for a color photo and to
    `<product name>` for a general photo, set on upload when left empty and restored when cleared
    (still editable). A product or color rename updates alt texts that still equal the old
    default, never hand-written ones. Migration 0028 backfilled the default into existing empty
    alt texts.
  - Storefront fallback: a color's own photos plus the general ones; if neither exists, the first
    other color's photos; if the product has no photo at all, a static placeholder (the Ammari
    mark on the image background, 2:3, `apps/web/public/images/`). Never a broken image.
- `production_batches` — `status` is `draft` → `posted`, one-way, and a posted batch is frozen by
  DB triggers. **Posting** consumes the batch's fabric and accessories from raw-material stock at
  their moving-average cost and freezes HPP/pcs (`ceil(total batch cost / planned pcs)`, written
  to every line and never rewritten). Posting adds **no** finished-goods stock: the sewn output
  enters stock only when it is received (§5.1a). Receipt progress lives in its own column,
  `receipt_status` (`pending` / `partially_received` / `received` / `closed`; always `pending` for
  a draft), recomputed after every receipt and reversal. `closed` is a short-close ("Tutup batch")
  for output that will never arrive: a required reason plus `closed_at` /
  `closed_by_staff_user_id` / `close_reason`; it moves no stock, keeps HPP/pcs as posted, and the
  batch shows the frozen cost of the pcs that never arrived as "Nilai belum terserap". Batches
  posted before migration 0025 already put their output into stock at posting; they were
  backfilled to `received` and are never received again.
- `production_batch_items` — one line per SKU: planned `qty` and the frozen `unit_cost_amount`.
- `production_batch_costs` — extra cost lines (sewing fee, etc.), each with a snapshotted
  component name/unit/type and optionally the supplier paid for that line (`supplier_id` plus a
  `supplier_name` snapshot, prefilled from `cost_components.default_supplier_id`).
- `stock_movements` — an append-only ledger: signed `qty` (±), signed `value_amount`, `type`
  (`production` / `sale` / `return` / `adjustment`), and a `reference`. Current stock for a SKU is
  `SUM(qty)` over its movements — never a mutable stock counter; its value is `SUM(value_amount)`
  (moving average). A `production` row is written only by a goods receipt of a batch's output
  (`ref_type = 'goods_receipt_item'`, valued at the batch line's frozen HPP/pcs) and is exactly
  negated by that receipt's reversal; `production` rows with `ref_type = 'production_batch_item'`
  are history written at posting by releases before migration 0025.

### 5.1a Suppliers, raw materials, purchases & goods receipts

The rule: **stock only moves when goods are received.** Recording a purchase moves no stock, and
posting a production batch adds no finished-goods stock (it still consumes raw materials). Stock
rises only through a goods receipt, by the quantity actually accepted, in as many partial
receipts as it takes. Received quantity is immediately sellable; unreceived quantity simply isn't
in stock (orders refuse it with the usual "stok tidak cukup"), and the main site marks a variant
available only from received stock (its `available` flag is `SUM(qty) > 0`).

- `suppliers` — the master list of who she buys from and who sews for her. Only `name` (`citext`,
  unique) is required; optional kinds (Kain / Aksesoris / Jasa / Lainnya — a soft filter only,
  never a restriction), phone/WhatsApp, address, bank details, notes. Deactivated, never deleted,
  once referenced. Legacy free-text supplier names on older rows are not mapped onto it.
- `accessories`, `accessory_movements`, `fabric_stock_movements` — raw-material stock on the same
  append-only, signed `qty`/`value_amount` moving-average ledger shape as `stock_movements`. A
  wrong purchase row is corrected only by a reversing `purchase_void` row, never edited. Receipt
  rows carry `supplier_id` plus a supplier-name snapshot.
- `purchases` + `purchase_items` — a purchase document (`PO-YYYYMM-NNN`): a required supplier,
  the order date, and lines of fabric (yards, 2 decimals) or accessories (whole pcs), each storing
  exactly what was entered: `qty_ordered` and `total_amount` (ongkir included), never a unit
  price. `status`: `ordered` → `partially_received` → `received`, recomputed from the receipts;
  `closed` / `cancelled` only by "Tutup pesanan" with a required reason (`cancelled` when nothing
  arrived). Header and lines are editable only while nothing has been received; once a line has a
  receipt, its quantity, total and item are frozen by a DB trigger. Each receipt is valued as a
  cumulative-rounding slice of the line total, so partial receipts sum to exactly what was paid.
  Single-row purchases recorded before purchase documents existed stay as they are, listed under
  "Pembelian lama", never backfilled into documents.
- `goods_receipts` + `goods_receipt_items` — one receipt table pair for both sources (a purchase
  or a production batch), `GR-YYYYMM-NNN`. A receipt records, per line (per purchase line, or per
  batch variant), the quantity accepted (`qty_accepted`, good, into sellable stock) and the
  quantity rejected (`qty_rejected`, "Ditolak (cacat)", into defect stock — see
  `defect_movements` below), a receipt date (defaults to today in Jakarta, backdatable, never in
  the future), the staff user who recorded it, and an optional "Diterima oleh". Accepted and
  rejected **both** use up the line: settled = accepted + rejected − returned to the supplier
  and outstanding = ordered − settled. Over-receipt (accepted + rejected beyond what is
  left) is refused entirely with an Indonesian message naming the line and what is left. Only
  accepted units complete a line: a document or batch where everything arrived but some of it was
  defective stays `partially_received` with nothing left to receive, until it is closed or the
  defects are exchanged. For purchases, the arrival's value (the cumulative slice of the
  line total) is split between accepted and rejected in proportion, the two parts summing exactly
  to the slice; for production, both are valued at the batch line's frozen HPP/pcs.
  Concurrent receipts serialize on the source document's row lock. A wrong receipt is corrected
  only by "Batalkan penerimaan", which writes an exactly negating reversal receipt plus reversing
  ledger rows (`purchase_void` for raw materials, a negated `production` row for finished goods);
  it is refused once the stock it brought in was consumed, sold (an order, packed or not) or
  adjusted afterwards, pointing at "Sesuaikan stok" instead. A reversal also reverses the
  receipt's defect rows exactly, and is refused once those defects were returned or released.
  Every receipt, reversal and close is written to `audit_log`.
  **`/receipts`** ("Penerimaan", `inventory.view`) lists every receipt and reversal of both
  sources, newest receipt date first, filterable by source (Pembelian / Produksi), supplier (a
  purchase's supplier, or any supplier on a batch's cost lines), date range and status
  (Diterima / Dibatalkan / Pembatalan), each linking to its purchase or batch (the batch link
  only for `production.manage`). Read-only: receiving and reversing stay on the source document.
  Ledger rows link back too: on `/stock/[sku]` every `production` row (receipt, reversal, or
  legacy at-posting row) links to its batch, and on the fabric/accessory ledgers every
  receipt-backed `purchase` row and its reversal's `purchase_void` row link to the purchase.
- `defect_movements` — **defect stock** (stok barang cacat), one append-only ledger for all three
  item kinds (`item_kind` `sku` / `fabric` / `accessory`, exactly one of `sku` / `fabric_id` /
  `accessory_id`, always naming its source purchase line or batch line). A separate table on
  purpose: defect stock can never be sold, ordered, packed, shown as available on the main site,
  or counted as sellable, because none of those paths reads this table. Balance and value per
  item are `SUM(qty)` / `SUM(value_amount)` (shown pooled per item, never mixed into the sellable
  average or HPP), but every outflow is valued at its **source line's own** defect value, never
  at the item's pooled average: a `return_out` or `dispose` takes its share of the line's net
  reject value by cumulative rounding over the line's net rejects (the same shape as a receipt slice), and the
  outflow that empties a line takes exactly what that line still holds, so a line's
  dispositions sum to exactly its reject value and no value moves between two purchases or
  batches of the same item at different costs. Types: `reject` (written by a receipt, 1:1 with `qty_rejected`),
  `return_out` and `dispose` (exchange and release, S6), and `reversal` (exact negation, never an
  edit; a DB trigger makes rows immutable except for the reversal stamp). A release (`dispose`)
  carries `disposal_type` — `auction` (Lelang, proceeds > 0), `donation` (Hibah, Rp 0) or
  `discarded` (Dibuang/Dimusnahkan, Rp 0, reported separately from Hibah as waste) — and
  `proceeds_amount`, stored for a future accounting module but booked nowhere today. Visible on
  `/stock/defects` (tab "Cacat"), on each purchase and batch (line columns Cacat / Ditukar /
  Dilepas, where "Cacat" is what is still held; "Barang cacat" history with each row's type,
  quantity, proceeds and notes), as a "Cacat" figure on `/stock`, `/stock/fabrics` and
  `/stock/accessories`, as a "Barang cacat" section (balance + ledger linking each row to its
  source document) on `/stock/[sku]`, `/stock/fabrics/[id]` and `/stock/accessories/[id]`, and
  read-only per SKU on the stock count. Values and proceeds only with `finance.view_profit`.
  A reversal must exactly negate the row it reverses (same item, source line and disposal type;
  qty, value and proceeds negated, enforced by a DB trigger), and a reject's receipt item must
  belong to its own source line (composite FKs).
- **Defect dispositions** (all need `inventory.manage`, all audit-logged, all locking the
  document row first and then the item row):
  - **Return to supplier/tailor** ("Kembalikan ke supplier" / "Kembalikan ke penjahit"):
    quantity (at most what the line still holds), date, required reason. The units leave defect
    stock at that line's own defect value and re-open exactly that much outstanding on the line;
    the replacement arrives through the normal receipt on the same document, at that line's
    price, and the document can then reach `received`. A return against a **closed or cancelled** document (or a short-closed batch)
    re-opens it to `partially_received`, stamping `reopened_at` / `reopened_by_staff_user_id` /
    `reopen_reason` (the return reason), with a "Dibuka kembali" badge; the last close record is
    kept. No other action re-opens a document.
  - **Release** ("Pelepasan"): quantity, type Lelang (proceeds entered by hand, required, > 0),
    Hibah (Rp 0) or Dibuang/Dimusnahkan (Rp 0), date, required notes. Never creates outstanding
    and never changes the document status. Proceeds are gross cash received, stored only, never
    booked (no accounting entries).
  - **Reversal** ("Batalkan" on a return or release): an exact copy-and-negate row (proceeds
    negated too), never an edit. A return's reversal is refused once its replacement was received
    ("Batalkan penerimaan pengganti dulu"); a reject is reversed only with its receipt. A reversal
    never re-closes a re-opened document.
- **Variance figures** (read-only, `finance.view_profit`). HPP/pcs is never rewritten. Purchase
  ("Nilai pesanan"): Total pesanan, Nilai diterima, Nilai cacat masih disimpan, Nilai ditukar,
  Nilai cacat dilepas per type (Lelang, Hibah and Dibuang/Dimusnahkan always on separate lines),
  Hasil pelepasan, Kerugian bersih barang cacat (= released − proceeds; negative is shown as a
  gain, "untung"), and Nilai belum terserap once closed. Batch (inside "Biaya batch"): the same
  defect lines plus **HPP riil per pcs** = (value received into sellable stock at HPP/pcs + net
  defect loss + Nilai belum terserap) / pcs received, which is (total batch cost − proceeds) /
  sellable pcs once everything is settled; marked "Sementara" while defects are still held or
  output is still expected.
- Stock count ("Hitung stok") guard: the count page lists that product's posted batches whose
  output is not fully received (with a link), because goods physically in the house but not yet
  received read as missing and must be received, not "corrected" by a count. It also always
  shows "Jangan hitung barang cacat, hitung hanya barang yang bisa dijual.", and each SKU row
  shows its defect quantity read-only ("Cacat: N pcs (tidak ikut dihitung)"), never part of the
  system count and never submitted.
- "Dipesan" (pieces held for unpaid web checkout orders, `stock_reservations`): read-only,
  shown only while an active, unexpired hold exists. `/stock` shows "Dipesan N" next to the
  physical count, `/stock/[sku]` lists the holding orders (order number, quantity, hold expiry),
  and the count page shows "Dipesan: N pcs (tetap dihitung)" per SKU plus a note that held
  pieces are still on the shelf and are counted. Every physical figure (count, "Sistem", low-stock
  status) stays physical stock; holds never change it.

- **Supplier payments** (docs/plans/purchase-payments.md, migration 0038). `supplier_payments`
  (`BYR-YYYYMM-NNN`, against one purchase or one posted batch and payee, amount, date, Tunai /
  Transfer, a required proof in `private_files`) and `purchase_attachments` (notas) are
  append-only: no edit, no delete, a mistake is voided with a reason and stops counting. Payment
  status is derived, never stored: Belum bayar / DP / Lunas / Tanpa tagihan / Lebih bayar.
  Tagihan: a purchase's order total (a short-closed one only what was settled, a cancelled one 0);
  a posted batch's service lines per payee, never fabric or accessories. A payment above the
  remaining balance is refused. "Total utang" per supplier = remaining over their purchases plus
  their share of posted batches; overpaid documents show "Lebih bayar" separately. Amounts need
  `finance.view_profit`; recording, voiding and viewing proofs also `supplier_payments.manage`.

### 5.2 Orders & finance

- `channels` — `shopee`, `tiktok`, `web`, `reseller`.
- `orders` — unique on `(channel_id, channel_order_no)`.
- `order_items` — `unit_cost` is **locked** at the moment the order is recorded (not recomputed
  later if cost assumptions change); unique on `(order_id, sku)`. If a marketplace export has
  several rows for the same SKU in one order, the importer **merges them into one line** before
  inserting: `qty` summed, `unit_price` the weighted average rounded to the nearest whole
  rupiah. `unit_price` is always what was charged; `list_unit_price` (migration 0036, nullable)
  is the undiscounted price, snapshotted for checkout lines, and for manual-order lines charged
  below the SKU's normal price (NULL on older rows, marketplace orders and undiscounted manual
  lines; never below `unit_price`).
- `order_settlements` — actual payout data from the marketplace, arrives after `orders`.
- `import_batches` — tracks each Shopee/TikTok export upload.
- `payments` — one row per payment attempt (Midtrans); unique on `provider_order_id`
  (`<env prefix><order_no>-<attempt>`, prefix `""` in prod and `DEV-` / `LOCAL-` elsewhere because
  dev and local share one gateway Sandbox account), unique `(order_id, attempt)`, unique nullable
  `provider_ref` (the gateway transaction id). Schema exists (migration 0030, plan §3); nothing
  writes it until the Dec 2026 cart/checkout sessions (§3.4). The same holds for every table and
  `orders` column below that is marked for checkout.
- `payment_notifications` — raw log of every gateway notification (payload, signature validity,
  processing result); payloads kept 12 months.
- `stock_reservations` — one row per web order line while its payment is pending
  (`active` / `consumed` / `released`, `expires_at`). Storefront availability becomes physical
  stock minus active, unexpired reservations; the append-only `stock_movements` ledger still
  records real sales only. Paying an order (`awaiting_payment -> to_ship`) consumes its holds;
  cancelling it unpaid releases them. Admin and marketplace-import paths keep checking physical stock only
  (a marketplace sale already happened and is never refused).
- `carts`, `cart_items` — database-backed cart (no price column on items).
- `shipping_areas` — province / city / kecamatan / postal-code rows keyed by `provider_area_id`
  (unique; the Biteship area id, which is kecamatan + kode pos level, so `subdistrict` stays
  NULL). No licensed dataset exists (checked 2026-10-20), so since the 2026-10-21 revision the
  table is **filled on demand from the provider's area search (Biteship Maps)** at checkout (each
  search upserts what it returns); checkout orders and saved addresses point at a row through
  `shipping_area_id`, and the browser only ever sends that id. Migration 0031 added
  `subdistrict`, `label`, `last_synced_at`, made `postal_code` nullable and swapped the
  `(province, city, district, postal_code)` UNIQUE for a UNIQUE on the provider id; migration
  0032 renamed `komerce_destination_id` to `provider_area_id`. `@ammari/commerce/address` stays
  the validator and snapshot builder.
- `shipping_rate_cache` — provider quotes per (origin, destination, weight, service allowlist),
  reused for up to 6 hours, pruned after 7 days (migration 0031).
- `order_access_tokens` — "Lihat pesanan" view-only links; only the sha256 of the token is
  stored, one row per email sent, expiring 120 days after issuance.
- `order_notifications` — unique `(order_id, kind)`, the idempotency guard for transactional
  emails.
- `shipments`, `shipment_events`, `shipping_webhook_events` — Phase K (Biteship): one shipment per
  order (courier, service, AWB, the cost Ammari pays, normalized status), de-duplicated tracking
  events, and a raw webhook log.
- `orders` additions for web orders (all nullable or defaulted): `payment_status`,
  `payment_expires_at`, `paid_at`, contact snapshot (`contact_email`, `contact_phone`,
  `recipient_name`), `shipping_address_snapshot`, `shipping_area_id`, `checkout_attempt_id`
  (unique, makes double submit idempotent), consent evidence, `cancel_reason`,
  `needs_attention` (a set of flags, `text[]`: e.g. stock short at payment, paid after cancel,
  amount mismatch, refund due, payment anomaly; several can hold at once and each is cleared on
  its own), and `placed_with_session`. Migration 0031 added the locked shipping quote:
  `shipping_cost_amount`, `shipping_subsidy_amount`, `shipping_courier_code`,
  `shipping_service_code`, `shipping_courier_label`, `shipping_weight_grams`,
  `shipping_destination_id`, `shipping_quoted_at` (all set or all null; when set,
  `shipping_amount = shipping_cost_amount - shipping_subsidy_amount`, so `shipping_amount` is
  the buyer's share; every checkout order has them). A checkout order is one with `payment_status` set (staff
  can also enter manual orders on the `web` channel, which leave it NULL). It is
  `awaiting_payment` until paid, then enters the normal `to_ship` queue; the 18%
  marketplace-fee assumption does not apply to `web`. Ongkir paid by the buyer is pass-through,
  not sales revenue; the subsidy is a shipping expense.
- `ad_spend_daily` — unique on `(date, channel)`.
- `expenses`
- `targets` — one row per month (not used yet; seasonal weights for the target curve later).
- `sales_goal` — one row (`id = 1`, migration 0039): the first-year revenue target and its start
  date (Asia/Jakarta). The row ships in the migration.
- `cost_assumptions` — dated by `effective_from`; see §7 for the initial row.
- Defect disposal proceeds (`defect_movements.proceeds_amount`, Lelang) are **not** finance data
  yet: stored, visible on the source document and audit-logged, but booked nowhere (no journal,
  no Overview metric). A known gap until a double-entry accounting module exists (§5.1a).

### 5.3 Customers & vouchers

- `customers` — `phone` nullable (optional at account creation; see §10.3) but unique when
  present; unique `email` (stored as `citext` for case-insensitive matching); verification
  timestamps; `pdp_consent_at`; `promo_consent_at`; `type` (`retail` / `reseller`).
- `customer_addresses` — saved addresses (recipient, phone, address, area via `shipping_area_id`
  plus denormalized names incl. kelurahan from migration 0031, optional coordinates, one default
  per customer); orders always store an address **snapshot**. Schema only so far,
  see the `payments` note in §5.2.
- `customer_login_links` — the "Masuk ke akun" one-time login links (§10.3): hashed token, bound
  to a customer id and email, 24-hour expiry, `consumed_at` / `superseded_at`; a partial unique
  index allows at most one live link per customer. Migration 0033 (session 14), which also added
  `customers.contact_offer_resolved_at` (when the customer last answered the /account offer to copy
  contact details from guest orders).
- `otp_codes` — stores a hash of the code, `expires_at`, `attempts`, `consumed_at`.
- `thank_you_cards` — unique `order_id`; unique `token_hash`; `claim_deadline`; `status`.
- `vouchers` — unique `card_id`; unique `used_order_id`; `status`
  (`active` / `used` / `expired` / `void`).
- `resellers` — later (not v1).
- `staff_users` — full RBAC columns in §9.
- `audit_log`

## 6. Overview dashboard metrics

- **Omzet** (canonical revenue, owner decision 2026-10-24,
  [docs/plans/dashboard-overview.md](plans/dashboard-overview.md) §1): `subtotal_amount -
  discount_amount` of orders in `to_ship`, `shipped` or `completed` (Siap Kirim, Dikirim,
  Selesai), dated by `order_date` in Asia/Jakarta. Excluded: `awaiting_payment`, `cancelled`,
  `returned`, and web orders whose payment is `refunded` or `chargeback`; a later return removes
  the order from its original date. A `partially_refunded` web order counts minus its refunded
  amount (capped at the goods amount). Ongkir is out (pass-through); the voucher is a reduction;
  product discounts are already in `unit_price`. Platform fees are not subtracted (later, net
  profit). Per-line breakdowns spread each order's omzet over its lines so they add up to omzet.
- **Laba kotor** = omzet − Σ `qty × unit_cost` (HPP locked when stock left). Lines with
  `unit_cost = 0` are flagged as incomplete HPP. The shipping subsidy is not in laba kotor.
- Omzet vs. the first-year target (`sales_goal`, one row: Rp 1.000.000.000 from 1 November 2026,
  editable on `/settings`), straight-line pace for now, shown year-to-date and for the current
  month. Amounts, profit and target progress only with `finance.view_profit`.
- 7-day average revenue — chart only, no status color.
- Units sold per SKU.
- Size mix vs. the cutting ratio per fabric roll: **XS2-S4-M4-L3-XL2**. A gap of more than 10
  percentage points from the cutting ratio is flagged yellow. `ALLSIZE` variants (one-size-fits-
  all products, `products.size_mode = 'all_size'`) are excluded from this metric entirely — they
  have no place in a cutting ratio.
- Stock per SKU vs. its minimum threshold.
- Profit per order, computed from the actual marketplace payout once available; until the payout
  arrives, use the 18% marketplace-fee assumption from `cost_assumptions`.
- ROAS per channel — break-even ROAS is **8.3**.
- Cancellations + returns rate vs. the 3% reserve target.
- Vouchers printed / claimed / redeemed counts.

## 7. Cost assumptions (initial `cost_assumptions` row)

| Assumption | Value |
|---|---|
| Marketplace fee | 18% |
| Ads | 12% |
| Returns reserve | 3% |
| Target net profit | 20% |
| Packaging | IDR 4,000 / piece |
| **Max COGS** | selling price × 47% − IDR 4,000 |

## 8. Open decisions (defaults — use until explicitly changed)

- Vouchers **stack with per-product discounts** (owner decision 2026-10-23,
  [docs/plans/product-discount.md](plans/product-discount.md)): the voucher applies to the
  already-discounted goods subtotal (`discount_amount = min(voucher, subtotal)`, never ongkir).
  Vouchers still cannot be combined with any other promo.
- A voucher is **voided** if its source order is cancelled or returned before the voucher is
  used.
- A voucher is **restored** if the main-site order that used it is cancelled or its payment
  expires, provided the voucher has not since expired (an expired one stays expired). It is
  **not** restored when the order is later returned.
- The shipping address is collected at **checkout**, not at claim time.
- OTP delivery is via **email first**; WhatsApp delivery may be added later.
- Payment gateway: **Midtrans** (Snap, redirect mode), methods limited to QRIS, GoPay, ShopeePay
  and BCA / BNI / BRI / Mandiri / Permata virtual accounts. **No card payments.** Ammari absorbs
  gateway fees.
- Courier: **Biteship** (decided 2026-10-21, replacing Komerce) for area search and rates at
  checkout from launch, and for booking, pickup and tracking (Phase K), on the **Grow** plan
  (Rp149.000/month; Starter for development; see §3.4). **Shipping subsidy of at most Rp20.000
  per order** (2026-10-21; free shipping ended); the buyer pays the rest as "Ongkir". The
  cheapest allowlisted regular service is chosen by the server.
- Order number stays `ORD-YYYYMM-NNNN`, shared across channels.
- Maximum 10 per line and 20 pieces per order. The payment window is 60 minutes and stock is held
  for 75 minutes.
- When a marketplace sale takes the last piece before a web order is paid, the marketplace sale
  stands; the paid web order is flagged for refund or restock.

## 9. Admin access control (RBAC)

- Dynamic RBAC. Every person has their own admin account (no shared accounts). Each staff user
  has exactly one role.
- Permissions are constants defined in code (e.g. `orders.view`, `orders.import`,
  `packing.print_cards`, `stock.view`, `stock.adjust`, `production.manage`, `products.manage`,
  `inventory.view`, `inventory.manage`, `inventory.receive`, `finance.view_profit`,
  `settings.manage`, `customers.view`, `vouchers.void`, `staff.manage`, `roles.manage`,
  `audit_log.view`). A startup/seed step syncs them into the `permissions` table, and any key the
  code matches by literal value also ships in a migration (CLAUDE.md). Roles and role→permission
  mappings live in the database and are editable from the admin UI.
- Inventory split (§5.1a): `inventory.view` reads raw-material stock, suppliers and purchases;
  `inventory.receive` posts a goods receipt (purchase or production output) and nothing else, so
  the person standing next to the delivery can receive without editing documents;
  `inventory.manage` keeps the supplier master, purchase documents, "Tutup pesanan" / "Tutup
  batch", "Batalkan penerimaan", and every defect disposition (return to supplier/tailor, which
  can re-open a closed document; release by lelang / hibah / dibuang; and their reversals). Posting a batch needs `production.manage` plus
  `finance.view_profit`.
- System roles (seeded, `is_system = true`):
  - `super_admin` (held by the husband): every permission, including `roles.manage`,
    `staff.manage`, `audit_log.view`, and risky actions (data corrections, voiding vouchers).
  - `owner` (held by the wife): all business permissions (orders, import, packing, stock,
    production, products, `finance.view_profit`, targets and cost assumptions, customers and
    vouchers), but not `roles.manage`, `staff.manage`, or `audit_log.view` by default.
  - Additional roles for future staff are created from the admin UI.
- Safety rules: `super_admin` cannot be deleted, cannot lose permissions, and can only be granted
  by a `super_admin`. The system refuses to deactivate or demote the last active `super_admin`.
  `owner` cannot be deleted; its permissions are editable by `super_admin` only.
- Enforcement: permissions are checked on the server for every page, server action, and route
  handler — never only by hiding UI. Cost, profit, and payout figures are only returned to roles
  with `finance.view_profit`, including on Overview and Products.
- Every change to roles, role permissions, and staff accounts is written to `audit_log`.
- Schema additions:
  - `roles` — `id`, `key` (unique), `name`, `description`, `is_system`.
  - `permissions` — `id`, `key` (unique), `description`, `group`.
  - `role_permissions` — `role_id`, `permission_id`, unique pair.
  - `staff_users` — `id`, `name`, `email` (unique, `citext`), `role_id`, `is_active`,
    `last_login_at`, timestamps.
- Timeline: tables, seeding the two system roles, and server-side permission checks must be done
  before 1 November 2026; the Roles & Staff management pages ship in the first week of November
  2026 (see §3.2).

## 10. Authentication

Two separate [Better Auth](https://better-auth.com) instances, by design, never sharing tables,
cookies, or secrets:

- **Staff** (`apps/admin` only) — built, detailed in §10.1–§10.2.
- **Customer** (`apps/web`) — login/account built (see docs/plans/voucher-claim.md session 1);
  the voucher claim flow itself (`/claim/[token]`) is session 2, not yet built. §10.3 records the
  design. Adding it touched neither the staff instance's tables nor its config.

Both live in `packages/auth` (`@ammari/auth`), which depends on `packages/db` for schema and the
Drizzle client but owns all Better Auth configuration, hooks, and session/permission-loading
logic. `packages/db` stays schema-only (tables, migrations, seed) — see `staff_auth_*` in §5.3's
sibling schema files.

### 10.1 Staff login (apps/admin)

- **Methods:** email OTP and Google. No passwords, no self sign-up — login succeeds only for an
  email matching an existing `staff_users` row with `is_active = true`.
- **Identity model:** `staff_users` stays the sole source of truth for identity and role.
  Better Auth's own tables (`staff_auth_users`, `staff_auth_accounts`, `staff_auth_sessions`,
  `staff_auth_verifications`) are separate tables linked 1:1 via `staff_auth_users.staff_user_id`
  (`NOT NULL`, `UNIQUE`, `ON DELETE RESTRICT` — enforced at the database level, not just by
  Better Auth's own, more permissive, `additionalField` validation). `role_id`, `is_active`, and
  all RBAC data live only in `staff_users`/`roles`/`role_permissions`, never in a Better Auth
  table.
- **Admission gate:** `user.validateUserInfo` (a Better Auth hook that runs before `create-user`,
  `link-account`, and OAuth `sign-in`, across every authentication method) checks the incoming
  email against `staff_users` and rejects anything that isn't an active match. This is the single
  gate for both login methods — `disableSignUp`/`disableImplicitSignUp` are deliberately **not**
  used, because both would block Better Auth from creating the row a legitimate staff member
  needs on their very first login, before any hook of ours gets to run.
  `databaseHooks.session.create.before` is a second, independent gate that re-checks
  `staff_users.is_active` live on every session creation (not just new accounts) — this is what
  makes a staff member deactivated between logins fail their very next login attempt, and what
  `getStaffSession()` (below) re-derives on every request rather than trusting a cached session.
- **No account enumeration:** the login UI shows one fixed, generic Indonesian error for every
  failure — wrong code, expired code, too many attempts, unknown email, inactive staff, or a
  rejected Google sign-in. The OTP-send step always returns the same response regardless of
  whether the email belongs to an active staff member, an inactive one, or no one at all; the
  actual email is only ever sent for a genuine match.
- **OTP rules** (CLAUDE.md): 6 digits, expires in exactly 5 minutes
  (`@ammari/auth/otp-timing`'s `OTP_EXPIRES_IN_SECONDS` — the one place the server config and
  the login UI's own countdown both read this from, so they can't drift apart), max 5 verify
  attempts, stored **hashed** (Better Auth's `storeOTP: "hashed"`, in `staff_auth_verifications`,
  which fully replaces `otp_codes` for staff login — `otp_codes` is kept only for the voucher
  claim flow, which isn't Better Auth-backed yet).
- **Login UI calls real HTTP endpoints, not `staffAuth.api.*` from a server action:**
  `app/login/login-form.tsx` is a client component using Better Auth's React client
  (`lib/auth/client.ts`) against `/api/auth/*`. This is deliberate, not incidental: Better Auth's
  rate limiter and origin/CSRF check are wired into its HTTP router, not into the `.api` object —
  calling `.api.sendVerificationOTP()`/`.api.signInEmailOTP()`/`.api.signInSocial()` directly from
  a server action would silently skip both. (A 429 from the per-IP limiter gets its own UI
  message, not the generic one — that's a legitimate, non-enumerating signal.)
- **Login UI:** a "Ganti email" button on the OTP step returns to the email step with the
  previous email prefilled and the OTP input cleared — purely client-side, no network call, and
  the anti-enumeration behavior above is untouched (resending from there goes through the exact
  same send path). Two live countdowns, both derived from a `sentAt` timestamp captured the
  moment the send call resolves and persisted to `sessionStorage` (so they survive a refresh —
  always recomputed from that absolute timestamp, never a decrementing tick counter, so they're
  also correct after the tab was backgrounded/suspended, e.g. an iPhone screen lock):
  "Kode berlaku m:ss" → "Kode sudah kedaluwarsa" (disables submit) at the real 5-minute mark, and
  "Kirim ulang dalam m:ss" → "Kirim ulang kode" at the 60s mark (see the cooldown below). The
  countdown math (`remainingMs`/`formatCountdown`/`useCountdown`) lives in `@ammari/ui/lib`,
  shared by both apps. The visible countdown text is `aria-hidden`; a separate
  `aria-live="polite"` region announces only the two discrete state changes (sent → expired),
  never once a second.
- **Rate limiting and throttling — four independent mechanisms**, all configured in
  `packages/auth`'s two Better Auth factories:
  - **Per IP, abuse guard only** (20 sends per 10 minutes), via Better Auth's own limiter, backed
    by the database (`staff_auth_rate_limits`, so limits survive restarts/deploys — see
    `rateLimit: { storage: "database" }` in both factories) and keyed off the `CF-Connecting-IP`
    header — not `X-Forwarded-For` — so a client cannot spoof it (`advanced.ipAddress.
    ipAddressHeaders: ["cf-connecting-ip"]`; confirmed directly against Better Auth's own
    `getIP()`, which checks ONLY the configured header list, with no `X-Forwarded-For` fallback
    when a list is given). See the Pre-deploy checklist below for the infrastructure half of
    this guarantee. Deliberately generous, not the resend cooldown itself: Indonesian mobile
    carriers use CGNAT, where thousands of real customers/staff can share one public IP — a
    tight per-IP rule (closer to "1 per minute") would block legitimate users at launch. Only
    reachable because the login UI goes through the real HTTP endpoint (previous bullet).
  - **Per destination email, a 60-second resend cooldown** — the UI mechanism above this one is
    the real line of defense for a normal user; this is the server-side backstop, enforced via
    `auth_email_throttle` (see below) and a **silent no-op** when violated (same anti-enumeration
    posture as every other throttle outcome here, not a visible error — it's keyed by email, not
    IP, so showing a distinct message would itself be a timing-independent signal about that one
    address).
  - **Per destination email, a 5-per-5-minutes send cap** — unchanged from before, and still
    compatible with the 60s cooldown above: 5 sends 60s apart span 240s, comfortably inside the
    300s window.
  - **Whole-system circuit breaker** — a configurable cap (`globalHourlyCap`, env
    `OTP_GLOBAL_HOURLY_CAP`, default 300/hour) on TOTAL OTP sends across BOTH the staff and
    customer instances (same shared table), protecting the Resend sending quota and
    `mail.ammari.id`'s sender reputation from ever being exhausted. Logs loudly
    (`console.error`) when tripped — this is an operational alarm, not an enumeration boundary.
  - The per-email cooldown/cap/global-cap all share one table, `auth_email_throttle`: one atomic
    `INSERT ... RETURNING` per send attempt computing all three outcomes from the same pre-insert
    snapshot (not a separate count-then-insert — CLAUDE.md requires atomic handling for anything
    concurrent). This exists because Better Auth's own `emailOTP` plugin deletes and recreates
    its single verification row per `(type, email)` on every send, so counting rows in THAT table
    can never see more than one — it cannot back any of these limits on its own.
- **No timing side-channel on OTP-send:** `sendVerificationOTP`'s entire body (throttle check,
  staff lookup, and the actual email send) runs via Next's `after()` — after the HTTP response is
  already sent — so an unknown/inactive/throttled email and a real one are not just
  body-identical but also time-identical from the caller's perspective. Without this, a real
  email provider's network latency would make the valid-account path measurably slower than the
  no-op paths, defeating the enumeration protection above via timing even with an identical
  response body.
- **Cookies:** prefix `ammari_staff`, scoped to the admin app's own origin only (no
  `crossSubDomainCookies`, no parent-domain cookie), `Secure` when that origin is `https://`,
  session `expiresIn` 7 days / `updateAge` 1 day (both set explicitly, not left to the library
  default). `trustedOrigins` is exactly `[BETTER_AUTH_URL]` — never derived from a request
  header.
- **Secrets:** `STAFF_BETTER_AUTH_SECRET` (distinctly named — never the generic
  `BETTER_AUTH_SECRET` — so it can't be confused with the customer instance's own secret once
  that exists). Required at startup in production; the app refuses to start without it.
- **Enforcement in apps/admin:** `proxy.ts` (Next 16's renamed `middleware.ts`) is a coarse gate
  only — "is there any valid staff session" — redirecting to `/login` otherwise; it is never the
  sole authorization boundary. `requirePermission(key)` is called in every page, server action,
  and route handler individually: redirects to `/login` if unauthenticated, renders the 403 page
  (`forbidden()`, `next.config.ts`'s `experimental.authInterrupts`) if the session's role lacks
  the permission. Permission keys are typed from `packages/db/src/rbac/permissions.ts`.
- `last_login_at` is updated on every successful login (`databaseHooks.session.create.after`).

### 10.2 Email delivery

An `EmailSender` interface (`packages/auth`) with three implementations: `ConsoleEmailSender`
(local dev — prints the OTP to the server console), `UnconfiguredEmailSender` (production
without a provider configured — throws loudly rather than silently dropping the email), and
`ResendEmailSender` (calls Resend's REST API directly via `fetch`, no SDK dependency). Both
apps select `ResendEmailSender` the same way: `RESEND_API_KEY` + `EMAIL_FROM` set.

Transactional order emails (Dec 2026, plan §8, built in session 13 as `@ammari/commerce/emails`)
use the same sender (with an HTML part, a plain-text part and an idempotency key), in Indonesian: `created` (order number, lines, total, "Lanjutkan pembayaran", payment deadline in WIB,
"Lihat pesanan"), `paid`, `shipped` (courier and resi), `delivered`, `cancelled`, and `owner_paid`
(to `store_settings.support_email` on every paid order). Guest orders also carry "Masuk ke akun"
(§10.3). They are sent after the transaction commits, guarded by a unique
`order_notifications (order_id, kind)` row so retries never double-send, and a send failure is
recorded but never fails a payment webhook; a cron pass (`POST /api/internal/emails/dispatch`, every
5 minutes) retries failed sends for up to 23 hours and sends "Pesanan dikirim" after staff's manual
"Tandai dikirim". Emails never name the payment gateway.

### 10.3 Customer login (apps/web)

Built — see docs/plans/voucher-claim.md for the full plan; the voucher claim flow itself
(`/claim/[token]`) is built too.

- Self sign-up allowed (unlike staff), via Google or email OTP.
- **Login creates only the minimal identity needed to authenticate — it never captures PDP
  consent.** After sign-in, a mandatory `/consent` step (checkbox linking to `/privacy-policy`
  and `/terms-of-service`, "Lanjutkan" button) gates the claim and account pages for as long as
  `customers.pdp_consent_at` is null; accepting it stamps that column for the signed-in customer.
  The claim server action (session 2) independently re-checks `pdp_consent_at` server-side —
  never only a page-level redirect. Promo consent is not yet captured anywhere (not part of
  session 1's scope); it stays a future, separate, optional checkbox.
- Profile completion is **optional**: `/account/complete-profile` (name, phone) with a "Lewati"
  (skip) button — skipping leaves the account as-is, no write. `customers.phone` is nullable
  (migration `0002`) and **never required** anywhere in the customer-facing flow, including the
  voucher claim — the claim itself needs no form at all beyond being signed in and consented
  (decided plan; supersedes this section's earlier draft, which had the claim form collecting
  name/phone/email). Address is collected at checkout (December), not account creation.
- While phone is missing, a dismissible-per-session (`sessionStorage`) "Lengkapi profilmu"
  banner shows on the account page.
- Account linking: a sign-in whose email already belongs to a customer (e.g. created via a
  voucher claim, or by staff manual order entry) links to that customer instead of creating a
  duplicate. For Google specifically, only on a Google-**verified** email — an unverified Google
  email matching an existing customer is rejected outright, not linked (it can't create a
  separate row either: `customers.email` is `citext UNIQUE`). Email-OTP completion is itself
  proof of ownership, so it always qualifies to link.
- No `proxy.ts` on apps/web — most of the app is intentionally public. `/account`, `/consent`,
  and (session 2) the claim action each check the session server-side individually.
- Schema: separate `customer_auth_*` tables (mirroring `staff_auth_*`), own cookie prefix
  (`ammari_customer`), own secret (`CUSTOMER_BETTER_AUTH_SECRET`), ~60-day sliding session.
  Nothing in the staff instance needed to change to add this; `auth_email_throttle` (the
  per-destination OTP-send cooldown/cap, and the whole-system circuit breaker) is shared by both
  instances via a hoisted helper in `packages/auth/src/shared/email-throttle.ts` — see §10.1's
  "Rate limiting and throttling" for the full mechanism list, unchanged here except that the
  per-email message is the plain `GENERIC_ERROR` (no account-existence distinction to protect).
  The login UI itself (Ganti email, both countdowns) is identical to staff's — same
  `@ammari/ui/lib` countdown hook, same `sessionStorage` persistence.
- Email delivery: `ResendEmailSender` (see §10.2) is shared with the staff instance — same
  `RESEND_API_KEY`/`EMAIL_FROM` env vars, selected the same way in both apps.

**Guest checkout, order access and the order login link (Dec 2026, plan §9).** Checkout never
creates a session, so a guest has no silent login. Instead a guest order's emails carry two
separate links:

- **"Lihat pesanan"** — view-only access to that one order: 32 random bytes, only the sha256
  stored, URL `/orders/<orderNo>?t=<token>` (moved into an httpOnly cookie scoped to that order
  and removed from the URL on first open). Valid 120 days from the email that issued it; no other
  orders, vouchers or account data; the only actions are re-opening the stored payment link and,
  on a cancelled unpaid order, "Pesan lagi" (which only fills the visitor's own cart). The token
  request renders nothing (`Referrer-Policy: no-referrer`); the token-free page sends `same-origin`.
  Rate limited. An expired, wrong or unknown link reads the same as an order the visitor may not
  see, with an email-OTP login. "Pesanan saya" shows a guest order linked by email only while its
  contact email is the account's current, verified email (owner decision 2026-10-21).
- **"Masuk ke akun"** — a one-time login link, implemented as a **small custom Better Auth
  plugin** on the customer instance (the stock `magic-link` plugin in 1.7.7 logs in on GET, does
  not invalidate older links and has public issuance, so it is not used). Rules: issued
  server-side only (no public endpoint); valid 24 hours; single use; stored hashed; bound to the
  customer id and the email it was sent to; a newer link supersedes the older one (at most one
  live link per customer, enforced by a partial unique index); at most 5 issued per customer per
  24 hours, the only issuance limit (the OTP email throttle is never written by order emails, owner
  decision 2026-10-21; over the limit the email still goes out, without this link). Only the
  `created` and `paid` emails of a guest order carry it.
- **Opening the link never logs in.** `/login/link?token=...` (GET) is `noindex`, sends
  `Referrer-Policy: same-origin` (owner decision 2026-10-21: `no-referrer` would make the form POST
  carry `Origin: null`) and refuses framing, does a read-only lookup and shows "Masuk sebagai a***@..." with
  a "Masuk" button (or "Link sudah tidak berlaku" with an OTP login link), so mail scanners and
  prefetchers cannot consume it. Login happens only on the button's POST, protected by Better
  Auth's form CSRF and origin check plus a rate limit (10 per 10 minutes per IP). The consume is
  one atomic `UPDATE ... WHERE consumed_at IS NULL AND superseded_at IS NULL AND expires_at >
  now() RETURNING`; it then re-checks the customer's email still matches, marks the email
  verified (the click proves ownership), and creates the session through Better Auth with the
  same cookie and hooks as OTP and Google logins. Every consume is written to `audit_log` (no
  staff actor). After login the user lands on "Pesanan saya" (`/orders`), the guest
  cart merges, and the `/consent` gate still applies. A login that fails before a session exists
  gives the link back.
- **Contact details from guest orders** (owner decision 2026-10-21): a guest checkout records the
  WhatsApp number and promo choice only on the order. After any login, `/account` offers them (the
  number only if the account has none and no other account uses it; promo consent only when ticked
  again); nothing is copied without "Simpan".
- The checkout finish page offers a third, separate path: "Masuk untuk melihat semua pesanan",
  which goes to `/login?next=/orders` with the contact email prefilled (email OTP).
- Customer sessions still never reach admin endpoints (unchanged).

## 11. Pre-deploy checklist

Added for the Dec 2026 checkout (details in docs/plans/cart-checkout.md §12, §14 and §15
session 17; step-by-step runbooks: `docs/launch/checkout-dev.md` and `docs/launch/checkout-prod.md`): Midtrans production approval for exactly
the §3.4 methods and production keys in the prod env; the payment notification URL set, and the
dev site's Cloudflare Access bypass for exactly that one path; the internal cron service (expiry
sweeper every 5 minutes, retention job daily, Biteship tracking polls in Phase K) with
`INTERNAL_CRON_SECRET`, on the internal network only (Caddy does not route `/api/internal/*`);
owner-edited privacy policy and terms in admin Konten before launch; footer payment chips
changed to QRIS, Virtual Account, GoPay, ShopeePay. Before checkout launch (added 2026-10-21):
a Biteship **Grow** subscription (Biteship replaced Komerce, §3.4) with the allowlisted couriers
activated and a `biteship_live.` key in the prod env; the shipping variables set by name
(apps/web: `BITESHIP_API_KEY`, `BITESHIP_BASE_URL`, `BITESHIP_ORIGIN_AREA_ID`,
`BITESHIP_DAILY_MAPS_BUDGET`, `BITESHIP_DAILY_RATES_BUDGET`, `SHIPPING_QUOTE_CACHE_MINUTES`,
`SHIPPING_RATE_PROVIDER`; a test key is refused when `DEPLOY_ENV=production`; details in plan
§12), the daily budgets at or below the plan's monthly quotas / 31, every published product with
a shipping weight, and the announcement bar, Pengiriman page, privacy policy and terms re-worded
for the subsidy. Before Phase K goes live: Biteship's live Order API activated for the account,
the webhook registered in the Biteship dashboard with `BITESHIP_WEBHOOK_PATH_TOKEN`, the shipper
variables (`BITESHIP_SHIPPER_*`) and `BITESHIP_*` in the admin env too.

The dev deploy pipeline (`.github/workflows/deploy-dev.yml`, `docs/deploy.md`) is built. Items
below marked **(automated)** are enforced by that pipeline/image and need no per-deploy action;
everything else is still a manual, one-time step the owner does by hand (`docs/deploy.md` is the
step-by-step runbook) before the *first* deploy to any given environment (dev or prod):

- **Cloudflare origin trust (automated, image-independent):** `deploy/Caddyfile` requires the
  Cloudflare origin-pull client certificate on every TLS handshake (Authenticated Origin Pulls),
  not just an IP allowlist — confirmed necessary because Docker inserts its own iptables rules
  that bypass ufw's filtering of published ports, so a ufw-only allowlist would leave Caddy (and
  therefore a spoofable `CF-Connecting-IP`) reachable from anywhere. Defense in depth
  (`deploy/cloudflare/cloudflare-only.caddy`, generated by `deploy/update-cloudflare-ips.sh`)
  also rejects non-Cloudflare source IPs. Both were validated against a real `caddy:2.10.2`
  instance (config validation + an actual TLS handshake rejected without a client cert) during
  development — still manual: downloading the real origin cert and origin-pull CA from the
  Cloudflare dashboard onto the VPS (`deploy/cloudflare/README.md`), and the runbook's own
  "curl the VPS IP directly, bypassing Cloudflare, must fail" verification step.
- **Email provider:** `ResendEmailSender` (§10.2) is implemented; `RESEND_API_KEY`/`EMAIL_FROM`
  still need real values set in each environment — production refuses to start without them
  (`UnconfiguredEmailSender` throws rather than silently dropping OTP emails otherwise), so this
  still blocks any real deploy until those env vars are actually filled in.
- **sharp platform binaries (product images) (automated, but fragile — read this):** verified
  empirically, not assumed: a plain `next build` under this Next 16/Turbopack setup does NOT
  carry `sharp` into `.next/standalone` at all (output-file tracing silently drops it, even
  though `sharp` is on Next's own built-in server-external-packages list) — confirmed by
  `require("sharp")` working fine in the Docker build stage but failing with
  `Cannot find module 'sharp'` in the copied runtime image before `apps/admin/Dockerfile`'s
  explicit workaround (flattening pnpm's real, already-resolved sharp install — the package
  itself, its sibling regular dependencies pnpm resolves alongside it, and its platform-specific
  `@img/sharp-linux-x64`/`@img/sharp-libvips-linux-x64` binaries — into a fixed location the
  runtime stage copies directly, bypassing tracing a second time). If `sharp` is ever upgraded,
  or the build moves off Turbopack, or Next fixes this tracing gap, re-verify by actually
  running `require("sharp")` inside the built image (`apps/admin/Dockerfile`'s own comments walk
  through exactly how this was diagnosed) — don't assume a future Next version still needs the
  workaround, but don't remove it on faith either.
- **Prod bucket public access:** the prod R2 bucket (`ammari-prod`) needs a Cloudflare custom
  domain connected (R2 dashboard → bucket → Settings → Public access → Custom Domains →
  `img.ammari.id`) before any uploaded image is reachable — there is no bucket-policy API on R2
  and no per-prefix tooling to run; the whole bucket becomes public once the domain is
  connected. Verify with `pnpm --filter @ammari/storage storage:check` — see docs/deploy.md's
  "Public image access" section and `docs/plans/storage-r2.md`.
- **`MAIN_SITE_URL` (apps/admin):** apps/web's own public base URL — `https://ammari.my.id` on
  dev, `https://ammari.id` in production (no trailing slash; must be `https://` once
  `NODE_ENV=production`, enforced by `apps/admin/src/lib/main-site-url.ts`). Every thank-you-card
  claim URL this app generates (the packing feature's QR + printed fallback text, §4.2) is built
  from this — get it wrong and every card printed in that environment points at the wrong site.
