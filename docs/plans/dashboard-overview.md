# Ringkasan: the owner's daily overview

Status: **owner decisions recorded 2026-10-24** (section 12, all recommendations accepted). Sessions
1 to 5 implemented. Written 2026-10-24.

Session 4/5 notes: the "Target penjualan" section, its server action and the card's "Atur target"
link need `settings.manage` AND `finance.view_profit` (owner decision 2026-10-24, after D9); with
only `settings.manage`, `/settings` shows no section and never reads the goal. Charts live in
`components/charts/` (BarChart, RankBars, ProgressBar, CumulativeLine); labels are HTML next to a
stretched SVG so they stay readable at 390px, and each chart has a visually hidden data table.
Chart switches are URL params: `?metric=orders` (chart 1) and `?top=omzet` (Produk terlaris rank,
finance only). "Perlu tindakan" lists 3 rows per block (5 for Stok menipis).

Session 2/3 notes: the target card's progress bar is a plain div (`overview-target-card.tsx`);
session 4 may move it to `components/charts/` with the SVG charts. The period tabs sit above the
tiles (not in the page header), since the target card does not follow the period. "Pcs terjual" is
its own tile only without `finance.view_profit`; with it, pcs is a line under "Pesanan" so the four
money tiles stay one row on desktop.

The admin `/` page ("Ringkasan", `overview.view`) is a `ComingSoonPage` placeholder today. It
becomes the page the owner opens every morning on the phone: progress toward the first-year goal
of **Rp 1.000.000.000** (docs/SPEC.md §1), what sold, what needs action.

This plan covers a first slice of SPEC §6. Metrics from §6 that are **not** in this plan are
listed in section 11 (later). SPEC §6's "net revenue from completed orders" was replaced by the
omzet definition in 1.1 and 1.2 (D1; SPEC updated in session 1).

## 0. What the data model gives us (investigated)

| Need | Source | Notes |
|---|---|---|
| Order date | `orders.order_date` (timestamptz, NOT NULL) | Set for every channel. **No index today.** |
| Status | `orders.status`: `awaiting_payment`, `to_ship`, `shipped`, `completed`, `cancelled`, `returned` | Transitions (`@ammari/commerce` `ORDER_STATUS_TRANSITIONS`): `shipped -> returned`, `completed -> returned`; `cancelled` only from `awaiting_payment`/`to_ship`. Nothing sets `completed` automatically (staff only; the marketplace importer is not built). |
| Money (header) | `subtotal_amount`, `shipping_amount`, `discount_amount`, `total_amount` | CHECK `total = subtotal + shipping - discount`. `subtotal = sum(qty * unit_price)` (computed in `createOrder` / `placeOrder`). |
| Ongkir | `shipping_amount` = buyer's share; `shipping_subsidy_amount` = what Ammari pays (checkout only) | SPEC §5.2: ongkir is pass-through, not revenue; the subsidy is a shipping expense. |
| Voucher | `orders.discount_amount` | Order level, goods only, never ongkir (SPEC §8). Not allocated per line. |
| Product discount | `order_items.unit_price` (charged) vs `list_unit_price` (undiscounted, nullable) | `unit_price` already is the discounted price. `list_unit_price` is NULL for marketplace and older rows. |
| HPP | `order_items.unit_cost` | Locked at the moment stock leaves (`decrementStockForOrderItems`, moving average of the SKU ledger). `0` while `awaiting_payment`; also `0` when the SKU's stock was valued at 0 (e.g. an adjustment-only SKU). |
| Refunds | `payments.refunded_amount`, `orders.payment_status` in `refunded` / `partially_refunded` / `chargeback` | Web checkout orders only. Marketplace refunds only show up later in `order_settlements` (importer not built). |
| Marketplace payout | `order_settlements` (gross, fee, net) | Empty until the income importer exists. |
| Channel | `orders.channel_id`: `shopee`, `tiktok`, `web`, `reseller`, `whatsapp`, `instagram`, `offline` | `channels.name` holds the label. |
| Product type | `products.product_type_code -> product_types` (migration 0037) | Via `order_items.sku -> product_variants.product_id -> products`. |
| Stock | `sum(stock_movements.qty)` per SKU; `product_variants.min_stock_qty` | `stockStatus()` in `lib/stock/status.ts`: `habis` at 0, `menipis` when `min > 0 and stock <= min`. `/stock?low=1` already filters. |
| Supplier debt | `lib/supplier-payments/supplier-balance.ts` (`supplierDocumentsSql`, "Total utang") | Derived on read, never stored. Cost data: `finance.view_profit`. |
| Unpaid production | `listBatches` payment filter (`unpaid` / `partial`) in `lib/production/queries.ts` | Status visible to `production.manage`, amounts need `finance.view_profit`. |
| Needs action | `needs_attention` (`countOrdersNeedingAttention`), `status = 'to_ship'`, `status = 'awaiting_payment'` (+ `payment_expires_at` for checkout) | Order list filter value `perlu-dicek` exists. |
| Targets | `targets` table: one row per month (`revenue_target_amount`, `units_target`) | Exists since early migrations, nothing reads or writes it yet. No yearly goal or start date anywhere. |
| Settings pages | `/settings` "Pengaturan" (`settings.manage`, placeholder, SPEC §3.1: "targets, cost assumptions, staff"); `/content/settings` "Pengaturan Toko" (`content.manage`, storefront contact / announcement bar / meta) | `store_settings` is read by `apps/web`. See D2. |
| Charts | No chart library in `apps/admin` or `packages/ui` | See section 4.1. |

