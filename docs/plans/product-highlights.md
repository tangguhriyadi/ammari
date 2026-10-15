# Plan: Product Highlights ("Keunggulan")

**Status:** Approved (user asked for plan-then-implement in one message). Implemented, then
amended same session (see "Amendment" below) when the requirement changed from free text to a
fixed set.

## Summary

A fixed set of 5 selling-point KEYS per product (`breathable`, `flowy`, `falls_perfectly`,
`cool_fabric`, `not_see_through` — never free text), toggled via 5 checkboxes in the admin
product form (create + edit), shown read-only (by their Indonesian label, in canonical order) on
the detail/list views, and exposed through a minimal `packages/db` read function so the
(not-yet-built) storefront PDP can map each key to its own icon later. Goes through the existing
audit log automatically — no new audit code needed.

## Amendment: free text → a fixed set (same session, before anything was deployed)

The original build (see git history / the rest of this doc, now updated in place to describe the
final state) implemented highlights as **free text**: up to 5 trimmed strings, 1–40 chars, no
case-insensitive duplicates, add/remove/reorder via up/down buttons. The owner then changed the
requirement: the storefront needs to map each highlight to its own **icon**, which only works
for a **closed set** — so highlights became 5 fixed keys with a shared key→label module, and the
admin UI became 5 checkboxes (no reordering — canonical order is always the display order).
Since migration 0018 had not been committed or deployed anywhere, it was **amended in place**
(same file number, new content) rather than adding 0019 — see "Migration 0018" and "Local
database procedure" below for exactly what that involved and what was done to the owner's local
databases.

## Storage choice: a `text[]` column on `products`, not a child table

Unchanged by the amendment — still the right call for the same reasons, now reinforced by the
fixed set making it even simpler:

- **No independent identity or lifecycle.** A highlight is never referenced from elsewhere, has
  no own timestamps, and nothing needs to query "all highlights across products" — the entire
  list is read/written as one unit, always scoped to its product.
- **Audit logging is already array-level** — the whole product row's before/after, already
  automatic via `writeAuditLog` in `updateProduct`/`createProduct`.
- **Atomicity is free** — `text[] NOT NULL DEFAULT '{}'` updates in the exact same `UPDATE
  products SET ...` the rest of the form already does.
- Now that the set is closed, the DB can enforce membership AND uniqueness directly (see below)
  — the free-text version's per-item length/trim rules are gone entirely; there's nothing left
  for application code to validate beyond "is this key one of the 5."

## Single source of truth: keys + labels, in `packages/db`

- `packages/db/src/schema/constants.ts` → `PRODUCT_HIGHLIGHT_KEYS` (and `ProductHighlightKey`),
  alongside every other enum-like constant this file already holds (`PRODUCT_CLOSURES`, `SIZES`,
  ...) — the array **is** the canonical display order everywhere, nothing else decides ordering.
- `packages/db/src/catalog/highlights.ts` (new, exported as `@ammari/db/highlights`) →
  `PRODUCT_HIGHLIGHT_LABELS` (Indonesian text, NOT stored in the DB — only the key is, so
  rewording never needs a migration) and `PRODUCT_HIGHLIGHTS` (`{key, label}[]`, the convenient
  shape for rendering a fixed checkbox list or a fixed set of read-only badges without every call
  site re-zipping the two arrays itself). Used by `apps/admin` today; `apps/web` imports the same
  module once the storefront PDP exists.

## Migration 0018 (amended in place, gapless, additive, backward-compatible)

