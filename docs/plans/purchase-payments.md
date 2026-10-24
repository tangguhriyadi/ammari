# Plan: Supplier payments with mandatory proof (Pembelian + Produksi)

Status (2026-10-24): **Approved.** Owner answers recorded in §12 (A1 to A10); nothing open.
S1 (database + status logic) committed (`ee30ed7`). S2 (private storage, file processing, viewing
route) implemented, awaiting review and commit.

Record every rupiah paid to a supplier or tailor against the document it settles, with a proof
file that can never be quietly changed or removed, so the books can be audited later. Scope is
purchase documents (bahan, aksesoris) and production batches' service costs. Ads and other
expenses come later with "Iklan & Biaya" and are **not** built here.

Admin only. The storefront (`apps/web`) is untouched.

---

## 1. What exists today (verified against the code)

**Purchases.** `purchases` + `purchase_items` (migration 0024). A line stores `qty_ordered` and
`total_amount` exactly as typed, ongkir included (suppliers-goods-receipt D6). No payment concept
anywhere; `/purchases` shows the sum as "Total dibayar", but that is the *agreed amount*, not money
that moved. Statuses: `ordered`, `partially_received`, `received`, `closed`, `cancelled`
(`apps/admin/src/lib/purchases/status.ts`). Lines are editable only while `ordered` with no
receipt (`updatePurchase` deletes and reinserts the lines; trigger
`prevent_received_purchase_item_change` freezes a received line). Purchases are never deleted (no
delete path). A short-close with partial receipts gives `closed`; a close with nothing arrived
gives `cancelled` (D19).

**Production.** `postBatch` (`lib/production/queries.ts:714`) computes
`totalCost = fabricCost + accessoryConsumption + Σ production_batch_costs.total`. Crucially,
**fabric and accessory cost is not money owed to anyone for this batch**: it is the moving-average
value of material consumed from stock, material that was already bought (and is paid) through a
purchase document. Only `production_batch_costs` lines (ongkos jahit, finishing, other services)
are money owed *because of* the batch. Each such line carries its own `supplier_id` +
`supplier_name` snapshot (D9), so one batch can owe tailor A for sewing and B for finishing. Lines
are frozen once posted (`prevent_posted_batch_cost_mutation`, migration 0007). Drafts can be
deleted (`deleteDraft`, cascade).

**Suppliers.** `/suppliers` list + detail; no payable view (D28 deliberately kept
`purchases.supplier_id` and `production_batch_costs.supplier_id` so one can be built now).

**RBAC.** No payment permission. `finance.view_profit` gates every amount on purchases and batch
costs today (`stripPurchaseAmounts`, `getBatchCosts`). `inventory.view` / `inventory.manage` /
`inventory.receive` / `production.manage` gate the pages and actions. Default roles: `super_admin`
gets every key; `owner` every key except `roles.manage`, `staff.manage`, `audit_log.view`.

**Audit log.** `writeAuditLog(tx, { actorStaffUserId, action, entityType, entityId, before, after })`
(`packages/commerce/src/db.ts:14`), plain verbs (`create`, `close`, `receive`, `reverse`).
`audit_log` itself has no immutability trigger.

**Storage.** `packages/storage`: `put/get/delete/publicUrl`, S3 client with
`Cache-Control: public, max-age=31536000, immutable` on every put. Both media buckets
(`ammari-dev`, `ammari-prod`) are **public as a whole** through custom domains
(`img.ammari.my.id`, `img.ammari.id`); R2 has no per-prefix privacy, so *nothing private may ever
be written into them* (storage-r2.md). No presigner installed. e2e uses `STORAGE_DRIVER=memory`;
local dev uses the real dev bucket with `S3_KEY_PREFIX=local/`. One R2 token per bucket, scoped
"Object Read & Write" to that bucket only.

