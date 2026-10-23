# PDP image gallery (Shopee-style)

Status: **owner answers in (2026-10-23, §13, all recommendations accepted). Session 1 done
(2026-10-23): data layer, index math, responsive `ProductImage` mode, canonical URL, design spec.
Session 2 done (2026-10-23): page gallery (§14). Session 3 done (2026-10-23): viewer (§15),
pending the owner's real-iPhone check.**

Scope: `apps/web` only (PDP). No schema, migration, admin, pricing, cart or checkout change.

## 0. Owner decisions (final, from the request)

1. Large main image + horizontal thumbnail strip below it. Active thumbnail outlined; the strip
   scrolls when there are many. A magnifier icon in a corner of the main image.
2. Thumbnails = ALL images: general images first, then grouped per colour, in the admin's colour
   order.
3. Selecting a colour jumps the gallery to that colour's first image and scrolls the strip to it.
   Never the other way: browsing images never changes the selected colour or variant.
4. Clicking the main image opens a full-screen modal with prev/next and a close (X) button.
   Navigation wraps (last to first, first to last), in the page gallery and in the modal.
5. Phone: swipe on the main image, thumbnail strip still shown. In the modal: swipe and
   pinch-to-zoom. Desktop: arrow keys and Esc in the modal.
6. UI text Indonesian, no em dash, keep the existing minimal look.

## 1. What the codebase does today (investigation)

### 1.1 Storage and order

- `product_images` (`packages/db/src/schema/catalog.ts`): `product_id`, `fabric_color_id`
  (**null = general image**, applies to every colour), `storage_key`, `alt_text`, `width`,
  `height` (after EXIF rotation), `sort_order`. Index
  `(product_id, fabric_color_id, sort_order)` matches "one group per colour, ordered inside".
- Files: the admin pipeline writes three fixed WebP sizes per image, `<storage_key>/{400,800,1600}.webp`.
  `apps/web/next.config.ts` sets `images.unoptimized: true` (the CI-built image cannot know the
  storage host), so **next/image emits no `srcset`**: the `sizes` prop does nothing today and every
  PDP slide downloads the 1600 file, even on phones.
- `fabric_colors` has **no display-order column**.
- Admin "Foto" section (`apps/admin/.../product-photos-section.tsx`): a "Umum" (general) group
  first, then one group per colour that has variants, **ordered by colour name**
  (`listProductColorGroups`, `orderBy(fabricColors.name)`). Inside a group, "Geser" left/right
  rewrites `sort_order` (`reorderProductImagesAction`). The thumbnail fallback rule also uses name
  order.
- Storefront read (`packages/db/src/storefront/queries.ts` `getStorefrontProductBySlug`): all
  images of the product (including ones tagged to a now-inactive colour); colours = every colour
  that has an active variant **or** an image, active colours only, **ordered by
  `fabric_colors.created_at`**. The homepage tile's "first colour" uses the same created-at order.

