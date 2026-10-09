# Plan: Packing (`/packing`) + Printable Thank-You Card

**Status:** Approved 2026-10-09. Implementation in progress.

## Grounding — what already exists

- **`thank_you_cards`** (`packages/db/src/schema/customers.ts`): `orderId`, `tokenHash` (unique),
  `status` (`active`/`claimed`/`void`), `claimDeadline`, `printedByStaffUserId`,
  `claimedByCustomerId`, `claimedAt`. A partial unique index
  (`thank_you_cards_active_order_id_key`, `WHERE status = 'active'`) already enforces "at most
  one **active** card per order" — reprinting is already modeled as *void the old row, insert a
  new one*, keeping full history. No schema change needed here.
- **`vouchers`**: entirely the claim page's job (SPEC §4.3) — packing never touches `vouchers`.
  No schema change needed.
- **`packing.print_cards`** permission already exists and already gates the `/packing` nav item
  and stub page. No new permission needed for printing.
- **`orders.manage`** (built this session) already gates `transitionOrderStatus` — reused as-is
  for "Tandai dikirim."
- **Missing**: `orders.courier`/`orders.trackingNumber` — migration **`0013`**. (The "0013 is
  reserved" note in an earlier draft of this plan was a mistake, corrected after the fact — see
  migration `0014`, which also backfills channel/permission/role reference data that turned out
  to be seed-only.)
- **Missing**: no QR-code library anywhere in the monorepo — new dependency: `qrcode` (pure JS,
  no native/canvas dependency needed for the SVG render path).
- Cormorant (weights 300/500) already wired via `packages/ui/src/fonts`; brand color `#695A5A` +
  white/black already in `theme.css`.
- Patterns mirrored: `/orders`'s `FilterTabs`+`Pagination`+`CardList`/`TableContainer`;
  `transitionOrderStatus` (never a raw `UPDATE`); `writeAuditLog`; `buildImageSizeUrl` for the
  pick-list thumbnail.

## Schema changes — migration `0013`

- `orders.courier text` (nullable, free text + a client-side suggestion list — JNE, J&T,
  SiCepat, AnterAja, Ninja Xpress, ID Express, POS Indonesia, Lion Parcel — via `<datalist>`, not
  a DB enum).
- `orders.trackingNumber text` (nullable).

## Token / claim data model