Volume today: the goal is about 310 to 335 pieces/month (SPEC §1), so roughly 300 orders and
350 order lines per month, about 4.000 orders a year. 10x is about 40.000 orders and 45.000 lines
a year.

## 1. Revenue definitions

All three numbers below live in ONE module (`apps/admin/src/lib/overview/revenue-sql.ts`) as SQL
fragments, so every tile, chart and the target tracker use the same definition. Same posture as
`purchaseLineTagihanSql`.

### 1.1 Which orders count ("pesanan terjual")

An order counts when the sale has happened and has not been undone:

```
status in ('to_ship', 'shipped', 'completed')
and coalesce(payment_status, 'paid') not in ('refunded', 'chargeback')
```

- `awaiting_payment`: out (not paid yet, stock has not left, `unit_cost` is still 0).
- `cancelled`, `returned`: out. A return removes the order from its **original** order date's
  numbers (the past changes). Simple, and it matches what the order list shows. The alternative
  (book a negative on the return date) needs a return-date ledger; not worth it in v1. The
  "Retur & batal" count of the period is shown next to the tiles so a drop is explainable.
- `to_ship` counts: for every channel, `to_ship` means paid (a checkout order reaches it only
  through the verified webhook / status poll; a manual order the staff marks paid; a marketplace
  order is paid on the platform). Stock has already left and HPP is locked.
- `partially_refunded` (web only, rare): counts, minus the refunded amount (1.2).

Why not "completed only" (SPEC §6 today): nothing moves orders to `completed` automatically and
the marketplace importer is not built, so a completed-only number would sit far below reality for
weeks and the tracker would say "behind" for no reason. D1.

### 1.2 Omzet (canonical revenue)

```
omzet = sum(subtotal_amount - discount_amount) - refund_adjustment     over counted orders
refund_adjustment = for partially_refunded web orders: least(sum(payments.refunded_amount), subtotal - discount)
```

- **Ongkir out** (`shipping_amount` is pass-through, SPEC §5.2). The shipping subsidy is an
  expense, not a revenue reduction; it is out of "laba kotor" too and belongs to a later net
  profit view.
- **Voucher in as a reduction** (`discount_amount` is money the buyer did not pay).
- **Product discount** is already in `unit_price`. No extra handling. "Diskon produk" (the
  `list_unit_price - unit_price` gap) is not shown in v1; it is NULL for marketplace lines anyway.
- **Marketplace orders:** `unit_price` is what the buyer paid for the item on the platform
  (before platform fees). Platform fees are not subtracted from omzet; they belong to net profit
  (SPEC §6 "profit per order", later).
- Attribution date: `order_date` in Asia/Jakarta, for every channel (a web order created 23:55
  and paid 00:05 counts on the day it was placed).
- UI label: **Omzet**. Help text: "Penjualan barang setelah voucher, tanpa ongkir. Pesanan batal
  dan retur tidak dihitung."

### 1.3 Laba kotor

