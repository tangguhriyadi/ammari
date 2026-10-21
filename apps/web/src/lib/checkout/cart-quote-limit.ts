import "server-only";
import { sql } from "drizzle-orm";
import { claimRateLimits } from "@ammari/db/schema";
import type { Database } from "@/lib/claim/throttle";

// The checkout quote's per-cart limit (docs/plans/cart-checkout.md §4.5.4, session 8 security
// review): the per-IP `shipping_quote` limit alone lets one caller behind many addresses vary area
// and weight to miss the rate cache and spend the scarce daily Rates budget. Stored in
// claim_rate_limits like every other storefront limit, under the fixed ip 0.0.0.0 (no real client
// has it; the shipping budgets use it the same way) with the action `shipping_quote_cart:<cart
// id>`, so the existing (ip, action, created_at) index serves the count and the 1-day cleanup
// removes the rows. The cart id is our own uuid, never a token.

const CART_LIMIT_IP = "0.0.0.0";

export function cartQuoteAction(cartId: string): string {
  return `shipping_quote_cart:${cartId}`;
}

/** Records one quote for this cart and returns how many were already recorded in the window (the
 * same atomic insert-and-count statement as recordClaimAttemptAndCount, never count-then-insert). */
export async function recordCartQuoteAndCount(db: Database, cartId: string, windowSeconds: number): Promise<number> {
  const action = cartQuoteAction(cartId);
  const [row] = await db
    .insert(claimRateLimits)
    .values({ ip: CART_LIMIT_IP, action })
    .returning({
      prior: sql<number>`(
        select count(*) from ${claimRateLimits}
        where ${claimRateLimits.ip} = ${CART_LIMIT_IP}::inet
          and ${claimRateLimits.action} = ${action}
          and ${claimRateLimits.createdAt} > now() - make_interval(secs => ${windowSeconds})
      )`,
    });
  // INSERT ... RETURNING always yields the row; if it ever did not, count it as over the limit.
  if (!row) {
    console.error("[checkout] per-cart quote limit row was not recorded; refusing the quote", { cartId });
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(row.prior);
}