**Image pipeline.** `sharp` 0.35.5 in the admin server
(`lib/products/image-processing.ts`): magic-byte sniff (JPEG/PNG/WebP only), 10 MB cap, 40 MP
limit, `.rotate()` then metadata stripped (no `withMetadata`), WebP variants. Client-side
downscale to 2400 px (`client-image-resize.ts`). Upload is a server action with FormData;
`serverActions.bodySizeLimit: "12mb"`. **No HEIC decoder** (prebuilt libvips has none); the file
pickers use `accept="image/jpeg,image/png,image/webp"` so iOS transcodes HEIC to JPEG on pick.

**Name clash to avoid.** `payments` already exists (Midtrans checkout attempts). Everything here is
named `supplier_payments`.

---

## 2. Decisions (proposed; owner decisions from the brief marked [owner])

| # | Decision |
|---|---|
| P1 | [owner] Scope: purchase documents and posted production batches. No ads/misc expenses. |
| P2 | [owner] A payment: date, amount (IDR integer), method `cash`/`transfer` (Tunai/Transfer), **required** proof file, optional note, recorded_by, recorded_at. Many per document (DP, pelunasan). |
| P3 | [owner] Payment status is **derived, never stored**: Belum bayar (paid = 0), DP (0 < paid < tagihan), Lunas (paid = tagihan). A payment above the remaining balance is refused. One extra derived label, **"Tanpa tagihan"**, when tagihan = 0 (a batch with no service lines, a free-sample purchase), so a Rp 0 document never shows as "Belum bayar" forever. |
| P4 | [owner] Receiving goods and stock are independent of payment. No receipt/stock code changes. |
| P5 | [owner] Existing documents become "Belum bayar" by derivation (no rows, no backfill). No retroactive proof. |
| P6 | [owner] Append-only: no edit, no hard delete; a wrong payment is **voided** with a required reason, stays in history labelled "Dibatalkan" (struck through), and stops counting. Enforced by a trigger. Every record/void writes an audit entry. |
| P7 | Proofs live in a **separate private R2 bucket** and are only ever served **through an admin route handler** that checks the permission on every request (§5). No public URL, no shareable link. |
| P8 | Images are re-encoded server-side to JPEG, long edge ≤ 2000 px, EXIF/GPS stripped after auto-orient (§6). PDFs stored as-is, ≤ 10 MB. Proof files are never deleted by code: the private storage client has **no delete method**. |
| P9 | [owner A3] "Utang" per supplier = Σ remaining over that supplier's non-cancelled purchases **plus** its share of posted batches' service lines. |
| P10 | New permission `supplier_payments.manage` (§7). |
| P11 | [owner A1, A2] **Tagihan (amount due) definition**, §3. Purchases: order total, except a short-closed document is due only for what was settled. Production: Σ service lines of a **posted** batch, per payee. |
| P12 | A payment names its **payee** (`supplier_id` + name snapshot). For a purchase it is always the purchase's supplier. For a batch it is one of the suppliers on its service lines (or "Tanpa pemasok" for unattributed lines), and the cap applies **per payee**, so overpaying the tailor while the finisher is unpaid is refused. |
| P13 | The optional supplier invoice (nota) is a separate **attachment** table, many per purchase, same append-only + void rule, same private storage. Not required, never blocks anything. |

---

## 3. How "tagihan" (total due) is defined

### 3.1 Purchases

```
orderTotal(p)   = Σ purchase_items.total_amount
tagihan(p)      = orderTotal(p)                                   status ordered / partially_received / received
                = Σ_line cumulativeValue(total_amount, qty_ordered, qtySettled(line))   status closed   (A1)
                = 0                                               status cancelled (nothing arrived)
paid(p)         = Σ supplier_payments.amount  where purchase_id = p and voided_at is null
remaining(p)    = tagihan(p) - paid(p)
```

`qtySettled` (suppliers-goods-receipt §4.2) and `cumulativeValue` (`lib/receipts/valuation.ts`,
the function every receipt slice is built from) are reused, so "what a closed document is worth"
has one definition. It is computed from the settled quantity, not summed from ledger rows, so it
is deterministic and independent of receipt/reversal history; it matches the booked receipt value
except for at most a rupiah of cumulative-rounding drift after a non-latest receipt was reversed
(valuation.ts `sliceValue` comment). Implemented in S1 as `purchaseTagihan`
(`apps/admin/src/lib/supplier-payments/status.ts`).