```
hpp        = sum(order_items.qty * order_items.unit_cost)   over counted orders
laba kotor = omzet - hpp
margin     = laba kotor / omzet  (shown as a percentage, computed in integer basis points)
```

- `unit_cost` is locked at the moment stock left, so a later cost change never rewrites the past.
- A counted line with `unit_cost = 0` means its stock had no value (wrong data), and would inflate
  profit. The query also returns `linesWithoutCost`; when it is > 0 the tile shows a muted note
  "HPP belum lengkap untuk N item" with a link to `/stock`. No guessing of a cost.
- A partially refunded order keeps its full HPP (the goods left). Rare, acceptable.

### 1.4 Per-line breakdowns (product type, top products)

The voucher is order level. To make the product-type bars add up to the omzet tile, each line's
share of the voucher is prorated:

```
line_omzet = qty * unit_price - discount_amount * (qty * unit_price) / nullif(subtotal_amount, 0)
```

computed in `numeric` and rounded once per group (`round(sum(...))::bigint`). Group sums can differ
from the total by a few rupiah; the chart never shows a "total" row, so nothing visibly disagrees.
Partial refunds are not prorated (rare; channel totals use the header, which includes them).
Top products also show **pcs** (`sum(qty)`), which needs no proration. D6.

## 2. Target tracker

### 2.1 Storage (migration 0039)

The existing `targets` table is per month and has no year or start date, so a yearly goal does not
fit it. New single-row table, same shape as `store_settings`:

```
sales_goal
  id                     integer PRIMARY KEY DEFAULT 1, CHECK (id = 1)
  revenue_target_amount  bigint NOT NULL DEFAULT 1000000000, CHECK (> 0)
  start_date             date              -- NULL = not set yet; Jakarta calendar date
  created_at / updated_at (set_updated_at trigger)
```

- The single row is inserted **in the migration** (`INSERT ... ON CONFLICT DO NOTHING`, start
  date `2026-11-01`, see D3): the page depends on it, so it is reference data (CLAUDE.md rule), not
  `seed.ts`. The read helper still tolerates a missing row (treat as not configured).
- Purely additive (new table + new index), so the previous release is unaffected and rollback is
  safe.
- Each save writes `audit_log` (`entity_type = 'sales_goal'`, before/after).
- The year runs `start_date` to `start_date + 1 year - 1 day` (365 or 366 days, leap years
  handled by date arithmetic, not by "365").

### 2.2 Where it is edited

**Recommended: `/settings` ("Pengaturan", `settings.manage`)**, which turns from a placeholder
into a page with its first section, "Target penjualan" (target amount + start date). SPEC §3.1
already puts targets there. Not "Pengaturan Toko": that page is storefront content
(`content.manage`, a permission a future content helper may hold) and its table is read by
`apps/web`; a private revenue goal should not sit in a row the public site selects. D2.

Form: `Input` for the amount (digits only, thousand separators shown, "Rp" prefix), date input for
the start date, `Button` "Simpan". Validation (Zod, server side): amount whole rupiah 1 to
100.000.000.000; start date a valid date, not more than 1 year in the future. Changing the start
date after sales exist shows a confirmation text ("Progres akan dihitung ulang dari tanggal
ini.").

### 2.3 Calculations (pure, in `lib/overview/goal.ts`, unit tested)

Inputs: target `T`, year start `S`, year end `E`, today `D` (Jakarta date), actual omzet from `S`
to now `A`.

```
totalDays    = E - S + 1
elapsedDays  = clamp(D - S + 1, 0, totalDays)          -- today counts as elapsed
expected     = T * elapsedDays / totalDays              -- linear pace (D4)
progress     = A / T                                    -- basis points, can exceed 10000
status       = A >= expected ? "on_track" : "behind"
gap          = expected - A                             -- shown when behind
remaining    = max(T - A, 0)
daysLeft     = E - D + 1                                -- including today
neededPerDay = ceil(remaining / daysLeft)
neededPerMonth = neededPerDay * 30   (shown as "± Rp X / bulan")
neededPcsPerDay = ceil(neededPerDay / avgPricePerPcs)   -- avg omzet per pcs over the last 30 days; hidden when < 10 pcs sold
```

Edge states: before `S`: "Target mulai DD MMM YYYY" with no status. After `E`: final result, no
"needed". Goal reached: "Target tercapai" in olive. Not configured: a card linking to
`/settings` (for `settings.manage`), plain text otherwise.

Display: big percentage, a progress bar with a marker at the expected point, badge **"Sesuai
target"** (olive, `success`) or **"Di bawah target"** (brick, `danger`), the line "Kurang Rp X
dari target hari ini" when behind, and "Perlu Rp X per hari (± N pcs) untuk sisa N hari". Small
cumulative chart: actual per month vs the target line.

## 3. KPI tiles for a period

### 3.1 Periods

`FilterTabs` with `paramName="period"`: **Hari ini** (`today`), **Kemarin** (`yesterday`),
**7 hari** (`7d`, today and the 6 days before), **Bulan ini** (`month`), **Pilih tanggal**
(`custom`, `?from=YYYY-MM-DD&to=YYYY-MM-DD`, max 366 days, `to` not after today). Default: **Kemarin** (D5).
Invalid params fall back to the default (never throw).

Comparison period ("dibanding ..."):

- Hari ini: yesterday **up to the same time** (a fair comparison at 08:00).
- Kemarin: the day before.
- 7 hari: the 7 days before, up to the same time on the last day.
- Bulan ini: last month's first N days up to the same time (N = days elapsed this month; capped at
  the length of last month).
