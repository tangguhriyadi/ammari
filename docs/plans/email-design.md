# Email design pass: every email looks like Ammari

Status: **built 2026-10-27** (one session). Shared package `packages/email` (`@ammari/email`);
order emails, sign-in codes and the staff invite all render through it.

Goal: every email the system sends carries the same Ammari look (logo, gray red `#695A5A`,
Indonesian, footer with contact) and works in Gmail (web and app), Apple Mail and Outlook, with a
plain-text part, a preheader, and dark mode where the client supports it.

---

## 1. Inventory: every email the system can send

| # | Email | Subject | To | Built in | Sent from | Before this pass |
|---|---|---|---|---|---|---|
| 1 | Customer sign-in code | `Kode masuk Ammari` | buyer | `packages/email/src/sign-in-code.ts` (`audience: "customer"`) | `packages/auth/src/customer/create-customer-auth.ts` (`sendVerificationOTP`) via `shared/sign-in-code-email.ts` | plain text only, unbranded |
| 2 | Staff sign-in code | `Kode masuk Ammari Admin` | staff | `packages/email/src/sign-in-code.ts` (`audience: "staff"`) | `packages/auth/src/staff/create-staff-auth.ts` (`sendVerificationOTP`) | plain text only, unbranded |
| 3 | Staff invite | `Undangan ke Admin Ammari` | invited staff | `packages/email/src/staff-invite.ts` | `apps/admin/src/lib/staff/invite-email.ts` (`buildStaffInviteEmail`), sent by `lib/staff/mutations.ts` (invite and renew) | plain text only, unbranded |
| 4 | Order `created` (menunggu pembayaran) | `Pesanan {no} menunggu pembayaran` | buyer | `packages/commerce/src/emails/templates.ts` | `packages/commerce/src/emails/dispatch.ts` (cron and after-checkout dispatch) | branded |
| 5 | Order `paid`, confirmed / review | `Pembayaran pesanan {no} sudah kami terima` | buyer | same | same | branded |
| 6 | Order `cancelled` (4 reasons: payment expired, payment cancelled, admin before payment, admin after payment) | `Pesanan {no} dibatalkan` | buyer | same | same | branded |
| 7 | Order `shipped` | `Pesanan {no} sudah dikirim` | buyer | same | same | branded |
| 8 | Order `delivered` | `Pesanan {no} sudah sampai` | buyer | same | same | branded |
| 9 | Owner `owner_paid` (paid / stock short / paid after cancel) | `Pesanan baru dibayar: {no}`, `Perlu dicek: ...` | `store_settings.support_email` | same | same | branded |

Nothing else sends email: the only `EmailSender.send` / transport calls are the three call sites
above (checked with a search for every `.send(` on an email sender or transport). The customer
"Masuk ke akun" login link is not its own email; it rides inside #4 and #5. The monthly bills
reminder is in-app only.

## 2. Shared layout (`@ammari/email`, `src/layout.ts`)

- **Header:** a 4px gray red bar on the card, the logo mark (`/logos/ammari-primary.png` on the
  storefront, absolute https only, 24x28) and the `AMMARI` wordmark (Cormorant where installed,
  else Georgia). No https origin (local dev) means the wordmark alone.
- **Logo URL source:** the storefront origin. Order emails: `deps.siteOrigin`. Customer code:
  the customer auth `baseURL` (the storefront itself). Staff code and invite: apps/admin's
  `MAIN_SITE_URL`, read leniently (unset or http just drops the logo, never breaks sign-in).
- **Colours:** `brand.ts` tokens only (`#695A5A`, `#000000`, `#FFFFFF`, muted `#6B6161`, line
  `#E7E2E2`, page `#F6F4F4`, highlight `#F6F3F1`).
- **Fonts:** Inter, then system sans, Helvetica, Arial. No web font is loaded (Outlook on Windows
  falls back to Times New Roman on one); an `mso` conditional forces Arial/Georgia there.
- **Footer** (every email, both parts): "Ammari, gamis syar'i dari Bandung", `Email:
  ammariofc@gmail.com`, `WhatsApp: +62 888 0854 1442`, then the email's own note (why the reader
  got it). Plain text, not links. The contact is fixed in `brand.ts`; order emails additionally
  keep their own "Ada pertanyaan? ... wa.me/..." line from `store_settings.whatsapp_number`.
- **Structure:** table layout, inline styles, `max-width:600px` plus an Outlook ghost table,
  `role="presentation"` tables, filled-cell buttons (visible in Outlook), `lang="id"`.
- **Dark mode:** `color-scheme: light dark` and a `prefers-color-scheme: dark` block that maps
  each light token to a dark one by matching the inline style text (`[style*="color:#000000"]`
  etc.), so every section, including commerce's own order rows, follows without extra classes.
  Works in Apple Mail, iOS Mail, Outlook for Mac. Gmail ignores it and applies its own inversion,
  which the design survives (no text in images, transparent logo, bordered code box). A new
  colour in an email must get a dark counterpart in `layout.ts`.
- **Preheader** on every email (hidden div plus zero-width filler so body text does not leak into
  the inbox preview).