**Mismatch found:** admin shows colours by name, the storefront swatches by creation time. For
"the admin's colour order" there was no single answer; the owner chose the swatch order (§13 #1).

### 1.2 How the PDP picks images today

- `page.tsx` reads `?color=`, `resolveSelectedColorId` falls back to the first colour for an
  unknown or stale id. `pageUrl` (JSON-LD `offers.url`, the WhatsApp message) carries `?color=`.
  There is **no `rel=canonical`** on the PDP (only `metadataBase` in the layout), so `?color=`
  URLs are separate indexable URLs in production. Fixed in session 1: `generateMetadata` sets
  `alternates.canonical: /products/<slug>` (§13 #7).
- `buildProductView` splits images into `imagesByColor` and `generalImages`, each sorted by
  `sort_order`. `width`/`height` are dropped.
- `getGalleryForColor(view, colorId)`: the selected colour's images **then** general images.
  Neither: the first other colour with photos. No photo at all: `[]`, one placeholder slide.
- `ProductPurchasePanel` (client) renders **two** galleries: phone = scroll-snap swipe with a
  "N / total" chip; desktop = a vertical sticky stack of every image. Both mark image 0 `priority`
  (deprecated in Next 16 in favour of `preload`), so two images compete for preload. Changing
  colour swaps the whole image array and scrolls back to 0 in a `useEffect` (with an
  `eslint-disable`).
- `getPrimaryImage` (OG image, JSON-LD) = first general image, else first colour's first image.
  Unchanged.
- `ProductImage` swaps to the static placeholder on a missing or failed photo, always `fill`
  inside an `aspect-[2/3]` box.
- Design spec `docs/design/storefront.md` §6 item 1 describes today's layout (desktop vertical
  stack). It must be updated in session 1 to describe this gallery.

### 1.3 Admin or schema change needed?

**None.** Everything needed is already stored: general vs per-colour, per-group order, alt text,
width/height. The only data-layer change is in `apps/web` (the view model keeps `width`/`height`
and a pure function derives the flat gallery list). Storefront and admin colour order stay as
they are (§13 #1).

## 2. Gallery order

One flat list per product, derived by `buildProductGallery(view)` in `lib/content/product-view.ts`
(pure, unit-tested). Deviation from the first draft, decided in session 1: it is a function of
the view, not a field on it, so the client props don't carry every image twice (the view already
holds `generalImages` and `imagesByColor`); server and client compute the same indexes.

1. General images, by `sort_order`.
2. Then, for each colour **in swatch order** (`view.colors`), that colour's images by
   `sort_order`.
3. Images tagged to a colour not in `view.colors` (deactivated colour) are left out, **unless**
   the list would otherwise be empty (keeps today's "never empty while any photo exists" rule).

Plus `colorStartIndex: Record<colorId, number>` (index of each colour's first image; absent for a
colour with no photo) and each image's `colorId` (for the alt fallback and tests).

"Admin's colour order" = the storefront swatch order (creation date), so the thumbnail groups
always read in the same order as the swatches right above them (owner answer, §13 #1).

## 3. Behaviour

### 3.1 Page gallery

- **Initial image (server-computed, no hydration flash):** URL has a valid `?color=` and that
  colour has photos: its first image. Otherwise index 0 (first general image, which is also the
  OG image). The page computes `initialGalleryIndex(view, gallery, requestedColor)` (session 1)
  and passes it to the panel (session 2). §13 #2.
- **Select a colour:** index = `colorJumpIndex(gallery, colorId, current)`
  (`lib/gallery/index-math.ts`, session 1) and the strip scrolls so that thumbnail is visible.
  Done in `handleSelectColor`, not in an effect (removes today's `eslint-disable`). Size reset,
  cart feedback reset and `?color=` replace stay exactly as today.
- **Colour with no photo:** jump silently to index 0 (first general image) when one exists,
  otherwise the index does not move. No message (§13 #3).
- **Re-tapping the selected colour:** jumps back to its first image (today it is a no-op). Small
  change in `handleSelectColor`: run the jump before the early return (§13 #4).
- **Browse (thumbnail tap, swipe, arrow buttons):** only the index changes. Never the colour,
  size, URL or any purchase state.
- **Wrap:** `next = (i + 1) % n`, `prev = (i - 1 + n) % n`, for swipe, arrow buttons and the modal.
- **Layout (both breakpoints, one gallery):** a 2:3 main image, a chip "3 / 12" bottom-right
  (kept from today), a magnifier icon top-right (lucide `ZoomIn`, decorative), then the strip.
  On desktop, chevron prev/next buttons sit on the main image's left and right edges, shown on
  hover and on keyboard focus. On phones they are hidden (swipe instead).
- **Desktop size:** the gallery column is sticky (`md:top-20`), and the main image is capped so
  main + strip fit the viewport: width `min(100%, (100svh - header - strip - gaps) * 2/3)`,
  centred in the column. The right column stops being sticky (it is taller than the viewport, so
  `sticky` does nothing useful there today) and simply scrolls.
- **Thumbnails:** 2:3, 64 px wide on phones (about 5 visible at 390 px), 80 px on desktop, 8 px
  gap. Active = 1 px ink outline with 2 px offset (same language as the selected swatch), others
  at full opacity (no dimming, keeps the minimal look). Strip is `overflow-x-auto`, no visible
  scrollbar on touch, `scroll-snap` off. Scrolling it into view uses `strip.scrollTo({ left })`
  computed from the thumbnail's offset, **not** `scrollIntoView` (that can scroll the whole page
  vertically on phones).

### 3.2 Swipe on the main image (phone)

Single main image slot (not a scroll-snap row of every photo), Pointer Events, `touch-action:
pan-y` so vertical page scroll still works:

- Horizontal drag moves the photo with the finger (`translateX`); release past 20% of the width
  or a flick (> 0.4 px/ms) goes to next/prev with wrap and a 180 ms slide; otherwise it snaps
  back. Reduced motion: no slide, instant swap.
- A drag over 10 px cancels the click, so a swipe never opens the modal.
- Why not keep the native scroll-snap row: it cannot wrap past the last image, it keeps every
  image in the DOM and the wrap/jump logic would fight the browser's scroll position.

### 3.3 Full-screen modal

- Native `<dialog>` with `showModal()`, the same choice `packages/ui` `Dialog` already made:
  focus containment, the rest of the page inert, Esc via the `cancel` event, top layer, backdrop.
- Opens at the current index. Closing (X, Esc, swipe down is not in scope) writes the modal's
  index back to the page gallery, so the shopper lands on the photo they last looked at. The
  colour stays untouched.
- Content: full photo with `object-contain` on a white background (brand look; §13 #5),
  counter "3 / 12", prev/next buttons (hidden when n = 1), X button top-right. Uses the 1600 file.
- Desktop keys: Left/Right = prev/next (wrap), Esc = close. Tab order: X, prev, next.
- Phone: swipe left/right = prev/next (wrap) **only at zoom 1**; pinch zooms 1x to 4x around the
  pinch centre, one-finger drag pans while zoomed (clamped to the photo edges), double-tap toggles
  1x/2.5x. Changing image resets zoom. Desktop: no zoom at all, no wheel or click zoom (§13 #6).
- **Scroll lock:** `overflow: hidden` on `<html>` while open (iOS Safari ignores it on `<body>`
  alone), plus `overscroll-behavior: contain` on the dialog; restored on close.
- **Focus restore:** focus returns to the element that opened it (the main image button). Done
  explicitly on close, not left to the browser default, so WebKit behaves the same as Chromium.

## 4. Edge cases

| Case | Behaviour |
| --- | --- |
| No photo at all | One placeholder (today's `ProductImage`), no strip, no counter, no magnifier, not clickable, no modal. |
| Exactly one photo | Main image only: no strip, no counter, no arrows, no swipe. Magnifier and modal still work (zoom is useful), modal has no prev/next. |
| Two photos | Wrap works both ways (prev from 1 = 2). |
| Colour with no photo of its own | Swatch still selectable; gallery goes to index 0 (§3.1). Purchase panel unchanged. |
| Only colour photos, no general | List starts at the first colour's group; behaviour unchanged otherwise. |
| Sold-out colour | Its photos stay in the strip and are browsable; selecting it jumps as usual. Stock never affects the gallery (SOLD OUT button logic is untouched). |
| Whole product sold out | Same gallery; only the existing SOLD OUT button. |
| Image tagged to a deactivated colour | Hidden from the strip (no swatch to explain it) unless it is the only photo (§2). |
| Photo fails to load | `ProductImage` placeholder in the main image; the thumbnail also uses `ProductImage` (400 placeholder) so no broken icon. |
| `?color=` unknown/stale | `resolveSelectedColorId` falls back as today; initial index 0. |
| Many photos (e.g. 20+) | Strip scrolls; only thumbnails near the viewport load (§5). |

## 5. Performance and layout shift

- **Pick the right file ourselves.** Checked in the installed Next 16.3.7
  (`next/dist/shared/lib/get-img-props.js`): next/image **deletes** a passed `srcSet` and, with
  `images.unoptimized`, generates none. So the main image becomes a plain `<img>` (inside
  `ProductImage`, same placeholder/onError behaviour, same `fill`-style 2:3 box) with
  `srcSet="800.webp 800w, 1600.webp 1600w"` and `sizes="(min-width: 768px) 40vw, 100vw"`. A
  2x phone gets 800, a 3x phone or desktop gets 1600. Needs an eslint override for
  `@next/next/no-img-element` on that one line, with a comment pointing here.
- **Thumbnails:** always the 400 file, `loading="lazy"` (browser default), `decoding="async"`,
  `sizes` irrelevant. Horizontal lazy-loading works in Chromium and WebKit for overflow
  containers.
- **Preload only the main image:** the initial main image gets `fetchPriority="high"` and
  `loading="eager"` (the Next 16 docs recommend these over `preload`; `priority` is deprecated),
  nothing else is prioritised. Today two images are marked priority; after this change exactly
  one.
- **Neighbours:** after the first interaction (swipe start, arrow hover/focus, thumbnail tap),
  warm `index +/- 1` with `new Image().src`. Modal images (1600) load only when the modal opens.
- **No layout shift:** main image and every thumbnail sit in fixed `aspect-[2/3]` boxes with
  `fill` (as today); the strip has a fixed height; the counter, magnifier and arrows are absolutely
  positioned. The server renders the right initial index, so nothing moves after hydration.
- **Bundle:** the modal (gesture code) is split with `next/dynamic` and loaded on first open (and
  prefetched on magnifier hover/focus), so it costs nothing on first paint.

## 6. Library vs hand-built

Installed today in `apps/web`: `react`, `next`, `lucide-react`, `@ammari/ui` (`clsx`,
`tailwind-merge`). **No carousel, lightbox, gesture or focus-trap library** anywhere in the repo.
The repo hand-builds its interactive pieces (`Curtain`, `MobileNav`, `packages/ui` `Dialog` on
native `<dialog>`).

| Piece | Hand-built cost | Library option |
| --- | --- | --- |
| Thumbnail strip, wrap, colour jump | Trivial, pure index math | none needed |
| Phone swipe on main image | ~80 lines, Pointer Events | embla-carousel (small, maintained) but no wrap-to-jump control we need for free |
| Focus trap, Esc, inert, top layer | Free with native `<dialog>` | none needed |
| Scroll lock | ~10 lines | none needed |
| **Pinch-zoom + pan + double-tap** | ~150 to 200 lines; the only risky part (iOS Safari gesture quirks) | PhotoSwipe 5 (vanilla, MIT, mature pinch-zoom, roughly 15 to 20 KB gzip JS+CSS, must be measured) or yet-another-react-lightbox + Zoom plugin (React, MIT, roughly 10 to 15 KB gzip, must be measured) |

**Decision: hand-built, no new dependency** (§13 #8). The gesture math lives in a pure module
(`lib/gallery/zoom.ts`: scale clamp, pinch centre, pan bounds, swipe decision) with unit tests;
the components only wire Pointer Events to it. Reasons: matches the repo's style and its native
`<dialog>` precedent; full control of Indonesian labels, wrap, reduced motion and the "never
change colour" rule; no third-party DOM/portal to style around; zero first-load cost either way
(dynamic import). Exit ramp: if the owner's real-iPhone check in session 3 finds pinch-zoom
not good enough, swap only the zoom layer for PhotoSwipe 5 (lazy-loaded, exact pinned version
at least 2 weeks old, sizes measured with `next build` output before and after). Owner accepted this (§13 #8).

## 7. Accessibility

- Main image: a real `<button>` wrapping the photo, `aria-label="Perbesar foto 3 dari 12"`,
  photo `alt` = its alt text (CMS-required). Magnifier icon `aria-hidden`.
- Page arrows: `aria-label="Foto sebelumnya"` / `"Foto berikutnya"`, real buttons, 44 px targets.
- Strip: a `role="group"` with `aria-label="Foto produk"`; each thumbnail is a `<button>` with
  `aria-label="Lihat foto 3 dari 12"` and `aria-current="true"` on the active one; thumbnail
  `<img alt="">` (the button already names it). Left/Right arrow keys move focus within the strip
  (roving `tabIndex`, one tab stop), Enter/Space selects.
- Counter: visible text "3 / 12"; a polite live region announces "Foto 3 dari 12" only on
  user-driven changes (not on colour jumps, which the swatch change already conveys, and not on
  first render).
- Modal: `<dialog aria-label="Galeri foto {nama produk}">`, X button `aria-label="Tutup"`,
  prev/next `"Foto sebelumnya"` / `"Foto berikutnya"`, counter in a polite live region. Focus
  starts on X, stays inside, returns to the opener on close.
- Visible focus ring everywhere (2 px ink outline, 2 px offset, design spec §8).
- `prefers-reduced-motion`: no slide or zoom animation (instant), same pattern as `Curtain`.
  Pinch-zoom itself still works (it is user-driven, not an animation).
- Contrast: the chip and icons sit on white chips (as today's counter), not directly on the photo.

## 8. Discount price and purchase panel

- `ProductPrice`, `view.price`, `resolveStorefrontPrice`, JSON-LD price: **not touched**.
- Purchase panel logic (colour, size, SKU, cart, buy now, WhatsApp, SOLD OUT, pending order
  notice): not touched, except `handleSelectColor` additionally sets the gallery index.
- Structure: extract the gallery into `components/pdp/product-gallery.tsx` (client), with the
  modal in `components/pdp/gallery-lightbox.tsx` (dynamic). The panel keeps owning `colorId` and
  passes the gallery a "jump" signal (`{ colorId, nonce }` or an imperative ref), so browsing state
  stays inside the gallery and can never flow back into colour state. The gallery receives no
  setter for colour at all, which enforces decision 3 by construction.
- `getGalleryForColor` is replaced by the flat list; `getPrimaryImage` and
  `resolveSelectedColorId` stay.

## 9. Files

- `apps/web/src/lib/content/product-view.ts` (+ test): `width`/`height` on `ProductGalleryImage`,
  `buildProductGallery(view)` (images + `colorStartIndex`), `initialGalleryIndex(view, gallery,
  requestedColorId)` (session 1, done). `getGalleryForColor` stays until session 2 replaces its
  one caller (the panel), then goes.
- `apps/web/src/lib/gallery/index-math.ts` (`nextIndex`, `prevIndex`, `colorJumpIndex`; session 1,
  done), `apps/web/src/lib/gallery/zoom.ts` (session 3) (+ tests).
- `apps/web/src/lib/storage/public-url.ts`: `buildImageSrcSet` (session 1, done).
- `apps/web/e2e/seo-meta.spec.ts`: canonical URL test (session 1, done).
- `apps/web/src/components/pdp/product-gallery.tsx` (+ test), `gallery-lightbox.tsx` (+ test).
- `apps/web/src/components/pdp/product-purchase-panel.tsx` (+ test update), `app/products/[slug]/page.tsx`.
- `apps/web/src/components/product-image.tsx` (+ test): optional responsive mode (plain `<img>`
  with `srcSet`/`sizes`/`fetchPriority`), placeholder fallback unchanged (session 1, done).
- `apps/web/e2e/pdp-gallery.spec.ts` (new), `product-page.spec.ts` and
  `product-image-fallback.spec.ts` (selectors `.md\:hidden img` / `.md\:flex img` go away;
  switch to the main image's role/test id), `storefront-fixtures.ts` (one product with 2 general
  + 2 colour groups of 2 + a colour without photo).
- `docs/design/storefront.md` §6 item 1 (session 1, done).

## 10. Tests

### Unit (Vitest + Testing Library, jsdom)

`product-view.test.ts`
- Order: general first, then colour groups in swatch order, each by `sort_order`.
- `colorStartIndex` correct; absent for a colour with no photo.
- Deactivated-colour images excluded, but used when they are the only photos.
- No photo: empty list. One photo: list of one.
- `initialGalleryIndex`: valid `?color=` with photos, valid without photos (0), unknown (0), none (0).

`index-math.test.ts`: next/prev wrap for n = 1, 2, 5; jump to colour; colour without photo.

`zoom.test.ts`: scale clamps 1 to 4; pinch centre keeps the point under the fingers; pan clamped
to edges; swipe allowed only at scale 1; threshold and flick decisions; double-tap toggle.

`product-gallery.test.tsx`
- Renders strip with n thumbnails, `aria-current` on active, counter text.
- Thumbnail click changes main image and does **not** call anything colour-related.
- Arrow buttons wrap; arrow keys move focus in the strip.
- Jump signal moves to the colour's first image.
- n = 1: no strip/arrows/counter; n = 0: placeholder, no button.
- Reduced motion: no transition class.

`gallery-lightbox.test.tsx`: opens at index, ArrowLeft/Right wrap, Esc closes and reports the
index back, focus starts on "Tutup" and returns to the opener, `<html>` overflow locked/restored.
(jsdom lacks `showModal`; polyfill in the test like the existing `Dialog` tests, if any, else a
small stub.)

`product-purchase-panel.test.tsx`: colour click still sets `?color=`, resets size, AND jumps the
gallery; browsing the gallery leaves "Warna: X", size selection and the URL untouched; price
display unchanged with and without an active discount.

### E2E (Playwright, Chromium + WebKit projects, each test at 390 px and 1280 px)

`pdp-gallery.spec.ts`
1. Strip shows all images in order (general, then colour groups); active thumbnail outlined.
2. Selecting a colour jumps the main image to its first photo and the active thumbnail is within
   the strip's visible area; URL gets `?color=` via replace (back leaves the page).
3. Thumbnail tap and arrows (desktop) / swipe (390 px, `page.mouse` drag or touch dispatch)
   change the image, wrap at both ends, and never change "Warna: X", size or URL.
4. Landing with `?color=<navy>` starts on navy's first photo; landing without starts on index 0.
5. Colour without photo: selecting it shows the first general image.
6. Modal: click main image opens it at the same photo; Right on last goes to first; Esc closes;
   focus back on the main image; page did not scroll while open; closing at photo k leaves the
   page gallery at k.
7. Modal at 390 px: swipe next/prev; pinch-zoom via CDP touch events in Chromium only (WebKit
   cannot synthesize multi-touch in Playwright, so WebKit asserts double-tap zoom instead; real
   pinch is the owner's iPhone check).
8. One-photo product: no strip, no arrows, modal opens without prev/next. No-photo product:
   placeholder, no button (existing fallback spec, updated selectors).
9. No layout shift: main image box height equal before and after hydration and after image load
   (`boundingBox` compare), CLS from `PerformanceObserver('layout-shift')` is 0 on load.
10. Only one image has `fetchpriority="high"`/preload; thumbnails have `loading="lazy"`.
11. Discount product (existing `discount-fixtures.ts`): price block identical before and after
    browsing the gallery and opening the modal.

Plus: `visual-screenshots.spec.ts` captures gallery and open modal at both widths.

## 11. Session split (one feature per session)

1. **Data + design doc + canonical (done 2026-10-23):** `buildProductGallery`,
   `initialGalleryIndex`, width/height; `index-math.ts`; `buildImageSrcSet` and the responsive
   `ProductImage` mode (§5); canonical `/products/<slug>` in `generateMetadata` (§13 #7) + e2e;
   `docs/design/storefront.md` §6; unit tests. No visible UI change shipped (the new functions
   and the responsive mode have no caller yet; the canonical `<link>` is head-only).
2. **Page gallery:** `product-gallery.tsx` (main image, counter, magnifier, strip, desktop
   arrows, phone swipe, colour jump), wire into the panel and page, responsive image sizes,
   preload, update existing e2e selectors, new e2e 1 to 5, 9, 10, 11.
3. **Modal:** `gallery-lightbox.tsx` + `zoom.ts` (dynamic import, native dialog, keys, swipe,
   pinch, double-tap, scroll lock, focus restore), e2e 6 to 8, visual screenshots. Owner's real
   iPhone Safari check closes this session (exit ramp in §6 if pinch is not good enough).

Each session: `/code-review` with `react-reviewer` + `typescript-reviewer` before the owner
commits.

## 12. Risks

- iOS Safari gesture handling (pinch vs page zoom, `touch-action`) is the main risk; isolated in
  `zoom.ts` and session 3, with the PhotoSwipe exit ramp.
- Playwright cannot do real multi-touch in WebKit; real-device check is required.
- Existing e2e tests use the `.md:hidden` / `.md:flex` gallery selectors; they must move to
  role-based selectors in session 2 or they break.

## 13. Owner answers (2026-10-23, final, all recommendations accepted)

1. **Colour order:** gallery colour groups follow the storefront swatch order (creation date).
   Storefront and admin colour order stay unchanged.
2. **Landing photo:** no `?color=`: the first photo overall; with `?color=`: that colour's first
   photo.
3. **Colour without photos:** jump silently to the first general photo, no message.
4. **Re-tapping the selected colour** jumps back to its first photo.
5. **Viewer background:** white.
6. **No desktop zoom** in the viewer.
7. **Canonical:** add `/products/<slug>` (no `?color=`), as part of this work (session 1).
8. **Dependency:** hand-built pinch-zoom; PhotoSwipe only if the owner's iPhone test fails.
9. **Desktop prev/next arrows** on the page gallery show on hover and keyboard focus only.

No open questions remain.

## 14. Session 2 notes (2026-10-23)

- `components/pdp/product-gallery.tsx` replaces both old galleries; `getGalleryForColor` is gone.
  The panel computes `buildProductGallery(view)` once and calls the gallery's imperative
  `showColor(colorId)` from `handleSelectColor` (before the early return, so a re-tap jumps too);
  the old scroll-reset effect and its `eslint-disable` are gone.
- The swipe decision is a pure module, `lib/gallery/swipe.ts` (+ test), for session 3 to reuse.
- Clicking the main image calls the optional `onOpenViewer(index)` prop; nothing passes it yet.
  Session 3 opens the lightbox there (and writes the closing index back).
- `ProductImage` now forwards `fetchPriority` (and eager loading) on its next/image path too, so
  the no-photo placeholder is the prioritised image. No `priority` on the PDP any more.
- Preload: React 19 itself emits one `<link rel="preload" as="image" imagesrcset>` for the
  eager, high-priority main `<img>`. That is the single preload; e2e 10 asserts exactly one
  product-photo preload. (The footer's payment logos have their own preloads, unrelated.)
- Thumbnail placeholder uses the 800 file (there is no 400 placeholder).
- E2E fixture: `e2e/gallery-fixtures.ts` (own fabric, old `created_at`, like
  `discount-fixtures.ts`) instead of extending `storefront-fixtures.ts`, so no other spec's
  related list or homepage changes. It carries an active discount, used by e2e 11 instead of the
  discount fixtures (those have no photos).
- E2E added beyond the list: 3b (arrows on hover/focus only, hidden on phones), 3c (strip keys).

### Owner feedback round (2026-10-23, before commit)

- **Slide on every change.** Arrows, thumbnails, colour jumps and page keys slide too (before,
  only the swipe did). Next and wrap-around from the last photo come in from the right, previous
  from the left, and a jump slides once toward the target's side. All slides, including a swipe's
  finish and snap-back, use one Web Animations slide (`GALLERY_SLIDE_MS` 300, ease-out, in
  `lib/gallery/swipe.ts`). The index updates at once and the leaving photo slides out beside the
  new one. A newer change cancels the running slide and starts from the track's live offset, so
  the latest target wins with no queue. A drag takes over a running slide. Reduced motion: instant.
- **Left/Right anywhere on the page** step the photo (wrap, slide, announced). Ignored with a
  modifier, during IME composition, mid-drag, in text fields, contenteditable and arrow-key ARIA
  widgets, inside anything that scrolls sideways (the size chart), while a `dialog[open]` or
  `[aria-modal=true]` is open (the session 3 viewer), and when the thumbnail strip already used
  the key (it moves focus there, so the photo never moves twice).
- E2E 12, 12b, 12c (slide direction, wrap, rapid clicks, reduced motion), 13 and 13b (page keys
  and the ignored cases).

## 15. Session 3 notes (2026-10-23)

- `components/pdp/gallery-lightbox.tsx` (native `<dialog>`, `showModal()` on mount) is owned by
  the page gallery: tapping the main photo (or Enter/Space) opens it at the current index; its
  `onClose(lastIndex)` sets that index on the page gallery without a slide, reveals its thumbnail
  and focuses the main photo. The `onOpenViewer` placeholder prop is gone. Loaded with
  `next/dynamic` on first open, prefetched on pointer enter, focus and pointer down of the main photo.
- The slide machinery moved out of `product-gallery.tsx` into `lib/gallery/use-slide-track.ts`
  (drag, Web Animations slide, interruption, slots); page gallery and viewer both use it, so the
  viewer slides with the same `GALLERY_SLIDE_MS`/easing and is instant under reduced motion.
- Zoom math is `lib/gallery/zoom.ts` (pure, tested). Zoom reacts to `pointerType === "touch"`
  only, so mouse/trackpad never zooms (§13 #6); a touchscreen laptop or tablet at desktop width
  does get pinch and double-tap. The stage is `touch-action: none`, and `gesturestart` is
  prevented while open (iOS page zoom).
- Scroll lock: `overflow: hidden` on `<html>`, plus `scrollbar-gutter: stable` while open when
  the page has a classic scrollbar, so nothing behind moves sideways. Previous inline values are
  restored on close.
- `ProductImage` gained an optional `loading` override: the viewer's photos are eager without
  claiming `fetchPriority="high"`. The viewer uses the 1600 file and preloads only the two neighbours.
- E2E: 6, 6b (tab order, buttons, same slide timing), 6c (reduced motion), 7 (swipe; Chromium
  pinch and pan via CDP touch; double-tap via `touchscreen.tap` in both engines; desktop mouse
  never zooms), 8 (one-photo product); `visual-screenshots.spec.ts` captures the gallery and the
  open viewer at both widths. WebKit tabs with Option+Tab (Safari's Tab skips buttons by default).

### Owner feedback round (2026-10-23, before commit): open/close transition

- Open: the stage grows from the main photo's box to full screen (one transform on the stage,
  `GALLERY_SLIDE_MS`/easing) while a white backdrop layer and the controls fade in; the dialog
  itself is transparent. Close (X, Esc, back gesture via `cancel`): the page gallery switches to
  the last photo at once (`onClosing`), the photo shrinks back into the main photo, and only then
  the dialog closes and focus returns. A main photo off screen or without size: the whole viewer
  fades instead. A close the browser already did (uncancellable Esc): no animation.
- `data-state` on the dialog: `opening` / `open` / `closing`; no input except X/Esc outside
  `open`. Esc during the opening reverses the opening in place. Safety timers end a transition that
  never reports its end. Reduced motion: instant open and close.
- Known approximation: a non-2:3 photo's contained box does not exactly match the 2:3 cover crop
  on the page, so its first and last frames are slightly off. Closing while zoomed shrinks the
  zoomed photo.