Edge cases:

- **Editing lines after a DP.** `updatePurchase` gains one guard, under the same purchase row lock
  it already takes: the new order total may not fall below `paid`. Indonesian error:
  "Total pembelian tidak boleh lebih kecil dari yang sudah dibayar (Rp X)."
- **Closing with money paid.** If the resulting tagihan is below `paid` (cancelled after a DP, or a
  short-close below the DP), the close is still allowed (closing is about goods), the dialog warns
  first, and the document shows **"Lebih bayar Rp X"** instead of a remaining amount. Refunds from
  the supplier are out of scope for now (A4).
- **Changing the supplier after a payment.** Migration 0038's composite FK
  `(purchase_id, supplier_id) -> purchases(id, supplier_id) ON UPDATE RESTRICT` already makes it
  impossible at the DB level (voided payments included: the payee of a record is history). S3 adds
  the friendly guard in `updatePurchase`, under its row lock: if the supplier changes and any
  payment row exists, refuse with "Pemasok tidak bisa diganti karena sudah ada pembayaran."
  instead of surfacing the raw FK error (database review, S1).
- **Defects.** Returns-to-supplier and releases never change `total_amount` (D20), so they never
  change tagihan of an open document. A return re-opens outstanding quantity for a replacement,
  which is paid under the same order total.

### 3.2 Production batches

```
tagihan(b, payee) = Σ production_batch_costs.total  where batch = b and supplier_id = payee   (payee may be NULL)
tagihan(b)        = Σ over payees                    (only when b.status = 'posted'; drafts have no tagihan)
paid(b, payee)    = Σ non-voided supplier_payments for (b, payee)
```

Fabric and accessory consumption are **excluded** on purpose: that value is already owed (and
paid) through the purchase documents that bought the material; counting it again would double the
payable. Lines are frozen at posting, so tagihan never moves after a payment exists. A short-closed
batch keeps its posted tagihan, and there is no "potongan tagihan" record for now (A2).

Payments only against posted batches: a draft's lines (and the batch itself) can still change or
be deleted, and a payment would block or be orphaned by that.

### 3.3 Status (pure function, TDD)

```ts
summarizePayment(tagihan, paid): { tagihan, paid, remaining, overpaid, status: "no_bill" | "unpaid" | "partial" | "paid" | "overpaid" }
// no_bill: tagihan = 0 and paid = 0     -> "Tanpa tagihan"
// unpaid:  paid = 0 < tagihan           -> "Belum bayar"
// partial: 0 < paid < tagihan           -> "DP"
// paid:    paid = tagihan > 0           -> "Lunas"
// overpaid: paid > tagihan              -> "Lebih bayar" badge + "Lebih bayar Rp X" (only reachable via close/edit edge cases above)
```

Badge colours follow the muted palette: Belum bayar = brick (`danger`), DP = `warning`,
Lunas = olive (`success`), Tanpa tagihan = `neutral`, Lebih bayar = `warning`. In S1 overpaid
became its own status (label "Lebih bayar") rather than a "Lunas" badge with a note, so a
cancelled purchase under a DP never reads as settled; the "Lunas" list filter includes it.

---

## 4. Schema (migration 0038, additive only)

### 4.1 `private_files`

One row per stored private object. Immutable.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| purpose | text | CHECK in (`payment_proof`, `purchase_invoice`) |
| storage_key | text unique | `{S3_KEY_PREFIX}{purpose}/{yyyy}/{mm}/{id}.{jpg\|pdf}` |
| content_type | text | CHECK in (`image/jpeg`, `application/pdf`) |
| byte_size | integer > 0 | stored size |
| sha256 | text | of the stored bytes (integrity check on read, optional) |
| original_filename | text | as uploaded, for display/download name |
| original_content_type | text | sniffed, not client-claimed |
| original_byte_size | integer | |
| original_sha256 | text | of the uploaded bytes; used for the duplicate-proof warning (§8) |
| uploaded_by_staff_user_id | uuid not null FK staff_users RESTRICT | indexed |
| created_at | timestamptz | |