- **Plain-text part** on every email, same content, links written out as `Label:\nURL`.
- `format-detection` meta and an `x-apple-data-detectors` reset stop iOS turning the code, phone
  number or dates into links.

Order emails: content unchanged. What changed is the page around it (header, footer, width 560
to 600px, dark mode) and the footer text: the old first footer line ("Ammari" / "Ammari admin") is
now the shared brand line; the owner email's note reads "Email ini untuk admin Ammari dan berisi
data pembeli. Jangan diteruskan." A retried send across this deploy renders the new layout, so
its bytes differ from the first attempt; Resend's idempotency key then answers with an error for
that one retry within 24 hours of the first (the dispatcher already treats a send failure as
retryable and logs it).

## 3. Per-email rules

**Sign-in codes (customer and staff).**
- Subject names the purpose, never the code (`Kode masuk Ammari`, `Kode masuk Ammari Admin`,
  unchanged): the code then never shows on a lock screen notification or in a shared inbox list.
- The code is large (34px, monospace, bold, letter-spaced), black on a light box with a border,
  one text node with `user-select:all`, never an image. In the plain text it is on its own line.
- Expiry: "Berlaku 5 menit, sampai pukul 14.35 WIB." The time is computed when the email is
  built, minus 5 seconds so the shown minute is never later than the real expiry.
- Safety lines: "Jangan bagikan kode ini ke siapa pun, termasuk yang mengaku dari tim Ammari. Kami
  tidak pernah meminta kode ini." and "Kalau bukan kamu yang meminta kode ini, abaikan saja email
  ini."
- **No links or buttons at all**, so a phishing copy with a "Masuk di sini" button cannot pass
  for it. Tested (`<a` and `href=` absent).

**Staff invite.**
- One button, "Buka Admin Ammari", to the admin origin (no token, no code). The plain address is
  repeated under it ("Alamat") so the reader can check where it goes.
- States which email to log in with, the methods (Google or email code), the expiry in WIB, and
  that another address will not work. "Kalau Anda tidak merasa diundang, abaikan email ini."

**Preheaders.**

| Email | Preheader |
|---|---|
| Sign-in code | "Kode ini berlaku 5 menit, sampai pukul 14.35 WIB. Jangan bagikan ke siapa pun." |
| Staff invite | "Masuk dengan {email} sebelum {tanggal, jam WIB}." |
| Order emails | unchanged (e.g. "Selesaikan pembayaran sebelum ...", "Nomor resi: ...") |

## 4. Customer sign-in must prove the email (security check)

- **Email code:** completing it proves the mailbox.
- **"Masuk ke akun" order link:** only issued to the order's own contact email; clicking proves
  the mailbox (marks it verified).
- **Google:** previously the customer instance had no `validateUserInfo`, so a Google profile with
  `email_verified: false` for an address that had no account yet **created** a customer account
  and `customers` row for it (verified by a failing test before the fix). Linking to an
  existing account was already refused (Better Auth does not link an untrusted unverified
  provider; `loadOrCreateCustomerForEmail` refuses an existing `customers` row).
- **Fix:** `createCustomerAuth` now has the same gate as staff: `validateUserInfo` returns
  `{ error: "invalid_account" }` for any OAuth source whose `emailVerified` is not `true`. Better
  Auth runs it on OAuth create-user, link-account and sign-in. Tests in
  `packages/auth/test/customer-auth-google.test.ts`.

## 5. Local preview

```bash
pnpm --filter @ammari/commerce emails:preview
open .email-preview/index.html
```

Renders all 13 sample emails (sign-in codes, invite, every order email variant used in practice,
the three owner variants) with sample data into `.email-preview/` (git-ignored) as `.html` and
`.txt`. A script only: no app imports it, it sends nothing, reads no database, calls no API, and
refuses to run with `NODE_ENV=production`. The logo loads from `EMAIL_PREVIEW_SITE_ORIGIN`
(default `https://ammari.id`). For dark mode, switch the OS to dark and open in Safari.

## 6. Tests

- `packages/email/src/emails.test.ts`: per sign-in code and invite: subject, preheader, code as a
  text node in both parts, expiry, safety line, no link (codes) / exactly one button (invite),
  plain-text part, footer contact, no em or en dash, absolute https images only.
- `packages/commerce/src/emails/emails.test.ts`: every order email (14 renders) is in the shared
  layout: preheader, plain-text part, footer contact, https images only; existing content tests
  unchanged.
- `packages/auth/test/{customer,staff}-auth.test.ts`: the sent code email has the HTML part with
  the code and no link. `customer-auth-google.test.ts`: §4.
- `apps/admin/src/lib/staff/mutations.test.ts`: the invite's HTML part has one button to the
  admin URL.

## 7. Not done / follow-ups

- No VML button for Outlook on Windows (the filled cell is the button there; rounded corners
  square off).
- The footer contact is fixed in code (`brand.ts`), not read from `store_settings`; change both
  together if the number or address changes.
- The storefront login page does not show a specific message when Google refuses an unverified
  email; the user lands on Better Auth's generic error, same as staff.
