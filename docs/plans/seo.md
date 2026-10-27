# SEO — storefront (apps/web) + indexing safety (admin, dev)

One session, 2026-10-27. No commits, no server changes, nothing submitted to Google or any
external service, no new dependency.

## 1. Findings (state before this session)

| Area | Found |
| --- | --- |
| Titles | Every page has a "Name \| Ammari" title; `/` is editable (Pengaturan Toko). The root layout's fallback description is the placeholder `"Ammari \| syar'i gamis"`. |
| Product description ("Langkah 624") | `generateMetadata` replaces tags with spaces and cuts at 160 chars: entities stay encoded (`&amp;`, `&nbsp;`), whitespace is not collapsed, the cut lands mid-word with no ellipsis, and a product without a storefront description gets an English-ish `"<name>, Ammari syar'i gamis."`. JSON-LD `description` has the same entity/whitespace problems. |
| Info pages | Title only, no meta description, no canonical. An unpublished page ("sedang disiapkan") is indexable. |
| Canonical | `/products/<slug>` done (gallery session 1). `/` (has `?voucher=…` notice param) and info pages have none. |
| OG / Twitter | Site-level 1200x630 Hero JPEG + `summary_large_image` done. The product page's `openGraph` replaces the layout's whole block, so it loses `siteName`, `locale`, `type`, `url`, and has no width/height/alt/type for its photo. |
| JSON-LD | Product only. `offers.url` carries `?color=` (not canonical); no `brand`, `url`, `itemCondition`, only one image. Serialised with plain `JSON.stringify` inside `<script>`: a product name containing `</script>` would break out of the tag (XSS from admin-entered text). No Organization, WebSite, BreadcrumbList. |
| sitemap.xml | None. |
| robots.txt (web) | Exists, runtime `DEPLOY_ENV` (only `production` allows). No `Sitemap:` line, `/api/` not disallowed. |
| noindex, private routes | cart, checkout, checkout/finish, orders, login/link, preview have it. **Missing:** `/account`, `/account/complete-profile`, `/login`, `/claim`, `/claim/<token>`, `/consent`. |
| Non-production web | robots.txt disallow-all and PDP `robots` meta only. No HTML-level noindex on the other pages; the `X-Robots-Tag` header comes only from dev's Caddy (`deploy/caddy/Caddyfile`, every dev host). `next.config.ts` `headers()` is resolved at `next build`, so it cannot depend on runtime `DEPLOY_ENV` (the image is environment-neutral). |
| Admin (dev + prod) | No robots.txt (its auth proxy redirects `/robots.txt` to `/login`), no `noindex` meta. Prod Caddy sends **no** `X-Robots-Tag` for `admin.ammari.id` (`deploy-prod/caddy/Caddyfile` removed them all). Only dev admin is covered, by dev Caddy. |
| Alt text | Admin stores `"<name> warna <colour>"` by default, so DB alt text is already right. The storefront's fallback for a null alt is the bare product name on both tiles and the gallery. |
| Headings / lang | `lang="id"` on both apps. One h1 per page, **except `/` without a published Hero: no h1 at all.** |
| 404 | Real 404 status (already e2e-checked). Only a "Kembali ke halaman utama" link. |
| Performance | Hero with a separate mobile crop renders two `<Image priority>`s, so phones preload **both** 1600px files (one is `display:none`). PDP's first photo is `fetchPriority="high"`; image boxes are aspect-ratio boxes (no layout shift); fonts via `next/font`. |
| Social links | None in `store_settings` or code, so Organization gets no `sameAs`. |
| "Collection-like pages" | None exist: "Koleksi" is the `/#koleksi` anchor on `/`. Nothing to template. |

## 2. Changes

**apps/web, new `src/lib/seo/`** (pure, unit-tested):
- `text.ts`: `htmlToPlainText` (tags to spaces, entity decode, whitespace collapse) and
  `truncateAtWord` (≤160, word boundary, `…`).
