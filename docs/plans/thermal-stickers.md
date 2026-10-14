# Plan: Thermal QR Stickers on `/packing`

**Status:** Approved 2026-10-15. Implemented this session (code review pending).

## Summary

Added a second, now-primary print option on `/packing`: a real downloadable PDF of 3×3 thermal QR
sticker sheets (OKAY D100 printer, 100×120mm sheets, 9 stickers/sheet), replacing the existing
A6/A4 HTML card as the default action. The card print stays available as a secondary option,
unchanged. Printing stickers **reuses the exact same token-minting pipeline** (`mintThankYouCard`,
reprint rotation, the "already printed" warning, `audit_log`) via a new shared helper,
`mintThankYouCardsForOrders` — a sticker print *is* a card print, just rendered differently, and
both persist a sticker code on the minted card.

## Grounding — what already existed

- **Token minting** (`apps/admin/src/lib/packing/queries.ts::mintThankYouCard`,
  `apps/admin/src/lib/packing/token.ts`): mints/rotates `thank_you_cards`, writes `audit_log`.
  Unchanged — reused as-is by both print paths via the new shared helper.
- **`PackingList`** (`.../packing/_components/packing-list.tsx`): `handlePrintClick` already did
  the "check already-printed → warn → mint" flow via `getCardPrintStatusAction` +
  `reprintWarning` state + a confirm `Dialog`. Generalized to take a `mode: "card" | "sticker"`
  parameter so one warning dialog serves both buttons.
- **`qrcode` (`^1.5.4`, already a dependency)**: `QRCode.create(text, { errorCorrectionLevel })`
  returns a `BitMatrix` (`{ size, get(row, col) }`) with no quiet zone baked in — drawn as filled
  rectangles directly onto the PDF page via `pdf-lib`.
- **New dependency: `pdf-lib@1.17.1`**, pinned exactly (verified as current npm `latest`).

## Sticker code algorithm — `apps/admin/src/lib/packing/sticker-code.ts`

Pure, no DB/IO:

```ts
export const CHANNEL_STICKER_CODE: Record<ChannelId, string> = {
  shopee: "SHP", tiktok: "TTS", web: "WEB", whatsapp: "WA",
  instagram: "IG", offline: "OFF", reseller: "RSL",
};

export function buildStickerCodeBase(order: StickerCodeOrderInput, last4Length: 4 | 6 = 4): string
export function assignStickerCodes(pending: StickerCodeOrderInput[], fixed: StickerCodeFixed[] = []): Map<string, string>
```

- MODEL/COLOR: strip accents (NFD + drop combining marks) and non-letters, uppercase, first 2
  characters — literal "first 2 letters of the string" (confirmed against the owner's examples:
  "Sage" → "SA", "Cyra" → "CY").
- SIZE: as-is except `ALLSIZE → AS`.
- LAST4: alphanumeric-only suffix of `channelOrderNo` (shopee/tiktok) or `orderNo` (everyone
  else); falls back to `orderNo` if a marketplace order is unexpectedly missing its own.
- Multi-piece (total qty > 1): first item by `(productName, colorName, size)`, `" x{total}"`
  suffix.
- **Collision model**: `assignStickerCodes(pending, fixed)` — `pending` orders get a fresh code;
  `fixed` entries are codes ALREADY persisted elsewhere, used only as collision context, never
  recomputed. Any `pending` order colliding with another `pending` order OR any `fixed` entry
  gets LAST4 widened to 6 characters (one escalation level). This single function is reused by
  both call sites below with different `pending`/`fixed` sets — never two different collision
  implementations.

31 unit tests in `sticker-code.test.ts` cover every channel, accents, `ALLSIZE`, single/multi-item,
qty>1, marketplace vs. internal LAST4 source, and the collision widening.

## Persisted vs. preview codes (owner's refined design, superseding the original draft)

**The list and the printed sticker must never disagree** — so the code is persisted, not
recomputed on every page view:

- **New nullable column** `thank_you_cards.stickerCode` (migration `0017`, nothing else in it —
  no backfill; a card minted before this feature simply has `null` forever unless reprinted).
