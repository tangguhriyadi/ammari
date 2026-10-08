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

**Next:**

- Stock (`/stock`).
- Production (`/production`).
- Orders import (`/import` — Shopee/TikTok Shop export parsing).
- Packing (`/packing`) + QR thank-you cards.
- Overview dashboard (§6 metrics).
- Main site (`apps/web`) — see §3.3/§3.4 for v1 and December 2026 scope.

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
    Sumopod dev database).
  - `main` branch → auto-deploys to prod (`ammari.id`, `admin.ammari.id`, prod database).
  - All work happens on `dev` (small features may use short-lived branches merged into `dev`).
    A release is a merge from `dev` into `main`.
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
- Import — upload Shopee/TikTok Shop order and income exports; preview before saving; merges
  duplicate SKU rows within one order before inserting (see `order_items` in §5.2)
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
- `production_batches`
- `production_batch_items`
- `stock_movements` — an append-only ledger: signed `qty` (±), `type`
  (`production` / `sale` / `return` / `adjustment`), and a `reference`. Current stock for a SKU is
  `SUM(qty)` over its movements — never a mutable stock counter.

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

## 10. Authentication

Two separate [Better Auth](https://better-auth.com) instances, by design, never sharing tables,
cookies, or secrets:

- **Staff** (`apps/admin` only) — built this session, detailed in §10.1–§10.2.
- **Customer** (`apps/web`, from the main site's OTP login / voucher claim flow onward) — **not
  built yet**. §10.3 records the design so it can be added later without touching the staff
  instance.

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
- **OTP rules** (CLAUDE.md): 6 digits, expires in 5 minutes, max 5 verify attempts, stored
  **hashed** (Better Auth's `storeOTP: "hashed"`, in `staff_auth_verifications`, which fully
  replaces `otp_codes` for staff login — `otp_codes` is kept only for the voucher claim flow,
  which isn't Better Auth-backed yet).
- **Login UI calls real HTTP endpoints, not `staffAuth.api.*` from a server action:**
  `app/login/login-form.tsx` is a client component using Better Auth's React client
  (`lib/auth/client.ts`) against `/api/auth/*`. This is deliberate, not incidental: Better Auth's
  rate limiter and origin/CSRF check are wired into its HTTP router, not into the `.api` object —
  calling `.api.sendVerificationOTP()`/`.api.signInEmailOTP()`/`.api.signInSocial()` directly from
  a server action would silently skip both. (A 429 from the per-IP limiter gets its own UI
  message, not the generic one — that's a legitimate, non-enumerating signal.)
- **Rate limiting — two independent mechanisms:**
  - Per IP, via Better Auth's own limiter, backed by the database (`staff_auth_rate_limits`, so
    limits survive restarts/deploys) and keyed off the `CF-Connecting-IP` header — not
    `X-Forwarded-For` — so a client cannot spoof it. See the Pre-deploy checklist below for the
    infrastructure half of this guarantee. Only reachable because the login UI goes through the
    real HTTP endpoint (previous bullet).
  - Per destination email, via a dedicated `auth_email_throttle` table: one atomic
    `INSERT ... RETURNING (SELECT count(*) ...)` per send attempt (not a separate count-then-
    insert — CLAUDE.md requires atomic handling for anything concurrent). This exists because
    Better Auth's own `emailOTP` plugin deletes and recreates its single verification row per
    `(type, email)` on every send, so counting rows in that table can never see more than one —
    it cannot back a per-destination limit on its own.
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

An `EmailSender` interface (`packages/auth`) with two implementations: `ConsoleEmailSender`
(local dev — prints the OTP to the server console) and `UnconfiguredEmailSender` (production
without a provider configured — throws loudly rather than silently dropping the email). A real
provider is not yet chosen; see the Pre-deploy checklist.

### 10.3 Customer login (apps/web) — design only, not built

- Self sign-up allowed (unlike staff), via Google or email OTP.
- Profile completion is **optional**: after a first Google sign-in, a "Lengkapi profil" page
  (phone, address, promo consent) with a "Lewati" (skip) button — skipping still creates the
  account.
- Privacy consent **cannot** be skipped: "Dengan melanjutkan, kamu menyetujui Kebijakan Privasi
  Ammari" (linked) on the sign-up screen, with `pdp_consent_at` recorded at account creation.
  Promo consent stays a separate, optional, unticked checkbox.
- `customers.phone` is nullable (migration `0002`, done this session) but still **required**
  where it matters operationally: the voucher claim form, and at checkout (December). Address is
  collected at checkout, not account creation.
- While phone is missing, a dismissible-per-session "Lengkapi profilmu" banner shows after login
  and on the account page.
- Account linking: a Google sign-in whose email already belongs to a customer (e.g. created via a
  voucher claim) links to that customer instead of creating a duplicate — only on a
  Google-**verified** email.
- Schema: separate `customer_auth_*` tables (mirroring `staff_auth_*`), own cookie prefix
  (reserved: `ammari_customer`), own secret (reserved: `CUSTOMER_BETTER_AUTH_SECRET`). Nothing in
  the staff instance needs to change to add this.

## 11. Pre-deploy checklist

Items that must be satisfied before the **first** deploy to any real environment (dev or prod),
beyond the per-feature work tracked elsewhere in this document:

- **Cloudflare IP allowlisting:** the VPS must accept HTTP(S) only from Cloudflare (firewall
  allowlist of Cloudflare IP ranges, or Authenticated Origin Pulls), and Caddy must not trust a
  client-supplied `CF-Connecting-IP` on any request that didn't actually arrive through
  Cloudflare. Otherwise the auth rate limit (§10.1) can be bypassed by spoofing that header on a
  direct-to-origin request.
- **Email provider:** `EmailSender` has no real implementation yet (§10.2) — production currently
  refuses to start without one (`UnconfiguredEmailSender` throws rather than silently dropping
  OTP emails), so this blocks any real deploy, not just a "nice to have."
- **sharp platform binaries (product images):** `sharp` ships prebuilt native binaries per
  platform/libc — the ones resolved into `node_modules` on a developer's Mac are NOT the ones
  Linux/the Docker image needs. Verify in the actual Docker build/image (not just locally) that
  `sharp` loads correctly for the base image's OS and libc (e.g. Alpine/musl vs Debian/glibc) —
  a mismatch fails at require-time (`Could not load the "sharp" module`), not at build time, so a
  green `pnpm build` locally proves nothing about the deployed image. Confirm pnpm's
  `allowBuilds.sharp` (`pnpm-workspace.yaml`) carries through the image's own `pnpm install`.
- **Prod bucket policy:** the prod S3 bucket needs its own public-read policy for `products/*`
  (and the `healthcheck/*` prefix used by `packages/storage`'s own check), mirroring
  `packages/storage/bucket-policy.dev.json` but scoped to the prod bucket's own ARN/prefixes —
  that file only covers the dev bucket (`ammaridev-uc1gfp`).