Trigger `prevent_private_file_mutation`: rejects every UPDATE and DELETE.

### 4.2 `supplier_payments`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| payment_no | text unique | `BYR-YYYYMM-NNN`, `nextDocumentNumber` (advisory lock, existing helper) |
| target_type | text | CHECK in (`purchase`, `production_batch`) |
| purchase_id | uuid FK purchases RESTRICT | exactly one of the two, agreeing with target_type (same idiom as goods_receipts) |
| production_batch_id | uuid FK production_batches RESTRICT | |
| supplier_id | uuid FK suppliers RESTRICT, nullable | payee. NOT NULL when target_type = purchase (CHECK). NULL only for a batch's unattributed lines |
| supplier_name | text | snapshot, pair check with supplier_id |
| paid_at | date | Jakarta calendar date of the transfer/cash handover; app: not in the future |
| amount | bigint | CHECK > 0 |
| method | text | CHECK in (`cash`, `transfer`) |
| note | text | |
| proof_file_id | uuid **not null** FK private_files RESTRICT, unique | a proof belongs to one payment |
| recorded_by_staff_user_id | uuid not null FK staff_users RESTRICT | |
| created_at | timestamptz | = recorded_at |
| voided_at / voided_by_staff_user_id / void_reason | | `num_nonnulls(...) in (0,3)` and reason non-blank (same idiom as `purchases_reopened_triple_check`) |

Indexes: `(purchase_id, created_at)`, `(production_batch_id, created_at)`, `supplier_id`, both
staff FKs, `paid_at desc`.

Trigger `prevent_supplier_payment_mutation` (shape of `prevent_accessory_movement_mutation`):
DELETE always rejected; UPDATE rejected if already voided, or if anything other than the three
`voided_*` columns changes (`to_jsonb(NEW) - ... IS DISTINCT FROM to_jsonb(OLD) - ...`). So
amount, date, method, payee, proof and note can never change at the DB level.

### 4.3 `purchase_attachments`

`id`, `purchase_id` FK RESTRICT, `file_id` FK private_files RESTRICT unique, `kind` CHECK
(`invoice`), `note`, `created_by_staff_user_id`, `created_at`, `voided_*` triple. Same
append-only trigger as payments.

### 4.4 Reference data in the same migration

```sql
INSERT INTO "permissions" ("key","description","group") VALUES
  ('supplier_payments.manage', 'Catat dan batalkan pembayaran pemasok, lihat bukti bayar', 'finance')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ... WHERE r."key" IN ('super_admin','owner') ... ON CONFLICT DO NOTHING;
```

Plus the key in `packages/db/src/rbac/permissions.ts`.

### 4.5 Backward compatibility (prod `d5c654b`, dev `da8e12a`)

Only new tables, new triggers **on the new tables**, and new reference rows. No existing column,
constraint or trigger is touched. 0038 does not depend on 0037 (dev-only so far); both apply
cleanly in order on prod. The previous release never reads or writes the new tables, so rollback
(redeploy the older image, schema stays) is safe. One known gap during a rollback window only: the
old `updatePurchase` lacks the "not below paid" guard, so a purchase could be edited under its
DPs; after roll-forward it simply shows "Lebih bayar", nothing breaks. And the old image changing
the supplier of a purchase that already has a payment fails on the FK (a 500, no data change);
safe, rare, and only during a rollback window.

### 4.6 Why the balance cap is app-level under a row lock, not a DB trigger

The cap depends on tagihan, which for a closed purchase spans purchase_items, goods_receipt_items
and defect_movements. Re-implementing §3 in plpgsql would create a second definition that can
drift. Instead every writer that can change paid or tagihan locks the **parent row**
(`lockPurchaseForUpdate` / the existing batch lock) first: record payment, void payment (only
lowers paid, still locks for ordering), `updatePurchase`, `closePurchase`, receipts and
returns. Concurrent payments on one document serialize on that lock, so this is not the forbidden
check-then-write race; it is the same pattern the over-receipt rule (D17) uses. The DB still
guarantees the parts it can express locally: amount > 0, one target, payee rules, immutability.