- Custom: the same number of days right before `from`.

All period math is a pure function (`resolvePeriod(period, now)`) returning UTC instants
`[start, end)` for both periods, built from Jakarta midnights (WIB is fixed UTC+7, no DST). Lives
next to `jakarta-month.ts` in `@ammari/commerce` as `jakarta-day.ts` (both apps will need it).

### 3.2 Tiles

| Tile | Value | Permission |
|---|---|---|
| Omzet | 1.2 | `finance.view_profit` |
| Pesanan | count of counted orders | everyone with `overview.view` |
| Pcs terjual | `sum(qty)` | everyone |
| Rata-rata per pesanan | omzet / pesanan | `finance.view_profit` |
| Laba kotor | 1.3, with margin % below | `finance.view_profit` |

Each tile: value, then a delta line "▲ 12% dibanding kemarin" (olive when up, brick when down, the
arrow carries the meaning so color is never the only signal; "Belum ada data pembanding" when the
previous value is 0). Below the grid, muted: "Batal: N, Retur: N" for the period.

## 4. Charts

### 4.1 Library decision

Nothing is installed. **Recommendation: no new dependency.** Build four small server-rendered SVG
components in `apps/admin/src/components/charts/` (move to `packages/ui` only if `apps/web` ever
needs them):

- `BarChart` (vertical bars over time),
- `RankBars` (horizontal bars with label + value, for categories),
- `ProgressBar` with an expected-pace marker,
- `CumulativeLine` (actual vs target, one line + one dashed line).

Why: the forms are simple; server SVG means no client JS and no hydration on the phone; the brand
colors and muted earth tones are applied directly; every chart also renders its numbers as text
(an accessible `<table>` visually hidden, plus value labels on bars), which a canvas/JS chart would
need extra work for. Tooltips are not needed when values are labelled; on desktop each bar gets an
SVG `<title>`. If a later need is truly interactive (zoom, brushing), Recharts would be the
candidate, as a client component, justified then. D7.

Colors: bars `#695A5A` (primary), target/expected line black dashed, comparison/neutral bars
`neutral-300`. No pie charts (hard to read at phone width; ranked bars replace them).

### 4.2 Charts on the page (all `finance.view_profit`, see 6)

1. **Omzet per hari / per bulan**: daily bars when the period is up to 62 days, else monthly. For
   "Hari ini"/"Kemarin" it shows the last 14 days ending on that day (one bar is not a chart).
   Toggle "Omzet / Pesanan" via `?metric=orders` so staff without finance can see the orders
   version.
2. **Per channel**: `RankBars`, omzet and share %, from the order header (sums to the tile).
3. **Per jenis produk**: `RankBars`, prorated line omzet (1.4) plus pcs.
4. **Produk terlaris**: top 10 by pcs, grouped by product, each row expandable (`<details>`) to its
   top variants (color + size). Value: pcs and omzet. Pcs-only version for staff without finance.

Charts 2 to 4 follow the selected period. Chart 1 follows it as described.

## 5. Action lists ("Perlu tindakan")

