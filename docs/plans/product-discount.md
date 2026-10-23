# Per-product discount ("launching price")

Status: **owner answers in (2026-10-23, §12). Sessions 1 (database + price function) and 2 (admin)
done; sessions 3 and 4 not started.**

Scope: `packages/db`, `packages/commerce`, `apps/admin`, `apps/web`.

## 0. Owner decisions (final, from the request)

1. A discount is set per **product** and applies to all of its variants.
2. The admin form has two linked inputs, "Harga setelah diskon" (Rp) and "Diskon (%)"; typing
   either fills the other. One value is stored, the other derived.
3. Optional start and end datetime (Asia/Jakarta) plus a manual on/off toggle. Active only when
   the toggle is on AND now is inside the window (empty start = from now, empty end = no end).
4. The Rp20.000 voucher stacks with discounted products: it applies to the discounted subtotal.
5. Storefront: original price struck through (muted) + discounted price in red wherever a price
   is shown; catalog card gets a red badge, white text `N% OFF` (approved English exception, like
   `SOLD OUT`), N = floor of the real percentage (350.000 -> 279.000 shows `20% OFF`).

## 1. What the codebase does today (investigation)

### 1.1 Can variants of one product have different base prices?

**In the schema, yes. On the storefront, no.**

- `products.base_price` (bigint, `>= 0`) and `product_variants.price_override_amount` (nullable
  bigint) both exist (`packages/db/src/schema/catalog.ts`). The admin variant builder lets staff
  set an override per SKU (`apps/admin/src/app/(shell)/products/_components/variant-builder.tsx`).
