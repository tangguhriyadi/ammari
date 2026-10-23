import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { fabricColors, products, productVariants, stockReservations } from "@ammari/db/schema";
import { activeReservedQtySql } from "@ammari/db/stock-availability";
import { ActionError, FieldError } from "../errors";
import type { Tx } from "../db";
import { lockVariantForUpdate } from "./lock";
import { currentBalanceForSkuLocked } from "./ledger";
import { sizeLabel } from "../size-label";

// Stock held for unpaid checkout orders (docs/plans/cart-checkout.md D3, §5 step 7). The ledger
// (stock_movements) keeps recording real sales only: a hold is a stock_reservations row, the
// `sale` movement is written when the order is paid (transitionOrderStatus's
// awaiting_payment -> to_ship, which also consumes the hold). Staff-entered and marketplace orders
// never reserve and keep checking physical stock only (D4).

/** Owner decision 1: stock is held 75 minutes (the payment window is 60). apps/web reads
 * `CHECKOUT_STOCK_HOLD_MINUTES` and falls back to this. */
export const DEFAULT_STOCK_HOLD_MINUTES = 75;
const MAX_STOCK_HOLD_MINUTES = 24 * 60;

export interface ReserveStockLine {
  orderItemId: string;
  sku: string;
  qty: number;
}

export type StockReservation = typeof stockReservations.$inferSelect;

/** "Stok Gamis Basic warna Black ukuran M tidak cukup." Names the product, colour and size (plan
 * §5 step 7) but never a count (plan §4.2). */
async function insufficientStockError(tx: Tx, sku: string): Promise<FieldError> {
  const [row] = await tx
    .select({ productName: products.name, colorName: fabricColors.name, size: productVariants.size })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productVariants.sku, sku))
    .limit(1);
  if (!row) return new FieldError(sku, "Stok tidak cukup.");
  return new FieldError(sku, `Stok ${row.productName} warna ${row.colorName} ukuran ${sizeLabel(row.size)} tidak cukup.`);
}

/** Holds `lines` of `orderId` for `holdMinutes`. MUST run inside the caller's order transaction
 * (placeOrder), so a refused line rolls back the order and every earlier hold with it.
 *
 * Per SKU, in sorted order (the deadlock-avoidance idiom of saveStockCount and the sale path):
 * `SELECT ... FOR UPDATE` the variant, then `physical - active unexpired holds >= qty`, then
 * insert. The variant lock is what makes the check atomic: every other hold on the same SKU and
 * every admin stock write takes the same lock first, so two buyers racing for the last piece
 * serialize and the second one sees the first one's hold. `expires_at` is computed from the
 * database clock (`now()`, the transaction's start time), the same clock every `expires_at > now()`
 * comparison reads. */
export async function reserveStockForOrder(
  tx: Tx,
  orderId: string,
  lines: readonly ReserveStockLine[],
  holdMinutes: number,
): Promise<StockReservation[]> {
  if (!Number.isInteger(holdMinutes) || holdMinutes < 1 || holdMinutes > MAX_STOCK_HOLD_MINUTES) {
    throw new RangeError(`holdMinutes must be an integer from 1 to ${MAX_STOCK_HOLD_MINUTES}`);
  }
  if (lines.length === 0) throw new ActionError("Pesanan harus punya minimal 1 item.");
  const seen = new Set<string>();
  for (const line of lines) {
    if (!Number.isInteger(line.qty) || line.qty <= 0) throw new FieldError(line.sku, "Jumlah harus lebih dari 0.");
    // One hold per SKU per order: two lines for the same SKU would each be checked against the
    // same balance and together could hold more than exists.
    if (seen.has(line.sku)) throw new FieldError(line.sku, "SKU muncul lebih dari sekali dalam pesanan ini.");
    seen.add(line.sku);
  }

  const sorted = [...lines].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  const reserved: StockReservation[] = [];
  for (const line of sorted) {
    const variant = await lockVariantForUpdate(tx, line.sku);
    if (!variant) throw new FieldError(line.sku, "Produk tidak ditemukan.");

    const physical = await currentBalanceForSkuLocked(tx, line.sku);
    // The shared "which holds count" rule (active and unexpired), not a second copy of it.
    const [held] = await tx.execute<{ qty: number }>(sql`select ${activeReservedQtySql(sql`${line.sku}`)} as qty`);
    if (physical.qty - (held?.qty ?? 0) < line.qty) throw await insufficientStockError(tx, line.sku);

    const [row] = await tx
      .insert(stockReservations)
      .values({
        orderId,
        orderItemId: line.orderItemId,
        sku: line.sku,
        qty: line.qty,
        expiresAt: sql`now() + make_interval(mins => ${holdMinutes}::int)`,
      })
      .returning();
    if (!row) throw new Error("failed to insert stock reservation");
    reserved.push(row);
  }
  return reserved;
}

/** At payment (awaiting_payment -> to_ship, inside transitionOrderStatus): every still-active hold
 * of the order becomes `consumed`, expired or not, since the `sale` movement written in the same
 * transaction now carries those pieces. Released holds stay released (a payment after expiry is
 * the payment state machine's case, session 11). Returns the rows it changed, so a replay is an
 * empty no-op. */
export async function consumeReservationsForOrder(tx: Tx, orderId: string): Promise<StockReservation[]> {
  return tx
    .update(stockReservations)
    .set({ status: "consumed", consumedAt: sql`now()` })
    .where(and(eq(stockReservations.orderId, orderId), eq(stockReservations.status, "active")))
    .returning();
}

/** On cancel or payment expiry of an unpaid order: every still-active hold becomes `released`.
 * Consumed holds are never touched (their pieces left through a `sale` row, and a later
 * cancellation restores those through the ledger). Returns the rows it changed. */
export async function releaseReservationsForOrder(tx: Tx, orderId: string): Promise<StockReservation[]> {
  return tx
    .update(stockReservations)
    .set({ status: "released", releasedAt: sql`now()` })
    .where(and(eq(stockReservations.orderId, orderId), eq(stockReservations.status, "active")))
    .returning();
}
