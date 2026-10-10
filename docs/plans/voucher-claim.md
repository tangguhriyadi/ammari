# Plan: Voucher Claim on the Main Site (`apps/web`) + Customer Login

**Status:** Approved 2026-10-10. Session 1 (apps/web bootstrap + customer login + consent) in
progress; sessions 2 (claim flow) and 3 (e2e harness) not started.

**Deadline:** must work before ~3 Nov 2026 (first buyers scan cards printed from 1 Nov 2026).

## Grounding — what already exists

- **Schema** (`packages/db/src/schema/customers.ts`): `customers`, `thankYouCards`, `vouchers`
  all already exist with the right shape — no changes needed to any of them. `thankYouCards`
  (`orderId`, `tokenHash` unique, `status` active/claimed/void, `claimDeadline`,
  `claimedByCustomerId`, `claimedAt`) and `vouchers` (`cardId` unique, `customerId`, `amount`
  default 20000, `status`, `issuedAt`, `expiresAt`, `usedOrderId` unique) are exactly what the
  claim flow needs.
- **`otp_codes`/`OTP_PURPOSES`**: confirmed dead code — referenced nowhere outside their own
  schema file. Predates the decision to give customers their own Better Auth instance (mirroring
  staff, which never used `otp_codes` either — it uses `staff_auth_verifications`). **Dropped in
  this work** (decision #1 below).
- **`docs/plans/packing-cards.md`**: the token model (`generateClaimToken`/`hashClaimToken`,
  Crockford Base32, sha256 of the *string* form) and two standing responsibilities it already
  hands to this future claim page: (1) strip non-alphanumerics + uppercase manual input before
  hashing, (2) independently re-check the source order isn't cancelled/returned — never trust
  that an `active` card implies a live order.
- **`packages/auth/src/staff/*`**: the exact Better Auth factory pattern
  (`createStaffAuth`/`staff-data.ts`) mirrored for the new customer instance. Staff's
  `mintThankYouCard` (`apps/admin/src/lib/packing/queries.ts`) is the transaction pattern
  (`SELECT ... FOR UPDATE` → branch → write, inside `db.transaction`) the claim action will
  mirror in session 2.
- **`apps/web`'s starting state**: an empty Next.js scaffold (`app/layout.tsx` + `app/page.tsx`
  only) — no `@ammari/ui`, no `@ammari/auth`, no `better-auth`, no fonts/theme wired, no e2e.
  This plan bootstraps all of that.
- **`@ammari/ui`**: already app-agnostic; its own `theme.css` doc comment already says "shared by
  @ammari/admin and (later) @ammari/web" — confirms the intended reuse point.
- Next migration number: **`0015`**.

## Decided rules (unchanged from the approved plan)

- Voucher Rp20.000, one per order/card, no minimum, redeemable only on ammari.id. Claim deadline
  = `thank_you_cards.claim_deadline`. Once claimed, valid 3 calendar months from claim date, end
  of day Jakarta, clamped to month-end (reuses `claimDeadlineFromOrderDate`'s clamping logic,
  applied to the claim date instead of the order date).
- Reject cards that are void, already claimed, expired, or whose source order is
  cancelled/returned — friendly Indonesian messages, never more detail than necessary.
  - **Exception, approved addition**: if the signed-in customer re-opens a card **they
    themselves** claimed, show "Voucher ini sudah kamu klaim" with a link to `/account` — not an
    error. Claimed by someone else still gets the generic "sudah diklaim" message.
- Manual entry at `/claim` (no token): strip non-alphanumerics, uppercase, then hash — same
  normalization the packing plan already documents for this page.