```sql
ALTER TABLE "products" ADD COLUMN "highlights" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_highlights_allowed_check" CHECK ("products"."highlights" <@ ARRAY['breathable', 'flowy', 'falls_perfectly', 'cool_fabric', 'not_see_through']::text[]);--> statement-breakpoint
-- Hand-authored (not drizzle-kit generated): Postgres rejects a subquery inside ANY check
-- constraint outright, even one that only reads the row's own column — confirmed directly
-- against this exact migration's target version, not assumed from the docs — so "no
-- duplicates" is expressed through this tiny IMMUTABLE SQL function instead. Same
-- "hand-authored addition to an auto-generated migration" idiom migration 0001 already used
-- for its own set_updated_at() trigger function.
CREATE FUNCTION "text_array_has_duplicates"(arr text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(arr) <> cardinality(ARRAY(SELECT DISTINCT unnest(arr)))
$$;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_highlights_no_duplicates_check" CHECK (not text_array_has_duplicates("products"."highlights"));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_highlights_max_check" CHECK (cardinality("products"."highlights") <= 5);
```

Three CHECKs, each confirmed empirically against the real local Postgres 16 (not assumed from
the SQL text):
- `products_highlights_allowed_check` — Postgres's `<@` ("is contained by") array operator,
  rejects any key outside the 5 allowed ones with `23514`.
- `products_highlights_no_duplicates_check` — needs the hand-authored function above because
  Postgres flatly refuses `ARRAY(SELECT DISTINCT unnest(...))` written directly inside a CHECK
  expression ("cannot use subquery in check constraint" — reproduced directly, not guessed);
  wrapping the exact same subquery inside a tiny `IMMUTABLE SQL` function sidesteps that
  restriction (the restriction is about the CHECK clause's own syntax, not what a function it
  calls is allowed to contain).
- `products_highlights_max_check` — now **logically implied** by the two checks above (5
  distinct allowed keys, no duplicates ⇒ at most 5 elements), kept anyway as a cheap, explicit,
  self-documenting invariant, matching this schema's existing "belt and suspenders" posture
  elsewhere.

Verified on a genuinely fresh database (full migration chain 0000→0018): empty array accepted,
all 5 valid keys accepted, an unknown key rejected (`23514`), a duplicate key rejected (`23514`),
and the OLD free-text values from before this amendment (`"Breathable"`, `"Flowy"`, ...) are
ALSO correctly rejected now (confirming this isn't just "any short string passes").

## Local database procedure (what was actually done, non-destructively)

The owner's `ammari` (local dev) and `ammari_e2e` databases had already applied the OLD 0018
(free-text version: just the column + the single max-5 check) before the requirement changed.
Migration 0018 itself had never been committed/deployed anywhere, so it was amended in place
(same filename position, replaced content — old `0018_mean_celestials.sql` deleted, drizzle-kit
regenerated a fresh `0018_early_daredevil.sql` from the amended schema, then hand-edited to add
the `CREATE FUNCTION` statement) rather than adding a new 0019.

**The constraint:** drizzle-orm's own migrator (`drizzle-orm/postgres-js/migrator`, which
`packages/db/src/migrate.ts` calls) decides what to (re-)apply purely by comparing each
migration's journal timestamp against the latest *already-applied* timestamp recorded in
`drizzle.__drizzle_migrations` — confirmed by reading its actual source
(`node_modules/drizzle-orm/pg-core/dialect.js`), not assumed. It does **not** diff a migration's
hash against what's already applied to decide whether to re-run it. Since the amended 0018 is a
real content change, a plain `db:migrate` run against a database that already ran the OLD 0018
would try to re-execute the WHOLE file — including `ADD COLUMN "highlights"` again — and fail
with "column already exists." So the delta was applied directly, bypassing the migrator, then
drizzle's own bookkeeping was updated to match exactly what a normal `migrate()` run would have
recorded, so future migrate runs on these same databases correctly see 0018 as already done:

1. **Surveyed both databases first** (read-only) for any existing `products.highlights` values
   that would violate the new constraints. Found only the agent's own debug/test rows from
   earlier in this session (all obviously named: `Debug Product <timestamp>` in `ammari`,
   `Contoh Gamis Keunggulan/Validasi E2E <timestamp>` in `ammari_e2e`) — no owner data.