- `descriptions.ts`: `productMetaDescription` (storefront description as text; empty gives an
  Indonesian template from name + colours, never empty), `infoPageMetaDescription` (published body
  as text, else a per-page template).
- `indexing.ts`: `isIndexableDeployment` (only `DEPLOY_ENV=production`, same rule as robots.ts),
  `PRIVATE_PATH_PREFIXES` (cart, checkout, account, orders, login, claim, consent, preview, api),
  `xRobotsTagFor(pathname, env)`, `NOINDEX` metadata constant.
- `json-ld.ts`: Product (canonical url, brand, images, offer with effective price,
  `priceValidUntil`, InStock/OutOfStock, NewCondition), Organization (Ammari, logo, contact
  email + WhatsApp from store settings, falling back to ammariofc@gmail.com / +62 888 0854 1442),
  WebSite, BreadcrumbList, and `serializeJsonLd` (escapes `<`, `>`, `&`, U+2028/9).
- `sitemap.ts`: `buildSitemap` from DB data: home, published info pages, active + published
  products; lastModified from `updated_at` / `published_at`; canonical URLs only.

**apps/web, wiring:**
- `app/sitemap.ts` (force-dynamic), `robots.ts` adds `Sitemap:` and disallows `/api/` in
  production. Private pages are **not** disallowed in robots.txt: a crawler has to fetch a page to
  see its `noindex`, and the header links to /cart and /account on every page.
- `src/proxy.ts`: **header only, no auth gate** (voucher-claim decision #3 is about session
  gating and still holds). Sets `X-Robots-Tag: noindex, nofollow` on every response when not
  production, and on private prefixes in production. This is the only runtime place for a header
  (next.config `headers()` is fixed at build time).
- Root layout: `robots` noindex when not production, real default description. `/`: canonical,
  Organization + WebSite JSON-LD, sr-only h1 fallback without a Hero. Info pages: shared
  `generateMetadata` (description, canonical, noindex while unpublished) + BreadcrumbList.
  PDP: clean description, full openGraph (siteName/locale/url/image size+alt+type), new JSON-LD,
  BreadcrumbList. Missing `robots` noindex added to account, complete-profile, login, claim,
  claim/<token>, consent.
- Alt fallback `"<name> warna <colour>"` on tiles and gallery (matches admin's default).
- 404: links to Koleksi and home.
- Hero: `<picture>` art direction via `getImageProps` (Next's documented pattern) so a phone
  downloads only the mobile crop; `fetchPriority="high"` instead of double `priority`.

**packages/db:** `getStorefrontSitemapData()` in `storefront/queries.ts` (explicit column lists,
same filters as the PDP query) + DB test.

**apps/admin:** `app/robots.ts` (always disallow-all), `/robots.txt` let through the proxy, layout
`robots` noindex, `X-Robots-Tag: noindex, nofollow` on every path via `next.config.ts` (static,
because admin is never indexable in any environment).

## 3. Tests

Unit: text, descriptions, indexing, json-ld (shape per type, escaping), sitemap builder, robots
(web, admin), DB query. Web e2e (`seo-indexing.spec.ts`, `seo-meta.spec.ts`): robots.txt,
sitemap.xml contents, `X-Robots-Tag` + meta noindex on private routes and on the non-production
e2e server, canonical/OG/JSON-LD on a product page, unknown product = 404.

## 4. Follow-ups (not in this session)

- Product OG image is the 1600px WebP; a 1200x630 JPEG per product (like the Hero's) would be
  safer for older scrapers.
- `ProductGroup` + per-colour/size variant offers, shipping/return-policy details on Offer
  (Merchant Listing fields) — a larger structured-data change.
- Social profile URLs (Instagram/TikTok/Shopee) in Pengaturan Toko, then `sameAs`.
- Prod Caddy: optionally add `X-Robots-Tag "noindex, nofollow"` back to `admin.ammari.id` only
  (belt-and-braces; the app now sends it itself).