- **At mint time** (`mintThankYouCardsForOrders`, shared by both print actions): for the batch
  being minted, `pending` = those orders' fresh sticker-code inputs; `fixed` = every OTHER
  `to_ship` order's already-persisted code (`getFixedStickerCodesForToShipQueue`, excluding the
  batch itself since those old codes are being replaced). The result is persisted onto each new
  card row in the SAME transaction as the mint.
- **On `/packing`'s display** (`listPackingQueue`): an order with an active card shows its
  PERSISTED code (`stickerCodeIsPreview: false`). An order with no card yet shows a PREVIEW —
  `pending` = every `to_ship` order without an active card (the WHOLE queue, not just the current
  page, and not narrowed by the channel filter either), `fixed` = every `to_ship` order's
  persisted code. This guarantees the preview a staffer sees is computed with the exact same
  collision context that printing it a moment later will use (modulo the queue changing in
  between — the same staleness window every other "preview then act" flow in this app already
  accepts).
- UI: `PackingQueueRow` gained `stickerCode: string | null` and `stickerCodeIsPreview: boolean`;
  shown in both `CardList` and `TableContainer` via a shared `StickerCode` component (muted
  italic + "(pratinjau)" suffix when preview; plain dash when `null`, which only happens for a
  pre-feature card).

## PDF builder — `apps/admin/src/lib/packing/sticker-pdf.ts`

```ts
export async function buildStickerSheetPdf(cards: StickerPdfCard[]): Promise<Uint8Array>
export function stickerPdfFilename(now: Date): string // "ammari-stiker-2026-10-15-0930.pdf", Jakarta
```

- Page size exactly 100×120mm (in PDF points), 3×3 grid, one page per 9 cards, trailing cells on
  the last sheet left blank.
- QR drawn at 29mm with the standard 4-module quiet zone computed INTO that box (not left to
  incidental cell padding), pure black vector rectangles — never an embedded raster image.
- Code text: Helvetica-Bold, shrinks (via `font.widthOfTextAtSize`) until it fits one line, never
  wraps.
- Small inward corner crop marks (2mm) per cell, no full grid lines.

Unit tests (`sticker-pdf.test.ts`): page count for 9/10/18 cards, exact page size, and — since
optically decoding a PDF's vector QR isn't practical in a unit test — `vi.spyOn(QRCode, "create")`
asserting each card's exact `claimUrl` reached the encoder, in order.

## Shared minting — `mintThankYouCardsForOrders` (`lib/packing/queries.ts`)

Replaces `printThankYouCardsAction`'s old inline per-order loop. Mints every order via the
existing `mintThankYouCard` (unchanged), computes sticker codes for the whole batch (collision
scope above), persists them, and returns everything both actions need. `printThankYouCardsAction`
(card/HTML path) and the new `printStickerSheetsAction` (PDF path) both call this — the only
difference downstream is SVG-for-the-overlay vs. vector-QR-in-a-PDF.

## Server actions (`.../packing/actions.ts`)

- `printThankYouCardsAction`: unchanged behavior, now calls the shared helper.
- `printStickerSheetsAction(orderIds): ActionResult<{ filename, pdfBase64 }>` — same
  `requirePermission("packing.print_cards")` + zod validation as the card action, mints via the
  shared helper inside `defaultDb.transaction`, builds the PDF, returns it **base64-encoded**
  through the existing `ActionResult` envelope (owner-confirmed: consistent with every other
  action in this codebase, no new Route Handler).

## UI (`packing-list.tsx`)

- "Cetak stiker" is now the primary button (default variant, first); "Cetak kartu" is
  `variant="secondary"`, second.
- `reprintWarning` carries `mode: "card" | "sticker"`; its confirm branches to
  `mintAndShowCards`/`mintAndDownloadStickers` accordingly.
- `downloadOrOpenPdf`: decodes base64 → `Blob` → object URL. iPad Safari (detected via
  `/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1` — iPadOS Safari reports
  as a touch-capable Mac since iPadOS 13) opens the blob URL in a new tab instead of a synthetic
  `<a download>` click, per the owner's explicit fallback instruction; everyone else gets the
  anchor+download approach. URL revoked after a short delay either way.

