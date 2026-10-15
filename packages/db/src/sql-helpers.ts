import { getTableName, sql, type AnyColumn, type SQL, type Table } from "drizzle-orm";

/**
 * A fully table-qualified `"table_name"."column_name"` reference, safe to interpolate ANYWHERE
 * inside a hand-written `sql` fragment — in particular inside a correlated subquery
 * (`(select ... from x where x.col = <outer column>)`).
 *
 * **Why this exists (real incident, 2026-10-15):** `sql`...${someTable.someColumn}...`` does
 * NOT reliably render as `"some_table"."some_column"`. Empirically (confirmed against the real
 * local Postgres, drizzle-orm 0.45.3): whether a Column reference gets table-qualified depends
 * on whether the ENCLOSING query builder call (`.select().from(...).innerJoin(...)`) itself
 * involves more than one table. A query with at least one `.innerJoin`/`.leftJoin` qualifies
 * every interpolated column consistently, including ones embedded in a raw subquery fragment
 * referencing a table that isn't even part of that join graph. A query with only `.from(oneTable)`
 * and NO join renders every interpolated column bare (just `"column_name"`) — including a column
 * from a completely different table, interpolated only inside a hand-rolled subquery string.
 * When that different table happens to share a column name with the query's one real table (e.g.
 * both have a `sku` column), the bare, unqualified name inside the subquery's own scope resolves
 * to the SUBQUERY's table every time, silently turning an intended correlation
 * (`stock_movements.sku = product_variants.sku`) into a self-comparison
 * (`stock_movements.sku = stock_movements.sku`, always true) — the subquery then aggregates
 * EVERY row of its own table instead of just the one correlated to the outer row, with no error,
 * no warning, just a wrong number. This was caught in `packages/db/src/storefront/queries.ts`'s
 * own availability subquery before it ever shipped (that query had no join, so it hit exactly
 * this). `apps/admin/src/lib/stock/queries.ts`'s `getSkuDetail`/`listProductSkusForCount` use the
 * identical correlated-subquery shape but happen to always have at least one `.innerJoin`
 * already, so they were NOT actually producing wrong numbers — but their correctness depended
 * entirely on that incidental join staying present, which is exactly the kind of thing a future,
 * unrelated refactor (dropping a join, or a drizzle-orm upgrade changing this internal behavior)
 * could silently break again. Both were hardened to use this helper instead of relying on it.
 *
 * **The rule going forward:** any hand-written subquery that correlates to an outer query's
 * column — not just a plain aggregate over the query's own single `.from()` table — MUST use
 * `qualifiedColumn()` for every column reference involved in that correlation, never bare
 * `${table.column}` interpolation. See `test/sql-correlation-guard.test.ts`, which greps the
 * whole repo for the risky raw shape and fails if it finds one outside this file.
 */
export function qualifiedColumn(table: Table, column: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(table))}.${sql.identifier(column.name)}`;
}
