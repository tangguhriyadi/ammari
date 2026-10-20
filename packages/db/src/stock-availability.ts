import { sql, type SQL } from "drizzle-orm";
import { stockMovements, stockReservations } from "./schema";
import { qualifiedColumn } from "./sql-helpers";

// Finished-goods stock figures as correlated SQL subqueries, shared by the storefront queries
// (availability) and the admin stock screens ("Dipesan"), so the "which reservations hold stock"
// rule lives in one place (docs/plans/cart-checkout.md D3).
//
// `outerSku` is the SKU the subquery correlates to: the outer query's column, written with
// `qualifiedColumn()` (see sql-helpers.ts for why a bare `${table.column}` is unsafe here), or a
// bound value (`sql`${sku}``). Every inner column is qualified for the same reason. Quantities
// only: nothing here reads a value or cost column.

/** Physical stock: `SUM(stock_movements.qty)` for the SKU (0 when it has no movements). */
export function physicalStockQtySql(outerSku: SQL): SQL<number> {
  return sql<number>`coalesce((select sum(${qualifiedColumn(stockMovements, stockMovements.qty)}) from ${stockMovements} where ${qualifiedColumn(stockMovements, stockMovements.sku)} = ${outerSku}), 0)::int`;
}

/** Pieces held for unpaid checkout orders: `active` reservations that have not expired. A
 * reservation counts only while `expires_at > now()`, so a missed sweep never strands stock
 * (plan D3). Uses the partial index `stock_reservations_active_sku_idx`. */
export function activeReservedQtySql(outerSku: SQL): SQL<number> {
  return sql<number>`coalesce((select sum(${qualifiedColumn(stockReservations, stockReservations.qty)}) from ${stockReservations} where ${qualifiedColumn(stockReservations, stockReservations.sku)} = ${outerSku} and ${qualifiedColumn(stockReservations, stockReservations.status)} = 'active' and ${qualifiedColumn(stockReservations, stockReservations.expiresAt)} > now()), 0)::int`;
}

/** What the storefront may still sell: physical stock minus active, unexpired reservations. */
export function sellableQtySql(outerSku: SQL): SQL<number> {
  return sql<number>`(${physicalStockQtySql(outerSku)} - ${activeReservedQtySql(outerSku)})`;
}