- **Generation**: `crypto.randomBytes(16)` → 128 bits raw.
- **Encoding**: Crockford Base32 (excludes ambiguous `I`/`L`/`O`/`U`, case-insensitive) → 26
  characters. Same single token in the QR's URL (`<MAIN_SITE_URL>/claim/<token>`, no separate
  short path — SPEC §4.2) and in the printed human-typable fallback, grouped for legibility
  (`XXXX-XXXX-XXXX-XXXX-XXXX-XX`). The dashes are decorative only — **the future claim page must
  strip non-alphanumeric characters from manual input before hashing** (documented in the
  token module's own doc comment).
- **The claim URL's domain is never hardcoded** (approved correction) — a new env var
  `MAIN_SITE_URL` (apps/web's own public base URL: `http://localhost:3000` locally,
  `https://ammari.my.id` on dev, `https://ammari.id` in production) is validated by
  `apps/admin/src/lib/main-site-url.ts` (valid absolute URL, no trailing slash, must be https
  when `NODE_ENV=production`) and consumed by `lib/packing/token.ts`'s `claimUrl`/
  `claimUrlForDisplay` — the full URL for the QR, the protocol-stripped host for the printed
  fallback text (e.g. `ammari.my.id/claim/...`, never `https://ammari.my.id/claim/...`).
- **Hashing**: `sha256(tokenString).hex` → `thank_you_cards.tokenHash`. Hashes the *encoded
  string*, not the raw bytes.
- **Claim deadline**: `orderDate` + 1 calendar month, 23:59:59 WIB, **clamped to the last day of
  the target month** (e.g. 31 Jan → last day of Feb, never a silent rollover into March).
- **Print = mint**: no "create card" step separate from printing — `thank_you_cards.createdAt`
  of the active row *is* "printed at."
- **Reprint**: voids the existing active card (`status = 'void'`) and inserts a fresh row with a
  new token/hash. One combined warning for the whole batch when any selected order already has
  an active card (not per-order granularity).
- **Cancel/return voids the card too** (approved addition): when `transitionOrderStatus` moves an
  order to `cancelled` or `returned`, it voids that order's active thank-you card **in the same
  transaction**, audit-logged. A claimed card/voucher is never touched by this — if the card was
  already `claimed` (voucher issued) before the order was cancelled/returned, the owner decides
  that policy later; this only ever voids an `active` (unclaimed) card. **The future claim page
  must independently reject a claim whose source order is cancelled or returned** (SPEC §4.3's
  own claim-validation list already says this) — documented in the token module's doc comment as
  a reminder for that page, since an `active` card can still exist if this transition races the
  claim (vanishingly unlikely, still worth stating as the claim page's own responsibility, not
  just packing's).
- **Audit**: every mint writes `audit_log` — `action: "print"` for a first card, `"reprint"` when
  it supersedes an active one, `"void"` when cancel/return voids it; `entityType:
  "thank_you_card"`.

## Print approach — CSS print, no new PDF pipeline

- `qrcode`, `QRCode.toString(url, { type: "svg", errorCorrectionLevel: "Q" })` — level **Q** for
  print durability (approved), inlined server-side as trusted markup.
- Card box always declared at the exact physical size, 105mm × 148mm, via CSS — never relies on
  `@page size` switching. Toggle controls how many boxes share a sheet: one-per-page
  (`page-break-after: always`) vs. four-per-A4 (2×2 grid, new page every 4 orders). Staff who
  want A6 stock pick that paper size in their own OS print dialog.
- The card never depends on the 🤍 emoji rendering for layout — plain text/flex layout around it,
  never sized or positioned relative to its glyph box.
- Flow: select orders → "Cetak kartu" → read-only `getCardPrintStatus` check → if any already
  have an active card, one combined warning naming them, requiring an explicit second click →
  confirmed click mints/rotates and returns printable data for all selected orders in one
  response → client renders the print-ready cards inline (visible only via `@media print`) →
  `window.print()`. Token never appears in a URL or query string.

## Draft card copy (approved as drafted)

```
Halo, {nama},

Terima kasih sudah berbelanja bersama Ammari 🤍
Sebagai ucapan terima kasih, kami titipkan voucher
Rp20.000 untuk belanja berikutnya di ammari.id.

Pindai QR di samping untuk klaim vouchermu,
atau kunjungi:
ammari.id/claim/XXXX-XXXX-XXXX-XXXX-XXXX-XX
```

(The last line's domain is illustrative — the actual printed text uses whatever `MAIN_SITE_URL`
resolves to per environment, e.g. `ammari.my.id/claim/...` on dev; see above.)

`{nama}` resolves `customerName ?? buyerUsername ?? "Kakak"` — **with masked-marketplace-name
handling (approved addition)**: if `customerName` contains `*` (marketplace masking, e.g. "Bu
S***i"), skip it and fall back to `buyerUsername`, then `"Kakak"`, exactly like a missing name.

## RBAC

No new permission. `packing.print_cards` gates `/packing` and printing; `orders.manage` gates
"Tandai dikirim," independently checked (a staffer with one but not the other sees only the
controls they're allowed to use).

## "Nothing ships without a card" (approved addition)

Marking an order `shipped` (single or bulk) when it has **no active card** shows a warning
listing those specific orders and requires an explicit confirmation before proceeding. Enforced
in the UI *and* server-side: the mutating server action takes an explicit `confirmNoCard: boolean`
flag and rejects the request outright if it's false and any target order lacks an active card —
never only a client-side check.

## Pages & files

- `apps/admin/src/app/(shell)/packing/page.tsx` — replaces the stub. Queue of `to_ship` orders,
  oldest `orderDate` first, `FilterTabs` by channel, `CardList`+`TableContainer`, each row
  expandable to its pick list (SKU/color/size/qty/thumbnail via `buildImageSizeUrl`).
- `.../packing/_components/{packing-list,pick-list,mark-shipped-dialog,print-cards-button}.tsx`.
- `.../packing/actions.ts` — `getCardPrintStatusAction`, `printThankYouCardsAction`,
  `markShippedAction` (single, optional courier/resi, `confirmNoCard`), `bulkMarkShippedAction`
  (no courier/resi, `confirmNoCard`).
- `apps/admin/src/lib/packing/queries.ts` — `listPackingQueue`, `mintThankYouCard`
  (print/reprint), `claimDeadlineFromOrderDate`, `getCardPrintStatus`.
- `apps/admin/src/lib/packing/token.ts` — `generateClaimToken()`, `hashClaimToken()`,
  `claimUrl()`, `claimUrlForDisplay()`.
- `apps/admin/src/lib/main-site-url.ts` — `getMainSiteUrl()`/`getMainSiteHost()`, validating
  `MAIN_SITE_URL` (new env var — see `.env.example`).
- `apps/admin/src/lib/packing/card-copy.ts` — the message constant + name-resolution helper.
- `apps/admin/src/lib/orders/queries.ts` — `transitionOrderStatus` extended: optional
  `{ courier, trackingNumber }` on a `shipped` transition; voids the active thank-you card on a
  `cancelled`/`returned` transition, same transaction, audited.
- Migration `0013` as above.

**"Tandai dikirim" is two separate actions**: a per-order button opens a small courier/tracking
form before transitioning that one order; bulk transitions every selected order straight to
`shipped` with no courier/tracking field.

## Explicitly NOT building now

The `/claim/[token]` page itself (apps/web), OTP verification, voucher creation at claim time,
account creation/linking.

## Resolved open questions

1. Courier — free text + suggestion `<datalist>` (JNE, J&T, SiCepat, AnterAja, Ninja Xpress, ID
   Express, POS Indonesia, Lion Parcel), not a DB enum.
2. Claim-deadline month-end — clamp to the last day of the target month.
3. Reprint-warning granularity — one combined warning for the whole batch.
4. Printed-card badge wording — fine as drafted.
5. Card copy — approved as drafted.
6. QR error-correction level — **Q**, for print durability.