2. **Cleared `highlights` to `'{}'`** on exactly those named rows (by id, not a blanket
   `UPDATE`) — 2 rows in `ammari`, 3 in `ammari_e2e`. Nothing else touched; no table dropped, no
   database wiped.
3. **Ran the delta SQL directly**: `CREATE OR REPLACE FUNCTION text_array_has_duplicates(...)`,
   then `ADD CONSTRAINT products_highlights_allowed_check`, then `ADD CONSTRAINT
   products_highlights_no_duplicates_check` (the pre-existing `products_highlights_max_check`
   needed no change — same name, same expression as before).
4. **Inserted one row into `drizzle.__drizzle_migrations`** with the amended 0018 file's real
   sha256 hash and its journal `when` timestamp — exactly what `migrate()` itself would have
   inserted had it run the file normally. Confirmed afterward: running `pnpm --filter @ammari/db
   db:migrate` against `ammari` is a clean no-op (no attempt to re-run 0018), and the new
   constraints are live (a bogus key is rejected with `23514`).

The whole procedure was first dry-run against a disposable `ammari_scratch` database seeded to
mimic the exact pre-amendment state, confirmed correct end-to-end there, THEN run for real
against `ammari`/`ammari_e2e` — never attempted on the owner's real databases unverified.

**`ammari_test`** (vitest's own test database) was NOT given this same delta treatment — it's
explicitly named in `CLAUDE.md` as disposable for vitest runs, so it was simply dropped; the next
`pnpm --filter @ammari/db test` run recreates and fully re-migrates it from scratch (confirmed:
it did, and the amended constraints work correctly there too).

## Validation

Zod enum, not free-text rules — there is nothing left to validate beyond "is each key one of the
5 allowed ones, with no duplicates, at most 5 of them" (`apps/admin/src/app/(shell)/products/
actions.ts`):

```ts
const highlightsSchema = z
  .array(z.enum(PRODUCT_HIGHLIGHT_KEYS))
  .max(5, "Maksimal 5 keunggulan.")
  .refine((keys) => new Set(keys).size === keys.length, "Keunggulan tidak boleh duplikat.")
  .transform((keys) => PRODUCT_HIGHLIGHT_KEYS.filter((key) => keys.includes(key)));
```

`z.enum` rejects any key outside the fixed set outright — never trusting the client's checkboxes
alone. The same `.max`/no-duplicate rules are ALSO enforced at the DB level (belt and suspenders,
same posture as everywhere else in this schema). The final `.transform` re-sorts into
`PRODUCT_HIGHLIGHT_KEYS`' own canonical order regardless of what order the client's array
happened to list them in — display order is never trusted from the request either, only ever
this one canonical list.

No more pure validation module needed on the admin side (the free-text version's
`apps/admin/src/lib/products/highlights.ts` + its own test file were deleted) — there's nothing
left to unit-test beyond what `z.enum` already guarantees structurally.

## UI — 5 checkboxes inside the product form, no reordering

`_components/highlights-editor.tsx`: `PRODUCT_HIGHLIGHTS` rendered as 5 `Checkbox`es (from
`@ammari/ui` — already `min-h-11`, a 44px touch target, for free). `ProductFormValues.highlights`
is just `ProductHighlightKey[]`; toggling a box always rebuilds the array by filtering
`PRODUCT_HIGHLIGHT_KEYS` for membership, so the STORED order is always canonical regardless of
click order. No "disable once 5 are selected" logic: there are exactly 5 checkboxes for exactly
5 allowed keys, so checking every box IS the max — there's no way to exceed it through this UI,
structurally, so the old free-text version's "Tambah disabled at 5" concern doesn't apply to a
fixed checkbox set at all. A small `data-testid="highlights-counter"` shows "n/5" as a courtesy,
not because it's load-bearing.

Lives **inside** `ProductForm` itself (not a separate below-the-fold section like Photos/
Variants/Accessory-Recipe), same reasoning as before the amendment: no independent identity,
submitted together with name/price/etc. in the same `createProductAction`/`updateProductAction`
call — the create flow gets it for free.

## Display — detail page (via the form) + list page (read-only labels, canonical order)

- **Detail page**: the form (edit mode) already shows the current selection via checked boxes —
  satisfies "shown on the detail view."
- **List page** (`_components/product-list.tsx`): a `highlightLabels(keys)` helper filters
  `PRODUCT_HIGHLIGHTS` by membership (iterating the canonical list, not the product's own stored
  array) and renders the resulting LABELS as `Badge` chips, in both the mobile `CardList` and
  desktop `TableContainer` (CLAUDE.md's dual-viewport rule). Only rendered when non-empty, so
  every existing product's row is unchanged.

## Query layer / packages/db read function

Unchanged by the amendment: `CreateProductInput`/`UpdateProductInput` already carry
`highlights: string[]` straight through to the column; `queryProductsPage` already projects
`highlights`; `packages/db/src/queries.ts`'s `getActiveProductBySlug` (new `"./queries"` export)
is still the minimal, deliberately thin read function for the future storefront — not consumed
by apps/web yet.

## Tests

- **Unit** (`packages/db/test/products.test.ts`, rewritten for the fixed set): stores all 5
  allowed keys in whatever order given; rejects a key outside the set; rejects the OLD free-text
  labels directly (confirms the old stored values are now themselves invalid, not just "some
  random string"); rejects a duplicate key; rejects 6 elements (structurally impossible without
  a duplicate or an invalid key, from only 5 valid keys); `getActiveProductBySlug`'s active/
  inactive/nonexistent cases, using a real key.
- **E2E** (`apps/admin/e2e/product-highlights.spec.ts`, rewritten for checkboxes, one test, both
  viewports in sequence): check/uncheck on create and edit, confirm the SAVED order comes out
  canonical even when checked out of order, confirm it survives a real reload, confirm the list
  page shows the right labels (and not an unchecked one) in canonical order — at both 390px and
  1280px. Same dedicated e2e email as before the amendment
  (`E2E_PRODUCT_HIGHLIGHTS_EMAIL`).

## Verification

- `pnpm --filter @ammari/db db:generate` then read the migration (above) before applying it
  locally; the full chain (0000→amended 0018) verified against a genuinely fresh database.
- `packages/db` unit suite (88 total, up from 85 — the rewritten `products.test.ts` has 1 more
  case than before), `@ammari/admin` (469, down from 484 — the free-text validation test file,
  no longer applicable, was deleted), `@ammari/web` (40) — all green.
- E2E: the rewritten spec passes, run twice and alongside the existing `products.spec.ts` (8
  tests total) to confirm stability and no cross-spec interference.
- `pnpm typecheck && pnpm lint && pnpm build` (workspace-wide) — all green.
- The local database amendment procedure itself was dry-run against a disposable scratch
  database before being applied to `ammari`/`ammari_e2e` for real (see above).

**A real debugging detour while first writing the (now-superseded free-text) e2e test**, worth
keeping on record since it looked EXACTLY like an application bug at first: a "save, then
reload, assert the new value" assertion kept seeing the ORIGINAL pre-edit value, as if the save
had silently done nothing. Bisected by querying the e2e database directly, in the same test,
immediately after the save click — the database already had the correct, freshly-saved value
every time. The save was never the problem; the test's own `page.goto(page.url())` (a hard, fresh
navigation) was racing the SAME click's own client-side `router.push`/`router.refresh()`, and
intermittently won that race, rendering a snapshot from before the refresh's RSC fetch had
committed. Fixed by adding `await page.waitForLoadState("networkidle")` after the Simpan click,
before the assertion's own hard reload — kept in the rewritten checkbox-based spec too.

## Explicitly NOT built

The storefront PDP itself (or the icon-per-key mapping it will need), any apps/web code at all,
per-item audit trail, drag-and-drop or any other reordering (checkboxes have no concept of it;
canonical order is fixed), free text of any kind.
