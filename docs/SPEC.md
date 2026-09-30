# Ammari — Product & Technical Specification

Ammari is a syar'i gamis (modest Muslim dress) brand based in Bandung, Indonesia, run by a
husband (former software engineer) and his wife (non-technical, handles day-to-day operations).
This document is the source of truth for scope, architecture, data model, and business rules for
v1. `CLAUDE.md` at the repo root points here for details and should stay in sync with this file.

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
- **Prod:** a separate managed Postgres 16 + pgvector instance. Dev and prod databases are
  always separate.
- **Local:** Postgres 16 + pgvector via the root `docker-compose.yml`, for local development and
  automated tests only. A laptop never connects to the Sumopod dev database directly — local
  work always talks to the local container.
- **Object storage:** S3-compatible, with separate dev and prod buckets.
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
- Import — upload Shopee/TikTok Shop order and income exports; preview before saving
- Packing — queue view + print a QR thank-you card per order, or in bulk
- Products & SKUs
- Stock
- Production
- Settings — targets, cost assumptions, staff

### 3.2 Admin — first week of November 2026

- Ads & expenses
- Customers & vouchers
- Roles & staff — see §9

### 3.3 Main site — v1 (1 November 2026)

- Home (company profile)
- Catalog
- Product detail — the buy button temporarily links out to Shopee/TikTok Shop (no cart yet)
- Voucher claim — `/k/<token>`
- OTP login
- My account — vouchers + their expiry dates
- Privacy policy

### 3.4 Main site — 1 December 2026

- Cart
- Checkout
- Payment
- Shipping cost calculation
- Voucher redemption
- Order status

## 4. Voucher & QR thank-you card program

### 4.1 Purpose and scope

A thank-you card with a unique QR code is printed **per order** during packing, **only** for
Shopee/TikTok Shop orders. The card must never invite the buyer to leave the marketplace (no
"follow us" / "order direct next time" language) — it exists to drive account creation and repeat
purchases on the main site without violating marketplace policy.

### 4.2 Token

- The QR encodes `ammari.id/k/<token>`.
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
5. Login is passwordless (OTP-based) throughout — there is no password to set.

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

- `fabrics`
- `products`
- `product_variants` — `sku` is the primary key; unique on `(product, color, size)`; sizes
  XS–XL.
- `product_images`
- `production_batches`
- `production_batch_items`
- `stock_movements` — an append-only ledger: signed `qty` (±), `type`
  (`production` / `sale` / `return` / `adjustment`), and a `reference`. Current stock for a SKU is
  `SUM(qty)` over its movements — never a mutable stock counter.

### 5.2 Orders & finance

- `channels` — `shopee`, `tiktok`, `web`, `reseller`.
- `orders` — unique on `(channel_id, channel_order_no)`.
- `order_items` — `unit_cost` is **locked** at the moment the order is recorded (not recomputed
  later if cost assumptions change).
- `order_settlements` — actual payout data from the marketplace, arrives after `orders`.
- `import_batches` — tracks each Shopee/TikTok export upload.
- `payments` — unique on `provider_ref`.
- `ad_spend_daily` — unique on `(date, channel)`.
- `expenses`
- `targets` — one row per month.
- `cost_assumptions` — dated by `effective_from`; see §7 for the initial row.

### 5.3 Customers & vouchers

- `customers` — unique `phone`; unique `email` (stored as `citext` for case-insensitive
  matching); verification timestamps; `pdp_consent_at`; `promo_consent_at`; `type`
  (`retail` / `reseller`).
- `customer_addresses`
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
  percentage points from the cutting ratio is flagged yellow.
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
  `finance.view_profit`, `settings.manage`, `customers.view`, `vouchers.void`, `staff.manage`,
  `roles.manage`, `audit_log.view`). A startup/seed step syncs them into the `permissions`
  table. Roles and role→permission mappings live in the database and are editable from the admin
  UI.
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
