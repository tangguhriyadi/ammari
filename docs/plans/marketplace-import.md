# Marketplace import: Shopee (now) and TikTok Shop (framework)

Status: **owner decisions recorded 2026-10-24** (section 13). Sessions 1 to 3 implemented
2026-10-24/25, sessions 4 and 5 implemented 2026-10-25 (section 17).
Shopee "Simpan" stays locked (`SHOPEE_MAPPING_VERIFIED = false`) until a real Seller Center header
is checked (section 2.1). Written 2026-10-24.

The admin `/import` page ("Impor", `orders.import`) is a `ComingSoonPage` placeholder today
(`apps/admin/src/app/(shell)/import/page.tsx`). This plan turns it into a daily upload of the Seller
Center order export: the owner uploads the Excel file, sees a preview of what will change, clicks
**Simpan**, and the marketplace orders land in admin `orders` with stock deducted, so Ringkasan
shows real omzet per channel and the stock page matches what was sold.

Owner decisions this plan is built on (final, from the brief):

- Purpose: revenue reporting **and** stock deduction.
- **No buyer personal data** is stored (name, username, address, phone, ...). Those columns are
  never read past the header row.
- Stored: marketplace order number, order date/time, status, lines (variant via SKU, qty, price),
  seller-funded voucher, platform fees (admin / service / commission / affiliate) for net profit.
- Daily uploads at random times; files overlap. Idempotent on **channel + marketplace order
  number**; re-import updates status and amounts; cancel/return on the marketplace cancels/returns
  the admin order and restores stock, through the existing lifecycle.
- Marketplace variant SKU = admin SKU. Unknown SKUs are never silently imported. **Matching is by
  SKU only**: marketplace product and variation names always differ from admin names and are never
  used for matching (only shown, in the preview, to help a person decide). An unknown SKU can be
  matched by hand to an admin variant for one import (section 8.1).
- A **Daftar SKU** page with CSV download and copy, for filling SKUs into Shopee/TikTok listings
  (section 11.1).
- Two steps: upload, server-side parse, preview, then **Simpan**. Nothing is written before
  Simpan. Audit log on Simpan.
- TikTok Shop: adapter structure only; upload refuses with a clear Indonesian message until a real
  export header is mapped.
- Test fixtures are synthetic only.

## 0. What exists today (investigated)

| Need | What is there | Notes |
|---|---|---|
| Route | `/import` placeholder, `requirePermission("orders.import")`; nav item gated on `orders.import` (`lib/nav/config.ts`); `/impor` 308s to `/import` | Nothing to reuse beyond the route, permission and nav entry. |
| Permission | `orders.import` ("Import Shopee/TikTok order and income exports"), shipped in migration 0014, held by `owner` and `super_admin` | No new permission needed. |
| Channels | `CHANNEL_IDS` includes `shopee`, `tiktok`; `MARKETPLACE_CHANNEL_IDS = ["shopee", "tiktok"]` | Rows already in the DB (migration 0014). |
| Idempotency key | `orders_channel_id_channel_order_no_key` UNIQUE `(channel_id, channel_order_no)`; `channel_order_no` required for marketplace channels (`createOrder`) | Designed for this importer (orders-core plan, "Idempotency for the future importer"). |
| Line key | `order_items_order_id_sku_key` UNIQUE `(order_id, sku)`; SPEC §5.2: duplicate SKU rows in one order are **merged** (qty summed, `unit_price` = weighted average rounded) | `list_unit_price` stays NULL for marketplace lines. |
| Stock key | `stock_movements_type_ref_unique_idx` UNIQUE `(type, ref_type, ref_id)`: at most one `sale` and one `return` per order line | A retried import can never deduct twice. |
| Batches | `import_batches` (`channel_id`, `kind` in `orders`/`income`, `filename`, `status` in `pending`/`previewed`/`committed`/`failed`, `uploaded_by`, `row_count`, `error_message`); `orders.import_batch_id` FK | Never written so far. |
| Payouts | `order_settlements` (gross / fee / net per `external_ref`) | For the later **income** export, not this plan (decision 11). |
| Write paths | `@ammari/commerce` `createOrder` (starts at `to_ship` or `awaiting_payment`, decrements stock at `to_ship`, locks `unit_cost`), `transitionOrderStatus` (the only status path: restores stock on cancel/return, voids the active thank-you card, writes audit) | `createOrder` takes a date string (Jakarta midnight) and a staff creator; the importer needs the real timestamp and `created_by = null`, so it gets its own insert path that reuses the same stock helpers (section 6). |
| Stock rule | `decrementStockForOrderItems` refuses a sale that would take a SKU below 0 (`FieldError` naming the SKU); the ledger has no negative balances | Conflicts with "a marketplace sale is never refused" (SPEC §5.2). Decided: decision 2. |
| Lifecycle | `to_ship -> shipped/cancelled`, `shipped -> completed/returned`, `completed -> returned`; `cancelled`, `returned` terminal; **`shipped -> cancelled` forbidden** | Drives the status mapping (section 3). |
| Manual marketplace orders | `/orders/new`: staff pick `shopee`/`tiktok`, the marketplace order number is required, lines typed by hand, starts at `to_ship` (stock leaves at once) | An import of the same number **matches** that order (same unique key) and updates it (decision 10). |
| Omzet | `revenue-sql.ts`: counted = status in `to_ship`/`shipped`/`completed` (minus refunded web payments); omzet = `greatest(subtotal - discount, 0)`; laba kotor = omzet - sum(qty x unit_cost) | Applies to marketplace orders unchanged (section 9). |
| Per kanal | `overview/queries.ts` groups counted orders by `channel_id`, label from `channels.name` (via `channelDisplayNameSql`) | Shopee and TikTok Shop appear automatically. |
| Audit | `writeAuditLog(tx, {...})` into `audit_log` (open-ended `action`/`entity_type`) | |
| Upload size | admin `serverActions.bodySizeLimit = "12mb"`; product images enforce 10 MB server-side | Same 10 MB cap fits without a config change. |
| Spreadsheet library | **None installed** (no `xlsx`, `exceljs`, `papaparse`, ...) | New dependency, section 10. |

## 1. Flow

```
[Pilih kanal: Shopee | TikTok Shop] [Pilih file .xlsx/.csv] [Periksa file]
        |
        v  server action previewImport(formData)            (no DB writes)
   read file in memory -> guards (size, type, zip) -> sheet rows
   -> adapter: find header row, map columns, refuse if a required column is missing
   -> normalize rows (drop every unmapped column immediately; buyer data never leaves the parser)
   -> group rows into orders (double-count rule, section 4)
   -> plan against the DB (read-only): new / updated / unchanged / needs review / skipped
   -> return preview + planDigest
        |
        v  owner reviews, clicks "Simpan N pesanan"
   server action commitImport(formData: same file + planDigest)
   re-parse + re-plan (same code); digest differs -> return the fresh preview, write nothing
   else one transaction: batch row, inserts, updates, transitions, fees, audit
```

**Save blockers.** `parseMarketplaceFile` returns `saveBlockers`: every reason nothing in the file
may be saved. Today: the channel's mapping lock (section 2.1), and rows that have data but no
usable order number (such a row could be an item of any order, which would then import short;
session 1 review). The commit refuses on the server while the list is not empty.