- Customers sign in with Google or email OTP (same hardening as staff: hashed 6-digit OTP,
  5-minute expiry, 5 attempts, DB-backed rate limit, per-email throttle, IP from
  `cf-connecting-ip`). Separate Better Auth instance: separate tables (`customer_auth_*`),
  separate secret (`CUSTOMER_BETTER_AUTH_SECRET`), separate cookie prefix (`ammari_customer`),
  ~60-day sliding session. Google sign-up allowed. Profile completion (name, phone) is optional
  with a "Lewati" button and a dismissible-per-session reminder banner on `/account`.
  - **Login itself only creates the minimal identity needed to authenticate** — no PDP consent
    is captured at login time (see decision #2).
- PDP consent: see decision #2 — a mandatory post-login consent step, not a login-time checkbox.

## Decisions from this round

1. **Drop `otp_codes` and `OTP_PURPOSES`** in migration `0015`. Confirmed unused anywhere in the
   codebase; the customer Better Auth instance makes them permanently dead.
2. **PDP consent — option (c)**: login creates only the minimal identity (no consent capture at
   that point). After sign-in, if `customers.pdp_consent_at` is null, a mandatory consent step
   (`/consent` — checkbox linking to `/privacy-policy` and `/terms-of-service`, "Lanjutkan"
   button) blocks the claim and account pages until accepted. Accepting sets `pdp_consent_at` for
   the signed-in customer. The **claim server action must independently reject if
   `pdp_consent_at` is null** — server-side, not just a UI redirect (session 2).
3. **No `proxy.ts` on `apps/web`.** `/account`, the consent step, and the claim action each check
   the session server-side, individually. Most of this app is intentionally public (catalog,
   home, claim preview); a coarse gate has nothing to protect that its own per-page checks don't
   already cover.
4. **`docs/SPEC.md` gets updated** (§3.3, §4.3, §10.3) as part of this work, not as an
   afterthought — it currently describes the *old* design (claim page collects name/phone/email
   + two checkboxes, matches existing accounts by phone-or-email), which this plan supersedes.
   Per CLAUDE.md, SPEC.md must win; the fix is to make it match what's actually built.
5. **Delivery split into 3 sessions** (small, independently committable, per CLAUDE.md):
   - **Session 1** (this one): `apps/web` bootstrap, customer Better Auth instance, login,
     mandatory consent step, account + profile completion, legal page placeholders, Resend email
     sender.
   - **Session 2**: the claim flow itself (`/claim/[token]`, `/claim`, the atomic claim
     transaction, voucher creation, success page, `/account` voucher list) + admin-side "Diklaim"
     display on `/packing` and `/orders/[id]`.
   - **Session 3**: e2e harness for `apps/web` (mirrors admin's Playwright setup) + the full
     scan → login → claim → account flow at 390px/1280px in Chromium and WebKit.

### Additions from this round

- **Already-claimed-by-me is not an error** (see "Decided rules" above) — session 2.
- **`claim_rate_limits` must not grow forever.** Same opportunistic-cleanup treatment extends to
  `auth_email_throttle`, which also currently lacks any pruning. Both get a plain `created_at`
  index (for an efficient age-based delete) and an opportunistic cleanup call (low-probability,
  on every insert) from whichever helper function writes to them.
- **Audit log entries must never contain the raw claim token** — only `thank_you_cards.id`
  (session 2; the raw token is never persisted anywhere, matching the existing packing-side
  convention).
- **Voucher expiry** = `claimedAt` + 3 calendar months, end of day Jakarta, clamped to
  month-end — reuses `claimDeadlineFromOrderDate`'s clamping logic (session 2).
- **Google OAuth**: both the staff and customer OAuth clients can live in the same Google Cloud
  project and share one consent screen — just two separate "OAuth 2.0 Client ID" credentials
  within it, each with its own redirect URI. (Corrects this plan's earlier "different consent
  screen" wording.)
- **Email delivery**: build `ResendEmailSender implements EmailSender` in `packages/auth`,
  selected by env (`RESEND_API_KEY` + `EMAIL_FROM`), usable by **both** apps. Keep
  `ConsoleEmailSender` for local/e2e. `apps/admin`'s own `emailSender()` selection is updated to
  use it too when configured — this also happens to close the "no real EmailSender" item on
  SPEC's pre-deploy checklist for staff login, not just customer login.

---

## Schema changes — migrations `0015` and `0016`

(Split into two migrations during implementation: `drizzle-kit generate` prompts interactively to
resolve a same-diff rename ambiguity whenever a table is dropped and new tables are added at
once — it can't tell "drop otp_codes, add 6 unrelated tables" from "rename otp_codes to one of
them" without a human answering a TTY prompt, which isn't available in this environment. `0015`
is the pure addition; `0016` is the pure drop. Both were applied to the local `ammari` database
and verified.)

**New file `packages/db/src/schema/customer-auth.ts`** (mirrors `staff-auth.ts`):

- `customer_auth_users` — `id`, `customerId` (FK → `customers.id`, `ON DELETE RESTRICT`,
  **nullable** — unlike staff's `NOT NULL UNIQUE`, since a customer identity is created *by*
  self-signup; there's no pre-existing `customers` row to require up front. The link-or-create
  hook fills it in before the row is ever written, same timing as staff's hook), `name`, `email`
  (citext, unique), `emailVerified`, `image`, timestamps.
- `customer_auth_accounts`, `customer_auth_sessions`, `customer_auth_verifications` — identical
  shape to their staff counterparts.
- `customer_auth_rate_limits` — Better Auth's own per-IP limiter storage for this instance.

**New file `packages/db/src/schema/claim-throttle.ts`**:

- `claim_rate_limits` — `id`, `ip inet`, `action text` (`"view"` / `"claim"`), `createdAt`.
  Composite index `(ip, action, createdAt)` for the throttle read, plus a plain `createdAt`
  index for the cleanup delete. The query/cleanup helper that writes to this table is session
  2's work (the claim action itself) — this session only ships the table.

**`packages/db/src/schema/auth-throttle.ts`**: add a plain `createdAt` index to
`auth_email_throttle` (same reasoning — backs an efficient age-based cleanup delete that the
hoisted helper now performs).

**`packages/db/src/schema/customers.ts`**: delete the `otpCodes` table entirely.

**`packages/db/src/schema/constants.ts`**: delete `OTP_PURPOSES`/`OtpPurpose`.

**`packages/db/src/schema/index.ts`**: export the two new schema files.

No RBAC/permission changes — this is all main-site-facing; admin-side display (session 2) reuses
existing `customers.view`/`packing.print_cards`.

---

## `packages/auth` changes

- **`src/shared/email-throttle.ts`** (new) — `recordEmailThrottleAttemptAndCount`, hoisted out of
  `staff/staff-data.ts` unchanged in behavior, plus an opportunistic cleanup pass (low
  probability per call, deletes rows older than a generous retention window via the new
  `created_at` index). Both `staff/create-staff-auth.ts` and `customer/create-customer-auth.ts`
  import this.
- **`src/customer/create-customer-auth.ts`** (new) — `createCustomerAuth(options)`, same shape as
  `createStaffAuth`:
  - **No admission gate** — self sign-up is allowed (the opposite of staff's closed gate).
  - `databaseHooks.user.create.before`: citext-match the incoming email against `customers`. If
    found (and, for Google, the incoming email is Google-verified), link
    (`customerId: existing.id`); otherwise create a fresh `customers` row (name from the OAuth
    profile, or a generic placeholder for OTP-only sign-ups; email; `emailVerifiedAt: now()` only
    when the provider actually verified it) and attach its id. This is the one real behavioral
    fork from staff's hook, which only ever links, never creates.
  - `advanced.cookiePrefix: "ammari_customer"`, own `secret`
    (`CUSTOMER_BETTER_AUTH_SECRET`), own `trustedOrigins` (just this app's own baseURL — never
    shared with admin's), `ipAddressHeaders: ["cf-connecting-ip"]`.
  - `session.expiresIn` ~60 days, `updateAge` sized so the sliding window actually behaves like
    one.
  - Same OTP plugin config as staff (6 digits / 5 min / 5 attempts / hashed), reusing
    `auth_email_throttle` for the per-destination send throttle via the hoisted helper above.
- **`src/customer/customer-data.ts`** (new) — the link-or-create logic as a testable unit
  (mirrors `staff-data.ts`'s split).
- **`src/customer/index.ts`** (new) — exports.
- **`packages/auth/package.json`** — add `"./customer": "./src/customer/index.ts"` export.
- **`src/resend-email-sender.ts`** (new) — `ResendEmailSender implements EmailSender`, calling
  Resend's REST API directly via `fetch` (no new dependency — Resend's API is one POST call, and
  `packages/auth` currently has zero HTTP-client dependencies; adding the full SDK for one
  endpoint isn't worth the extra dependency). Constructor takes `{ apiKey, from }`.
- **`src/index.ts`** — export `ResendEmailSender` and its options type.

## `apps/web` — bootstrap

- **Dependencies** (pinned to exactly what `apps/admin` already uses): `@ammari/ui`,
  `@ammari/auth`, `better-auth@1.7.7`, `server-only@0.0.1`, `zod@4.6.5` (session 2's manual-entry
  form validation; added now so the dependency set is settled). Dev deps:
  `drizzle-orm@0.45.3`, `vitest@5.0.2`, `jsdom`, the same `@testing-library/*` set, matching
  CLAUDE.md's pinned-tooling rule.
- **`next.config.ts`**: add `@ammari/auth`, `@ammari/ui` to `transpilePackages` (alongside the
  existing `@ammari/db`).
- **`app/globals.css`**: `@import "tailwindcss"`, `@import "@ammari/ui/theme.css"`, the matching
  `@source` path to the package's components — same three lines admin's own `globals.css` uses.
- **`app/layout.tsx`**: wire `fontVariables` from `@ammari/ui/fonts` onto `<html>`, `font-sans`
  on `<body>`, update `<title>`/`description`.
- **`lib/auth/customer.ts`** — mirrors `apps/admin/src/lib/auth/staff.ts`: reads
  `BETTER_AUTH_URL` (this app's own origin), `CUSTOMER_BETTER_AUTH_SECRET`, optional Google
  creds, selects `ResendEmailSender` when `RESEND_API_KEY`+`EMAIL_FROM` are set, else
  `ConsoleEmailSender` outside production / `UnconfiguredEmailSender` in production. No e2e
  backdoor yet — that's session 3's job alongside the rest of the e2e harness.
- **`lib/auth/customer-session.ts`** — `getCustomerSession()`, `cache()`-memoized, resolves
  `customerId` off the Better Auth session's additional field, then loads the **live**
  `customers` row (id, name, email, phone, `pdpConsentAt`, `promoConsentAt`) fresh on every call
  — never trusts a cached session payload for consent/profile state, since consent and profile
  completion both write directly to `customers`, not to any Better Auth table.
- **`lib/auth/client.ts`** — `authClient` with `emailOTPClient()`, talking to real
  `/api/auth/*` HTTP (same reasoning as admin: Better Auth's rate limiter and origin/CSRF check
  are wired into the HTTP router, not `.api.*`).
- **`app/api/auth/[...all]/route.ts`** — identical shape to admin's, pointed at the customer auth
  instance.
- **`lib/auth/consent.ts`** — pure, unit-tested `needsConsent(customer: { pdpConsentAt: Date |
  null }): boolean`, plus `requireConsentedSession()`: redirects to `/login?next=` if
  unauthenticated, to `/consent?next=` if `needsConsent`, otherwise returns the live customer.
  Session 2's claim server action calls the same pure `needsConsent` check directly and rejects
  — the one place this logic must be enforced server-side regardless of what any page already
  redirected.
- No `proxy.ts` (decision #3).

## Pages (`apps/web`) — session 1 scope

- **`app/login/page.tsx` + `login-form.tsx`** — Google button + email OTP send/verify, mirroring
  `apps/admin`'s login form almost exactly (same generic-error-on-every-failure posture, same
  "real HTTP endpoint, not a server action" rule). `?next=` carries the return-to path. On
  success, redirects straight to `next` (defaulting to `/account`) — the destination page's own
  `requireConsentedSession()` is what bounces to `/consent` if needed, keeping the login form
  itself consent-agnostic.
- **`app/consent/page.tsx` + consent form** — server component: requires a session (redirect to
  `/login` if none); if already consented, redirects straight to `next`; otherwise renders the
  checkbox (linking to `/privacy-policy`/`/terms-of-service`) + "Lanjutkan" button (disabled
  until checked). The form action re-checks the session server-side, stamps `pdp_consent_at =
  now()`, redirects to `next`.
- **`app/account/page.tsx`** — `requireConsentedSession()`; shows name/email, a
  dismissible-per-session (`sessionStorage`, not persisted) "Lengkapi profilmu" banner + link
  when `phone` is null, and a "Keluar" sign-out form. No voucher list yet — that's session 2,
  once real claims can exist.
- **`app/account/complete-profile/page.tsx` + form** — name/phone fields (phone validated against
  the same `^\+62[0-9]{8,13}$` shape as the DB check constraint), "Lewati" (skip → back to
  `/account`, no write) and "Simpan" buttons. Gated by `requireConsentedSession()` too (reached
  from `/account`, but checked directly as defense-in-depth).
- **`app/privacy-policy/page.tsx`**, **`app/terms-of-service/page.tsx`** — static, Indonesian UI,
  placeholder prose for the owner to fill in later. Publicly accessible (linked from `/consent`
  and `/login` before any sign-in).
- **`app/actions.ts`** — `logoutAction` mirroring admin's exactly (`customerAuth.api.signOut` +
  redirect to `/login`).

## Shared `@ammari/ui` change

- Widen `CheckboxProps.label` from `string` to `ReactNode` (backward-compatible — every existing
  caller already passes a plain string, which is a valid `ReactNode`) so the consent checkbox's
  label can contain inline links to `/privacy-policy`/`/terms-of-service` without apps/web
  reimplementing an accessible checkbox from scratch.

## Env vars — `apps/web/.env.example` additions

```
BETTER_AUTH_URL=http://localhost:3000
CUSTOMER_BETTER_AUTH_SECRET=dev-only-insecure-secret-change-me
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
RESEND_API_KEY=
EMAIL_FROM=
```

`apps/admin/.env.example` also gets `RESEND_API_KEY`/`EMAIL_FROM` added (same two vars, same
`ResendEmailSender`, shared across both apps).

## Tests — session 1

- **Unit/integration (`packages/auth`)**: the customer-auth link-vs-create hook —
  - a brand-new email (OTP or Google) creates a new `customers` row and links it.
  - an existing `customers` row matched by citext email links instead of duplicating (Google,
    verified email).
  - two separate OTP sign-ins for the same email resolve to the same `customerId`, not two rows.
- **Unit (`apps/web`)**: the consent gate's pure `needsConsent()` function, and
  `requireConsentedSession()`'s redirect decisions (no session → `/login`; session but no
  consent → `/consent`; consented → passes through) via a mocked session loader.

## Verification — session 1

`pnpm typecheck && pnpm lint && pnpm build` across the workspace, the `packages/auth` and
`apps/web` unit suites, then a `security-reviewer` pass with CRITICAL/HIGH findings fixed before
reporting done.

## Explicitly NOT building in session 1

`/claim/[token]`, `/claim`, the claim transaction, voucher creation/listing, the admin-side
"Diklaim" display, `claim_rate_limits`' query/cleanup helper, and all e2e tests — all session 2/3.