---

## 5. Storage: private bucket, served through the admin

**Proposal (safest):**

1. Two **new private buckets**, `ammari-dev-private` (dev server + developers, prefixes `dev/`,
   `local/`) and `ammari-prod-private`. No custom domain, no r2.dev, never public. Never write a
   proof into the media buckets: those are public as a whole.
2. A **separate R2 API token per private bucket**, "Object Read & Write", scoped to that bucket
   only (the existing one-token-per-bucket rule). The media tokens never see proofs; the private
   token never sees media.
3. New `PrivateStorageClient` in `packages/storage`: `put(key, body, contentType)` with
   `Cache-Control: private, no-store`, and `get(key)`. **No `delete`, no `publicUrl`**, so no
   code path can remove or expose a proof.
4. Viewing: `GET /api/private-files/[fileId]` route handler in `apps/admin`. Per request: staff
   session, permission for that file's purpose (§7), file row exists and is referenced by a
   payment/attachment. Streams the bytes with `Content-Type` from the DB row,
   `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`,
   `Content-Disposition: inline; filename="<payment_no>.jpg"`, and a restrictive CSP. Nothing
   leaves the admin origin, so there is no URL to forward, leak in a screenshot, or keep working
   after a permission is revoked.

   No presigned R2 links (A6): no `@aws-sdk/s3-request-presigner`, and no redirect to R2.
5. Drivers: `PRIVATE_STORAGE_DRIVER=memory` for e2e/tests (refused in production, like
   `STORAGE_DRIVER`); `PRIVATE_STORAGE_DRIVER=fs` for local dev, writing to a gitignored
   `apps/admin/.private-storage/`, so a developer needs no private-bucket secret. Unset means S3.
6. Optional hardening on prod (owner, Cloudflare dashboard): an R2 **bucket lock rule** on
   `ammari-prod-private` (indefinite retention) so even someone holding the token cannot delete or
   overwrite an object. Works with our design since keys are never reused.
7. Upload order: process file, `put` to private storage, then one DB transaction (file row +
   payment row + audit). If the transaction fails (e.g. a concurrent payment took the balance),
   the object stays unreferenced in the private bucket. That is harmless (private, never served:
   the route requires a referencing row) and consistent with "never auto-delete". The form runs
   a read-only pre-check first so this is rare. The `private_files` ROW is inserted only inside
   that transaction, after the parent lock and the cap check, never before or in a separate
   transaction: rows are immutable and undeletable, so an orphan row could never be cleaned up,
   while an orphan object is merely unreachable. Lock order inside the transaction: parent row
   first, then `nextDocumentNumber`'s advisory lock, then the inserts (database review, S1).

**What the owner must set up (no values here):**

| Where | What |
|---|---|
| Cloudflare R2 | Buckets `ammari-dev-private`, `ammari-prod-private`; no public access, no custom domain. Optional bucket lock rule on prod. |
| Cloudflare R2 | Two API tokens, Object Read & Write, each scoped to one private bucket. Save as `~/ammari-secrets/r2-{dev,prod}-private-{access,secret}-key`. |
| Dev admin env (`deploy/env/admin.env`) | `PRIVATE_S3_BUCKET`, `PRIVATE_S3_ACCESS_KEY_ID`, `PRIVATE_S3_SECRET_ACCESS_KEY`. Reuses `S3_ENDPOINT`, `S3_REGION`, `S3_KEY_PREFIX`. |
| Prod admin env (`deploy-prod/env/admin.env`) | Same three. `make-prod-env.sh` gets them from the secret files (code change in S5). |
| Web env | Nothing. The storefront never touches proofs. |
| Backups | [A7] Proofs are copied nightly from `ammari-prod-private` into `ammari-prod-backups` (S5). The backup job then needs read access to the private bucket: either a third token (Object Read only, scoped to `ammari-prod-private`) on the backup host, or the private token. Recommended: the read-only token, so the backup host can never write or delete a proof. |

Code-side (S5): env examples, `turbo.json` env list, `storage:check --private` (put + get), a
go-live check entry. "The private bucket has no public domain" cannot be checked through the S3
API, so it becomes a manual checklist item in `docs/deploy-prod.md`.

