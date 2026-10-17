# Ammari storefront — design spec (apps/web)

Source of truth for the storefront UI. Mockups: `docs/design/mockup-*.png` (mobile, 390 px wide).
Data and CMS behaviour are defined in `docs/plans/storefront-cms.md`; this file only covers how things look and behave.

## 1. Direction

Minimal, editorial, Zara-like: white ground, large photography, small refined type, generous whitespace, no decoration.
Calm and modest (brand sells syar'i gamis): no loud colours, no badges/stickers, no countdown/urgency tricks, no emoji.
Mobile first. Most visitors arrive from Instagram/TikTok on phones.

## 2. Hard rules

- All UI copy in Indonesian. Route paths in English (`/products/[slug]`).
- Never mention the payment gateway name (no "Midtrans") or the shipping origin city (no "Bandung", no "dikirim dari …") anywhere.
- No invented claims (no customer counts, ratings or testimonials unless they come from real data).
- Never show stock counts. Availability is only "available" vs "habis" (crossed out).
- Never render cost/HPP or internal fields; only use the allowlisted storefront read layer.

## 3. Tokens

### Colour
| Token | Hex | Use |
|---|---|---|
| `--color-bg` | `#FFFFFF` | page background |
| `--color-ink` | `#1E1A1A` | primary text, icons, outlines, selected states |
| `--color-ink-muted` | `#5F5656` | secondary text, captions (≥ 4.5:1 on white) |
| `--color-ink-soft` | `#3E3636` | long-form body text inside accordions |
| `--color-brand` | `#695A5A` | brand colour: wordmark, PRIMARY buttons (white text), section eyebrows, footer background |
| `--color-pay` | `#F07A1A` | ONLY the final "Bayar sekarang" button. Text on it must be `--color-ink` (white on this orange fails contrast) |
| `--color-surface` | `#F6F3F1` | soft section background ("Kenapa Ammari", summaries, status boxes) |
| `--color-image-bg` | `#EEEAE7` | placeholder behind images while loading |
| `--color-line` | `#ECE7E4` | hairline dividers |
| `--color-line-strong` | `#D9D2CE` | input and unselected control borders |
| `--color-disabled` | `#8A7F7F` | disabled primary button background |
| `--color-error` | `#8C1D18` text / `#B3261E` border | inline errors |

Footer (on `--color-brand`): text `#FFFFFF`, dividers `#857676`, chip borders `#A39595`.

### Typography
| Role | Font | Size / weight | Notes |
|---|---|---|---|
| Wordmark "AMMARI" | Alta (NOT licensed yet — see §9) | 22 px header, 26 px footer | letter-spacing 0.34em, colour `--color-brand` (white in footer); brand logo mark to its left, see §9 |
| Display / headings | Cormorant Garamond | H1 hero 40 px / 300, line-height 1.05; page H1 30 px / 400; section H2 24–28 px / 400 | Load weights 300/400/500/600/700 only |
| UI + body | Jost | body 13–15 px / 400; emphasis 500 | Load 300/400/500 |
| Eyebrow / labels | Jost | 11 px / 500, letter-spacing 0.24em, uppercase | e.g. "KOLEKSI PERDANA", "KEUNGGULAN" |
| Buttons | Jost | 12 px / 500, letter-spacing 0.16–0.2em, uppercase | |

Use `next/font` (self-hosted, `display: swap`). No Inter/Roboto/Arial.

Button variants (`apps/web/src/components/buttons.tsx`): `PrimaryLink`/`PrimaryButton` (solid
`--color-brand`, white text — PDP, cart, checkout), `OutlineLink` (static outline, no hover-fill
— PDP secondary action), `HeroCtaLink` (Hero only — outlined by default, fills to the solid look
on hover/focus, see §5 item 1). The hero variant's hover-fill only applies on devices that
support hover (`can-hover:`, a custom variant in `globals.css`) so a tap on a touch screen never
leaves it stuck filled; touch gets its own brief fill on `:active` instead.

### Spacing, shape, motion
- Base unit 4 px. Page gutter 16 px on mobile, 24 px on hero overlays; desktop container max-width 1440 px with 40 px gutter.
- Corners: square (radius 0) everywhere, except colour swatches (circles).
- Touch targets ≥ 44 × 44 px. Primary buttons 52 px tall, "Bayar sekarang" 54 px.
- Motion: subtle only (opacity/transform 150–200 ms). Respect `prefers-reduced-motion`.
- Icons: lucide-react, stroke 1.3–1.5, 18–24 px, `aria-hidden` when decorative.

## 4. Global layout

### Header (56 px, white, bottom hairline)
Mobile: menu button (left) · wordmark (logo mark + "AMMARI") centred · search + cart (right, cart shows count). Desktop (≥ 1024 px): wordmark left, nav links centre, search/account/cart right. Sticky on scroll. The wordmark's logo mark renders `tone="primary"` here (brand-coloured mark on white), ~24 px.

### Footer (`--color-brand` background, white text)
Wordmark (logo mark + "AMMARI", `tone="white"`, ~28 px) + tagline "Graceful in every thread"; help links (Cara pemesanan, Pengiriman, Pengembalian & penukaran, Panduan ukuran, Syarat & ketentuan → `/terms-of-service`, Kebijakan privasi → `/privacy-policy`); contact (WhatsApp — shown as the formatted number, e.g. "+62 888 0854 1442", linking to wa.me — email, business address — from store settings, CMS session 8; until then hide the block); payment-method chips (QRIS, Virtual Account, GoPay, ShopeePay, Kartu kredit) without naming the gateway; "© 2026 Ammari".

## 5. Homepage `/` (all content from the published CMS sections; a hidden or empty section is not rendered)

1. **Hero** — full-bleed image (mobile ~620 px tall, desktop ~85vh), optional separate mobile crop. Top-left overlay: eyebrow + H1 headline (keep CMS line breaks). Bottom: full-width CTA (CTA label → target), outlined by default (transparent background, `--color-brand` border/text) and filling to the solid `--color-brand`/white look on hover or focus — hover-fill only on hover-capable devices, touch gets a brief fill on tap instead (`HeroCtaLink`, §3 Typography). Text sits on the image; the CMS image should be light behind the text (document this for the owner).
2. **Product grid** — H2 section title + count ("6 produk"). Tiles: image 2:3, then name (12 px), colour name (12 px muted), price (13 px / 500). 2 columns mobile with 2 px column gap and 20 px row gap; 3 columns ≥ 768 px; 4 columns ≥ 1280 px. Whole tile is a link to `/products/[slug]` (with `?color=` when the tile is a colour variant). Filter chips are out of scope.
3. **Kenapa Ammari** — `--color-surface` band; eyebrow + H2; up to 4 points in a 2-column grid (4 columns on desktop): icon (from the fixed icon-key map), title 14 px / 500, short text 12 px muted.
4. **Feature block** — large image (~600 px mobile); white caption bar at the bottom: title (Cormorant 22 px) + subtitle (muted) and an underlined text-link CTA ("LIHAT") to the linked product.

## 6. Product page `/products/[slug]`

Mobile order:
1. **Gallery** — horizontal swipe, scroll-snap, image ratio 2:3 full width, counter "1 / N" bottom-right on a white chip. Images follow the selected colour. Desktop: two columns — left a vertical stack of images (or grid 2-up), right a sticky info column (max ~440 px).
2. **Name** (Cormorant 30 px) · **price** (17 px / 500, "Rp269.000" format) · one short muted line.
3. **Colour** — label "Warna: <name>"; 44 px circular swatches with 4 px white inner gap; selected = 1 px ink ring. Changing colour updates gallery and URL (`?color=`), replace not push.
4. **Size** — label "Ukuran" (+ ": M" when selected) with "Panduan ukuran" link (opens/scrolls to the Ukuran accordion). 5-column grid of 46 px buttons; selected = ink fill, white text; unavailable = struck-through, `disabled`, muted, `aria-label="M, habis"`.
5. **Primary button** (brand colour): "PILIH UKURAN" (disabled look) until a size is chosen, then "TAMBAH KE KERANJANG". After adding: inline status box "Masuk keranjang: Beige, M · Lihat". (Cart itself is a later session; until then the button can be hidden or route to WhatsApp — decide in session 7 and report.)
6. **Secondary button** — outlined "TANYA VIA WHATSAPP" (prefilled message with product name, colour, size, URL).
7. **Trust row** — 3 small items: "Pembayaran aman", "Ongkir otomatis saat checkout", store exchange policy (from settings; hide until it exists).
8. **Keunggulan** — eyebrow "KEUNGGULAN"; numbered rows 01–05 (Cormorant numeral in brand colour + 15 px label + the icon for the key), canonical key order, hairline between rows.
9. **Accordions** (one open at a time, "Deskripsi" open by default; `+`/`−`, `aria-expanded`): **Deskripsi** (sanitized rich text), **Perawatan** (fabric care text), **Ukuran** (size chart table: Ukuran · Lingkar dada · Panjang gamis · Panjang lengan · Rekomendasi tinggi badan; horizontal scroll inside the accordion on small screens; plus all-size fit note when applicable), **Pengiriman & pengembalian** (general text; no origin city).
10. **"Lengkapi koleksimu"** — 2 related tiles (same tile component as the grid).

SEO: unique `<title>`/description per product, Open Graph image = first gallery image, `Product` JSON-LD with price in IDR and availability. Dev environment stays `noindex`.

## 7. Cart and checkout (later sessions — see mockups `mockup-cart.png`, `mockup-checkout.png`)

Cart: line items (image 96×144, name, "Warna · Ukuran", line total, qty stepper 1–10, remove ×), subtotal, "Ongkir: Dihitung saat checkout", primary "LANJUT KE CHECKOUT", text link "LANJUT BELANJA".
Checkout (single page, numbered sections 1 Kontak · 2 Alamat pengiriman · 3 Pengiriman · 4 Ringkasan) — behaviour decided by the owner:
- Guest checkout; email + WhatsApp number required; account auto-created (no password) + required consent checkbox (S&K + privacy links).
- Logged-in: email and phone are LOCKED (read-only card + "Bukan kamu? Keluar"); address shown as a summary card with "UBAH" / "GANTI ALAMAT"; editing offers "Perbarui alamat tersimpan"; orders store an address SNAPSHOT.
- Area search field "Kecamatan atau kode pos" (province, city, postal code, area ID filled from the courier service). Map pin (lat/lng) required only for instant couriers (GoSend/GrabExpress).
- Courier list as large radio rows (name, ETA, fee).
- Voucher: single dropdown field (Shopee-like); best voucher auto-selected (largest discount, then soonest expiry); × clears it; guests see "MASUK UNTUK PAKAI VOUCHER" (OTP) — vouchers never usable by just typing an email.
- "BAYAR SEKARANG" always enabled, colour `--color-pay` with ink text; when something is missing show an inline alert listing what to fix.

## 8. States and accessibility

- Every page: loading skeletons in `--color-image-bg`, empty states with a primary button back to the collection, friendly Indonesian error messages.
- Real `<button>`/`<a>`/`<label>`; visible focus ring (2 px ink outline, 2 px offset); `alt` from CMS alt text (required in admin).
- Text contrast ≥ 4.5:1 (≥ 3:1 for ≥ 24 px).
- Must work and be checked at 390 px and 1280 px (Playwright screenshots), Chromium + WebKit; real iPhone Safari check by the owner.

## 9. Wordmark (temporary) + logo mark

The Alta font is not licensed yet. Until the owner buys a licence: render "AMMARI" as text in Cormorant Garamond 700, letter-spacing 0.34em, colour `--color-brand`, inside a component (`<Wordmark />`) so it can later be swapped for an SVG logo without touching pages. Do NOT add any Alta font file to the repo.

The real Ammari logo mark (not a placeholder) renders immediately to the left of the text, vertically centred, 8 px gap (`gap-2`) — `<Wordmark />` takes a `tone` prop (`"primary" | "white"`) selecting which generated PNG to show, defaulting to match `size` the same way the text colour already does: `size="header"` → `tone="primary"` (`/logos/ammari-primary.png`, displayed 24 px tall), `size="footer"` → `tone="white"` (`/logos/ammari-white.png`, displayed 28 px tall). Both are `next/image` with explicit intrinsic `width`/`height` (94×112, the generated files' own real pixel size — not a 1:1 square) and a `style={{ height, width: "auto" }}` override for the displayed size, so there's no layout shift and no distortion; `alt=""` since the logo is decorative next to the text, the surrounding `<Link>` already carries the accessible name ("Ammari — beranda").

The two served files are GENERATED, not copied verbatim, by `packages/ui/assets/copy-brand-logos.mjs` (`node packages/ui/assets/copy-brand-logos.mjs` from the repo root — re-run after replacing the source art):
- Source: `packages/ui/assets/logo-ammari-primary.png` only (1254×1254, true alpha cutout). `logo-ammari-white.png` in that same directory is kept only as a reference source file — it is NEVER used to produce a served file (see below).
- The script trims the source's transparent padding, resizes to 112 px tall (4x the largest displayed size, 28 px, for crisp 2x/3x-DPI phone screens), and writes an optimized PNG — `ammari-primary.png`, currently ~94×112 px, ~4.7 KB.
- `ammari-white.png` is DERIVED from the trimmed/resized primary's own alpha channel (every opaque pixel repainted pure `#FFFFFF`, alpha untouched) rather than from the source `logo-ammari-white.png` file, which is not a clean cutout — every pixel across its canvas carries a translucent white alpha wash (roughly 20–25%) instead of true `alpha=0` outside the mark, which showed as a faint whitish box behind the mark against the footer's `--color-brand` background before this fix. Currently ~94×112 px, ~3.2 KB. This recolour technique is only valid because the primary mark is a single flat colour (verified by sampling: every fully-opaque pixel falls within R 90–106/G 73–88/B 72–86, consistent with anti-aliasing noise around one colour) — re-verify that by hand before reusing the technique if the source art ever becomes multi-colour.
- Both generated files are written to both apps' `public/logos/` (not committed from a manual edit) — never hand-edit them, always regenerate via the script.

Checked at 390 px: menu button, logo+wordmark, and account icon keep a comfortable ~50 px gap on each side at the current sizes — no collision, no mobile-only size reduction needed. Checked at 1280 px: the footer's white mark has no whitish-box artifact.
