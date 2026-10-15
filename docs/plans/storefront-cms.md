# Plan: Storefront Content Management ("Konten") + Product Storefront Data

**Status:** Draft — all 7 open questions from the first round resolved by the owner (see
"Resolved decisions" at the bottom). Still awaiting final go-ahead to implement; nothing in this
plan has been built.

## Summary

Make the main site (`apps/web`, `ammari.id`) fully admin-driven: a new admin menu **Konten**
(permission `content.manage`) controls the homepage's four sections (Hero, Product grid, Feature
block, "Kenapa Ammari"), and the product form grows a storefront-facing section (published flag,
rich-text marketing description, per-color images with required alt text, care instructions,
size chart). The product detail page (PDP) on `apps/web` is generated entirely from this data, at
`/products/[slug]` from the start — no per-product code. Phase 2 (planned here, built later)
covers editable info pages and store contact settings for the footer, needed for
payment-gateway verification.

Everything below is scoped to **data, admin, and the read/caching layer**. The actual `apps/web`
visual layout (tokens, "Alta" wordmark, section-by-section markup) is deliberately left
structural — real design lands later as `docs/design/storefront.md` + mockups, per your note.

## Decision: draft + "Terbitkan" (publish), for the homepage — with the cost spelled out

**Decided: draft + publish**, not save-is-live. Cost, honestly:

- **More to build.** Every homepage section needs two states (`draft_content`,
  `published_content`), a "Terbitkan" action that atomically promotes draft → published across
  **all** sections in one transaction (publishing section-by-section would let a published page
  show, e.g., a new Hero headline next to a not-yet-published old grid — worse than the problem
  draft/publish exists to prevent), and a preview path so you can see the draft before
  committing (below).
- **A second thing that can be "wrong."** You can edit the draft, look happy, forget to click
  Terbitkan, and wonder later why the live site didn't change. The admin UI must make
  draft-vs-published state obvious (a persistent "Ada perubahan belum diterbitkan" banner) to
  keep this from biting you.
- **Preview needs its own (small) mechanism** — see "Preview" below — because `apps/web` only
  ever shows the published site to real visitors.

Against that: save-is-live means a half-typed headline or a tile pointing at a product you
haven't finished re-photographing goes out immediately, with no undo except re-editing under
pressure while customers can already see it. Given the homepage is the storefront's main shop
window and edits here (tile order, hero copy, a newly-added product) are exactly the kind of
multi-step change that's easy to leave half-finished, draft + publish is worth the extra
mechanism. **Store settings (Phase 2 — WhatsApp number, email, address) are the opposite case: no
draft/publish**, save = live — they're single factual values with no "half-finished" composition
risk, and the cost of a typo is "fix it again," not "half a page went out."

Product storefront fields (the "published-on-storefront" flag, description, images, etc.) also
have **no separate draft/publish** — see "Products" below for why.

## Grounding — what already exists (read before building)

- `products.highlights` (`text[]`, migration 0018) is the only storefront-shaped column that
  exists today, plus `packages/db/src/catalog/highlights.ts` (`PRODUCT_HIGHLIGHT_KEYS`/
  `PRODUCT_HIGHLIGHT_LABELS`/`PRODUCT_HIGHLIGHTS`) — reused as-is for the PDP's highlight icons,
  and reused as the **pattern** for "Kenapa Ammari" icons (see below).
- `fabric_colors` already has `name` (citext) and `hex` (`^#[0-9A-F]{6}$`) — this **is** the
  per-color "color name + swatch hex" the pasted brief asked for. No new column needed.
