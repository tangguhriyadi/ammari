# Admin performance pass

Owner report: clicking any sidebar item on local, dev and prod leaves the old page on screen until
the new one is fully ready. Goal: instant visual feedback on every nav click, and less server time
per admin request, without caching permission or stock data across requests.

## 1. How it was measured

- **Build:** `next build` + `next start` of `apps/admin` (production mode), port 3201.
- **Database:** `ammari_perf`, a disposable copy of the local `ammari` db (`pg_dump | psql`, the
  owner's `ammari` db was only read), migrated to head, then bulk-seeded to a realistic size:
  20,007 orders over 12 months, 40,009 order items, 38,337 stock movements, 217 products /
  620 variants, 5,003 customers, 6,024 thank-you cards, 2,001 vouchers, 40,101 audit-log rows.
- **Auth:** one `staff_auth_sessions` row for the local super admin in `ammari_perf`, sent as a
  signed `ammari_staff.session_token` cookie (the same thing a browser sends).
- **Timing:** per route, 1 warm-up, then 7 full-document requests; the table shows the median.
  This is the whole server cost of one navigation: proxy session check + layout + page render.
- **Queries:** `log_min_duration_statement = 0` on `ammari_perf` only; one extra request per
  route, statements collected from the Postgres log, slow ones re-run with `EXPLAIN ANALYZE`.
- **Two columns:** "local" talks to Postgres on the same machine (round trip ~0.1 ms), which is
  also the **prod** shape: prod's Postgres is the `db` container in the same `/opt/ammari-prod`
  Docker Compose project on the VPS as the app. **Dev** is different: its app talks to a separate
  managed Postgres host (docs/deploy.md §0), so every query pays a network round trip there.
  "RTT 10" repeats the run through a local TCP proxy that adds 5 ms each way (10 ms round trip)
  to every Postgres packet: it models dev, and makes the cost of sequential queries visible. The
  round-trip reductions are kept for prod too: they still cut Postgres work per request, and
  prod's perceived lag is mostly the missing loading states and prefetch (finding 1), plus the
  browser to VPS round trip that every click pays.

## 2. Findings

1. **Rendering is not slow; waiting is invisible.** With 20k orders, every admin route renders in
   8-47 ms locally. But no admin route has a `loading.tsx`, so (a) a click shows nothing until
   the full RSC payload arrives, and (b) `<Link>` cannot prefetch anything for these dynamic
   routes (Next prefetches dynamic routes only down to the nearest loading boundary). Locally in
   `next dev` the wait also includes on-demand compilation of the route (seconds on first visit).
2. **Round trips dominate when the database is off-box (dev).** At 10 ms RTT the cheapest page takes ~190 ms and the heaviest
   ~460 ms. Each drizzle query costs **2** round trips (drizzle calls `postgres.unsafe()`, which
   is unprepared, so parse/describe and execute are separate trips: measured 27 ms/query vs
   15 ms for a prepared tagged query at 10 ms RTT). Driver-level, out of scope here, noted below.
3. **Every request pays a fixed auth chain of 6 sequential queries:** proxy: session by token ->
   auth user (2); render: session by token -> auth user -> staff+role -> role permissions (4).
   `getStaffSession` is already `cache()`d (runs once per render, confirmed in the log); the
   proxy's lookup is a separate request context and cannot share it. The last two render-side
   queries can be one.
4. **Sequential awaits in pages/loaders**, e.g. `/production/[id]` (26 queries, 5 independent
   `await`s in a row after the batch loads), `/purchases/[id]` (24), `/packing` (channels then
   queue then items, 14), `/products/[id]` (15), `/fabrics/[id]` (12).
5. **One index is justified:** `/orders` default sort is `created_at DESC, id DESC` with no index,
   so each page view hash-joins and sorts all 20k orders to return 20 (10.4 ms, grows linearly).
   With `orders (created_at DESC, id DESC)`: 0.2 ms (page 50: 0.6 ms). Tested inside
   `BEGIN ... ROLLBACK`.
6. **Not worth an index:** `/customers` (two parallel 12-16 ms aggregates over all orders, an
   index does not remove the aggregate), `/` low-stock (SUM over movements per SKU, 14 ms, uses
   the existing `(sku, created_at)` index), `/stock` and `/stock/sku-list` (6 ms, hash aggregate
   over all movements, a seq scan is the right plan at this size).

## 3. Before / after

Median ms per full server render (the whole response, skeleton and page). Queries and slowest
query are the "before" run; "after" re-ran the same harness on the same data with migration 0044
applied. `/` local after is the median of 15 runs (the 7-run pass read 52 ms, run-to-run noise).

| Route | Before local | Before RTT 10 | Queries | Slowest query ms | Main cost | After local | After RTT 10 |
| --- | --: | --: | --: | --: | --- | --: | --: |
| `/` | 35 | 286 | 22 | 35.1 | low-stock SUM per SKU, 22 queries | 38 | 246 |
| `/orders` | 19 | 241 | 9 | 18.9 | list sorts all orders (no `created_at` index) | 14 | 196 |
| `/packing` | 27 | 414 | 14 | 7.8 | channels -> queue -> items, sequential | 28 | 315 |
| `/import` | 11 | 205 | 7 | 0.1 | auth chain | 12 | 175 |
| `/stock` | 16 | 264 | 10 | 11.4 | stock SUM over all movements | 17 | 230 |
| `/purchases` | 10 | 221 | 9 | 0.4 | auth chain | 11 | 189 |
| `/production` | 10 | 223 | 8 | 0.2 | auth chain | 12 | 192 |
| `/receipts` | 11 | 224 | 9 | 0.3 | auth chain | 10 | 190 |
| `/products` | 14 | 257 | 10 | 1.1 | auth chain | 14 | 225 |
| `/product-types` | 8 | 192 | 7 | 0.6 | auth chain | 9 | 156 |
| `/fabrics` | 10 | 223 | 8 | 0.2 | auth chain | 10 | 187 |
| `/suppliers` | 12 | 254 | 9 | 0.2 | sequential awaits | 15 | 216 |
| `/content` | 9 | 190 | 7 | 0.2 | auth chain | 9 | 160 |
| `/content/size-charts` | 9 | 222 | 8 | 0.1 | auth chain | 9 | 185 |
| `/content/pages` | 9 | 194 | 7 | 0.2 | auth chain | 9 | 155 |
| `/content/settings` | 8 | 208 | 7 | 0.0 | auth chain | 10 | 171 |
| `/ads-expenses` | 10 | 237 | 9 | 0.0 | auth chain | 13 | 199 |
| `/customers` | 25 | 273 | 8 | 16.2 | per-customer aggregate over all orders | 26 | 227 |
| `/settings` | 9 | 212 | 8 | 0.1 | auth chain | 10 | 170 |
| `/roles-staff` | 10 | 223 | 9 | 0.3 | sequential awaits | 11 | 175 |
| `/activity-log` | 13 | 289 | 14 | 0.2 | 14 queries | 14 | 222 |
| `/stock/sku-list` | 47 | 272 | 7 | 14.4 | 620-row render + stock aggregate | 50 | 221 |
| `/stock/fabrics` | 10 | 252 | 9 | 0.2 | sequential awaits | 11 | 208 |
| `/stock/accessories` | 10 | 249 | 9 | 0.2 | sequential awaits | 11 | 208 |
| `/stock/defects` | 9 | 208 | 9 | 0.5 | auth chain | 9 | 170 |
| `/accessories` | 10 | 221 | 8 | 0.2 | auth chain | 10 | 184 |
| `/production/cost-components` | 10 | 192 | 7 | 0.3 | auth chain | 10 | 153 |
| `/orders/[id]` | 12 | 291 | 10 | 0.1 | sequential awaits | 13 | 192 |
| `/products/[id]` | 13 | 374 | 15 | 0.3 | 15 queries | 15 | 325 |
| `/customers/[id]` | 11 | 270 | 14 | 0.1 | 14 queries | 14 | 221 |
| `/stock/[sku]` | 12 | 273 | 12 | 0.3 | sequential awaits | 13 | 224 |
| `/production/[id]` | 16 | 463 | 26 | 0.2 | 26 queries, 5 sequential tail awaits | 19 | 413 |
| `/purchases/[id]` | 16 | 429 | 24 | 0.1 | 24 queries, doc -> legacy -> id lookups | 17 | 353 |
| `/suppliers/[id]` | 10 | 237 | 8 | 0.1 | sequential awaits | 10 | 194 |
| `/fabrics/[id]` | 12 | 318 | 12 | 0.1 | sequential awaits | 11 | 221 |
| `/activity-log/[id]` | 9 | 234 | 8 | 0.0 | auth chain | 10 | 195 |
| `/roles-staff/staff/[id]` | 12 | 260 | 14 | 0.2 | 14 queries | 11 | 222 |
| `/roles-staff/roles/[id]` | 9 | 209 | 8 | 0.3 | auth chain | 9 | 168 |
| `/content/size-charts/[id]` | 10 | 274 | 10 | 0.1 | sequential awaits | 9 | 193 |
| `/content/pages/[slug]` | 8 | 207 | 7 | 0.0 | auth chain | 8 | 167 |
| `/product-types/[code]` | 9 | 214 | 7 | 0.1 | auth chain | 10 | 167 |

"Auth chain" = the fixed 6 sequential auth queries plus one page query are the whole cost.

### What the table does not show: when something appears

- **Before:** no route had a loading boundary, so a click changed nothing on screen until the whole
  page had rendered (the "before" column), and the clicked menu item only lit up afterwards.
- **After, client navigation (a sidebar click):** the clicked item highlights in the same frame
  (client state, no server round trip), and the route's skeleton shows as soon as its loading
  state is available: instantly when the link was prefetched on hover/focus, otherwise with the
  first chunk of the response.
- **After, full document load:** the first byte, which already carries the skeleton, arrives at
  ~143 ms at RTT 10 on every route (proxy + layout session check), instead of after the full
  page (196-413 ms).
- **Fewer queries per request:** one less on every request (session staff/role + permissions now
  one query), one less on `/packing` and `/fabrics/[id]`, and per-color counts on `/fabrics/[id]`
  are one grouped query instead of one per color.

### Prefetch (measured in a browser, production build, 1280px)

| Page load | Prefetch requests | Postgres statements (page + prefetches) |
| --- | --: | --: |
| `/content/settings`, before | 24 | 60 |
| `/content/settings`, after | 0 | 6 |
| `/orders`, before | 44 | 96 |
| `/orders`, after | 23 | 52 |

Before, every visible sidebar link prefetched on every page load, and each prefetch runs
`proxy.ts`'s database-backed session check (2 statements). The sidebar and bottom nav now prefetch
on intent only (pointer enter, touch start, keyboard focus). The 23 left on `/orders` are the
page's own content links (one per order row, filter tabs, "Catat pesanan"), which already
prefetched before this pass (see §5).

## 4. What changed

- **Skeletons:** `Skeleton` (packages/ui) stops pulsing under `prefers-reduced-motion`; new
  `LoadingRegion` marks the skeleton `aria-busy` and announces "Memuat..." through a polite live
  region written after mount (not `role="status"`, which the app's toasts use).
  `apps/admin/src/components/page-skeleton.tsx` holds page-shaped presets (list, detail, form)
  built from the real `TableContainer`/`CardList`/`Card`, so the md breakpoint and boxes match.
  Every (shell) page except `/` has a sibling `loading.tsx` (67 files).
- **`/` has no loading.tsx on purpose:** `requireOverviewOrRedirect` must redirect a role without
  `overview.view` (Packing/Gudang land on `/` after login) before anything streams, so it stays a
  real server redirect instead of a dashboard skeleton flashing first. The page already streams
  per-section skeletons after that one session check.
- **Nav:** optimistic active item (`NavPendingProvider`, cleared on any pathname change) and
  intent-only prefetch in `nav-link.tsx`.
- **Server:** `loadStaffSessionData` is one query; independent reads run together in
  `listPackingQueue`, `getOrderDetail`, `/production/[id]` (draft), `/purchases/[id]`,
  `/fabrics/[id]`, `/roles-staff`, `/content/size-charts/[id]`.
- **Index:** migration 0044, `orders_created_at_id_idx` on `(created_at, id)`, additive. Ascending
  on purpose: a backward scan serves `ORDER BY created_at DESC, id DESC` with matching NULLS
  ordering (a `.desc()` index is NULLS LAST). `/orders` list query 10.4 ms -> 0.14 ms.
- **Behaviour to know about:** inside a route with a loading boundary, `forbidden()`/`notFound()`
  render after the skeleton has streamed, so "Akses ditolak" and 404 pages now arrive with HTTP
  200 (the page content is unchanged; route handlers such as CSV exports keep their real 403).
- **e2e:** `e2e/fixtures.ts` makes `page.goto`/`reload` wait until the skeleton is gone and React
  has hydrated the page (a full load now streams content after the skeleton, so typing right after
  `load` could hit inputs that are not hydrated yet), plus `clickAndWaitForAction`/
  `nextActionResponse` to wait for a Server Action instead of `networkidle`.
## 5. Out of scope (recorded for later)

- **Content links still prefetch on viewport.** Pre-existing (see the prefetch table): every
  in-page `<Link>` to a dynamic route prefetches when visible, 2 statements each, so a list page
  shows N row links -> N prefetches. Options: intent-only prefetch on list rows (a shared row-link
  component), or `prefetch={false}` on row links.
- **`/products/[id]`** still chains detail -> images -> step data (the step data partly needs the
  images).

- **Unprepared drizzle queries (2 round trips each).** Fixing it means patching or wrapping the
  drizzle/postgres-js driver for every query in both apps; a separate, riskier change.
- **Proxy session check.** Switching `proxy.ts` to a cookie-presence check would remove 2 queries
  per request, but it is a deliberate security posture (DB-backed coarse gate) and pages already
  re-check; owner decision, not part of this pass.
- **Session cookie cache.** Better Auth's `cookieCache` would skip the session lookup, but that
  is caching session state across requests; excluded by this task's rules.