Shown at all times (not tied to the period), each row a link to the filtered existing page, each
block only for viewers holding that page's permission.

| Block | Query | Link | Permission |
|---|---|---|---|
| Perlu dicek | `cardinality(needs_attention) > 0` (reuse `countOrdersNeedingAttention`) | `/orders?status=perlu-dicek` | `orders.view` |
| Siap Kirim | count `status = 'to_ship'`, plus count older than 2 days (Jakarta) as "N lebih dari 2 hari" | `/packing` (`packing.print_cards`) else `/orders?status=to_ship` | `orders.view` |
| Menunggu Bayar | manual orders `awaiting_payment` with `payment_status is null` older than 24 hours, and checkout orders whose `payment_expires_at` is within the next 15 minutes | `/orders?status=awaiting_payment` | `orders.view` |
| Stok menipis | active variants with `habis` or `menipis` (same rule as `stockStatus`); count of each + the 5 lowest (stock/min ratio) | `/stock?low=1` | `stock.view` |
| Utang pemasok | sum of "Total utang" over all suppliers (aggregate over `supplierDocumentsSql`), number of suppliers, top 3 | `/suppliers?balance=owed` ("Ada utang") | `inventory.view` + `finance.view_profit` |
| Produksi belum lunas | posted batches with payment `unpaid` or `partial`: count; remaining amount with finance | `/production?payment=unpaid` | `production.manage` (amount: + `finance.view_profit`) |

A block with 0 is shown collapsed as a single line "Tidak ada" so the owner sees it was checked.
Both Menunggu Bayar parts are kept (D8).

## 6. Permissions

- Page: `requirePermission("overview.view")` (unchanged key, no migration for permissions).
- Money (omzet, rata-rata, laba kotor, HPP, margin, charts in rupiah, target amounts and progress
  %, supplier debt, production amounts): only when the session holds `finance.view_profit`. The
  **query layer** takes `canViewProfit` and does not compute or return those fields otherwise
  (same idea as `stripOrderDetailCost`, but better: they are never selected), so nothing reaches
  the RSC payload. An e2e test asserts no "Rp" appears for such a user.
- Progress % is hidden too: with the target known, a percentage reveals revenue. D9.
- What a staff member without `finance.view_profit` sees: Pesanan and Pcs terjual tiles with
  comparison, the orders-count version of chart 1, top products by pcs, per channel by order
  count, and the action lists their other permissions allow (without amounts). No target card.
- Each action block also checks its own module permission on the server before querying.
- Settings section: `settings.manage` on the page and on the server action.

## 7. Performance, time zone, caching

**Query plan.** One server component per section, each wrapped in `<Suspense>` with a `Skeleton`
fallback, all queries started in parallel. Per page load: about 8 queries (tiles current +
previous in one query with `filter (where ...)`, goal-to-date, chart series, channel, product
type, top products, action counts, low stock, supplier debt, production).

**Volume.** At today's volume a year is about 4.000 orders / 4.500 lines; at 10x about 40.000 /
45.000. Every aggregation is a range scan on `order_date` plus a join to `order_items` on its
existing `order_items_order_id_idx`: single-digit milliseconds at 10x. The heaviest query is the
goal-to-date (a whole year): one indexed range scan, well under 50 ms at 10x. No rollup table or
materialized view; revisit only past about 500.000 orders.

**Indexes (migration 0039):**

- `orders_order_date_idx` on `orders (order_date)`. Needed: nothing indexes `order_date` today.
  A partial index on counted statuses is not used because statuses change; the status filter is
  cheap after the date range.
- Nothing else. Low stock sums `stock_movements` per SKU (as `/stock` does); at 10x that is about
  100.000 ledger rows a year, still tens of milliseconds, and `stock_movements_sku_created_at_idx`
  exists. Supplier debt reads small tables. `orders_status_idx` and `orders_needs_attention_idx`
  cover the action counts.

**Time zone.** Range filters are always `order_date >= $start and order_date < $end` with UTC
instants computed in TypeScript from Jakarta midnights, so the index is used. Bucketing for charts
uses `(order_date at time zone 'Asia/Jakarta')::date` (or `date_trunc('month', ...)`) in the SELECT
/ GROUP BY only, never in WHERE. "Today", "older than 2 days", the goal's elapsed days and the
custom date inputs are all Jakarta calendar dates.