## RBAC / audit

No change — `packing.print_cards` gates both paths; `mintThankYouCard`'s existing `print`/
`reprint` audit entries fire regardless of which UI triggered the mint. The raw claim token is
only ever held in-memory long enough to build `claimUrl(token)`/the QR; never logged, never part
of the sticker code or any audit payload.

## Tests shipped

- `sticker-code.test.ts` — 31 tests (pure algorithm).
- `sticker-pdf.test.ts` — 8 tests (page count/size, QR-input correctness via spy).
- `queries.test.ts` additions — `mintThankYouCardsForOrders` (batch mint + persist, in-batch
  collision, reprint recomputation) and `listPackingQueue` (persisted vs. preview, whole-queue
  collision scope spanning pages).
- `apps/admin/e2e/packing-stickers.spec.ts` — one spec covering both viewports (390px mobile via
  `CardList`, 1280px desktop via `TableContainer`): select orders → "Cetak stiker" → real
  `page.waitForEvent("download")` → asserts filename pattern and page count (via `pdf-lib`
  loading the downloaded bytes back, since its object-stream-compressed output doesn't support
  the plain-text-regex trick `packing-print.spec.ts` uses for Chromium's own `page.pdf()`).

## Verification run this session

`pnpm typecheck && pnpm lint && pnpm build` (workspace-wide) clean. `apps/admin` unit suite: 469
passed. `apps/web`/`@ammari/db` suites unaffected, still green. New + pre-existing packing e2e
specs (`packing.spec.ts`, `packing-print.spec.ts`, `packing-stickers.spec.ts`) all pass, including
repeated/combined runs.

`react-reviewer` + `security-reviewer` both ran; CRITICAL/HIGH fixed:
- **CRITICAL (react)**: the iPad-Safari `window.open` fallback ran well after the user-gesture
  window closed (two awaited server round-trips deep), so Safari would silently popup-block it
  with no feedback even though the mint had already committed. Fixed by opening a blank tab
  **synchronously inside the actual click** (`openStickerPopupPlaceholder`, called from both the
  toolbar button's `onClick` and the reprint-warning dialog's `onConfirm`) and navigating it to
  the blob URL once the PDF is ready; shows a visible error if the popup was blocked anyway.
- **HIGH (react, a11y)**: the sticker code had no accessible label in the mobile `CardList`
  layout (the desktop table has a `<Th>Kode stiker</Th>`, mobile had none). Fixed with an
  `sr-only` label on that call site.
- **HIGH (security)**: `orderIdsSchema` (shared by every packing action) had no upper bound —
  `printStickerSheetsAction` mints/rotates a card and builds a PDF for every id in one request,
  inside one DB transaction holding `orders` row locks for its duration; unbounded input was a
  real memory/lock-duration DoS reachable by any `packing.print_cards` account. Fixed with
  `.max(500)`.

Two MEDIUM security findings were surfaced and deliberately left unfixed per this session's scope
(CRITICAL/HIGH only) — noted here for a future pass:
- The sticker-code collision check (`getFixedStickerCodesForToShipQueue` → `assignStickerCodes` →
  persist) is check-then-write, not atomic, and `thank_you_cards.sticker_code` has no unique
  constraint — two concurrent print batches racing could theoretically both persist the same
  un-widened code. Real-world likelihood is low (two staff printing overlapping collision-prone
  batches at the exact same instant) but worth an advisory lock or a partial unique index +
  retry-on-conflict if it ever becomes a real incident.
- `mintThankYouCard`'s existing (pre-dating this feature) status check only excludes
  `cancelled`/`returned` orders, not scoped to `to_ship` — combined with the `.max(500)` cap
  above, one call can still mint/rotate cards for orders outside the visible `/packing` queue.
  Pre-existing behavior inherited by the new action, not a new regression; worth tightening
  later.

## Explicitly NOT built

Any change to the claim flow, `/claim/[token]`, or voucher issuance. No change to the A6/A4
card's own content/layout. No printer-driver integration — the PDF is generic.