- `fabrics.care_instructions` already exists and its own doc comment in `docs/SPEC.md` §5.1 says
  it "will appear on the main-site catalog later." The PDP's "Perawatan" accordion reads **this**
  column (via the product's `fabric_id`), not a new product-level field.
- `product_images` already has `fabric_color_id` (null = general image), `sort_order`,
  `alt_text` (nullable today), `width`/`height` (post-EXIF-rotation). The per-color "ordered
  images with required alt text" requirement is covered by making alt text **required at
  publish time** (app-level, see "Products" below), not a schema change — see why below.
- `packages/db/src/queries.ts`'s `getActiveProductBySlug` is a **placeholder**: a bare
  `.select()` (every column, including anything added to `products` later) with a doc comment
  saying it's "not consumed anywhere yet." This plan retires it entirely — see "Storefront read
  safety."
- Image pipeline to reuse as-is: `apps/admin/src/lib/products/image-processing.ts`
  (`processUploadedImage` — magic-byte sniff, EXIF auto-rotate, strip metadata, 3 WebP sizes
  400/800/1600, `sharp.concurrency(1)` for the 2 GB VPS) and `image-keys.ts`
  (`buildImageStorageKey`/`buildImageObjectKey`). `apps/admin/src/lib/storage.ts`'s lazy
  `getStorageClient()` singleton (S3 in prod/dev, in-memory for e2e via `STORAGE_DRIVER=memory`,
  fails closed) is reused unchanged for content images, just with a different key prefix
  builder.
- Deploy topology (`deploy/docker-compose.yml`): `admin` and `web` are two **separate**
  containers on one internal Docker bridge network (`internal`), reachable from each other by
  service name (`http://web:3000`, `http://admin:3000`) — **neither is reachable from outside
  except through `caddy`**, and `caddy` enforces Cloudflare Authenticated Origin Pulls (client
  cert) on every public hostname. This matters a lot for revalidation (below): admin **cannot**
  just `fetch("https://ammari.my.id/...")` server-to-server — that request would hit Caddy's AOP
  gate with no client cert and fail. It must call `web` directly over the internal network.
  `apps/admin/.env`'s existing `MAIN_SITE_URL` is the **public** URL (used today only for QR/
  claim links meant for a human's browser) — a new, separate env var is needed for the
  internal-network call.
- RBAC: permissions are a flat `PERMISSIONS` array in `packages/db/src/rbac/permissions.ts`,
  synced into the DB only via a migration (never just `db:seed` — CLAUDE.md's database rule,
  already bitten the project twice). `super_admin` gets every permission; `owner` gets every
  permission except `roles.manage`/`staff.manage`/`audit_log.view` (`OWNER_EXCLUDED_PERMISSION_KEYS`).
  Nav items live in one array, `apps/admin/src/lib/nav/config.ts`. RBAC is **fully dynamic** —
  every page/action checks a permission **key**, never a role name — so granting `content.manage`
  to a future marketing-only staff role later is purely a roles-UI action, no code change.

## Data model

### New permission: `content.manage` (the only new permission this plan needs)

Added to `PERMISSIONS` (group `content`), granted to `super_admin` (always) and `owner` (not in
`OWNER_EXCLUDED_PERMISSION_KEYS`) via a migration shaped exactly like 0012
(`grant_orders_manage_permission.sql`): idempotent `INSERT ... ON CONFLICT DO NOTHING` into
`permissions`, then into `role_permissions` for both role keys. Any other staff role only gets it
once someone with `roles.manage` grants it from the (future) roles/staff admin screen — **no
hardcoded role-name check anywhere in this feature's code**, same as every other permission in
this codebase.

One permission, not split into a `content.view`/`content.manage` pair the way `stock`/
`inventory` are: this codebase splits view/manage only where a real "can see but not edit" role
exists today (packing staff viewing stock, for example). Nothing in the brief calls for a
content-viewer-only role, so a single `content.manage` matches the simpler precedent
(`products.manage`, `roles.manage`, `staff.manage` are all single permissions too). This single
permission gates **everything** customer-content-shaped: the four homepage sections, the
product form's new "Storefront" section (publish flag, rich-text description, size chart
assignment — see "Admin UX" and "Security" below for why these specific product-form fields sit
behind `content.manage` rather than the product form's usual `products.manage`), size charts, and
(Phase 2) info pages + store settings.

### Homepage content: `storefront_homepage_sections`

One row per section, **not** a generic page builder — four fixed keys, exactly matching the
brief's four sections, seeded idempotently in the same migration that creates the table (same
"reference data ships in a migration" rule CLAUDE.md gives for permissions/channels):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `key` | text, unique, `CHECK key IN ('hero','product_grid','feature_block','why_ammari')` | fixed set, 4 rows total, ever |
| `draft_is_visible` | boolean not null default true | show/hide, staged |
| `draft_content` | jsonb not null | shape below, per key |
| `draft_updated_at` | timestamptz not null default now() | bumped on every draft save |
| `published_is_visible` | boolean, nullable | null until first publish |
| `published_content` | jsonb, nullable | null until first publish |
| `published_at` | timestamptz, nullable | |
| `published_by_staff_user_id` | uuid references staff_users, restrict | |

**Why JSONB content instead of a child table per section (tiles, "Kenapa" points)**, breaking
from this codebase's usual fully-relational, FK-and-CHECK-enforced style (fabrics, variants,
etc.): those tables model business-critical, concurrently-written, cross-referenced data where a
DB-level guarantee matters (stock, money, SKUs). Homepage content is the opposite shape — edited
by exactly one person at a time, never joined against by anything else, and the "child rows"
(grid tiles, "Kenapa" points) have no identity or lifecycle of their own, same reasoning
`product-highlights.md` already gives for storing `highlights` as a plain array instead of a
child table. Modeling draft/publish as two JSONB columns on one row per section means "publish
everything atomically" is one `UPDATE ... WHERE key = ANY(...)` in one transaction, not a
copy-step across N child tables per section. The cost: a tile's `productId`/`fabricColorId`
reference is validated by application code (exists, active, `is_published_on_storefront`), not
enforced by a real FK — so a tile can end up pointing at a since-deleted-or-unpublished product.
The renderer must treat that as "skip this tile," never a crash (product rows are never
hard-deleted anyway, only deactivated, so "deleted" in practice means deactivated or
unpublished). The admin editor should visibly flag a tile whose product can no longer be
resolved ("Produk ini sudah tidak aktif — pilih produk lain"), same spirit as
`fabric_colors.is_active`'s "deactivated but still referenced" handling elsewhere in this schema.

Each `*_content` JSONB validated by a per-key Zod schema at save time (never trusted as-is from
the client), shape:

- **`hero`**: `{ eyebrow: string, headline: string, image: ContentImage, ctaLabel: string, ctaTarget: { type: "anchor" } | { type: "product", productId: string, fabricColorId: string | null } }`.
  `headline` keeps literal `\n` for the admin-authored line breaks the brief calls out.
