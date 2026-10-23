# Product types ("Jenis Produk") — master data

Owner decisions are final (see the request of 2026-10-24). This plan records how they are built.

## Scope

- New master data **Jenis Produk** under Data Master in admin (`/product-types`): list, add,
  rename, change display order, deactivate/reactivate. No hard delete at all (simplest way to
  satisfy "a type used by any product cannot be deleted"). Every change is audit logged
  (`entity_type = 'product_type'`). Permission: `products.manage`, same as products. No new key.
- Every product has a type. Existing products become `DRESS` ("Gamis").
- Admin product form: required "Jenis produk" select (active types only; a product whose type
  was deactivated later keeps showing it, marked "(nonaktif)", and can be re-saved with it).
- Product list: type shown on both layouts (cards and table) and a "Jenis produk" filter.
- Product type drives nothing else (sizes, size chart, SKU). `apps/web` unchanged.
- **Reports:** admin has no revenue/report screen yet (`/` Ringkasan and `/ads-expenses` are
  "coming soon" placeholders), so no breakdown is added. Skipped on purpose.

## Schema (migration 0037)

```
product_types
  code        text PRIMARY KEY            -- e.g. DRESS; CHECK ^[A-Z][A-Z0-9_]{0,29}$
  name        citext NOT NULL UNIQUE      -- Indonesian display name, e.g. "Gamis"; CHECK btrim <> ''
  is_active   boolean NOT NULL DEFAULT true
  sort_order  integer NOT NULL DEFAULT 0  -- same convention as cost_components.sort_order
  created_at / updated_at (set_updated_at trigger)

products.product_type_code text NOT NULL DEFAULT 'DRESS'
  REFERENCES product_types(code) ON DELETE RESTRICT ON UPDATE RESTRICT
  + index products_product_type_code_idx
```

- The code is the primary key, like `channels.id`: it's short, immutable, and readable in the
  products row and in the audit log. A hand-authored trigger (`prevent_product_type_code_change`)
  rejects any `UPDATE` of `code`, even on a type no product uses yet. The FK's `ON UPDATE
  RESTRICT` already blocks the change for a type that is in use.
- The `DRESS` / "Gamis" row is inserted **in the migration itself** (`ON CONFLICT DO NOTHING`)
  between `CREATE TABLE` and the FK. The column default depends on it, so it is reference data
  (CLAUDE.md DB rule). `seed.ts` also inserts it insert-only (`onConflictDoNothing`, so a rename
  is never overwritten), because `e2e-db.ts` TRUNCATEs every table and only re-runs `seed()`.

### Backward compatibility (prod `d5c654b`, current dev)

Choice: **NOT NULL + constant DEFAULT 'DRESS'**, not "nullable + backfill".

- An older release inserts products without naming the column. The default fills in `DRESS`,
  which always exists because there is no hard delete. Old updates and selects never name the
  column, so they're unaffected. Rollback (an older image against this schema) keeps working.
- `ADD COLUMN ... DEFAULT <constant> NOT NULL` backfills every existing row to `DRESS` in the
  same statement. On Postgres 11+ that's a catalog-only change, with no table rewrite.
- No reader ever has to handle a NULL type, and **no later NOT NULL step is needed**.
- Optional later contract step: once no running release can insert without a type, drop the
  default (`ALTER COLUMN product_type_code DROP DEFAULT`). Then a future code path that forgets
  the type fails loudly instead of silently getting DRESS. It's not required for correctness,
  because the new app always sends the type and validates it.
- Caveat: if the owner ever deactivates DRESS, an older release would still create DRESS
  products. That's harmless, and it stops mattering once every running release is this one.

## App layer (apps/admin)

- `lib/product-types/queries.ts`: list (with product count), get, create, update (name and
  sort order only; the code is not in the update input), set active. Also active options for
  the picker, all-types filter options, and `lockSelectableProductType(tx, code)`. That last one
  uses `FOR SHARE` plus an active check, the same race-safe shape as `lockSelectableSuppliers`.
  The unique name and code are enforced by constraints and mapped to field errors, never
  check-then-insert.
- `app/(shell)/product-types/`: list (CardList + TableContainer, switch per row), `new`,
  `[code]` edit (code read-only), server actions with Zod and `requirePermission("products.manage")`.
- Products: `createProduct` requires `productTypeCode` and locks it active. `updateProduct`
  locks only when the type changes, so an unchanged inactive type re-saves fine. `listProducts`
  takes `{ q, productTypeCode }` and joins the type name.
- Nav: "Jenis Produk" under Data Master, `products.manage`.

## Tests

- `packages/db/test/migration-0037.test.ts`: upgrades a 0036 database with a product. Checks
  that the product becomes DRESS, that an old-release insert (no column) gets DRESS, that the
  constraints hold (code format, immutable code, FK restrict on delete, unique name), and that
  re-running is a no-op.
- `apps/admin/src/lib/product-types/queries.test.ts`: CRUD, audit log, duplicate code/name
  messages, and inactive types excluded from the options.
- Product query tests: the type is required, an inactive type is refused on create and on
  change, an unchanged inactive type is allowed, and the list filters by type.
- Action tests: permission (403) and validation.
- e2e `product-types.spec.ts` at 390px and 1280px: add, rename, product form select, list
  filter, deactivate (the type disappears from the new-product select, and an existing product
  shows it "(nonaktif)").
- Existing e2e specs that create a product through `/products/new` pick "Gamis" in the new
  select.