**Nothing is stored between the two steps.** The browser keeps the `File` object and sends it again
with Simpan, so there is no server-side draft, no temp table, and the uploaded file (which contains
buyer data) is never persisted anywhere: not in the DB, not in R2, not on disk, not in logs. The
re-parse at Simpan is cheap (a daily file is a few hundred rows) and makes the commit safe against
anything that changed in between (another upload, a manual status change, a stock adjustment):
`planDigest` is a sha256 over the canonical JSON of the plan (each order's key, action, target
status, lines, amounts, fees). If it no longer matches, the owner sees "Data berubah sejak
pemeriksaan. Periksa lagi sebelum menyimpan." with the new preview.

The file's own sha256 is stored on the batch at Simpan. Uploading a file whose hash was already
committed shows an info line ("File ini sudah pernah disimpan pada 23 Okt 2026 14.05.") and is
otherwise processed normally (it will simply be all "Tidak berubah").

## 2. Platform adapters

Reading and planning are admin-only, so they live in `apps/admin/src/lib/marketplace-import/`
(server-only); `apps/web` never carries the spreadsheet dependency. Only the write path (session 4)
goes into `@ammari/commerce`, next to `createOrder` / `transitionOrderStatus`, as CLAUDE.md
requires for order and stock writes:

```
apps/admin/src/lib/marketplace-import/
  read-sheet.ts        file bytes -> string[][] (guards, xlsx/xls/csv, no formulas)
  zip-guard.ts         xlsx central-directory check before parsing (zip bomb)
  headers.ts           header normalization, header-row detection, alias matching, missing-column report
  values.ts            money / qty / order number / SKU / Asia/Jakarta date-time parsing, strict
  group-orders.ts      rows -> NormalizedOrder[] (double-count rule, line merge)
  status-rules.ts      raw status + current admin status -> decision (section 3)
  parse-file.ts        the session 1 entry point: file -> ParsedImport (orders, row errors, warnings)
  adapters/
    types.ts           MarketplaceAdapter interface
    shopee.ts          column aliases, status map, fee columns, SHOPEE_MAPPING_VERIFIED
    tiktok.ts          columns = null -> refuses
    index.ts           registry by channel id
  plan.ts              (session 3) NormalizedOrder[] + DB (read-only) -> ImportPlan
packages/commerce/src/marketplace-import/
  commit.ts            (session 4) ImportPlan -> one transaction
```

```ts
type ColumnScope = "order" | "line"; // order: same value repeated on each row, taken once; line: summed

interface ColumnSpec {
  field: NormalizedField;              // "channelOrderNo" | "status" | "orderedAt" | "sku" | "qty" | "lineTotal" | "sellerVoucher" | fee components ...
  aliases: readonly string[];          // normalized header texts
  required: boolean;
  scope: ColumnScope;
}

interface MarketplaceAdapter {
  channelId: "shopee" | "tiktok";
  label: string;                       // "Shopee", "TikTok Shop"
  columns: readonly ColumnSpec[] | null; // null = mapping not known yet -> refuse to parse
  mappingVerified: boolean;            // false = preview works, Simpan is refused
  statusMap: Readonly<Record<string, StatusRule>>; // normalized raw status -> rule (section 3)
  feeColumns: readonly { field: NormalizedField; component: ChannelFeeComponent }[];
}
```

- **Header detection**: scan the first 10 rows for the row that matches the most required
  aliases. Normalization: Unicode NFKC, trim, collapse whitespace, lowercase, drop a trailing unit
  like `(rp)` / `(idr)`. A header matching two specs, or one spec matched by two headers, is an
  error (never guess). Unknown headers are ignored (Shopee has 40+ columns; most are buyer and
  shipping data we deliberately skip).
- **Missing column report**: "Kolom wajib tidak ditemukan: Nomor Referensi SKU, Jumlah. Pastikan
  file adalah export Pesanan dari Shopee Seller Center." Optional columns that are missing become
  warnings ("Kolom Biaya Layanan tidak ada di file; biaya platform pesanan ini dihitung belum lengkap.").
- **Channel check**: the owner picks the channel; a file that matches the other adapter's signature
  better is refused ("File ini sepertinya export TikTok Shop, bukan Shopee."). No auto-detect as
  the only input: a wrong guess would write orders to the wrong channel.
- **TikTok**: `columns: null`. Parsing refuses before reading rows: "Format export TikTok Shop belum
  dikonfirmasi, jadi file belum bisa diimpor. Kirim contoh baris judul kolom (tanpa data pembeli)
  ke admin teknis untuk dipasang dulu." Known cost components are already in the fee vocabulary
  (section 5) so adding TikTok later is a mapping plus tests, no migration: `voucher toko` ->
  `sellerVoucher`, `komisi platform` -> `platform_commission`, `komisi afiliasi` (per product) ->
  `affiliate_commission` with `scope: "line"`, seller shipping subsidy -> `seller_shipping_subsidy`.
  Buyer-paid ongkir is not mapped at all (not revenue).

### 2.1 Shopee columns (from a public article, **not verified against a real file**)

| Field | Aliases (initial) | Required | Scope | Notes |
|---|---|---|---|---|
| `channelOrderNo` | No. Pesanan, Nomor Pesanan, Order ID | yes | key | Trimmed; must match `^[A-Z0-9]{6,32}$` after uppercasing, else row error. |
| `status` | Status Pesanan, Order Status | yes | order | Section 3. |
| `orderedAt` | Waktu Pesanan Dibuat, Order Creation Date | yes | order | Asia/Jakarta wall time -> UTC. Decision 13. |
| `sku` | Nomor Referensi SKU, SKU Reference No. | yes | line | The **variant** SKU. Never aliased to "SKU Induk" (parent SKU). |
| `qty` | Jumlah, Quantity | yes | line | Integer > 0. |
| `lineTotal` | Total Harga Produk, Product Subtotal | yes | line | What the buyer was charged for the row's goods, after product discounts. |
| `sellerVoucher` | Voucher Ditanggung Penjual, Seller Voucher | yes | order | Into `orders.discount_amount`. Required: a missing voucher column would overstate omzet silently. |
| fee `admin_fee` | Biaya Administrasi | no | order | |
| fee `service_fee` | Biaya Layanan | no | order | |
| fee `platform_commission` | (none known for Shopee) | no | order | |
| fee `affiliate_commission` | Komisi AMS, Biaya Komisi AMS | no | order | Unverified alias. |
| fee `seller_shipping_subsidy` | (unknown) | no | order | |
| display only | Nama Produk, Nama Variasi | no | line | Shown in the preview for unknown SKUs, **never stored**. |
| ignored | Provinsi / Kota, and every name / username / phone / address column | | | Not read past the header row (decision 9). |

**Verification lock (owner decision 14).** The owner will export a real Shopee file once his shop's
brand verification issue is resolved. Until then the adapter is built on the columns above with
`SHOPEE_MAPPING_VERIFIED = false` (one exported constant in `adapters/shopee.ts`). Effect: Periksa
file (parse + preview) works fully, so parsing can be tested; the preview shows "Pemetaan kolom
Shopee belum diverifikasi dengan file asli, jadi pesanan belum bisa disimpan." and `commitImport`
refuses on the server (not only a disabled button). Unlocking = check the real header row and 2 or
3 orders' numbers against the Seller Center order detail page, adjust aliases/scopes if needed,
flip the constant, and update the tests that assert the lock.

