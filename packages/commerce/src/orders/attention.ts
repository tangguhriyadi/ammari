import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { orders, type OrderAttentionFlag } from "@ammari/db/schema";

// orders.needs_attention is a set (docs/plans/cart-checkout.md §3): adding a flag never removes
// another, clearing is per flag. SQL expressions for an UPDATE ... SET needs_attention = ..., so the
// change is computed from the row as locked, never from a value read earlier.

/** The current flags plus `flags`, each once, in order of first appearance. */
export function withAttentionFlags(flags: readonly OrderAttentionFlag[]): SQL {
  const added = sql`array[${sql.join(
    flags.map((flag) => sql`${flag}`),
    sql`, `,
  )}]::text[]`;
  return sql`array(select f from unnest(${orders.needsAttention} || ${added}) with ordinality as t(f, i) group by f order by min(i))`;
}

/** The current flags without `flag` (the others untouched). */
export function withoutAttentionFlag(flag: OrderAttentionFlag): SQL {
  return sql`array_remove(${orders.needsAttention}, ${flag}::text)`;
}