**Caching.** None in v1. The admin reads fresh everywhere else, the owner expects an order placed
a minute ago to show, and the queries are cheap. A shared cache would also have to be keyed by
permission set. If it ever matters: Next's data cache with a 60 s life, tagged and invalidated
from the order transition path. The page is dynamic (it reads the session), matching the rest of
the admin.

**Money safety.** Sums come back from Postgres as `bigint` strings; convert with the same
`Number.isSafeInteger` guard `getSupplierBalances` uses. Percentages in integer basis points.

## 8. Layout

**Phone (390 px, single column, order chosen for a morning glance):**

```
Ringkasan                         [Hari ini|Kemarin|7 hari|Bulan ini|Pilih]  (scrolls sideways)
+-------------------------------------------+
| Target tahun pertama          [Sesuai target]
| 23,4%      Rp 234.000.000 / Rp 1 M        |
| [=========|-----------------]  (marker)   |
| Perlu Rp 2.900.000/hari (± 11 pcs) . 241 hari lagi
+-------------------------------------------+
| Omzet        | Pesanan      |   2 x 2 grid of tiles
| Rp 3,2 jt ▲8% | 12  ▲2      |
| Laba kotor   | Rata-rata    |
+-------------------------------------------+
Perlu tindakan
  Perlu dicek            2  >
  Siap Kirim             7 (3 > 2 hari)  >
  Stok menipis           4  >
  Utang pemasok   Rp 12,5 jt  >
  Produksi belum lunas   1  >
+-------------------------------------------+
Omzet per hari (bar chart, full width)
Per channel / Per jenis produk / Produk terlaris (stacked cards)
```

Rows in "Perlu tindakan" are full-width tap targets of at least 44 px. Amounts on tiles use a
compact form ("Rp 3,2 jt", full value in a `title` and in the accessible text); the target card
shows full amounts.

**Desktop (1280 px):** 12-column grid with the shell's existing 32 px gutters.

```
[ Target card (8 cols)                ] [ Perlu tindakan (4 cols)  ]
[ Omzet ][ Pesanan ][ Rata-rata ][ Laba kotor ]  (4 tiles, 1 row)
[ Omzet per hari (8 cols)             ] [ Per channel (4 cols)     ]
[ Per jenis produk (6 cols) ] [ Produk terlaris (6 cols)           ]
```

Components reused: `PageHeader`, `Breadcrumb`, `FilterTabs`, `Card`, `Badge`, `Skeleton`,
`EmptyState` (no sales yet: "Belum ada penjualan di periode ini"), `Button`, `Input`, `Label`.
Money formatting via `formatRupiah` / `formatNumber` from `@ammari/ui`; the compact form ("Rp 3,2 jt") is a new helper next to them. No list page is introduced, so no
`CardList`/`TableContainer` pair is needed; e2e still runs both viewports (CLAUDE.md).

All UI text Indonesian. No em dash in any UI string.

## 9. Files

- `packages/db`: `schema/content.ts` or a new `schema/goals.ts` (`sales_goal`), `orders` index;
  migration `0039_sales_goal_and_order_date_index.sql` (generated, then read).
- `packages/commerce/src/jakarta-day.ts` (+ test): Jakarta day boundaries, `resolvePeriod`.
- `apps/admin/src/lib/overview/`: `revenue-sql.ts` (definitions), `goal.ts` (pure pace math),
  `queries.ts` (tiles, series, breakdowns, goal-to-date, action counts), `format.ts` (compact
  rupiah, delta), tests next to each.
- `apps/admin/src/lib/settings/sales-goal.ts` (read/save + audit) and the `/settings` page section.
- `apps/admin/src/components/charts/*` (4 SVG components).
- `apps/admin/src/app/(shell)/page.tsx` and `_components/*` per section.
- `docs/SPEC.md`: §6 first bullet and §3.1 Settings line updated (D1, D2); Status section.

## 10. Tests and session split

### 10.1 Tests

Unit (vitest, pure):

- `resolvePeriod`: each period at 00:00, 06:59 and 23:59 WIB (UTC day differs from Jakarta day);
  "Bulan ini" on 31 March (Feb is shorter, comparison capped); custom range validation (from >
  to, > 366 days, future `to`, garbage input -> default).