### 2.2 Value parsing

- **Money**: numeric cells must be whole numbers >= 0; text cells accept `Rp`, spaces, `.` as the
  thousands separator and an optional `,00`. Anything else (decimals, negatives, `1,5`, text) is a
  row error naming the row number and column, never a guess and never `parseFloat`.
- **Qty**: integer 1 to 1000.
- **Dates**: `YYYY-MM-DD HH:mm[:ss]` text or an Excel date serial, interpreted as Asia/Jakarta
  (fixed +07:00). Unparseable -> row error.
- **SKU**: trim, uppercase (admin SKUs are generated uppercase, `generateSku`), then exact match on
  `product_variants.sku`. No fuzzy matching.
- **Formulas and injection**: cells are read as their cached value, formulas are never evaluated
  (section 10). Stored strings are limited to the order number (strict pattern), the SKU (must match
  an existing variant) and the raw status (must be in the adapter's status map, max 64 chars), so a
  `=HYPERLINK(...)`-style payload can never reach the DB. The preview renders through React (escaped);
  nothing is ever rendered as HTML. Any future CSV export of these fields must prefix a leading
  `=`, `+`, `-`, `@`, tab or CR with `'`.

## 3. Status mapping

Raw status text is normalized (trim, lowercase, collapse whitespace) and looked up in the adapter's
`statusMap`. A status not in the map puts the order in **Perlu dicek** ("Status 'X' belum dikenal"),
never imported, never guessed. Unknown statuses are listed in the preview so the mapping can be
extended.

Shopee (seen = the owner has seen it in a real file; others are from Seller Center tabs and are
**unverified spellings**):

| Shopee status | Seen | Target | New order (not in admin) | Existing admin order |
|---|---|---|---|---|
| Belum Bayar | no | none | **Skip** (not a sale yet; decision 5) | No change (an earlier, unpaid state never moves an order back). |
| Perlu Dikirim | no | `to_ship` | Create at `to_ship`, stock out | No change if already `to_ship` or later. |
| Dikirim / Sedang Dikirim | no | `shipped` | Create at `to_ship` then `-> shipped` | `to_ship -> shipped`; later states unchanged. |
| Selesai | **yes** | `completed` | Create, `-> shipped -> completed` | Walk forward to `completed`; `cancelled`/`returned` unchanged + warning. |
| Batal | **yes** | `cancelled` | **Skip** (never existed for us; decision 5) | `to_ship -> cancelled` (stock restored); from `shipped`/`completed` -> **`returned`** (the lifecycle forbids `shipped -> cancelled`; the parcel comes back; decision 4). |
| Dalam Pengembalian | **yes** | hold | Create at `to_ship -> shipped` (the sale happened, stock left) and set the flag | Set flag `marketplace_return_pending` (decision 3); no return, no stock movement. An admin order still `to_ship` also moves `-> shipped` (the parcel left: it is coming back), owner 2026-10-25; `shipped`/`completed` stay as they are. |
| Pengembalian Selesai / Pengembalian Dana Disetujui (names unknown) | no | `returned` | Skip (sale undone before we saw it) | `-> returned` (stock restored), clears `marketplace_return_pending`. Added to the map only once seen in a real file. |

Rules that hold for every adapter:

1. **Forward only.** The importer walks `ORDER_STATUS_TRANSITIONS` forward from the current status
   to the target through the shortest allowed path (`to_ship -> shipped -> completed`), each step
   through `transitionOrderStatus` inside the commit transaction. A target that is behind the
   current status (an older overlapping file) is ignored: "Tidak berubah".
2. **Terminal stays terminal.** A `cancelled`/`returned` admin order is never revived. If the
   marketplace now says Selesai, the order shows under Perlu dicek with "Status admin Dibatalkan,
   marketplace Selesai" and nothing changes.
3. `orders.channel_status` always stores the latest raw marketplace status text (display and
   debugging), updated even when no transition happens.
3a. **`marketplace_return_pending` is cleared only when the return really ends**: the import moves
   the order to `cancelled`/`returned`, or the order is already final in admin. Any other status in
   a later file (an older overlapping export still saying Selesai or Dikirim) keeps the flag; a
   rejected return is settled by hand on the order page (session 5 adds "Hapus tanda retur", audit
   logged). Session 4: `transitionOrderStatus` to `cancelled`/`returned` clears the flag too, so a
   manual Retur never leaves it behind.
4. Courier and resi are not imported (shipping columns are skipped); `-> shipped` is called without
   them, the same as the packing page's bulk "Tandai dikirim".

## 4. The double-count rule

Shopee writes **one row per item**, and order-level values (voucher, fees, status, order time)
repeat on every row of the order. Each `ColumnSpec` declares its scope:

- `scope: "line"` (sku, qty, lineTotal, a per-product affiliate commission): **summed** per
  `(order, sku)`, then per order.
- `scope: "order"` (status, orderedAt, sellerVoucher, Shopee fees): **taken once**. All non-blank
  values across the order's rows must be identical; blanks are ignored (some exports fill only the
  first row). If two rows disagree, the whole order goes to Perlu dicek ("Nilai Voucher Ditanggung
  Penjual berbeda antar baris pesanan ini") and is not imported. This also catches a column we
  mis-scoped: a per-line voucher that differs between rows is reported, not silently counted
  once.
- Known blind spot, covered by the real-header check (section 2.1, session 7): a per-line value that
  happens to be identical on every row (two items, Rp5.000 voucher each) would be taken once. The
  real-file check confirms each money column's scope before the mapping is trusted.

Line merge (SPEC §5.2): rows of one order with the same SKU become one line: `qty` summed,
`unit_price = round(sum(lineTotal) / sum(qty))`. `subtotal_amount = sum(qty x unit_price)`. When
rounding makes that differ from `sum(lineTotal)` by a few rupiah the preview shows it per order
("Selisih pembulatan Rp1"); it is accepted (the line grain must add up, SPEC §6 per-line
breakdowns).

Header amounts for an imported order: `subtotal_amount` as above, `discount_amount =
sellerVoucher` (capped at the subtotal; above it is a row error), `shipping_amount = 0` (buyer
ongkir is pass-through, not ours to record), `total_amount = subtotal - discount` (the existing
balance CHECK holds). Platform-funded vouchers and coins are not ours and are not read.

## 5. Schema changes (migration 0040, backward-compatible)

All additive: new nullable columns, new tables, and one CHECK widened to a superset. The release
before 0040 never reads or writes any of them, so rollback stays safe (CLAUDE.md expand rule).

1. `orders.channel_status text NULL`, CHECK `char_length <= 64`. Latest raw marketplace status.
2. `orders.channel_synced_at timestamptz NULL`. When an import last confirmed this order.
3. `order_channel_fees`
   - `id uuid pk`, `order_id uuid not null fk orders (restrict)`, `component text not null` CHECK in
     `CHANNEL_FEE_COMPONENTS = ["admin_fee", "service_fee", "platform_commission",
     "affiliate_commission", "seller_shipping_subsidy", "other"]` (in session 1 it lives in
     `apps/admin/src/lib/marketplace-import/adapters/types.ts`; session 2 moves it into
     `constants.ts` with the CHECK and the adapter imports it from there), `amount bigint not null >= 0`, `import_batch_id uuid fk import_batches`,
     timestamps.
   - UNIQUE `(order_id, component)`: re-import upserts (`ON CONFLICT DO UPDATE`), never duplicates.
   - Index on `order_id` comes from the unique; index on `import_batch_id`.
   - A table, not five columns on `orders`: TikTok has different components and per-product
     commissions; a closed vocabulary keeps the CHECK and lets new components ship as a CHECK widen
     (decision 7).
4. `import_batches.file_sha256 text NULL`, `import_batches.summary jsonb NULL` (counts and totals
   shown in history), `import_batches.committed_at timestamptz NULL`. The importer inserts the batch
   **at Simpan**, directly as `committed`; `pending`/`previewed` stay unused (nothing is written
   before Simpan).
5. `import_batch_orders`: `import_batch_id fk (restrict)`, `order_id fk (restrict)`, `action text`
   CHECK in `["created", "updated"]`, `changes jsonb` (which fields/status moved, no buyer data),
   PK `(import_batch_id, order_id)`, index on `order_id`. Answers "what did this upload change" in
   the history view without reading `audit_log` (which needs `audit_log.view`).
6. `ORDER_ATTENTION_FLAGS` gains `marketplace_return_pending`; the
   `orders_needs_attention_allowed_check` is dropped and re-added with the superset (same file).
   The old release only ever writes old values, so it still passes.

No reference data rows are needed (channels and `orders.import` already ship in 0014). No data
backfill. `orders.import_batch_id` keeps meaning "the batch that created this order".

Generated with `drizzle-kit generate`, then the SQL is read line by line before committing.

## 6. Idempotency, concurrency and update rules

**Key**: `(channel_id, upper(trim(channel_order_no)))`. The planner normalizes the file's number the
same way; manual orders typed with stray spaces are matched by a trimmed, case-insensitive lookup in
the planner (read-only) and shown as "Cocok dengan pesanan manual ORD-202610-0042".

**Commit transaction** (`commitImport`), one transaction for the whole Simpan:

1. `pg_advisory_xact_lock(hashtext('marketplace-import:' || channel_id))`: two Simpan clicks, two
   tabs or two people importing the same channel run one after the other. The second one re-plans
   after the first committed and, because its digest no longer matches, shows the fresh preview.
2. Re-parse and re-plan **inside** the transaction, after the lock; compare `planDigest`. Mismatch:
   roll back, return the new preview.
3. Insert the `import_batches` row (`committed`, `file_sha256`, `summary`, `uploaded_by`).
4. Per new order (sorted by order number for a stable lock order):
   `INSERT ... ON CONFLICT (channel_id, channel_order_no) DO NOTHING RETURNING id`. Nothing
   returned means someone created it since the plan: treated as a digest mismatch (roll back,
   re-preview), never a check-then-write. Then `order_items`, then the shared
   `decrementStockForOrderItems` (exported from `lifecycle.ts` for this, sorted by SKU, row-locked,
   `unit_cost` locked), then forward transitions through `transitionOrderStatus(orderId, to,
   actorStaffUserId, tx)`. New orders get `created_by_staff_user_id = null`, `import_batch_id`,
   `order_no` from `generateOrderNumber` (advisory-locked per month), `buyer_username`,
   `shipping_address`, `notes`, all contact columns NULL.
5. Per existing order: `SELECT ... FOR UPDATE`, re-check against the plan, then:
   - status: forward transitions as above;
   - `discount_amount` (seller voucher) and `total_amount`: one conditional `UPDATE ... WHERE id =
     $1 AND discount_amount = $planned_before RETURNING`; zero rows = drift = roll back;
   - fees: `INSERT ... ON CONFLICT (order_id, component) DO UPDATE SET amount = excluded.amount`;
     a component that disappeared from the file is left as is (a missing column must not zero a
     real fee);
   - `channel_status`, `channel_synced_at`.
6. One `import_batch_orders` row per created/updated order; one `audit_log` row per order
   (`action: "import_create"` / `"import_update"`, `entity_type: "order"`, before/after of the
   fields that changed plus `importBatchId`), and one `audit_log` row for the batch (`action:
   "import_commit"`, `entity_type: "import_batch"`, the summary counts). `transitionOrderStatus`
   writes its own transition rows as usual.

**What re-import may change, and what it may not**:

| Field | Re-import | Why |
|---|---|---|
| Status | forward only (section 3) | Lifecycle rules. |
| Seller voucher (`discount_amount`, `total_amount`) | yes, any status | No stock effect; Shopee can adjust it. |
| Fees | yes, any status, upsert per component | Fees settle after the order completes. |
| `channel_status`, `channel_synced_at` | yes | Display. |
| `order_date` | **no**; a different value shows as a warning | Moving an order between days silently would rewrite past Ringkasan figures. |
| Lines (SKU set, qty, `unit_price`) | **no**; any difference -> Perlu dicek "Item di marketplace berbeda dengan yang tercatat", order not touched (decision 6) | Lines are locked once stock left (`updateOrderItems` rule); the fix is a person's call. |

**Unchanged**: an existing order whose status target, voucher, fees and raw status all equal what
is stored is "Tidak berubah" and is not written at all (no `updated_at` churn, no history row).

## 7. Stock effects

All through the existing ledger, never a direct write:

- New order reaching `to_ship` or later: one `sale` movement per line (`decrementStockForOrderItems`),
  `unit_cost` locked at that moment from the SKU's moving average. Movements carry
  `created_by_staff_user_id = uploader`.
- `-> cancelled` / `-> returned`: `restoreStockForOrderItems` inside `transitionOrderStatus`: one
  `return` movement per line valued at the exact negation of its sale; the active thank-you card is
  voided in the same transaction.
- `Dalam Pengembalian`: no stock effect until the return is final (decision 3).
- `stock_movements_type_ref_unique_idx` guarantees one sale and one return per line, so a retried
  or overlapping import can never move stock twice.
- Web stock holds are not consulted (SPEC §5.2: marketplace paths check physical stock only).
- **Short stock**: today's ledger refuses a sale below 0. The planner checks
  `physical stock - sum(qty of this file's earlier new orders for the SKU)` per SKU and puts an order
  that would go below 0 in **Perlu dicek** ("Stok POKA-FZ-SAGE-M di admin tersisa 1, pesanan butuh
  2"), with a link to `/stock?q=SKU`. The rest of the file still saves. Once the owner records the
  missing stock (receipt, adjustment), the next upload (files overlap) picks the order up (decision 2).

## 8. Unknown SKUs and other "Perlu dicek" reasons

An order is imported **whole or not at all** (owner decision 1). If any line's SKU is unknown,
the whole order waits in Perlu dicek with the unknown SKU, the product/variant name from the file
(display only, not stored) and the row numbers. Reasons:

- A partial order has wrong totals: the voucher and fees are per order and cannot be split
  honestly across the missing line.
- Lines are locked once stock left, so the missing line could never be added later; the order would
  stay wrong forever.
- The fix is fast and visible: correct the SKU on Shopee (or add the variant in admin), upload
  again. Overlapping daily files make the retry free.

Every Perlu dicek reason, all of which keep the order out of this Simpan:

| Reason (Indonesian label in the UI) | Fix |
|---|---|
| SKU tidak dikenal | Set the Shopee "Nomor Referensi SKU" to the admin SKU, or create the variant. |
| Stok tidak cukup | Record the stock (`/stock`, receipt), upload again. |
| Status belum dikenal | Tell the technical admin; the status is added to the map. |
| Nilai antar baris berbeda | Check the file; usually a mapping issue. |
| Item berbeda dengan yang tercatat | Decide by hand on the order page. |
| Status admin sudah final (Dibatalkan/Retur) tapi marketplace berbeda | Decide by hand. |
| Baris tidak valid (angka, tanggal, nomor pesanan) | Row number and column are shown. |
| Pemetaan kolom belum diverifikasi (whole file, not one order) | Verify the real header, flip the adapter constant (section 2.1). |

### 8.1 Manual SKU match ("Cocokkan ke varian", owner addition A)

Matching is **by SKU only**. Product and variation names from the file are never compared with
admin names (they always differ); they are shown next to an unknown SKU only so a person can
decide.

- Each unknown SKU in the preview (grouped: one entry per distinct unknown SKU, with every order
  and row it appears in) offers **Cocokkan ke varian**: a search picker over admin variants
  (product, colour, size, SKU; active first; reuses the order form's variant search).
- A match applies to **this import only**: it is sent with Periksa file / Simpan as
  `skuOverrides: { [fileSku]: adminSku }`, re-validated on the server (the admin SKU must exist),
  and folded into the plan and its digest. It changes nothing on the marketplace and is not
  remembered for the next upload (the lasting fix is correcting the marketplace SKU, which the
  preview says: "Perbaiki SKU di Shopee supaya impor berikutnya cocok otomatis.").
- Picking a match re-runs the preview (the order may now be ready, or now short of stock).
- On Simpan, each override used writes one `audit_log` row (`action: "import_sku_match"`,
  `entity_type: "import_batch"`, `after: { fileSku, adminSku, orderNos }`) and is listed in the
  batch `summary`, so the history shows which orders were matched by hand.
- Overrides are only accepted for SKUs the file actually contains and that are unknown; an override
  for a known SKU is refused (it would silently re-route a correct line).

## 9. Ringkasan, Per kanal and net profit

- **Omzet / laba kotor**: no change to `revenue-sql.ts`. An imported order counts exactly like any
  other: status in `to_ship`/`shipped`/`completed`, dated by `order_date` (Waktu Pesanan Dibuat, in
  Asia/Jakarta). Omzet = goods charged - seller voucher (`subtotal - discount`), ongkir out,
  platform fees **not** subtracted (SPEC §6). Laba kotor = omzet - sum(qty x locked `unit_cost`). A
  marketplace cancel/return drops the order from its original date, as for every channel.
- **Belum Bayar** orders are never imported, so they never count. Shopee COD orders in Perlu Dikirim
  count (the sale has happened, stock left), same as every `to_ship`.
- **Per kanal**: Shopee and TikTok Shop appear from `channels.name` with no code change. Manual
  Shopee orders and imported ones are the same channel, one bar.
- **Net profit** (new, finance only, last session, owner decision 8): "Laba setelah biaya
  platform" = laba kotor - `sum(order_channel_fees.amount)` over the counted orders. **No 18%
  assumption, never an estimate.** A counted marketplace order (`shopee`/`tiktok`) with no fee rows
  adds 0 and is counted in a note "Biaya platform belum lengkap untuk N pesanan" (same idea and
  styling as "HPP belum lengkap"). Web and other non-marketplace channels have no platform fee and
  never count as incomplete. One SQL fragment `orderPlatformFeeSql()` (plus
  `orderPlatformFeeMissingSql()`) in `revenue-sql.ts`, so the definition lives in one place.
  `seller_shipping_subsidy` counts as a platform cost here. Shipping subsidy of web orders and ad
  spend stay out (dashboard plan §11). SPEC §6's "until the payout arrives, use the 18%
  marketplace-fee assumption" is replaced by this rule in session 6.
- Imported `to_ship` orders show in Packing and in "Siap Kirim" on Ringkasan, like manual Shopee
  orders today; a late upload can make them look late there (decision 12).

## 10. Library, limits and file safety

**Decided: SheetJS Community Edition `xlsx` 0.20.3, vendored as a tarball** (owner decision 8).
`apps/admin/vendor/xlsx-0.20.3.tgz`, downloaded once from the official
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, sha256
`8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`, depended on as
`"xlsx": "file:vendor/xlsx-0.20.3.tgz"` in `apps/admin/package.json`; pnpm records the tarball's
integrity in `pnpm-lock.yaml`, so a changed file fails `--frozen-lockfile`. The tarball declares no
dependencies and no install scripts (checked). **No Dockerfile change**: a local
`turbo prune @ammari/admin --docker` (2026-10-24) showed prune copies `file:` tarballs into
`out/json`, so the image's install step finds it. `apps/admin/vendor/README.md` records the source
URL, hash and the upgrade steps. Only `apps/admin` depends on it; `apps/web` never carries it.
Before session 4/5 imports the parser into a server action, check `next build` bundles it (add it to
`serverExternalPackages` if it does not).

- One library reads `.xlsx` (and could read `.xls`), pure JS, **no runtime
  dependencies**, Apache-2.0. Seller Center files are machine-generated and occasionally odd;
  SheetJS is the most tolerant parser.
- **Never the npm-registry `xlsx@0.18.5`**: it is abandoned on npm and has published advisories
  (prototype pollution CVE-2023-30533, ReDoS CVE-2024-22363), fixed only in the SheetJS-hosted
  0.19.3+/0.20.x builds. SheetJS publishes only on its own CDN; vendoring the tarball keeps the
  Docker build independent of that CDN and makes the exact bytes reviewable. Cost: `pnpm audit` and
  Renovate do not watch it; a note in `docs/runbooks/` lists it for a manual check each release.
- Alternative considered: ExcelJS 4.4 (npm, streaming reader). Rejected: no CSV in the same API
  path, many transitive dependencies (larger supply-chain surface), slow maintenance.
- Server only (`import "server-only"`), never shipped to the browser; the browser sends the raw file.

Read options: `cellFormula: false`, `cellHTML: false`, `cellStyles: false`, `cellDates: false`
(dates parsed by our own code), `dense: true`, `sheetRows: 20_001`, first sheet only (or the sheet
whose header row matches; other sheets ignored). Formulas are never evaluated; only cached values
are read.

Limits and guards (all before or during parsing, all with Indonesian messages):

| Guard | Value | Message |
|---|---|---|
| File size | 10 MB (server-checked; `bodySizeLimit` stays 12 MB) | "File terlalu besar (maks. 10 MB). Export per rentang tanggal yang lebih pendek." |
| Type | `.xlsx` (zip magic `PK\x03\x04` + `[Content_Types].xml` and `xl/workbook.xml` inside) or `.csv` (not zip/OLE, strict UTF-8, no NUL), by extension **and** content. Legacy `.xls` and password-protected workbooks (OLE `D0 CF 11 E0`) are refused with "simpan sebagai .xlsx"; this keeps SheetJS's legacy and decryption parsers out of reach. CSV is parsed by our own RFC 4180 reader (`parseCsv`), every value kept as text | "Format file tidak didukung." |
| Zip bomb and reader differentials (xlsx) | `zip-guard.ts` walks the zip itself, requires every local header to match its central header (method, flags, name bytes, sizes unless a data descriptor), refuses zip64 / multi-disk / encryption / duplicate names / an end record not ending the file, inflates each entry once under `maxOutputLength` (<= 80 MB per entry, <= 100 MB total, <= 100 entries, real size must equal declared), then hands SheetJS a **freshly built stored-only zip of those checked bytes, never the upload**. Session 1 security review H1: a central "stored" header over a local "deflate" bomb passed an earlier check-only guard because SheetJS trusts local headers; rebuilding removes the disagreement | "File tidak bisa dibaca dengan aman." |
| Rows | <= 20.000 data rows | "Terlalu banyak baris (maks. 20.000)." |
| Orders | <= 5.000 orders per file | same advice |
| Cell text | cells truncated at 1.000 chars before use | |
| Time | measured in session 1 (parse only, synthetic Shopee-shaped files, laptop): 348 rows / 69 KB in 19 ms; 20.000 rows / 3,4 MB in 438 ms. Parsing is synchronous; if session 4 sees the event loop blocked noticeably on big files, move it to a worker thread | |

Volume context: about 300 orders a month (SPEC §1); a daily export with a few days of overlap is a
few hundred rows; a full quarter is about 1.000 to 1.500 rows. Memory for a 10 MB file is bounded
by the guards above.

Privacy: the reader returns whole rows, but the grouping reads only the cells of mapped columns,
so buyer data never reaches an order object, the planner, the preview payload, logs or error
messages (asserted by a test on the serialized parse result). Later sessions must never put the
reader's raw rows into a result, an error or a log. Errors cite row numbers and our own column names only. The uploaded bytes live only in the
request's memory.

## 11. Preview and history UI (`/import`)

Indonesian text, no em dash, CardList on phones and TableContainer from `md` up (both asserted in
e2e). Mostly used on a laptop, fully usable at 390 px.

```
Impor pesanan marketplace
Unggah file export Pesanan dari Seller Center. Data pembeli tidak disimpan.

Kanal   (o) Shopee   ( ) TikTok Shop
File    [Pilih file]  pesanan-2026-10-24.xlsx (182 KB)
        [Periksa file]

--- after Periksa file ---
Ringkasan file: 214 baris, 131 pesanan, 22 Okt 2026 sd 24 Okt 2026
[Baru 38] [Diperbarui 12] [Tidak berubah 74] [Perlu dicek 4] [Dilewati 3]
Pesanan baru: 41 pcs, omzet Rp9.872.000, voucher Rp120.000, biaya platform Rp1.204.500   (finance only)

Perlu dicek (4)  -- open by default, never saved this time
  2410229ABC  SKU tidak dikenal: POKA-FZ-SAGEE-M (Gamis Poka, Sage, M), baris 17
  2410228XYZ  Stok tidak cukup: POKA-FZ-SAGE-L tersisa 0, butuh 1   [Lihat stok]
  ...
Baru (38)          collapsible list: no. pesanan, tanggal, status, pcs, omzet*
Diperbarui (12)    per order: "Dikirim -> Selesai", "Biaya layanan Rp0 -> Rp4.500"
Tidak berubah (74) collapsed, count only
Dilewati (3)       Belum Bayar 2, Batal sebelum tercatat 1

[Simpan 50 pesanan]     (disabled when 0; Perlu dicek never blocks the rest)
```

- After Simpan: success notice "50 pesanan disimpan (38 baru, 12 diperbarui). 4 pesanan perlu dicek
  dan belum disimpan." and the history list refreshes.
- **Riwayat impor** below: date/time, kanal, file name, uploader, counts; a row opens the batch
  detail (`/import/[id]`) listing its `import_batch_orders` with links to each order.
- Order detail page: a small "Marketplace" block for imported or matched orders: raw status,
  last synced, and (finance only) the fee rows. "Retur di marketplace" badge when
  `marketplace_return_pending` is set; the Perlu perhatian filter picks it up.
- Money totals and fees only with `finance.view_profit`; counts, statuses, SKUs for anyone with
  `orders.import`.
- TikTok selected: the refusal message from section 2 shows after Periksa file.
- Shopee while `SHOPEE_MAPPING_VERIFIED = false`: the full preview shows, with the lock notice above
  the Simpan button, which stays disabled; the server refuses too.
- Unknown SKUs: "Cocokkan ke varian" per distinct SKU (section 8.1).
- Leaving the page with an unsaved preview: `use-unsaved-changes-guard` prompt.

### 11.1 Daftar SKU (`/stock/sku-list`, owner addition B, session 1)

For filling the variant SKU field ("Nomor Referensi SKU") of Shopee/TikTok listings.

- Permission `stock.view` (it shows stock; the owner holds it). Linked from the Stok page header
  ("Daftar SKU").
- Columns: Produk, Warna, Ukuran, SKU, Status (Aktif / Nonaktif), Stok (physical, the same sum as
  the Stok page). Sorted by product, colour, size. All variants, no pagination (a few hundred rows;
  capped at 5.000 with a notice), search by product name, product code, colour or SKU, filter Aktif /
  Nonaktif / Semua. "Aktif" = the variant and its product are both active. Path `sku-list`, not
  `skus`: `/stock/[sku]` is the SKU detail page, and a lowercase path can never be an (uppercase)
  SKU.
- **Unduh CSV**: route handler `GET /stock/sku-list/export` (same filters), `stock.view` checked in
  the handler, `text/csv; charset=utf-8` with a BOM (Excel opens UTF-8 correctly), comma-separated,
  RFC 4180 quoting, `Cache-Control: no-store`, filename `daftar-sku-YYYY-MM-DD.csv` (Jakarta date).
  Formula-injection safe: a cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`.
- **Salin tabel**: copies the visible rows as tab-separated text (pastes into Google Sheets or Excel
  as columns regardless of locale), and **Salin SKU** copies only the SKU column, one per line.
- CardList on phones (product + colour/size, SKU large and selectable, stock), table from `md`.

## 12. Permissions and security

- Page, `previewImport`, `commitImport`, batch history and detail: `orders.import`, checked on the
  server in every action (not only the page). Fee and money fields in the preview and order detail:
  `finance.view_profit`, enforced in the query layer (never returned otherwise).
- Customer sessions cannot reach any of it (admin app only, existing middleware).
- No new secrets, no external calls.
- `security-reviewer` and `silent-failure-hunter` review the parser and commit sessions (CLAUDE.md:
  import code). Specific things to hunt: a skipped row that is not reported, a missing optional
  column silently read as 0, a caught error that lets a partial commit through.

## 13. Owner decisions (2026-10-24) and what is still open

All recommendations were accepted, with the specifics below. The numbers are referenced as
"decision N" in this plan.

1. **Unknown SKU**: the whole order waits in Perlu dicek (section 8), with a manual "Cocokkan ke
   varian" match for this import only (section 8.1).
2. **Admin stock lower than the marketplace sale**: that order goes to Perlu dicek, the rest of the
   file saves (section 7). No negative stock.
3. **"Dalam Pengembalian"**: flag `marketplace_return_pending`; mark `returned` only when the parcel
   is back (by hand on the order page, or a later final return status).
4. **"Batal" on an order already shipped in admin**: `-> returned`, stock restored.
5. **First seen as "Batal" or "Belum Bayar"**: skip.
6. **Lines changed on the marketplace after the first import**: never auto-applied; Perlu dicek.
7. **Fees**: the separate `order_channel_fees` table with a fixed list of fee types.
8. **Library**: SheetJS 0.20.3, vendored tarball, never the npm `xlsx@0.18.5`. **No 18% fee
   assumption**: an order without fee data shows in "Biaya platform belum lengkap untuk N pesanan"
   next to "Laba setelah biaya platform", never estimated (section 9).
9. **"Provinsi / Kota"**: ignored.
10. **Import matching a manually entered Shopee order**: the same order, updated.
11. **Fees** come from the order export for now; the "Penghasilan" (income) export is a later plan.
12. Imported "Perlu Dikirim" orders appear in **Packing** and **Siap Kirim**.
13. **Order date** = "Waktu Pesanan Dibuat", never changed by a later import.
14. **Real header**: the owner will try to export one (brand verification issue on the shop). Until
    then Shopee Simpan is locked behind `SHOPEE_MAPPING_VERIFIED` (section 2.1); preview works.
15. **Limits**: 10 MB, 20.000 rows, 5.000 orders per file.

Owner additions: **A** matching by SKU only plus the manual match (section 8.1); **B** the Daftar SKU
page and CSV (section 11.1, session 1).

Still open (none blocks sessions 1 to 3):

- **O1. Real Shopee header** (decision 14): needed to unlock Simpan; also confirms whether the order
  export carries Biaya Administrasi / Biaya Layanan (decision 11) and the scope of each money
  column (section 4).
- **O2. Per-item partial cancels/returns on Shopee**: if they happen for this shop, a follow-up adds
  a partial return path (decision 6 keeps them in Perlu dicek until then).
- **O3. TikTok header**: one real export header row, no buyer data.

## 14. Tests

TDD (unit first) for the parser, planner and stock paths; integration tests against the test
database (`ammari_test`, via the existing vitest global setup), never `ammari`; e2e for the pages.
All spreadsheet fixtures are **generated in test code** (`test-fixtures.ts` builds xlsx/csv bytes
with SheetJS `write` from arrays) with invented order numbers, SKUs and obviously fake buyer
columns; no real export and no binary fixture is committed. The e2e upload (session 5) writes its
fixture to a temp file from the same builder.

**Parser (unit, session 1)**
1. Header found on row 1 and on row 3 (title rows above).
2. Aliases: Indonesian and English headers map to the same fields; trailing `(Rp)` ignored.
3. Missing required column: message lists every missing one by its Indonesian name.
4. Ambiguous header (two columns match one field, or one column matches two fields): error.
5. Buyer columns present in the fixture never appear in any parser output (assert on the
   serialized output for the fixture's fake names/phones/addresses).
6. Money: `249000`, `"Rp 249.000"`, `"249.000,00"` ok; `"249,5"`, `-1`, `1.5`, `"abc"` row errors.
7. Dates: text and Excel serial both give the right UTC instant; 23:30 Jakarta stays that date.
8. Formula cells: cached value used, formula never evaluated; a `=cmd|...` text is refused by the
   order-number pattern.
9. Guards: >10 MB, wrong magic bytes, zip with a huge declared uncompressed size, >20.000 rows,
   >5.000 orders.
10. CSV with BOM, `;` and `,` delimiters.
11. TikTok adapter refuses with the Indonesian message before reading rows.
12. Channel mismatch (Shopee picked, TikTok-shaped headers) refused. (Until the TikTok mapping
    exists, the check uses the Shopee signature: a file without it is refused as "not a Shopee
    order export".)
13. Shopee mapping lock: `parseFile` reports `mappingVerified: false` and the lock message.
13a. (Review) Zip reader differentials: central "stored" over local "deflate", local/central name
     mismatch, a fake end record after the real one; a 15-digit numeric order number is the limit;
     CSV blank lines keep row numbers, text after a closing quote is refused, the delimiter is taken
     from the header line below a title; a row of a multi-item order without an order number is a
     save blocker; a status that normalizes to nothing is invalid; the return flag survives an
     older file.

**Grouping and double count (unit, session 1)**
14. 3 rows, one order: voucher and fees repeated on each row counted once.
15. Order-level value only on the first row, blank on the rest: counted once.
16. Order-level value differs between rows: order -> Perlu dicek.
17. Same SKU on two rows: merged, qty summed, weighted-average `unit_price`, rounding diff reported.
18. Line-scope fee (a test-only adapter): summed.
19. Voucher > subtotal: order error.
20. Product/variation names are kept only as display hints and never used to resolve a SKU.

**Status rules (unit, session 1)**
21. Every row of the section 3 table: new and existing, each current status.
22. Unknown status -> Perlu dicek. Backward target -> unchanged. Terminal admin + live marketplace ->
    Perlu dicek.

**Daftar SKU (session 1)**
23. CSV builder (unit): header, RFC 4180 quoting (comma, quote, newline), BOM, formula-injection
    prefix for `=`, `+`, `-`, `@`, tab, CR.
24. Query (integration): every variant with product, colour, size, active, physical stock; search
    and active filter; sort order.
25. Export route: refuses without `stock.view`; headers (`text/csv`, `no-store`, filename).
26. E2E `apps/admin/e2e/sku-list.spec.ts` at 390 px and 1280 px: rows visible in the matching
    layout, search, Unduh CSV downloads a file with the seeded SKU, Salin SKU puts the SKUs on the
    clipboard.

**Planner (integration, session 3)**
27. New / updated / unchanged / Perlu dicek / dilewati counts for a mixed file.
28. Unknown SKU holds the whole order; other orders unaffected.
29. Manual SKU match: the matched order becomes ready; an override for a known SKU or a non-existent
    admin SKU is refused; the override changes the digest.
30. Stock short: the cumulative check within one file (two new orders on a SKU with stock 1: first
    ok, second Perlu dicek).
31. Manual order with the same number (different case/spaces) is matched.
32. Nothing is written: row counts of every touched table identical before and after preview.

**Commit (integration, TDD: stock, session 4)**
33. New `Selesai` order: one order, lines, one `sale` per line, `unit_cost` locked, status
    `completed`, `completed_at` set, batch + `import_batch_orders` + audit rows.
34. Same file committed twice: second is all unchanged; no extra movements, orders or fee rows.
35. Overlapping file with a status change `to_ship -> Batal`: `cancelled`, one `return` per line
    valued at the sale's negation, active card voided.
36. `shipped` + Batal -> `returned`, stock restored.
37. Dalam Pengembalian: no movement, flag set; later final return status -> `returned`, flag cleared.
38. Voucher and fees updated on re-import; a missing fee column does not zero stored fees.
39. Manual SKU match: one `import_sku_match` audit row per override, listed in the batch summary.
40. Digest drift (stock adjusted between preview and Simpan): nothing written, fresh preview
    returned.
41. Two concurrent commits of overlapping files: no duplicate orders, no double stock movement,
    the loser gets a re-preview.
42. A failure in the middle (forced error on order N): whole transaction rolled back, no batch row.
43. Shopee lock: `commitImport` refuses while `SHOPEE_MAPPING_VERIFIED = false` (server side).
44. Permission: `previewImport`/`commitImport` refuse without `orders.import`; money fields absent
    without `finance.view_profit`.

**Ringkasan (integration, session 6)**
45. Imported orders appear in omzet, laba kotor, Per kanal (Shopee) on their `order_date`; a
    cancelled one drops out.
46. "Laba setelah biaya platform" subtracts fee rows; a counted marketplace order without fee rows
    adds 0 and is counted in "Biaya platform belum lengkap untuk N pesanan"; web orders never are.

**E2E `apps/admin/e2e/marketplace-import.spec.ts` (session 5, 390 px and 1280 px)**
47. Upload fixture -> preview counts and Perlu dicek list visible in both layouts -> (with the lock
    off in the test build, or asserting the lock notice while it is on) Simpan -> success notice ->
    history row -> order visible in `/orders` with channel Shopee.
48. Upload the same fixture again -> all "Tidak berubah", Simpan disabled.
49. Unknown SKU -> Cocokkan ke varian -> the order moves to Baru.
50. TikTok selected -> refusal message. Missing-column fixture -> message names the column.

## 15. Session split

One feature per session, each committable on its own.

| # | Session | Output | Reviewers |
|---|---|---|---|
| 0 | Owner, no code | Decisions recorded (section 13). Real Shopee header pending (O1). | |
| 1 | Reader + adapters + Daftar SKU | Vendored SheetJS, `read-sheet`, zip guard, headers, values, grouping, status rules, Shopee adapter (locked) and TikTok adapter (refuses), `parseFile`, the synthetic fixture builder; Daftar SKU page, CSV export, copy. Tests 1 to 26. No DB schema change, no import UI yet. | typescript, security, react |
| 2 | Migration 0040 | Schema + constants (section 5), generated SQL read and reviewed, migrate on local and test DBs | database |
| 3 | Planner (read-only) | `plan.ts`, manual SKU overrides, digest; tests 27 to 32 | typescript, database, silent-failure |
| 4 | Commit (TDD, stock) | `@ammari/commerce` `commit.ts`, export of the shared stock helpers from `lifecycle.ts`, `previewImport` / `commitImport` server actions with permission checks and the Shopee lock; tests 33 to 44 | typescript, database, security, silent-failure |
| 5 | `/import` UI + history + order detail block | Page, preview, Cocokkan ke varian, Simpan (locked notice), history, batch detail, attention badge; e2e 47 to 50 at 390 and 1280 | react, typescript |
| 6 | Ringkasan net profit + docs | `orderPlatformFeeSql`, the "belum lengkap" note, tests 45 and 46; SPEC §3.1, §5.2, §6, Status updated | typescript, database |
| 7 | Shopee unlock (when O1 arrives) | Check aliases/scopes against the real header, flip `SHOPEE_MAPPING_VERIFIED`, adjust the lock tests | typescript |

TikTok mapping later: one small session once a real header is in hand (adapter `columns`, status
map, tests 11/12 flipped to "accepts", one e2e run).

## 16. Out of scope

- Shopee/TikTok **income** (Penghasilan) export into `order_settlements` and actual-payout profit.
- Courier/resi import, buyer data of any kind, regional reports.
- Partial (per-item) cancels/returns from the marketplace (O2).
- Negative stock (decision 2).
- Remembering manual SKU matches across imports (decision A: this import only).
- Any marketplace API (Open Platform) integration; this is file upload only.

## 17. Session notes (4 and 5)

- **Owner, 2026-10-25**: "Dalam Pengembalian" on an admin order still `to_ship` moves it to
  `shipped` AND sets `marketplace_return_pending` (section 3 table updated; the session 1 status
  rules already did this).
- **Where the commit lives.** The planner needs the parser, so it stays in apps/admin; the write
  path is `@ammari/commerce/marketplace-import` (`commitMarketplaceImport`). It opens the
  transaction, takes the channel advisory lock and calls back into the admin (`replan(tx)`), which
  plans again with the transaction's reads and decides: save blockers (enforced on their own, the
  digest does not cover them), digest equal to the preview's, something to write. Only then does
  the commerce module write. `lib/marketplace-import/commit.ts` is the admin side.
- **Re-check under the row lock.** Each update carries `expected` (status, voucher, total,
  `channel_status`, return flag, lines as the planner read them); the locked row must match it, and
  every money write is conditional (`discount_amount`/`total_amount`, each fee row `amount = before`
  or insert-if-absent). Any mismatch, an `INSERT ... ON CONFLICT DO NOTHING` that returns nothing, a
  stock sale refused, or a transition refused is drift: the whole transaction rolls back and the
  owner gets the fresh preview with "Data berubah sejak pemeriksaan".
- `decrementStockForOrderItems` is exported from `lifecycle.ts`; `transitionOrderStatus` to
  `cancelled`/`returned` now clears `marketplace_return_pending` (rule 3a).
- **History rows** (`import_batch_orders.changes`) and the batch `summary` carry money; the history
  queries (`history.ts`) null it for staff without `finance.view_profit`. The preview payload is an
  allowlist (`preview-view.ts`), money filled only for finance staff.
- **E2E unlock.** `SHOPEE_MAPPING_VERIFIED` stays `false`. The import actions honour the cookie
  `e2e_marketplace_mapping_verified=<channel>` only when `NODE_ENV !== "production"` and
  `E2E_TEST_LOGIN=true` (`e2e-unlock.ts`, same gate as the e2e sign-in backdoor); the save-path e2e
  sets it on its own browser context. The fixture goes to the file input as an in-memory buffer
  (no temp file).
- "Hapus tanda retur" reuses the audited `clearAttentionFlag`; the Perlu dicek panel on the order
  page now shows for any order with a flag (it was checkout-only), and the order list's "Perlu
  dicek" badge too.
- **Locks (review).** Before any write the commit locks every touched order (`ORDER BY id FOR
  UPDATE`) and then every touched SKU (sorted), the same order the other stock paths use, under a
  10 s `lock_timeout`; a lock timeout or deadlock rolls back and shows "Sebagian data sedang dipakai
  proses lain ... Coba simpan lagi". Measured locally: 300 Selesai orders (600 lines) commit in
  about 4,5 s; the per-month `ORD-` number lock is held for that long, so a manual order or web
  checkout placed during a Simpan waits for it.
- Known gap, not fixed: a manual Shopee order typed in lowercase between the in-transaction plan and
  the insert would not hit the exact unique key (the planner's match is case-insensitive). The
  window is the length of one transaction; uppercasing marketplace numbers in `createOrder` would
  close it.