- **`product_grid`**: `{ title: string, tiles: { productId: string, fabricColorId: string | null }[] }`.
  Validated: no duplicate `(productId, fabricColorId)` pair (the brief's "once per color" rule).
  Tile order **is** array order — reordering is an up/down swap + re-save, nothing fancier. A
  future `/products` catalog page (see "Resolved decisions" below) is a **separate, later**
  piece of work — this grid stays a hand-curated list, not a feed off the catalog.
- **`feature_block`**: `{ title: string, subtitle: string, image: ContentImage, linkedProduct: { productId: string, fabricColorId: string | null }, ctaLabel: string }`.
- **`why_ammari`**: `{ eyebrow: string, heading: string, points: { icon: WhyAmmariIconKey, title: string, text: string }[] }`
  (`points.length <= 4`, enforced in the Zod schema). **`icon`** is a key from a fixed,
  code-defined set — same pattern as `PRODUCT_HIGHLIGHT_KEYS`, not free text or an uploaded
  image, because (a) the brief asks for a closed set so each key maps to one icon, and (b)
  letting the admin upload an arbitrary icon image would be a second, smaller image-upload
  pipeline for no real benefit over a well-chosen fixed set. New module
  `packages/db/src/catalog/why-ammari.ts` (mirroring `catalog/highlights.ts` exactly):
  `WHY_AMMARI_ICON_KEYS` in `schema/constants.ts`, labels + canonical order here. **Proposed
  initial key set** (confirm/edit before implementation — this is a first draft, not a final
  answer the way the other 6 resolved questions are):

  | key | Indonesian label | why |
  |---|---|---|
  | `syari_design` | Desain Syar'i | longgar, menutup aurat, sesuai syariat |
  | `premium_fabric` | Bahan Premium | adem, tidak menerawang, jatuh sempurna — echoes the existing product highlight keys at brand level |
  | `handmade_craftsmanship` | Dijahit dengan Teliti | made-to-order/small-batch production story |
  | `comfortable_fit` | Nyaman Seharian | all-day wearability |
  | `easy_care` | Mudah Dirawat | low-maintenance washing/ironing |
  | `responsive_service` | Respon Cepat | WhatsApp-based customer service, matches the PDP's own "Tanya via WhatsApp" CTA |
  | `trusted_by_customers` | Dipercaya Ribuan Pelanggan | social proof, no specific number claimed in the key itself |
  | `bandung_made` | Dibuat di Bandung | local-provenance/craft story |

  Each key maps to one `lucide-react` icon in `apps/web` (exact icon chosen during
  implementation — not a planning-level decision), same "key↔label in `packages/db`,
  key↔icon-component in the consuming app" split `PRODUCT_HIGHLIGHT_KEYS` already uses.

`ContentImage` = `{ storageKey: string, altText: string, width: number, height: number }`
(optionally `mobileStorageKey`/`mobileWidth`/`mobileHeight` for the hero's optional separate
mobile crop) — a plain snapshot, not a row in any table, same "no independent identity"
reasoning as the tiles above. Alt text is `required` **in the Zod schema** for every
`ContentImage` — easy to enforce since, unlike `product_images`, nothing pre-existing needs this
field to stay nullable.

### Products: storefront fields

Additive, backward-compatible columns on `products` (nullable or defaulted, per CLAUDE.md's
expand/contract rule):

- `is_published_on_storefront boolean not null default false` — distinct from `is_active`
  (which already means "sellable/produced"). `CHECK (NOT is_published_on_storefront OR is_active)`
  — can't publish an inactive product (mirrors the existing belt-and-suspenders style). No
  draft/publish pair for this flag: flipping it **is** the publish action for that one product,
  same reasoning store settings get no draft/publish — there's no multi-field "half-finished"
  state to protect against; either the product is ready to show or it isn't, and the admin
  toggles it when it is. A product can still be edited (photos swapped, description tweaked)
  after publishing — those edits go live immediately.
- `storefront_description text`, nullable — the public "Deskripsi" accordion body, stored as
  **sanitized HTML** (see "Storefront description: rich-text editor" below) — a genuinely **new**
  field, confirmed separate from the existing `products.description` column. `products.description`
  **stays internal-only** (the admin's own working note) and the storefront read layer must never
  select it at all — not merely exclude it from rendering, exclude it from the query's own column
  list, so there's no code path where it could leak even by accident (reinforced by a dedicated
  test — see "Testing plan").
- `allsize_fit_note text`, nullable — for `size_mode = 'all_size'` products, shown instead of a
  size chart table (there's nothing to tabulate for a single size). Null ⇒ PDP's "Ukuran"
  accordion shows a generic "Ukuran: All Size" line. Plain text, not rich text (short, one-line
  note — no formatting need).
- `size_chart_id uuid references size_charts(id) on delete restrict`, nullable — only meaningful
  for `size_mode = 'sized'` products; null ⇒ "Ukuran" accordion omits the table (admin should fill
  it before publishing, enforced at publish time in app code, not a DB CHECK — a `sized` product
  can exist in admin mid-setup before it has a chart).

New tables — **fixed measurement columns**, not admin-defined ones (resolved; see bottom):

- **`size_charts`**: `id`, `name text not null` (e.g. "Gamis Reguler" — the reusable, named
  group of rows a product points to; most products likely share one chart, nothing forces it),
  timestamps.
- **`size_chart_rows`**: `id`, `size_chart_id` FK (cascade), `size` (reuses the existing `Size`
  enum, `CHECK size <> 'ALLSIZE'` — ALLSIZE never has a chart row, it uses
  `allsize_fit_note` instead), four fixed measurement columns, all **in cm**, all `integer`,
  all `CHECK > 0`:
  - `bust_cm` — Lingkar dada
  - `length_cm` — Panjang gamis
  - `sleeve_length_cm` — Panjang lengan
  - `height_recommendation_min_cm` / `height_recommendation_max_cm` — Rekomendasi tinggi badan,
    stored as two integers (`CHECK height_recommendation_max_cm >= height_recommendation_min_cm`)
    rather than a single pre-formatted "150–160" string, so the range stays queryable/validated
    instead of being baked into display text at write time; the PDP formats it as "150–160 cm",
    or just "150 cm" when `min = max` (a single recommended height, no range).
  - unique `(size_chart_id, size)`.

This replaces the earlier admin-defined-columns design (a `columns text[]` + parallel
`values_cm integer[]` on each row) — no longer needed now that the four measurements are fixed:
a plain relational table with named, individually-checked columns is simpler and safer than a
parallel-array scheme that had to validate "same length as the parent's column list" in app code.

**Per-color presentation** needs no new table: color name + hex = `fabric_colors.name`/`.hex`
(existing); ordered images with alt text = `product_images` filtered by `fabric_color_id`,
ordered by `sort_order` (existing); **price is always `products.base_price`** — same price
across every color and size of a product (resolved; see bottom). The storefront read layer never
consults `product_variants.price_override_amount` at all; that column still exists for whatever
internal purpose it already served, it's simply not part of the storefront price story.

### Size/availability mapping (no schema change — a storefront query, not new storage)

"Out of stock = shown crossed out" reads the **existing** stock ledger, the same way
`apps/admin/src/lib/stock/queries.ts` already does: for each active `product_variants` row
belonging to the published product, `available = SUM(stock_movements.qty WHERE sku = ...) > 0`.
The storefront exposes **only this boolean**, per size — never the raw quantity, and never any
scarcity-style "only N left" messaging (resolved; see bottom — this is now a firm decision, not
a deferred option). A deactivated variant (`is_active = false`) is also always `available =
false`, size-chart row or not.

### Phase 2 (planned now, built later)

- **`info_pages`**: `id`, `slug` (`CHECK slug IN ('privacy-policy','terms-of-service','returns-exchange','how-to-order','shipping')` —
  fixed set, matches the five pages named in the brief, two of which already have placeholder
  routes in `apps/web`), `title text not null`, `draft_body text not null`, `published_body text`,
  `draft_updated_at`, `published_at`, `published_by_staff_user_id`. Body is **Markdown**, not a
  rich-text/WYSIWYG document — far less to build, and rendered through a markdown renderer with
  raw HTML disabled (no stored-XSS surface from admin-authored content, which matters once this
  is "anyone with `content.manage`," not just the owner). Each page gets its own draft/publish
  (independent pages, unlike the homepage's one atomic publish moment).
- **`store_settings`**: a genuine singleton (`id` fixed to a known constant, or a `CHECK (id = 1)`
  on a plain integer PK — same idiom as any single-row settings table) holding
  `whatsapp_number`, `support_email`, `business_address`. **Save = live**, per the draft/publish
  decision above.
- Both gated by `content.manage`, same as everything else in this plan.

### Phase 3 (named for completeness, not scheduled)

`/products` — the catalog index page from `docs/SPEC.md` §3.3. Resolved: it comes **later**, as
its own piece of work, not bundled into this plan's sessions. Nothing here blocks it: the
storefront read layer's per-product query is already shaped so a future catalog listing query
can reuse the same explicit-allowlist pattern, but no listing query is built now (see "Storefront
read safety" below — `getPublishedCatalogProducts()` from the earlier draft of this plan is
dropped from current scope for exactly this reason).

## Storefront description: rich-text editor + sanitization

- **Editor: TipTap** (ProseMirror-based), configured with only `Document`, `Paragraph`, `Text`,
  `Bold`, `Italic`, `BulletList`, `OrderedList`, `ListItem`, `HardBreak` — every other
  `StarterKit` extension (`Heading`, `Blockquote`, `CodeBlock`, `HorizontalRule`, `Strike`,
  inline `Code`, etc.) explicitly disabled, and `Image`/`Link`/color or font-size marks never
  added at all. TipTap is `contentEditable`-based (not the legacy `execCommand` style), which is
  why it's the standard choice for a constrained WYSIWYG editor that needs to behave on mobile
  Safari — **smoke-test it on a real iPhone/iPad Safari (or an accurate simulator) early in the
  session that builds this**, before investing in the rest of the editor integration, rather than
  assuming it from this plan alone.
- **No links.** The brief leaves this to judgment; decided against for now. No named use case
  came up (not "read more," no cross-link to a policy page), and allowing links reopens a
  meaningfully larger sanitization surface — URL scheme allowlisting against `javascript:`/
  `data:`/open-redirect-style concerns, plus `target`/`rel` attribute handling — for a feature
  whose only named content is "paragraphs, bold, italic, lists." Cheap to add later as a scoped
  follow-up (one more allowed tag + one more attribute-sanitization rule) if a real need shows
  up; not worth building the guardrails for a hypothetical today.
- **Storage format: sanitized HTML**, not editor-native JSON or Markdown.
  - Against editor JSON: would require shipping a read-only TipTap renderer (or hand-writing a
    JSON→React mapper) into `apps/web`'s bundle just to display 1–2 paragraphs of text — extra
    weight on a storefront that should stay lean, for a format whose only consumer
    (`apps/web`) has no other reason to parse editor-specific JSON.
  - Against Markdown: a WYSIWYG editor producing clean, restricted Markdown needs a translation
    layer between its internal document model and Markdown syntax (nested lists are the usual
    pain point) — an extra moving part that buys nothing here, since the allowed feature set is
    already this small. TipTap's `editor.getHTML()` gives HTML directly, with no translation
    step, and HTML renders in `apps/web` with nothing more than `dangerouslySetInnerHTML` after
    sanitizing.
- **Sanitization: strict allowlist, both ends.** A small new shared package,
  `packages/content-sanitize` (`@ammari/content-sanitize`), exports one function,
  `sanitizeStorefrontDescriptionHtml(html: string): string`, built on `sanitize-html` (pure JS,
  no DOM/jsdom dependency needed server-side, unlike DOMPurify) with:
  `allowedTags: ["p", "strong", "em", "ul", "ol", "li", "br"]`, `allowedAttributes: {}` (none at
  all — no `class`/`style`/`id`, and no `href` since links aren't allowed), everything else
  discarded. Called **twice**, independently:
  1. **On save**, server-side, in the product form's storefront-description action — the
     client's `editor.getHTML()` output is never trusted as-is, same posture this codebase
     already applies to `highlights` (`z.enum`, never trusting the client's checkbox state
     directly).
  2. **On render**, server-side, in `apps/web`, immediately before `dangerouslySetInnerHTML` —
     defense in depth: a second, independent guarantee that holds even if a bad value ever got
     into the column some other way (a direct DB edit, a future bug in the save path), same
     "belt and suspenders" posture this schema already applies elsewhere (DB CHECK **and** Zod
     for highlights; composite FKs **and** app-level checks for fabric/closure immutability).
- **Gated by `content.manage`**, not the product form's usual `products.manage` — see "Admin
  UX"/"Security" below.

## Storefront read safety (`packages/db`)

New module `packages/db/src/storefront/queries.ts`, replacing `getActiveProductBySlug` entirely
(delete it — it's unused today and is exactly the bare-`.select()` anti-pattern this module must
not repeat):

- **Never a bare `.select()`** anywhere in this module — every query names its exact column list
  explicitly, so a future column added to `products`/`fabrics`/`product_variants` (e.g. a cost
  field) does **not** silently appear in a storefront response just because it exists on the
  table. In particular, `products.description` (the internal note) is never in that column list
  at all — not filtered out after the fact, never selected in the first place.
- `getPublishedHomepageContent()` — reads `storefront_homepage_sections`, returns
  `published_content`/`published_is_visible` only (never the draft columns).
- `getDraftHomepageContent()` — same shape, reads the draft columns; used only by the admin
  editor and the preview route (below), never by a normal storefront request.
- `getStorefrontProductBySlug(slug)` — backs `/products/[slug]` from day one. `products` filtered
  on `is_active = true AND is_published_on_storefront = true`, explicit column allowlist (id,
  name, slug, `basePrice`, `storefrontDescription`, `highlights`, `sizeMode`, `allsizeFitNote`,
  `sizeChartId`), joined to: its `fabric`'s `care_instructions` only (never `price_amount`/
  `price_unit`/`supplier`); its active `product_images` (id, storageKey, fabricColorId, altText,
  sortOrder, width, height); its active `fabric_colors` (id, name, hex); its active
  `product_variants` (sku, fabricColorId, size, `available` boolean per the stock query above —
  never `price_override_amount`, `min_stock_qty`, or any raw stock number); its `size_chart` +
  `size_chart_rows` if `size_chart_id` is set. Price in the returned shape is `products.base_price`
  alone — resolved, no per-variant price logic. **Never** joins `fabrics.price_amount`/
  `price_unit`, `cost_components`, `production_batch_costs`, `accessory_movements.value_amount`,
  `stock_movements.value_amount`, or any `production_*` table.
- A future catalog-listing query (`/products`, Phase 3) is **not** built now — nothing in this
  plan's sessions needs it (the homepage grid works off per-tile product+color lookups, not a
  listing function), so it's deferred alongside the catalog page itself rather than built ahead
  of its one caller.

**Test** (`packages/db/test/storefront-queries.test.ts`): seeds a product with every cost-bearing
field populated (fabric price, a posted production batch with real costs, stock movement value
amounts) **and** a distinct internal `description` value alongside its storefront-safe fields,
calls every function above, and asserts the **serialized JSON output**:
- contains none of a denylist of substrings (`cost`, `hpp`, `margin`, `supplier`, `priceAmount`,
  `valueAmount`, `unitCost`, `minStock`) — a structural, not just behavioral, guard: if someone
  widens a `.select()` in this module later, the test fails even if they never think to ask "did
  I just leak cost data";
- does **not** contain the seeded internal `description` value anywhere, while it **does**
  contain the seeded `storefrontDescription` value — an exact-value check, not just a field-name
  check, so the two fields can never be silently swapped or both exposed by accident;
- never includes `priceOverrideAmount` and always reports price as the product's own `basePrice`.

Also asserts: an inactive product, an active-but-unpublished product, and a nonexistent slug all
resolve to `null`/empty, never throw.

## Image uploads

Content images (hero, feature block) reuse the exact pipeline in "Grounding" above —
`processUploadedImage` (validate → EXIF-rotate → strip metadata → 3 WebP sizes) and
`getStorageClient()` — with a new key-building function (`buildContentImageStorageKey`,
mirroring `buildImageStorageKey`'s shape: `{prefix}content/{sectionKey}/{imageId}/{size}.webp`).
No new DB table for the image itself (see "no independent identity" reasoning above) — the
`ContentImage` JSON object **is** the record; replacing an image means uploading a new one (new
`imageId`, new objects in the bucket) and only then overwriting the old `storageKey` in the
draft JSON, deleting the old objects from the bucket **after** the draft save succeeds (same
order `apps/admin/src/lib/products/image-queries.ts`'s product-photo delete already uses:
database state changes first, storage cleanup second, never the reverse — an orphaned object in
the bucket is a harmless no-op; a dangling DB reference to a deleted object is a broken image on
the live site).

Product color images are **unchanged** — they already go through the existing Photos section
(`product-photos-section.tsx`, `use-photo-staging.ts`) and `product_images` table; this plan
only adds the "alt text required before publish" app-level check (see "Products" above), no new
upload path for them. The storefront-description rich-text editor never embeds images — not in
the allowed mark set (see above); any imagery for a product comes only through the existing
Photos section.

`apps/web` needs only `STORAGE_PUBLIC_BASE_URL` added to its own env (it renders `<img>` tags
from public URLs, same `publicUrl()` shape `S3StorageClient` already returns) — it never uploads,
deletes, or holds S3 credentials.

## Caching and revalidation (`apps/web` ↔ `apps/admin`, separate containers)

- Every storefront page (`/`, `/products/[slug]`) sets a generous time-based fallback,
  `export const revalidate = 3600`, as defense-in-depth — a correctness floor if the on-demand
  path below ever fails silently (network blip between containers), never the primary mechanism.
- **On-demand**: `apps/web` adds `app/api/revalidate/route.ts` (POST), checking an
  `x-revalidate-secret` header against a new `REVALIDATE_SECRET` env var (generated the same way
  as `*_BETTER_AUTH_SECRET`, `openssl rand -base64 32`, **shared** between `admin.env` and
  `web.env` — same secret, two files, never committed, same posture as every other cross-app
  secret here) before calling `revalidatePath("/")` and/or `revalidatePath("/products/[slug]",
  "page")` for a specific slug. Reject with 401 on a missing/wrong secret, 400 on a malformed
  body — never silently no-op.
- `apps/admin` calls it via a new `WEB_INTERNAL_URL` env var — **not** the existing
  `MAIN_SITE_URL`, which is the public hostname behind Cloudflare/Caddy's Authenticated Origin
  Pulls gate and would fail a plain server-to-server `fetch` with no client cert (see
  "Grounding"). `WEB_INTERNAL_URL=http://web:3000` in the deployed `admin.env` (the Docker
  Compose service name, reachable only on the `internal` network), `http://localhost:3000`
  locally. Called from: the homepage "Terbitkan" action (revalidates `/`), every `info_pages`
  publish (Phase 2, revalidates that page's path), and the product form's save/publish action
  whenever `is_published_on_storefront` or any storefront-facing product field changes
  (revalidates that product's slug **and** `/` — a product could be referenced by a homepage
  tile). A failed revalidation call logs loudly (same posture as every other "never silently
  drop" rule in this codebase — payments, OTP email) but does **not** fail the admin's save: the
  1-hour fallback still catches it.

## Preview (draft, before publishing)

`apps/web` adds `app/preview/home/page.tsx`, reading `getDraftHomepageContent()` instead of the
published one, gated by a short-lived signed token (`?token=...`, HMAC-SHA256 over
`"homepage-draft"` + an expiry timestamp, keyed by a new shared `PREVIEW_SECRET` env — same
"shared secret, two env files" shape as `REVALIDATE_SECRET`) rather than a real login: there's no
customer-facing login this needs to integrate with, and a signed, expiring link is exactly enough
security for "only someone the owner handed this link to, for a few minutes, can see the draft."
The admin "Pratinjau" button mints the token server-side and opens the link in a new tab — no
token generation client-side, no token ever stored in the database.

## Admin UX (`content.manage`, 390px + 1280px)

New nav entry, group **"Konten"**, `href: "/content"`, gated by `content.manage` — added to
`NAV_ITEMS` in `apps/admin/src/lib/nav/config.ts` alongside the existing items, same shape (icon
from `lucide-react`, e.g. `LayoutTemplate`).

- `/content` — section list (Hero / Grid Produk / Feature Block / Kenapa Ammari), each showing
  its own visibility toggle and a top-level "Ada perubahan belum diterbitkan" banner plus a single
  "Terbitkan" button when **any** section's draft differs from its published state (computed by
  comparing `draft_content`/`draft_is_visible` against `published_content`/`published_is_visible`
  per row — not a separate dirty flag to keep in sync).
- `/content/hero`, `/content/product-grid`, `/content/feature-block`, `/content/why-ammari` —
  one editor page per section, each a plain form (text fields, image upload with preview reusing
  the same staged-upload pattern `use-photo-staging.ts` already established) that saves straight
  to that row's `draft_content` via a server action — no "save" vs. "submit" distinction beyond
  that; the only separate action in the whole feature is the top-level "Terbitkan."
  - **Product grid tiles**: a list with up/down reorder buttons (≥44px tap targets, same
    `min-h-11` convention `Checkbox`/other admin controls already use) and an "add tile" flow
    that opens a product picker (search by name → pick one of its **active** `fabric_colors`, or
    "semua warna" if the tile shouldn't pin a specific color) — check whether an existing
    searchable product-select component already exists elsewhere in admin (e.g. the orders/
    production "new" flows) before building a new one.
  - **Hero / feature block "linked product"**: same picker, singular.
  - **"Kenapa Ammari" points**: title + text fields plus an icon picker — a small grid of the
    fixed `WHY_AMMARI_ICON_KEYS` set, each shown with its label and icon, single-select per
    point (same closed-set idea as the product highlight checkboxes, just single-select per row
    instead of multi-select for the whole product).
- Product form (`apps/admin/.../products/_components/product-form.tsx`) grows a new
  "Storefront" section (own card, below Photos/Variants, same visual pattern as
  `accessory-recipe-section.tsx`): the publish toggle, the TipTap rich-text
  `storefront_description` editor, `allsize_fit_note` (only shown/relevant for
  `size_mode = 'all_size'`), and a size-chart picker (select an existing `size_charts` row, or
  "kelola ukuran" linking to a small `/content/size-charts` CRUD screen for the fixed
  bust/length/sleeve/height-range rows). **This whole section is visible and editable only to a
  session holding `content.manage`** — a staff user with `products.manage` but not
  `content.manage` can still edit name/price/SKU/variants/photos (unaffected), but won't see or
  control publish status, the storefront description, or size chart assignment. This split
  follows directly from `content.manage` being the permission for "anything customer-facing,"
  even when it's physically a section of the product form — someone managing catalog/inventory
  doesn't automatically need control over public storefront content, and vice versa, which is
  exactly what granular, dynamic RBAC is for.
- Every editor page is single-column, mobile-first at 390px (CLAUDE.md's rule applies even
  though Konten isn't in the "wife's daily pages" list — it's still used from a phone) and lays
  out identically, just with more horizontal room, at 1280px — no separate desktop-only table
  view is needed here (unlike Orders/Packing/Stock/Production) since there's no tabular list
  with two independent layouts to keep in sync; it's a handful of form pages.

## Security

- Every `/content` page (including the product form's Storefront section), every server action
  under it, and the new `/api/revalidate` route are checked server-side —
  `requirePermission("content.manage")` for the former (exact pattern
  `apps/admin/src/lib/auth/require-permission.ts` already gives every other admin page), the
  shared-secret header check for the latter (it has no staff session at all — it's called
  machine-to-machine). No part of this feature checks a role name directly; every check is a
  permission key, consistent with the rest of this codebase's dynamic RBAC.
- Every homepage/product-storefront write validates server-side with Zod — never trusts a client
  payload's shape, same posture `products/actions.ts` already has for `highlights`.
- The rich-text `storefront_description` is sanitized server-side against a strict allowlist on
  **every** save, and sanitized again, independently, at render time in `apps/web` — see
  "Storefront description" above.
- The preview route's token is verified server-side (HMAC + expiry), never just "does a token
  exist in the URL."
- `REVALIDATE_SECRET`/`PREVIEW_SECRET` live only in `admin.env`/`web.env` on the VPS, generated
  with `openssl rand -base64 32`, never committed — same rule as every other secret here.

## Testing plan

- **Unit** (`packages/db` + `apps/admin` + the new `@ammari/content-sanitize`, Vitest): Zod
  schemas for each homepage section (valid shape accepted, invalid rejected, duplicate tile
  `(productId, fabricColorId)` rejected, >4 "Kenapa" points rejected, an unknown `icon` key
  rejected the same way an unknown highlight key already is); the publish action (atomically
  promotes all 4 sections' draft → published in one transaction, confirmed via a forced-failure
  test that no row partially commits); `storefront-queries.test.ts`'s cost-leak denylist test and
  internal-vs-storefront-description distinctness test (above); size-chart row CHECKs (each
  measurement `> 0`, `height_recommendation_max_cm >= min`); availability resolution (zero stock
  vs. inactive variant vs. in-stock, all correctly `available`/not); `sanitizeStorefrontDescriptionHtml`
  — allowed tags/nested lists pass through unchanged, `<script>`, `on*` attributes, `<img>`,
  `<a href>`, inline `style`/`class` are all stripped, confirmed against a handful of real XSS
  payload shapes (not just "one script tag").
- **Dynamic-RBAC test**: a staff user on a **non-system** role granted only `content.manage` (no
  `products.manage`, not `super_admin`/`owner`) can reach `/content` and its actions but not the
  product form's other sections' write paths; a staff user with every permission **except**
  `content.manage` is forbidden from `/content` and from the product form's Storefront section —
  confirms the permission-key check, not a hardcoded role name, is what's gating access.
- **Admin e2e** (Playwright, both 390px and 1280px per CLAUDE.md's list-page rule — these aren't
  list pages in the `CardList`/`TableContainer` sense, but the rule's spirit, "assert both
  viewports render and work," still applies to every new admin page): edit each homepage
  section's draft, confirm the live site is unaffected until "Terbitkan," confirm "Terbitkan"
  updates the live page; reorder grid tiles via up/down buttons; publish a product to the
  storefront from the product form and confirm it appears/disappears from the homepage tile
  picker accordingly; write a rich-text description with every allowed formatting option and
  confirm it round-trips; permission check (a staff user without `content.manage` gets a 403,
  never just a hidden nav item). The rich-text editor's actual touch/keyboard behavior on iOS
  Safari is **not** something Playwright's Chromium/WebKit emulation fully stands in for — do a
  manual pass on a real device or an accurate simulator before calling that part done.
- **Web e2e** (Playwright, Chromium + WebKit per `apps/web`'s existing convention): homepage
  renders the published sections in order (including each "Kenapa Ammari" point's icon), hidden
  sections don't render; a PDP at `/products/[slug]` for a published product shows gallery/price
  (same price regardless of selected color/size)/color swatches/sizes (crossed-out when
  unavailable)/highlights/accordions, including the rich-text "Deskripsi" rendering exactly the
  allowed formatting and nothing else; an unpublished or deactivated product's slug 404s;
  `/api/revalidate` rejects a missing/wrong secret.

## Suggested implementation order (sessions, each independently deployable)

1. **Schema + permission** — ships: `content.manage` permission + grants (migration-based,
   default `super_admin`/`owner`); `storefront_homepage_sections` table + 4 seeded rows;
   `size_charts`/`size_chart_rows` (fixed bust/length/sleeve/height-range columns); products'
   storefront columns (`is_published_on_storefront`, `storefront_description`,
   `allsize_fit_note`, `size_chart_id`). No UI yet. **Owner can test:** nothing visible — verify
   via `db:studio` that the migration applied cleanly and a staff user's permission set includes
   `content.manage`.
2. **`packages/db` storefront read layer** — ships: the new query module + its cost-leak/
   description-distinctness test; `getActiveProductBySlug` deleted. **Owner can test:** nothing
   UI-visible; verify the new test suite passes (`pnpm --filter @ammari/db test`).
3. **`@ammari/content-sanitize` + admin: product form "Storefront" section** — ships: the shared
   sanitizer package; the TipTap editor (smoke-tested on real iPhone/iPad Safari before the rest
   of the session proceeds); the publish toggle, description editor, `allsize_fit_note`, and
   size-chart picker on the product form, all gated by `content.manage`; a `/content/size-charts`
   CRUD screen for the fixed-column charts. **Owner can test:** open any product in admin, write
   a formatted description (bold/italic/lists), assign a size chart, flip the publish toggle —
   all save and reload correctly; a staff account without `content.manage` doesn't see this
   section at all.
4. **Admin: Konten nav + homepage section editors + draft/publish mechanics** — ships: the
   "Konten" nav item; `/content` overview with the unpublished-changes banner; the four section
   editors (text fields + product/color picker, no images yet); the atomic "Terbitkan" action.
   **Owner can test:** edit any section's draft text/tiles, confirm nothing changes on the live
   site, click Terbitkan, confirm the draft is now what a fresh `getPublishedHomepageContent()`
   read returns (still no visible homepage yet — that's session 7).
5. **Admin: content image upload** — ships: hero/feature-block image upload+preview, reusing the
   existing processing pipeline. **Owner can test:** upload a hero image in the draft editor, see
   it staged with a preview, confirm it's part of what gets published.
6. **`apps/web`: revalidation endpoint + preview route** — ships: `/api/revalidate` (secret-
   gated); `WEB_INTERNAL_URL`/`REVALIDATE_SECRET`/`PREVIEW_SECRET` wired into both env files;
   admin's Terbitkan/product-save actions call it; `/preview/home` with signed-token preview.
   **Owner can test:** click "Pratinjau" after editing a draft and see the (still unstyled/
   structural) draft content at a private link; confirm a wrong/missing token is rejected.
7. **`apps/web`: homepage + PDP rendering** from published content, at `/` and
   `/products/[slug]` — ships: the actual customer-visible pages (still structural markup — this
   is the session that needs `docs/design/storefront.md` + mockups in hand for the real visual
   pass). **Owner can test:** the full loop end-to-end — publish a homepage change or a product,
   see it live on `ammari.my.id` within the revalidation window (near-instant via the webhook,
   worst case within the hour via the fallback).
8. **Phase 2** — ships: `info_pages` (Markdown, own draft/publish per page) + `store_settings`
   (save = live), their admin editors, and the existing `/privacy-policy`/`/terms-of-service`
   placeholder routes (plus the three new pages) wired to read from them. **Owner can test:** edit
   and publish each info page's text, confirm the footer's WhatsApp/email/address reflect a
   store-settings save immediately.

(Phase 3 — the `/products` catalog index — is intentionally not in this list; it's later,
separate work, per the resolved scope below.)

## Explicitly NOT building in this plan

The actual visual design/layout of the homepage or PDP (deferred to the design doc), a generic
page builder (sections are a fixed set of 4, not arbitrary), drag-and-drop reordering (up/down
buttons only, same reasoning the highlights feature gave for skipping it), cart/checkout/payment
(Dec 2026, unrelated), **any scarcity/low-stock messaging** (firmly decided against — availability
is boolean only, full stop), **per-color or per-size price overrides on the storefront** (one
price per product, always `base_price` — `price_override_amount` is simply not read by any
storefront code), the `/products` catalog index page (Phase 3, separate work), rich-text beyond
the 4 allowed marks (headings/images/embeds/colors/links — links explicitly considered and
declined for now), admin-uploaded custom icons for "Kenapa Ammari" (fixed code-defined set only),
multi-revision history or rollback of published content (publishing again is the only "undo" —
no version log), localization/multi-language (Indonesian-only, per CLAUDE.md).

## Resolved decisions (this round)

1. **Storefront description** is a new field (`products.storefront_description`), separate from
   the existing internal `products.description`. Rich text via TipTap, limited to paragraphs/
   bold/italic/bulleted+numbered lists, no links (judgment call, justified above), stored as
   sanitized HTML, sanitized again at render. See "Storefront description" section above for the
   full design and justification.
2. **Price is uniform** across all colors and sizes of a product — always `products.base_price`.
   `product_variants.price_override_amount` is not part of the storefront story.
3. **Size chart** has fixed columns (Lingkar dada, Panjang gamis, Panjang lengan, Rekomendasi
   tinggi badan — the last as a min/max cm range), one row per size. Admin-defined columns
   dropped from the design.
4. **No scarcity messaging** — availability is boolean only, permanently (not just "for now").
5. **PDP route is `/products/[slug]` from the start**; the `/products` catalog index comes later
   as separate (Phase 3) work. The homepage grid stays hand-curated, not catalog-driven.
6. **"Kenapa Ammari" icons** come from a fixed, code-defined key set (same pattern as
   `PRODUCT_HIGHLIGHT_KEYS`) — see the proposed 8-key table above; confirm or edit that specific
   list before implementation (the *pattern* is decided, the *exact keys* are a first draft).
7. **Access is permission-based**: `content.manage` (the only new permission this plan needs) is
   created via migration, granted by default to `super_admin`/`owner`, and assignable to any
   other role later purely through the roles/staff admin screen — no hardcoded role-name checks
   anywhere in this feature.

## Remaining nuances (not blocking, worth a quick look before/while implementing)

- **The proposed "Kenapa Ammari" icon key list** (8 keys, above) is a first draft for you to
  confirm or edit — the mechanism (fixed set, same as highlights) is decided either way.
- **TipTap's real-world behavior on iPhone/iPad Safari** hasn't been verified yet (it's the
  standard choice for this exact job, but "standard choice" isn't the same as "confirmed working
  here") — session 3 above calls out doing that check early, before building the rest of the
  editor integration around it.
