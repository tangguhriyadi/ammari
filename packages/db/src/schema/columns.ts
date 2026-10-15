import { customType } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";

/** Case-insensitive text, backed by the `citext` extension (enabled in migration 0000). */
export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

/** created_at + updated_at for mutable entity tables. updated_at is kept in sync by the
 * shared `set_updated_at()` trigger (migration 0001), not by the application. */
export function timestamps() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  };
}

/** created_at only, for append-only/immutable rows (ledgers, line items, logs). */
export function createdAtOnly() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  };
}

/** Builds a `col in ('a', 'b', ...)` CHECK expression from a shared TS const array, so the
 * constraint and application code can never drift apart.
 *
 * Deliberately uses `sql.raw` for the value list, not `${value}` interpolation: this SQL is
 * embedded literally into a migration file (DDL), not sent as a parameterized query, so a bound
 * placeholder (`$1, $2, ...`) would be dead text with nothing to bind it — Postgres would reject
 * it. `values` is always one of our own hardcoded const arrays (never user input), so building
 * the literal text here is safe. */
export function checkIn(column: AnyPgColumn, values: readonly string[]): SQL {
  const list = values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
  return sql`${column} in (${sql.raw(list)})`;
}

/** Same reasoning and `sql.raw` safety argument as `checkIn` above, for a `text[]` column: every
 * element of the column's array value must be one of `values` (Postgres's `<@` "is contained
 * by" operator). Confirmed empirically (not just from docs) against the real local Postgres 16
 * that `<@` rejects an unlisted element with a plain CHECK violation (23514) — no custom
 * function needed for this half of the constraint, unlike the "no duplicates" half (see
 * schema/catalog.ts's own comment on `products_highlights_no_duplicates_check` for why that one
 * DOES need one: Postgres flatly refuses a subquery inside any CHECK expression). */
export function checkArraySubset(column: AnyPgColumn, values: readonly string[]): SQL {
  const list = values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
  return sql`${column} <@ ARRAY[${sql.raw(list)}]::text[]`;
}
