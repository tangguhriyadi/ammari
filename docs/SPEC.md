# Ammari — Product & Technical Specification

Ammari is a syar'i gamis (modest Muslim dress) brand based in Bandung, Indonesia, run by a
husband (former software engineer) and his wife (non-technical, handles day-to-day operations).
This document is the source of truth for scope, architecture, data model, and business rules for
v1. `CLAUDE.md` at the repo root points here for details and should stay in sync with this file.

## Status

**Built:**

- Schema v1 (`packages/db`): products/fabrics/catalog, orders & finance, customers & vouchers,
  RBAC, staff auth tables.
- Staff auth + RBAC (`apps/admin`): email OTP + Google login, server-side permission checks (§9,
  §10.1).
- Admin shell: app shell, design tokens, permission-aware navigation.
- Products, fabrics, and fabric colors (`apps/admin`), including SKU generation and pagination.
- Product photos, per color, with thumbnail selection, staged uploads, and S3-backed storage
  (`packages/storage`).
- Customer auth + account (`apps/web`): email OTP + Google self-signup, mandatory PDP consent
  step, optional profile completion (§10.3).
- Stock (`/stock`), production (`/production`), and raw-material stock (fabric and accessories),
  all on append-only, moving-average ledgers (§5.1).
- Suppliers (`/suppliers`), purchase documents with goods receipts (`/purchases`), production
  output receipts, defect stock recorded at receipt (`/stock/defects`, plus a "Cacat" figure on
  every stock list and item page), and defect dispositions: return to the supplier/tailor for a
  replacement (re-opening a closed document), release by lelang / hibah / dibuang, their
  reversals, and read-only variance figures on each purchase and batch (§5.1a;
  docs/plans/suppliers-goods-receipt.md sessions S1–S6). The `/receipts` list and the polish
  sweep are that plan's S7.

**Next:**

- Orders import (`/import` — Shopee/TikTok Shop export parsing).
- Packing (`/packing`) + QR thank-you cards.
- Overview dashboard (§6 metrics).
- Main site (`apps/web`) — voucher claim flow and the rest of §3.3/§3.4's v1 and December 2026
  scope.

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
  plus a dedicated, private prod backups bucket (see `docs/plans/storage-r2.md`).
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

### 3.4 Main site — 1 December 2026

- Cart — `/cart`
- Checkout — `/checkout`
- Payment
- Shipping cost calculation
- Voucher redemption
- Order status — `/orders`

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
  SKU).
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
  colors).
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
- `defect_movements` — **defect stock** (stok barang cacat), one append-only ledger for all three
  item kinds (`item_kind` `sku` / `fabric` / `accessory`, exactly one of `sku` / `fabric_id` /
  `accessory_id`, always naming its source purchase line or batch line). A separate table on
  purpose: defect stock can never be sold, ordered, packed, shown as available on the main site,
  or counted as sellable, because none of those paths reads this table. Balance and value per
  item are `SUM(qty)` / `SUM(value_amount)` (its own moving-average pool, never mixed into the
  sellable average or HPP). Types: `reject` (written by a receipt, 1:1 with `qty_rejected`),
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
    stock at the pool's average value and re-open exactly that much outstanding on the line; the
    replacement arrives through the normal receipt on the same document, which can then reach
    `received`. A return against a **closed or cancelled** document (or a short-closed batch)
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

### 5.2 Orders & finance

- `channels` — `shopee`, `tiktok`, `web`, `reseller`.
- `orders` — unique on `(channel_id, channel_order_no)`.
- `order_items` — `unit_cost` is **locked** at the moment the order is recorded (not recomputed
  later if cost assumptions change); unique on `(order_id, sku)`. If a marketplace export has
  several rows for the same SKU in one order, the importer **merges them into one line** before
  inserting: `qty` summed, `unit_price` the weighted average rounded to the nearest whole
  rupiah.
- `order_settlements` — actual payout data from the marketplace, arrives after `orders`.
- `import_batches` — tracks each Shopee/TikTok export upload.
- `payments` — unique on `provider_ref`. Not yet implemented — part of the Dec 2026 cart/checkout
  work (§3.4), same as `customer_addresses` below.
- `ad_spend_daily` — unique on `(date, channel)`.
- `expenses`
- `targets` — one row per month.
- `cost_assumptions` — dated by `effective_from`; see §7 for the initial row.

### 5.3 Customers & vouchers

- `customers` — `phone` nullable (optional at account creation; see §10.3) but unique when
  present; unique `email` (stored as `citext` for case-insensitive matching); verification
  timestamps; `pdp_consent_at`; `promo_consent_at`; `type` (`retail` / `reseller`).
- `customer_addresses` — not yet implemented, see the `payments` note in §5.2.
- `otp_codes` — stores a hash of the code, `expires_at`, `attempts`, `consumed_at`.
- `thank_you_cards` — unique `order_id`; unique `token_hash`; `claim_deadline`; `status`.
- `vouchers` — unique `card_id`; unique `used_order_id`; `status`
  (`active` / `used` / `expired` / `void`).
- `resellers` — later (not v1).
- `staff_users` — full RBAC columns in §9.
- `audit_log`

## 6. Overview dashboard metrics

- Net revenue from completed orders vs. the target curve, shown year-to-date and for the current
  month.
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

- Vouchers cannot be combined with other promos.
- A voucher is **voided** if its source order is cancelled or returned before the voucher is
  used.
- A voucher is **restored** if the main-site order that used it is cancelled, provided the
  voucher has not since expired.
- The shipping address is collected at **checkout**, not at claim time.
- OTP delivery is via **email first**; WhatsApp delivery may be added later.
- Payment gateway and shipping-rate provider are **not yet chosen**.

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

### 10.3 Customer login (apps/web)

Built — see docs/plans/voucher-claim.md (session 1) for the full plan; the voucher claim flow
itself (`/claim/[token]`) is session 2, not yet built.

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

## 11. Pre-deploy checklist

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