- But the storefront deliberately never reads the override. `docs/plans/storefront-cms.md`,
  "Resolved decisions" #2: *"Price is uniform across all colors and sizes of a product, always
  `products.base_price`."* Every storefront and checkout read path follows that:
  - `packages/db/src/storefront/queries.ts` (header comment: "Price is always
    `products.base_price`"), PDP, related products, homepage tiles.
  - `packages/commerce/src/cart/cart.ts` `getCart` (`unitPrice: row.basePrice`).
  - `packages/commerce/src/checkout/place-order.ts` `lockedCartLines`
    (`unitPrice: products.basePrice`).
- The only place the override matters is the **admin manual-order SKU picker**
  (`apps/admin/src/lib/orders/queries.ts` `listOrderableVariants`, `effectivePrice =
  priceOverrideAmount ?? basePrice`, prefilled and editable per line). Marketplace imports carry
  their own prices.

So for every buyer-facing price, one product has exactly one base price, and a sale price in Rp
is unambiguous. The owner confirmed this stays so (§12, answer 1). The one place overrides still
matter is the admin manual-order picker, which will prefill the discounted price (answer 2, see
§5.2 for how an override combines with a discount).

### 1.2 Where prices flow today

| Surface | Source | File |
|---|---|---|
| PDP price, JSON-LD `offers.price` | `products.base_price` | `apps/web/src/app/products/[slug]/page.tsx`, `lib/content/product-view.ts`, `components/pdp/product-purchase-panel.tsx` |
| Related products on PDP | `base_price` | `getRelatedStorefrontProducts` |
| Homepage tiles (`/#koleksi`, hero CTA, feature block) | `base_price` | `getStorefrontProductTiles`, `components/product-tile.tsx` |
| Cart page, optimistic cart | `base_price`, re-read every render (cart rows have no price column) | `commerce/cart/cart.ts`, `components/cart/*` |
| Checkout summary + `expectedTotal` | cart subtotal from server; browser only adds up for display | `components/checkout/checkout-form.tsx` |
| Order line snapshot | `order_items.unit_price` written by `placeOrder` | `commerce/checkout/place-order.ts` |
| Midtrans `item_details` | `buildPaymentLines` from locked lines; retries re-read `order_items` | `commerce/payments/lines.ts`, `payments/attempts.ts` |
| Order emails | `order_items.unit_price` | `commerce/emails/dispatch.ts` |
| Buyer order pages, pending order banner | `order_items.unit_price` | `apps/web/src/lib/orders/queries.ts`, `lib/checkout/queries.ts` |
| Admin order detail | `order_items.unit_price` | `apps/admin/src/app/(shell)/orders/[id]/page.tsx` |

There is no catalog index page (`/products`) yet; the "catalog" today is the homepage product grid
(`/#koleksi`) plus related products on the PDP. Both render `ProductTile`.

### 1.3 Caching today

- `/products/[slug]`: **ISR, `revalidate = 3600`**, no `generateStaticParams`. Invalidated by
  `revalidatePath` from admin saves (`apps/admin/src/lib/revalidate.ts` `revalidateProductSlug`)
  and from payment events (`apps/web/src/lib/payments/revalidate.ts`).
- `/` (homepage): `dynamic = "force-dynamic"`, but its data is `unstable_cache`d for 3600 s under
  tag `storefront:homepage` (`lib/content/homepage-data.ts`), product tiles included.
- `/cart`, `/checkout`, `/orders/*`: `force-dynamic`, uncached. Always correct.
- Cron (`deploy/cron/cron.sh`) calls `/api/internal/*` every 5 minutes (payment sweep, emails).

Consequence: if the PDP rendered a resolved price, a discount that starts at 10:00 could keep
showing the old price until the next revalidation (up to 1 hour later), and the homepage tile
likewise. Section 7 fixes this.

### 1.4 Conflict with SPEC

`docs/SPEC.md` §8 said *"Vouchers cannot be combined with other promos."* Owner decision 4
overrides this for product discounts; SPEC §8 was updated on 2026-10-23 (vouchers stack with
product discounts and apply to the discounted subtotal).

## 2. Source of truth: store the sale price in Rp (decided)

**`products.discount_price_amount` (whole rupiah) is the source of truth. The percentage is always
derived.** Owner answer 1: the storefront stays one price per product.

Why:

1. Every buyer-facing price of a product is the single `base_price` (§1.1), so a fixed Rp sale
   price applies identically to all variants.
2. A launching price is a marketing number ("279.000"). Storing a percentage would make the
   stored price a by-product of rounding.
3. What the buyer pays, what Midtrans charges and what the order snapshot keeps are all Rp. The
   money the owner typed is exactly the money charged.
4. The badge percent is display only, computed with integer math from two stored integers.

Trade-off: if `base_price` is edited while a discount is configured, the sale price stays and the
percent changes. A base price edit that would make the discount invalid (sale price not below the
new base, or under 1%) is refused (§3.2, DB CHECK plus a friendly message in session 2).

## 3. Rounding and validation

All math is integer (`number` holding whole rupiah, far below 2^53). No floats are stored or
compared. Implemented in `packages/db/src/pricing.ts` (`@ammari/db/pricing`).

### 3.1 Formulas

Notation: `B` = base (list) price, `S` = sale price, `p` = percent the owner typed (whole number,
1..99). `floor` is integer division.

**Badge / percent off** (`discountPercentOff`):

```
N = floor((B - S) * 100 / B)
```

**Admin helper display, price -> percent** (`discountPercentTenths`): the "Diskon (%)" field
shows the real percent rounded down to one decimal, `floor((B - S) * 1000 / B)` tenths, formatted
with a comma (`20,2`). Display only, never submitted.

**Percent -> price** (`salePriceFromPercent`, owner answer 3: round DOWN to the nearest Rp1.000):

```
exact = floor(B * (100 - p) / 100)
S     = floor(exact / 1000) * 1000
```

Rounding the price down raises the real percentage, so the result is accepted only when the badge
still shows exactly `p`: `discountPercentOff(B, S) == p`. Since `S <= exact`, the badge can never
be below `p`; the check catches it being above `p`. If the check fails, the helper returns `null`
and the admin form says the percent cannot be rounded to Rp1.000 and asks for the Rp price
directly. The badge therefore **never shows more than the typed percent**.

Guarantee: for any `B >= Rp100.000` the check always passes, for every `p` from 1 to 99. Proof:
`B - S < (B * p / 100 + 1) + 999 = B * p / 100 + 1000 <= B * (p + 1) / 100` when `B >= 100.000`,
so `N < p + 1`. Every current gamis price is above that, so the `null` case is only reachable for
cheap items.

| Base | Typed % | exact | Rounded down `S` | Real % | Badge |
|---|---|---|---|---|---|
| 350.000 | 20 | 280.000 | 280.000 | 20,00 | `20% OFF` |
| 349.000 | 20 | 279.200 | 279.000 | 20,05 | `20% OFF` |
| 399.000 | 15 | 339.150 | 339.000 | 15,03 | `15% OFF` |
| 189.000 | 35 | 122.850 | 122.000 | 35,44 | `35% OFF` |
| 299.900 | 1 | 296.901 | 296.000 | 1,30 | `1% OFF` |
| 99.000 | 20 | 79.200 | 79.000 | 20,20 | `20% OFF` (passes, below the guarantee) |
| 50.500 | 1 | 49.995 | 49.000 | 2,97 | would be `2% OFF`: **refused** (`null`) |

Owner typing the Rp price directly (350.000 -> 279.000) is not rounded at all: the badge is
`floor(71.000 * 100 / 350.000) = 20` -> `20% OFF`; the field shows `20,2`.

The linked inputs never ping-pong: whichever field the owner typed in last drives the other, and
only the Rp value is submitted. The server re-validates the Rp value; a percent in the request is
ignored.

### 3.2 Validation (server-side; DB CHECKs as the backstop; client mirrors for UX only)

`validateDiscountPrice(B, S)` returns the first failing rule code (or `null`); session 2 maps the
codes to messages.

| Rule | Code | Message (UI, Indonesian) | DB enforced |
|---|---|---|---|
| `S` is a whole number `>= 1` | `not_positive` | "Harga setelah diskon harus lebih dari Rp0." | yes |
| `S < B` | `not_below_base` | "Harga setelah diskon harus lebih kecil dari harga normal." | yes |
| At least 1% off: `(B - S) * 100 >= B` (owner answer 5) | `under_min_percent` | "Diskon minimal 1%." | yes |
| Percent input whole number 1..99 | n/a | "Diskon harus 1 sampai 99 persen." | n/a (not stored) |
| Percent cannot round to Rp1.000 (§3.1 `null`) | n/a | "Persentase ini tidak bisa dibulatkan ke Rp1.000. Isi harga setelah diskon langsung." | n/a |
| Toggle on requires a price | n/a | "Isi harga setelah diskon dulu." | yes |
| `ends_at > starts_at` when both set | n/a | "Waktu selesai harus setelah waktu mulai." | yes |
| `ends_at` in the future at save time when toggle is on | n/a | "Waktu selesai sudah lewat." | app only (time-relative) |
| Editing `base_price` so the discount breaks one of the first three rules | n/a | "Harga normal harus lebih besar dari harga diskon (Rp279.000) dan diskon minimal 1%. Ubah atau hapus diskon dulu." | yes (same CHECK) |

The admin renders every rupiah amount in these messages with its own `formatRupiah` ("Rp 0",
"Rp 1.000", "Rp 279.000"), like the rest of the admin (owner, 2026-10-23).

Datetimes come from `<input type="datetime-local">`, interpreted as Asia/Jakarta (UTC+7, no DST),
converted to UTC `timestamptz` on the server, and shown back in Jakarta time. Precision is minutes
(seconds zeroed). A start in the past is allowed (it simply means "already started").

### 3.3 Active rule (one definition, used everywhere)

```
active = discount_enabled
     AND discount_price_amount IS NOT NULL
     AND discount_price_amount < base_price
     AND (discount_starts_at IS NULL OR discount_starts_at <= now)
     AND (discount_ends_at   IS NULL OR now < discount_ends_at)
```

Half-open window `[start, end)`: at exactly `ends_at` the discount is over. Empty start is stored
as NULL ("from now" and "no lower bound" behave the same).

Admin status label derived from the same rule: **Aktif**, **Terjadwal** (enabled, start in the
future), **Berakhir** (enabled, end passed), **Nonaktif** (toggle off).

## 4. Schema change and migration

Migration **`0036_product_discount.sql`** (session 1, done). Purely additive, so the currently
deployed release keeps working (expand/contract rule):

```ts
// products
discountPriceAmount: bigint("discount_price_amount", { mode: "number" }),        // nullable
discountEnabled:     boolean("discount_enabled").notNull().default(false),
discountStartsAt:    timestamp("discount_starts_at", { withTimezone: true, mode: "date" }),
discountEndsAt:      timestamp("discount_ends_at",   { withTimezone: true, mode: "date" }),

check("products_discount_price_amount_check",
  sql`discount_price_amount is null or (discount_price_amount > 0 and discount_price_amount < base_price
       and (base_price - discount_price_amount) * 100 >= base_price)`),   // >= 1% off
check("products_discount_enabled_price_check",
  sql`not discount_enabled or discount_price_amount is not null`),
check("products_discount_window_check",
  sql`discount_starts_at is null or discount_ends_at is null or discount_ends_at > discount_starts_at`),

// order_items
listUnitPrice: bigint("list_unit_price", { mode: "number" }),                     // nullable
check("order_items_list_unit_price_check",
  sql`list_unit_price is null or list_unit_price >= unit_price`),
```

- `order_items.unit_price` keeps its meaning: **the unit price actually charged** (revenue,
  Overview metrics, `linesAddUp`, Midtrans all keep working unchanged). `list_unit_price` is the
  pre-discount price, written by `placeOrder` for every checkout line (equal to `unit_price` when
  no discount was active). Manual orders (non-marketplace channels) write it only for a line
  charged below the SKU's normal price (override, else base), else NULL. NULL for pre-migration
  rows and marketplace orders.
- No new `orders` column: `orders.discount_amount` stays **voucher only**. The product discount is
  already inside `subtotal_amount` (sum of `qty * unit_price`); "Hemat" is derived from the line
  snapshots. `orders_total_amount_balance_check` is untouched.
- Existing rows: all products get `discount_enabled = false`, NULL elsewhere. Existing CHECKs on
  `base_price >= 0` stay; a base price of 0 simply cannot have a discount.
- No index needed: the discount is read with the product row it belongs to.
- No reference data, so nothing for the "ship it in a migration" rule.
- Rollback safety: the previous release ignores the new columns, so redeploying it is safe; while
  rolled back, the storefront shows and charges base prices (a discount silently pauses). Note
  this in the release notes. Also: the rolled-back release's product edit does not know the
  discount, so lowering `base_price` on a discounted product there hits
  `products_discount_price_amount_check` and shows a 500. Runbook line: clear active discounts
  before rolling back past the release that ships session 2 (code review 2026-10-23).
- A sale price may stay stored while the toggle is off (so the owner can switch a launch price
  off and on again without retyping it).
- Generated SQL read and checked: 5 `ADD COLUMN` (the one default is a constant, so no table
  rewrite on Postgres 16) and 4 `ADD CONSTRAINT ... CHECK`; no drop, rename or data change.
  Covered by `packages/db/test/migration-0036.test.ts` (upgrade from 0035 with existing rows, the
  previous release's writes, idempotent re-run) and `test/product-discount.test.ts` (each CHECK).

### 4.1 Audit log

No database plumbing is needed: `audit_log.action` / `entity_type` are free text by design
(`schema/rbac.ts`), and `writeAuditLog` already exists in the admin. The write therefore lands with
the admin action in session 2: a dedicated admin action `updateProductDiscount` (permission `products.manage`, checked on the
server), one transaction: `lockProductForUpdate`, read `before`, update, `writeAuditLog` with
`action: "discount_update"`, `entityType: "product"`, `before`/`after` =
`{ basePrice, discountPriceAmount, discountEnabled, discountStartsAt, discountEndsAt }` (base
price included so the percent at that moment can be reconstructed). The existing product `update`
audit already records `base_price` changes. Then `revalidateProductSlug` (see §7). Admin-visible
history is not in scope (audit table only).

## 5. One price resolver

### 5.1 Location (session 1, done)

- **`packages/db/src/pricing.ts`, exported as `@ammari/db/pricing`.** It lives in `@ammari/db`,
  not `@ammari/commerce`, because the storefront queries in `@ammari/db/storefront` need it and
  `@ammari/db` must not import `@ammari/commerce` (commerce depends on db). Precedent:
  `@ammari/db/stock-availability`. Pure: no schema import, no `server-only`, no clock, so the
  admin's client-side linked inputs (session 2) can import the percent helpers too.
- **`packages/db/src/pricing-columns.ts`, exported as `@ammari/db/pricing-columns`:**
  `productPricingColumns`, the select fragment every price-reading query spreads, so no call site
  forgets a column. Separate file so `pricing.ts` stays schema-free.

```ts
export interface ProductPricingInput {
  basePrice: number;
  discountPriceAmount: number | null;
  discountEnabled: boolean;
  discountStartsAt: Date | null;
  discountEndsAt: Date | null;
}

export interface ResolvedUnitPrice {
  listPrice: number;         // shown struck through when discounted; order_items.list_unit_price
  unitPrice: number;         // what is charged; order_items.unit_price
  discounted: boolean;
  percentOff: number | null; // badge, floored; null when not discounted
  endsAt: Date | null;       // JSON-LD priceValidUntil; null when not discounted or open-ended
}

resolveUnitPrice(input, now, { variantPriceOverride? }): ResolvedUnitPrice
isDiscountActive(input, now): boolean
discountStatus(input, now): "active" | "scheduled" | "ended" | "off"     // admin chip
validateDiscountPrice(base, sale): "not_positive" | "not_below_base" | "under_min_percent" | null
salePriceFromPercent(base, percent): number | null                       // §3.1
discountPercentOff(list, sale): number                                    // badge
discountPercentTenths(list, sale): number                                 // admin display, 202 = "20,2"
DISCOUNT_PRICE_ROUNDING = 1_000, DISCOUNT_PERCENT_MIN = 1, DISCOUNT_PERCENT_MAX = 99
```

`now` is always a parameter (never `Date.now()` inside): deterministic tests, and one consistent
instant per request / per order. A stored sale price that would fail `validateDiscountPrice` (the
DB forbids it, so this is defensive only) is treated as no discount.

`variantPriceOverride` exists for the admin manual-order picker only (owner answer 2). With an
override the list price is the override, and an active discount charges the product's sale price
only when it is lower than the override: a discount never raises a price. Storefront, cart and
checkout never pass it.

### 5.2 Call sites

| Consumer | Change |
|---|---|
| `getStorefrontProductBySlug`, `getRelatedStorefrontProducts`, `getStorefrontProductTiles` | Select `productPricingColumns`; return the **raw** `pricing: ProductPricingInput` (cacheable) instead of `basePrice`. |
| PDP page + `buildProductView` | Resolve once per request with `new Date()`; pass `listPrice`, `unitPrice`, `discounted` to the panel. |
| PDP JSON-LD | `offers.price = unitPrice`; add `priceValidUntil` (date part of `endsAt`) when discounted and an end exists. OG/meta have no price today; nothing else to change. |
| `ProductTile` (homepage grid, related, hero/feature links) | Resolve at render; badge + struck price. |
| `getCart` (`commerce/cart`) | Select pricing columns, `unitPrice` + `listUnitPrice` per line; `subtotal` from `unitPrice`. |
| Cart UI (`cart-line-item`, `optimistic-cart`) | Struck list price when `listUnitPrice > unitPrice`; "Hemat RpX" line under the subtotal (owner answer 8). |
| Checkout summary | Uses the cart's server-resolved lines and subtotal (already the pattern); add a "Hemat RpX" line (owner answer 8). |
| `placeOrder` `lockedCartLines` | Resolve every line with **one** `now` captured inside the transaction; insert `unit_price` + `list_unit_price`; audit `items` gain `listUnitPrice`. |
| `buildPaymentLines` / Midtrans `item_details` | Unchanged API: `price = unit_price` (net). No separate "Diskon produk" line; the voucher line stays. Sum still equals `gross_amount`. Retries keep reading `order_items`. |
| Emails (`commerce/emails/dispatch.ts`) | Read `list_unit_price` too; show struck list price when higher, plus a "Hemat RpX" line when the order saved anything (owner answer 8). |
| Buyer order pages, pending order banner | Same: snapshot only, struck list price when present and higher. |
| Admin order detail | Show "Harga normal" (struck) and "Harga" for lines with `list_unit_price > unit_price`. |
| Admin product list + detail | Status chip (Aktif / Terjadwal / Berakhir / Nonaktif) and the effective price. |
| Admin manual-order picker (`listOrderableVariants`) | Owner answer 2: prefill `resolveUnitPrice(product, now, { variantPriceOverride }).unitPrice` (still editable per line). `createOrder`/`updateOrderItems` snapshot `list_unit_price` when a line is charged below the normal price (session 2). Marketplace imports are never affected. |

The browser never sends a price anywhere: the cart stores only SKU and qty, and `placeOrder`
already treats `expectedTotal` as a drift detector only. That stays true.

## 6. Cart and pending orders across a start/end boundary

- **Item in a cart when a discount starts or ends:** carts store no price, so the next render of
  `/cart` or `/checkout` shows the new price automatically. No migration of cart rows.
- **Buyer on `/checkout` while the boundary passes:** `placeOrder` resolves at its own `now`; the
  total no longer matches `expectedTotal`, so it refuses with the existing `total_changed`
  ("Harga, ongkir atau voucher berubah. Cek ringkasan lagi.") and the page reloads the summary.
  The buyer is never charged a price they did not see.
- **Pending (unpaid) order when the discount ends:** the order keeps its snapshot
  (`order_items.unit_price` / `list_unit_price`, `orders.subtotal_amount`). Midtrans retries and
  "Ganti metode pembayaran" rebuild `item_details` from `order_items`, so the buyer can still pay
  the discounted price within the 60-minute window. If it expires, the reservation is released
  as today; "Pesan lagi" puts the items back in the cart at the current price.
- **Pending order when a discount starts:** no repricing; the order keeps the price it was placed
  at (owner answer 6).
- **Before the start time** the discount is invisible on the storefront: no badge, no struck
  price, no "coming soon" text (owner answer 9). `resolveUnitPrice` returns the base price until
  `starts_at`, so this needs no extra code.

## 7. Caching: correct price exactly at start/end

Principle: **cache the raw discount fields, decide the price at render time.**

1. **PDP:** switch `/products/[slug]` from ISR (`revalidate = 3600`) to `dynamic =
   "force-dynamic"`, and wrap `getStorefrontProductBySlug` / related products in `unstable_cache`
   tagged `storefront:product:<slug>` (plus a shared `storefront:products` tag), the same pattern
   the homepage already uses (`homepage-data.ts`). The render resolves the price with the request's
   `new Date()`, so a discount flips on the first request after `starts_at` / `ends_at`, to the
   second, with no cron and no timer. JSON-LD is correct for crawlers too.
2. **Homepage tiles:** already rendered per request; only the cached tile data changes shape (raw
   pricing fields instead of `basePrice`). Resolution happens at render, so it is also exact.
3. **Revalidation callers move from paths to tags for the PDP:** `apps/admin/src/lib/revalidate.ts`
   (`revalidateProductSlug(s)`) and `apps/web/src/lib/payments/revalidate.ts` send/apply
   `storefront:product:<slug>` alongside the homepage tag. `/api/revalidate` already accepts tags
   (max 10 per request; batching already exists). A discount save calls `revalidateProductSlug` so
   toggle/price edits show immediately.
4. **Cart / checkout / orders:** already `force-dynamic` and uncached.
5. Cost: a PDP request now does a server render (no DB hit while the cache is warm) instead of
   serving static HTML. Traffic is small; acceptable.
6. Before implementing: read the bundled Next 16.3.7 docs
   (`node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md`,
   `revalidateTag` signature with the profile argument) per `apps/web/AGENTS.md`, and keep the
   `page.tsx` comment about the build-time-DB deploy bug true.

Rejected alternative: keep ISR and add a cron step that revalidates products whose
`starts_at`/`ends_at` just passed. It is up to 5 minutes late, needs a "last revalidated" column,
and the PDP/JSON-LD would be wrong in between. A client-side clock component would fix display
but cause a flash and leave server HTML wrong.

## 8. Voucher interaction and totals

Unchanged formula, with the product discount living inside the line prices:

```
line unit_price    = resolveUnitPrice(product, now).unitPrice
subtotal_amount    = sum(qty * unit_price)                 (already discounted)
discount_amount    = min(voucher.amount, subtotal_amount)  (voucher only, goods only, never ongkir)
shipping_amount    = shipping_cost_amount - shipping_subsidy_amount
total_amount       = subtotal_amount + shipping_amount - discount_amount
```

### Worked example

Cart: 2 x Gamis A (base 350.000, launching price 279.000, active) + 1 x Gamis B (299.000, no
discount). Voucher Rp20.000. Courier quote Rp35.000, subsidy Rp20.000.

| | Amount |
|---|---|
| Gamis A: 2 x 279.000 (normal 2 x 350.000 = 700.000) | 558.000 |
| Gamis B: 1 x 299.000 | 299.000 |
| `subtotal_amount` | 857.000 |
| Hemat (display only: 999.000 - 857.000) | 142.000 |
| Ongkir: 35.000 - subsidi 20.000 = `shipping_amount` | 15.000 |
| Voucher: min(20.000, 857.000) = `discount_amount` | -20.000 |
| `total_amount` = 857.000 + 15.000 - 20.000 | **852.000** |

Midtrans `item_details`: `A-sku 279.000 x 2`, `B-sku 299.000 x 1`, `SHIPPING 15.000 x 1`,
`VOUCHER -20.000 x 1` = 852.000 = `gross_amount`.
`order_items`: A `unit_price 279.000, list_unit_price 350.000`; B `299.000, 299.000`.
Catalog badge for A: `floor(71.000 * 100 / 350.000) = 20` -> `20% OFF`.

The existing guard "total must be > 0" still applies (a voucher can never make a Rp0 charge).

## 9. UI

**Admin (product detail, new "Diskon" section under the base fields, `products.manage`):**
toggle "Aktifkan diskon"; "Harga normal" (read-only, from base price); "Harga setelah diskon"
(Rp) and "Diskon (%)" linked; "Mulai" and "Selesai" (datetime-local, optional, hint "Kosongkan
untuk mulai sekarang" / "Kosongkan jika tanpa batas waktu", "WIB" suffix); status chip; "Simpan
diskon" and "Hapus diskon" (clears price and dates, toggle off; audit logged). Product list: a
status chip next to the price. List page: mobile `CardList` and desktop `TableContainer` both.

**Storefront:** muted struck-through list price + discounted price in the discount red on PDP,
tiles, cart lines, checkout lines, order pages and emails. Tile badge `N% OFF`, discount-red
background, white text. A sold-out discounted product shows **only** `SOLD OUT`, never the
`N% OFF` badge (owner answer 7); its prices still show struck + red. Nothing shows before the start
time (answer 9). "Hemat RpX" line in cart, checkout and customer emails (answer 8). Indonesian text
otherwise, no em dash; e.g. "Hemat Rp142.000", screen-reader text "Harga normal Rp350.000, harga
diskon Rp279.000".

**Discount red `#D05D5C`** (owner answer 4), for both the sale price text and the badge
background. Added in session 3 as a named design token in the storefront theme (e.g.
`--color-discount` / Tailwind `text-discount`, `bg-discount`), never hardcoded in a component. Emails
cannot use CSS variables, so the email templates take it from one shared constant. Contrast,
reported only (the colour stays as decided): white on `#D05D5C` and `#D05D5C` on white are both
**3.89:1** (relative luminance 0.220). That passes WCAG AA for large text (at least 18.66px bold or 24px regular) and for
non-text UI, and **fails AA for normal-size text (4.5:1)**. A small badge (e.g. 11 to 13px,
semibold) and a 13 to 17px sale price are normal-size text, so both sit below AA. The struck list
price next to it stays readable, and the screen-reader text carries both prices.

## 10. Tests

### Unit / integration (TDD, required: touches payments, vouchers and stock paths)

`packages/db` (pricing + schema):
- `resolveUnitPrice`: toggle off; no price; before start; exactly at start (active); inside;
  exactly at end (inactive); after end; null start; null end; both null; sale >= base defensive
  (not discounted); percent floor (350.000/279.000 -> 20; 350.001 at 20% -> 20).
- Percent -> price helper: round down to Rp1.000, the badge equals the typed percent for every base
  from Rp100.000 and every 1..99, `null` when it cannot, the examples table in §3.1.
- Migration/CHECKs: sale `0` rejected; sale `= base` rejected; under 1% rejected; enabled without
  price rejected; `ends <= starts` rejected; `UPDATE base_price` that breaks the discount rejected
  (23514); `list_unit_price < unit_price` rejected; old-shape INSERTs (no new columns) still
  succeed.
- (Done in session 1: `packages/db/test/pricing.test.ts`, `product-discount.test.ts`,
  `migration-0036.test.ts`.)
- Storefront queries return raw pricing fields and still never select cost columns (extend the
  existing cost-leak test).

`packages/commerce`:
- `getCart`: discounted line `unitPrice`/`listUnitPrice`/subtotal; inactive window falls back.
- `placeOrder`: snapshot writes both prices; subtotal uses discounted price; voucher applies to the
  discounted subtotal (worked example as a test); `total_changed` when the discount ends between
  render and submit (inject `now`); audit row carries `listUnitPrice`.
- `buildPaymentLines`: item_details sum equals gross with discounted lines + voucher.
- Payment retry after the discount ended still charges the snapshot price.
- Emails render struck list price only when `list_unit_price > unit_price`; NULL handled.

`apps/admin`:
- `updateProductDiscount`: permission denied without `products.manage`; zod rules from §3.2;
  Jakarta datetime conversion (e.g. "2026-11-01T00:00" -> `2026-10-31T17:00:00Z`); audit row
  before/after; revalidation called.
- Base price edit refused with the friendly message when it would drop to/below the sale price.

### E2E (Playwright; list pages at 390px and 1280px)

- Admin: set a discount by typing Rp, see % fill; type %, see Rp fill; save; status chip on
  `/products` list at both viewports; validation messages.
- Storefront: PDP struck + red price and JSON-LD price; homepage tile badge `20% OFF` at both
  viewports; scheduled discount (start set via DB to the past/future) flips on reload with no
  admin action (proves §7).
- Cart -> checkout with voucher: summary numbers from the worked example; order page and admin
  order detail show both prices.
- Discount ended while on checkout -> "Harga, ongkir atau voucher berubah" -> resubmit at the new
  total.

## 11. Session split (one feature per session)

1. **Schema + resolver. Done 2026-10-23.** Migration `0036_product_discount.sql`,
   `@ammari/db/pricing`, `@ammari/db/pricing-columns`, CHECK and upgrade tests. No UI.
2. **Admin. Done 2026-10-23.** Manual orders snapshot `list_unit_price` when a line is
   charged below the normal price (NULL otherwise and for marketplace channels). "Diskon" section, linked inputs, `updateProductDiscount` + audit + revalidation,
   base-price guard, list status chip; unit + e2e. **Blocker from the session 1 code review:**
   `updateProduct` (`apps/admin/src/lib/products/queries.ts`) only maps 23503 and unique
   violations, so a base price edit that breaks a stored discount would surface as a 500. It must
   pre-check with `validateDiscountPrice(newBase, before.discountPriceAmount)` and throw a
   `FieldError("basePrice", ...)` with the §3.2 message, and also map a 23514 on
   `products_discount_price_amount_check` (race backstop). Covered by an admin integration test.
3. **Storefront display + caching.** Storefront queries return raw pricing, PDP to
   `force-dynamic` + tagged `unstable_cache`, revalidation callers to tags, PDP/tiles/related/
   JSON-LD UI, the `#D05D5C` design token; e2e.
4. **Cart, checkout, orders.** `getCart`, `placeOrder` snapshot (`list_unit_price`), payment lines,
   emails, buyer order pages, admin order detail; TDD; e2e worked example. (SPEC §8 already updated.)

Sessions 3 and 4 can ship in either order, but the discount must not be switched on in production
until **both** are deployed (otherwise the storefront could show a price checkout does not charge,
or vice versa). Until then the admin section can exist with the toggle unusable in prod, or simply
not be used.

## 12. Owner answers (2026-10-23, final)

1. Storefront stays one price per product. The sale price in Rp is the source of truth (§2).
2. The admin manual-order form prefills the discounted price while the discount is active (§5.2).
3. A price computed from a percent is rounded DOWN to the nearest Rp1.000; the badge never shows
   more than the typed percent (§3.1, formulas and examples).
4. Discount red is `#D05D5C` for the sale price text and the badge background, as a named design
   token (§9, contrast reported there).
5. Discounts under 1% are refused (§3.2, also a DB CHECK).
6. An unpaid order keeps the price it was placed at, even if a discount starts later (§6).
7. A sold-out discounted product shows only `SOLD OUT`, no `N% OFF` badge (§9).
8. "Hemat RpX" line in cart, checkout and customer emails (§5.2, §9).
9. A discount is invisible on the storefront before its start time (§6).

No open questions remain.