---

## 6. File processing

New `lib/supplier-payments/proof-processing.ts` (S2; not `lib/payments/`, which is the Midtrans
checkout code), reusing the product pipeline's sniff/limits:

- **Sniff by magic bytes**, never trust the client type: JPEG, PNG, WebP, PDF (`%PDF-`). HEIC
  (`ftypheic`/`ftypmif1`) is recognized only to give a clear Indonesian error; no HEIC decoder
  library (A5).
- **Images:** `sharp(input, { limitInputPixels: 40e6, failOn: "error" })` -> `.rotate()` (apply
  EXIF orientation first) -> `.resize(2000, 2000, { fit: "inside", withoutEnlargement: true })` ->
  `.toColourspace("srgb")` -> `.jpeg({ mozjpeg: true, quality })`. Quality ladder 82 -> 76 -> 70,
  stopping at the first result ≤ 600 KB (typical receipt photo lands 300 to 500 KB at 82). No
  `withMetadata`, so EXIF/GPS/XMP are dropped. JPEG rather than WebP because auditors and
  accountants open these outside the app.
- **PDF:** stored byte-for-byte, ≤ 10 MB, content type `application/pdf`. Not parsed or rendered
  server-side.
- **Upload limits:** input ≤ 10 MB (both kinds); the client downscales large photos first with the
  existing `client-image-resize.ts` (cap 2400 px) so phone photos stay well under the 12 MB
  server-action limit.
- **Picker:** `accept="image/jpeg,image/png,image/webp,application/pdf"` plus `capture` not set
  (she can choose camera or gallery). iOS transcodes HEIC to JPEG for this accept list.
- Error messages (Indonesian, no em dash): "Bukti bayar wajib diunggah.", "Format file tidak
  didukung. Gunakan foto JPG, PNG, WebP, atau PDF.", "Ukuran file maksimal 10 MB.", "Foto HEIC
  belum didukung. Ubah ke JPG lalu unggah ulang."

---

## 7. Permissions

New key **`supplier_payments.manage`**: record payments, void payments, view proofs. Granted by
migration to `super_admin` and `owner`.

Why a new key rather than an existing one:

- `finance.view_profit` is read-only by meaning; writing money records is a different, stronger
  act. Keeping it read-only means a role can see costs without being able to record payments.
- `inventory.manage` / `production.manage` are warehouse and production roles; the person who
  receives fabric should not by default be able to mark the supplier paid.

Rules (all checked on the server, per page, action and route handler):

| Action | Requires |
|---|---|
| See payment status badge (no amounts) on purchase/batch lists and detail | the page's existing key (`inventory.view` / `production.manage`) (A8) |
| See tagihan, paid, remaining, payment history amounts, supplier utang | + `finance.view_profit` (existing amount rule; queries strip amounts otherwise) |
| Record or void a payment | `supplier_payments.manage` + `finance.view_profit` |
| View a payment proof file | `supplier_payments.manage` + `finance.view_profit` |
| Attach / void a nota on a purchase | `inventory.manage` + `finance.view_profit` (same as editing a purchase today) |
| View a nota file | `inventory.view` + `finance.view_profit` |

Without `finance.view_profit` the payment section's Server Component is not rendered at all, so the
query never runs (existing pattern).

---

## 8. Write paths and audit

Purchase and production write paths live in `apps/admin/src/lib` today (not `packages/commerce`),
so these do too: `apps/admin/src/lib/supplier-payments/`.

**recordSupplierPayment(input, file, actor)**

1. Validate input (zod): amount integer > 0, `paid_at` ≤ today (Jakarta), no lower bound (A9),
   method, note ≤ 500.
2. Process + `put` the file (§6, §5.7).
3. Transaction: lock parent row (purchase or batch) `FOR UPDATE`; reject if purchase is
   `cancelled` or batch is not `posted`; compute tagihan/paid for the target (and payee); reject if
   `amount > remaining` with "Jumlah melebihi sisa tagihan (Rp X)."; insert `private_files`, insert
   `supplier_payments` (payment_no via `nextDocumentNumber`), `writeAuditLog` action `record`,
   entityType `supplier_payment`, after = full row incl. target and file id. Viewing a proof is
   never audited (A10).