- `goal.ts`: before start, day 1, mid-year, last day, after end, reached early, leap year
  (2027-11-01 start spans no Feb 29; a 2027-03-01 start spans 2028-02-29), `neededPerDay`
  rounding up, `avgPricePerPcs` threshold.
- Delta formatting: up, down, from 0, to 0, both 0.

Integration (vitest against the test database, like `lib/*/queries.test.ts`):

- Counted set: one order per status, plus `refunded`, `chargeback`, `partially_refunded` web
  orders -> only the right ones counted, partial refund subtracted.
- Omzet excludes ongkir and subtracts voucher; laba kotor uses locked `unit_cost`;
  `linesWithoutCost` counts `unit_cost = 0` lines.
- An order at 23:30 WIB lands on that Jakarta day, one at 00:30 WIB on the next.
- Returning a `completed` order removes it from its original day.
- Channel breakdown sums exactly to the omzet tile; product-type breakdown within a few rupiah.
- `canViewProfit = false`: the returned objects have no money fields at all.
- Action counts: needs_attention, to_ship age, stale manual awaiting_payment, near-expiry
  checkout, low stock (habis/menipis/min 0 ignored, inactive ignored), supplier debt total equals
  the sum of `getSupplierBalances`, unpaid production count.
- `sales_goal`: migration row present; save validation; audit row written; non-`settings.manage`
  action refused.

E2E (Playwright, each test at **390 px and 1280 px**):

- Owner: target card, tiles, period tabs change values and the URL, charts render with labels,
  action rows link to the right filtered pages.
- Staff with `overview.view` but no `finance.view_profit`: no "Rp" anywhere on the page, no target
  card, counts visible.
- Settings: change target and start date, Ringkasan reflects it.
- Empty database state: empty states, no crash.

### 10.2 Sessions (one feature each, each committable alone)

1. **Definitions + data layer:** migration 0039 (`sales_goal` + `orders_order_date_idx`),
   `jakarta-day.ts`, `lib/overview/revenue-sql.ts`, `goal.ts`, `queries.ts` for tiles and
   goal-to-date, with the unit and integration tests above. No UI. Reviewers: database,
   typescript.
2. **Settings "Target penjualan":** `/settings` page section, server action, audit log, tests.
3. **Ringkasan page, part 1:** period tabs, target card, KPI tiles, permission handling, Suspense
   sections, e2e (both viewports, both roles).
4. **Charts:** the 4 SVG components, omzet over time, per channel, per product type, top products;
   e2e additions.
5. **Perlu tindakan:** action blocks (orders, stock, supplier debt, production), e2e additions.
   Then update SPEC §6 / Status.

## 11. Later (SPEC §6 items not in this plan)

Size mix vs cutting ratio, stock per SKU vs minimum (beyond the low-stock list), profit after
marketplace fees (settlements or the 18% assumption), ROAS per channel (needs `ad_spend_daily`
input), cancellations + returns rate vs 3%, voucher printed/claimed/redeemed counts, monthly
target curve (D4), net profit including shipping subsidy and expenses.

## 12. Owner decisions (2026-10-24)

All recommendations were accepted. No open questions remain for sessions 1 to 5.

- **D1 Omzet scope:** orders in Siap Kirim, Dikirim, Selesai count. Batal, retur, refunded and
  chargeback are excluded. A later return removes the order from its original date. Partial
  refunds are subtracted. SPEC §6 updated to match.
- **D2 Where the goal is edited:** `/settings` ("Pengaturan", `settings.manage`), not Pengaturan
  Toko.
- **D3 Year one start:** 1 November 2026, editable.
- **D4 Pace:** straight line for now; seasonal (monthly) weights in a later session.
- **D5 Default period:** Kemarin; Hari ini one tap away.
- **D6 Voucher in per-line numbers:** prorated across each order's lines, so product-type bars sum
  to omzet.
- **D7 Charts:** no new dependency; small server-rendered SVG components.
- **D8 Menunggu Bayar:** manual orders unpaid for more than 24 hours, plus checkout orders expiring
  within 15 minutes.
- **D9 Staff without `finance.view_profit`:** order and pcs counts and action lists only; no rupiah
  and no target percentage.
- **D10 Siap Kirim late:** more than 2 days after the order date (Jakarta).
- **D11 Shipping subsidy:** not in laba kotor; it belongs to the later net-profit view.