4. Soft warning (non-blocking, shown before submit via a read-only check): the same
   `original_sha256` is already the proof of another non-voided payment ("Bukti ini sudah dipakai
   untuk pembayaran BYR-..."). Catches a double entry of one transfer.

**voidSupplierPayment(id, reason, actor)**: lock parent row, then
`UPDATE supplier_payments SET voided_* WHERE id = $1 AND voided_at IS NULL RETURNING *`; zero rows
means already voided ("Pembayaran ini sudah dibatalkan."). Audit action `void`, before/after.
Reason required, ≤ 500.

**attachPurchaseInvoice / voidPurchaseAttachment**: same shapes, entityType `purchase_attachment`.

`updatePurchase` and `closePurchase` gain the "below paid" guard / warning described in §3.1.

---

## 9. Admin UI (Indonesian, no em dash)

**Purchase detail** (`/purchases/[id]`): new card "Pembayaran" under the lines.
Summary row: Tagihan, Dibayar, Sisa (or "Lebih bayar"), status badge. History table (CardList +
TableContainer): No. bayar, Tanggal, Metode, Jumlah, Dicatat oleh, Bukti (opens viewer), Catatan;
voided rows struck through with a "Dibatalkan" badge and the reason + who/when. Buttons: "Catat
pembayaran" (dialog: Tanggal bayar (default hari ini), Jumlah (prefilled with Sisa), Metode
(Tunai / Transfer), Bukti bayar (wajib), Catatan), "Batalkan" per row (dialog with required
"Alasan pembatalan"). Card "Nota pemasok": list + "Lampirkan nota".

**Batch detail** (`/production/[id]`, posted only): same card, grouped per payee
("Penjahit A: tagihan, dibayar, sisa"); the dialog asks "Dibayar kepada" from the batch's payees.

**Lists** (`/purchases`, `/production`): new column/card field "Pembayaran" (badge) and, with
`finance.view_profit`, "Sisa". Second filter row `FilterTabs paramName="payment"`: Semua, Belum
bayar, DP, Lunas (Tanpa tagihan under Semua only). Filtering is a SQL predicate over the derived
sums (subquery, same style as the existing total subquery), never a stored column.

**Suppliers** (`/suppliers` list and `/suppliers/[id]`): "Total utang" column (with
`finance.view_profit`), and on detail a table of that supplier's documents with a remaining
balance (purchase no / batch no, tagihan, dibayar, sisa, status), newest first, plus total.

**Proof viewer:** image in a lightbox (the admin `<img>` points at `/api/private-files/[id]`), PDF
opens in a new tab through the same route.

---

## 10. Tests

TDD (vitest, `ammari_test`) because this is payment code:

- `paymentStatus` all five branches incl. 0/0 and overpaid.
- `purchaseTagihan` per status, incl. closed with partial receipt, closed after a return-out, and
  cancelled; equals variance "Nilai diterima + Nilai cacat" for a closed document.
- `batchTagihan` per payee, NULL payee, fabric/accessory excluded, draft = none.
- Migration 0038 test: permission + grants present; triggers reject DELETE and UPDATE of
  amount/paid_at/method/proof/supplier/note on payments, attachments and private_files; allow the
  one void update; reject a second void; CHECKs (amount > 0, one target, purchase needs payee,
  void triple, blank reason).
- `recordSupplierPayment`: happy path DP then pelunasan -> Lunas; over-remaining refused with the
  message; exactly-remaining allowed; cancelled purchase refused; draft batch refused; per-payee cap
  on a two-payee batch; **concurrency**: two parallel payments that together exceed remaining, one
  succeeds and one is refused; audit row written.
- `voidSupplierPayment`: voided payment stops counting; double void refused; concurrent double void
  -> exactly one wins; reason required.
- `updatePurchase` refuses a total below paid; `closePurchase` with paid > new tagihan succeeds and
  reports overpaid.
- Proof processing: JPEG with EXIF orientation 6 comes out rotated with no EXIF/GPS; PNG -> JPEG;
  4000 px -> 2000 px long edge; size ≤ 600 KB on a fixture receipt photo; PDF passthrough
  byte-identical; HEIC, GIF, spoofed extension, > 10 MB, > 40 MP all refused.
- Private storage: memory + fs drivers; memory/fs refused in production; S3 put sends
  `Cache-Control: private, no-store` (mocked client, no real API call); client exposes no delete.
- Route handler: 401 without session, 403 without each required key, 404 for an unreferenced file
  id, 200 with correct headers otherwise.

e2e (Playwright, `ammari_e2e`, memory private storage), **every list assertion at 390 px and
1280 px**:

- Record DP with a photo, see DP on the purchase list and detail, record pelunasan, see Lunas;
  filter "Belum bayar"/"DP"/"Lunas" on `/purchases`.
- Void a payment with reason: struck row with "Dibatalkan", status returns to DP.
- Over-remaining payment shows the Indonesian error.
- Batch payment to one of two payees; `/production` list badge + filter.
- Supplier list "Total utang" and detail breakdown.
- Staff without `finance.view_profit` sees badges but no amounts and no "Catat pembayaran"; staff
  with finance but without `supplier_payments.manage` cannot open a proof (route returns 403).

---

## 11. Sessions

Each one small enough to commit separately; `/code-review` per CLAUDE.md before each commit
(database-reviewer for S1, security-reviewer for S2/S3, typescript/react reviewers throughout).

| Session | Content |
|---|---|
| S1 | Migration 0038 (3 tables, triggers, permission), Drizzle schema, constants, pure `paymentStatus` / tagihan functions with TDD, migration test. |
| S2 | `PrivateStorageClient` (S3, memory, fs), `proof-processing.ts`, `/api/private-files/[fileId]` route with permission checks, tests. Env examples + turbo env. |
| S3 | Purchase payments: record/void write paths (TDD), `updatePurchase`/`closePurchase` guards, purchase detail card + dialogs, list column + filter, nota attachments, e2e. |
| S4 | Production payments: per-payee tagihan, batch detail card, `/production` list column + filter, e2e. |
| S5 | Supplier utang (list + detail), `make-prod-env.sh` + deploy env examples + `storage:check --private`, nightly copy of proof files into the private backups bucket (A7), go-live check, SPEC.md update, release notes in `docs/deploy-prod.md`. |

Deploy order note: the private-bucket env vars must exist on dev before S2/S3 reach `dev`, and on
prod before the release that contains S3. Without them the payment dialog fails closed with
"Penyimpanan bukti belum dikonfigurasi." and nothing else is affected.

---

## 12. Owner answers (2026-10-24, all recommendations accepted)

Nothing is open. Each answer is folded into the sections above; this list is the record.

| # | Question | Answer |
|---|---|---|
| A1 | Short-closed purchase | Due drops to the value of what arrived (existing receipt valuation, §3.1). |
| A2 | Production due | Posted service lines only, no fabric/accessories. A batch closed early keeps its posted amount; no "potongan tagihan" record for now (§3.2). |
| A3 | Total utang per supplier | Includes tailors' production balances, not only purchases (P9). |
| A4 | Cancelled/overpaid purchase | Show "Lebih bayar Rp X" only; recording the supplier's refund comes later (§3.1). |
| A5 | HEIC | Clear Indonesian error asking for JPG; no HEIC decoder library (§6). |
| A6 | Viewing proofs | Only through the admin route with a permission check; no signed R2 links (§5.4). |
| A7 | Backups | Proof files are copied nightly into the private backups bucket, planned in S5 with the deploy env (§5, §11). |
| A8 | Status visibility | Staff without `finance.view_profit` see the status badge (Belum bayar / DP / Lunas / Tanpa tagihan), never amounts (§7). |
| A9 | Payment date | Only "not in the future", no lower bound (§8). |
| A10 | Audit | Audit log only for recording and voiding payments (and nota attach/void), not for viewing proofs (§8). |
