import "server-only";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { cartItems, carts, fabricColors, productImages, products, productVariants } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import { sellableQtySql } from "@ammari/db/stock-availability";
import type { Database, Tx } from "../db";
import { CART_MAX_PIECES, CART_MAX_QTY_PER_LINE, type CartLineStatus, type CartRefusal } from "./limits";

// The database-backed storefront cart (docs/plans/cart-checkout.md D2, §4.1, §4.2). A guest cart
// is found by the sha256 of its httpOnly cookie (`carts.token_hash`, customer_id NULL); a
// logged-in cart by `carts.customer_id`. This code never writes a row with both set.
//
// Every write runs in one transaction that first takes the cart row's lock (the upsert's
// ON CONFLICT DO UPDATE, or SELECT ... FOR NO KEY UPDATE), so the 20-piece cap, which spans
// rows, is checked against a cart no concurrent write can change underneath it: each later
// statement takes a fresh READ COMMITTED snapshot after the lock, so the read-then-write of a
// line's quantity is serialized, not a check-then-write race. A refused write rolls its
// transaction back, so it never leaves an empty cart behind. A login merge runs in its own
// transaction before the write, so a refused write never undoes the merge.
//
// Lock order, for every caller: guest cart row, then customer cart row, then cart_items / product
// variants. Never lock a variant and then a cart. placeOrder (../checkout/place-order.ts, session
// 9) follows it: the cart row, then a per-contact-email advisory lock, the customer row, the
// order-number advisory lock, the variants (sorted by SKU) and the voucher row.
//
// Stock checks here are advisory (a cart holds nothing; placeOrder reserves, session 9): they
// use the shared sellable rule (physical minus active, unexpired holds) and never return the
// number itself (plan §4.2). Prices are always `products.base_price`, read at render; nothing
// here selects a cost or value column.

/** Who is asking. `guestTokenHash` is the sha256 of the cart cookie (see ./token.ts); for a
 * guest's write the caller passes the hash of the cookie it is about to set when there is none
 * yet. Both set = a logged-in customer whose browser still has a guest cookie: the guest cart is
 * merged into the customer's on this call (plan §4.1). */
export interface CartIdentity {
  customerId: string | null;
  guestTokenHash: string | null;
}

export interface CartResolution {
  cartId: string | null;
  /** The cookie no longer names a guest cart this identity should use (it was just merged, or
   * a session is present anyway): clear it when the response can set cookies. */
  clearGuestCookie: boolean;
  /** The merge had to cut lines to fit the 20-piece cap ("Maksimal 20 barang per pesanan."). */
  mergeTrimmed: boolean;
}

export type CartWriteResult =
  | { ok: true; cartId: string | null; pieceCount: number; clearGuestCookie: boolean; mergeTrimmed: boolean }
  | { ok: false; reason: CartRefusal };

export interface CartLineImage {
  storageKey: string;
  altText: string | null;
  width: number;
  height: number;
}

export interface CartLine {
  sku: string;
  productName: string;
  productSlug: string;
  colorName: string;
  sizeLabel: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  status: CartLineStatus;
  image: CartLineImage | null;
}

export interface CartView extends CartResolution {
  lines: CartLine[];
  pieceCount: number;
  /** Lines that can still be bought (`ok` and `insufficient`); sold-out and unavailable lines are
   * left out. */
  subtotal: number;
  /** At least one line, every line `ok`, and within the piece cap (plan §4.2: checkout refuses
   * while any line is unavailable). */
  canCheckout: boolean;
}

class CartRefused extends Error {
  constructor(public readonly reason: CartRefusal) {
    super(reason);
    this.name = "CartRefused";
  }
}

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

function isValidLineQty(qty: number): boolean {
  return Number.isInteger(qty) && qty >= 1 && qty <= CART_MAX_QTY_PER_LINE;
}

function noCart(clearGuestCookie: boolean, mergeTrimmed = false): CartResolution {
  return { cartId: null, clearGuestCookie, mergeTrimmed };
}

async function findGuestCartId(tx: Database, tokenHash: string, forUpdate: boolean): Promise<string | null> {
  const query = tx
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.tokenHash, tokenHash), isNull(carts.customerId)));
  const [row] = forUpdate ? await query.for("no key update") : await query;
  return row?.id ?? null;
}

async function findCustomerCartId(tx: Database, customerId: string, forUpdate: boolean): Promise<string | null> {
  const query = tx.select({ id: carts.id }).from(carts).where(eq(carts.customerId, customerId));
  const [row] = forUpdate ? await query.for("no key update") : await query;
  return row?.id ?? null;
}

/** Get-or-create the customer's cart; the DO UPDATE takes the row lock either way. */
async function upsertCustomerCart(tx: Tx, customerId: string): Promise<string> {
  const [row] = await tx
    .insert(carts)
    .values({ customerId })
    .onConflictDoUpdate({ target: carts.customerId, set: { lastActivityAt: sql`now()`, updatedAt: sql`now()` } })
    .returning({ id: carts.id });
  if (!row) throw new Error("failed to upsert customer cart");
  return row.id;
}

/** Get-or-create the guest cart for the cookie hash; the DO UPDATE takes the row lock. A row with
 * that hash that belongs to a customer is never opened by the cookie alone. */
async function upsertGuestCart(tx: Tx, tokenHash: string): Promise<string> {
  const [row] = await tx
    .insert(carts)
    .values({ tokenHash })
    .onConflictDoUpdate({
      target: carts.tokenHash,
      set: { lastActivityAt: sql`now()`, updatedAt: sql`now()` },
      setWhere: isNull(carts.customerId),
    })
    .returning({ id: carts.id });
  if (!row) throw new Error("cart token belongs to a customer cart");
  return row.id;
}

interface MergeLine {
  sku: string;
  qty: number;
  addedAt: Date;
}

/** Folds the guest's lines into the customer's (plan §4.1): the same SKU becomes
 * `LEAST(old + new, 10)`; then the cart is trimmed to 20 pieces. Priority for the cap is the
 * guest's lines first (what the buyer was just shopping for), in the order they were added, then
 * the customer's older lines; whatever crosses 20 is cut, and lines past it are dropped. */
export function mergeCartLines(
  guestLines: readonly MergeLine[],
  customerLines: readonly MergeLine[],
): { lines: MergeLine[]; trimmed: boolean } {
  const merged = new Map<string, MergeLine>();
  for (const line of [...guestLines, ...customerLines]) {
    const existing = merged.get(line.sku);
    if (existing) {
      existing.qty = Math.min(existing.qty + line.qty, CART_MAX_QTY_PER_LINE);
      if (line.addedAt < existing.addedAt) existing.addedAt = line.addedAt;
    } else {
      merged.set(line.sku, { sku: line.sku, qty: Math.min(line.qty, CART_MAX_QTY_PER_LINE), addedAt: line.addedAt });
    }
  }

  const lines: MergeLine[] = [];
  let pieces = 0;
  let trimmed = false;
  for (const line of merged.values()) {
    const room = CART_MAX_PIECES - pieces;
    if (room <= 0) {
      trimmed = true;
      continue;
    }
    const qty = Math.min(line.qty, room);
    if (qty < line.qty) trimmed = true;
    lines.push({ ...line, qty });
    pieces += qty;
  }
  return { lines, trimmed };
}

async function cartLinesForMerge(tx: Tx, cartId: string): Promise<MergeLine[]> {
  return tx
    .select({ sku: cartItems.sku, qty: cartItems.qty, addedAt: cartItems.addedAt })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.addedAt), asc(cartItems.sku));
}

/** Merges the guest cart (if it still exists) into the customer's, inside `tx`. Lock order is
 * always guest cart, then customer cart, so two merges never deadlock; the second of two
 * concurrent merges of the same guest cart finds it gone and does nothing. */
async function mergeGuestIntoCustomer(tx: Tx, customerId: string, guestTokenHash: string): Promise<{ merged: boolean; trimmed: boolean }> {
  const guestCartId = await findGuestCartId(tx, guestTokenHash, true);
  if (!guestCartId) return { merged: false, trimmed: false };

  const guestLines = await cartLinesForMerge(tx, guestCartId);
  if (guestLines.length === 0) {
    // Nothing to carry over: drop the empty guest cart without creating a customer cart.
    await tx.delete(carts).where(eq(carts.id, guestCartId));
    return { merged: true, trimmed: false };
  }
  const customerCartId = await upsertCustomerCart(tx, customerId);
  const { lines, trimmed } = mergeCartLines(guestLines, await cartLinesForMerge(tx, customerCartId));

  await tx.delete(cartItems).where(eq(cartItems.cartId, customerCartId));
  if (lines.length > 0) {
    await tx.insert(cartItems).values(lines.map((line) => ({ cartId: customerCartId, sku: line.sku, qty: line.qty, addedAt: line.addedAt })));
  }
  // Cascades to the guest's cart_items.
  await tx.delete(carts).where(eq(carts.id, guestCartId));
  return { merged: true, trimmed };
}

/** A stale cookie (its cart already merged) is the common case after login and is seen on every
 * render until an action clears it, so look without a lock or transaction first; the merge
 * re-checks under its lock. */
async function mergeIfGuestCartExists(db: Database, customerId: string, guestTokenHash: string): Promise<{ merged: boolean; trimmed: boolean }> {
  if (!(await findGuestCartId(db, guestTokenHash, false))) return { merged: false, trimmed: false };
  return db.transaction((tx) => mergeGuestIntoCustomer(tx, customerId, guestTokenHash));
}

/** The cart for `identity`, without creating one. With a session and a guest cookie, merges the
 * guest cart into the customer's first (plan §4.1: on the first cart read or write after any
 * login). Safe to call from a page render: it never needs to set a cookie itself, it only reports
 * `clearGuestCookie` for the next response that can. */
export async function resolveCart(db: Database, identity: CartIdentity): Promise<CartResolution> {
  const { customerId, guestTokenHash } = identity;
  if (customerId) {
    if (!guestTokenHash) return { cartId: await findCustomerCartId(db, customerId, false), clearGuestCookie: false, mergeTrimmed: false };
    const { trimmed } = await mergeIfGuestCartExists(db, customerId, guestTokenHash);
    return { cartId: await findCustomerCartId(db, customerId, false), clearGuestCookie: true, mergeTrimmed: trimmed };
  }
  if (guestTokenHash) return { cartId: await findGuestCartId(db, guestTokenHash, false), clearGuestCookie: false, mergeTrimmed: false };
  return noCart(false);
}

interface LockedCart {
  cartId: string | null;
  clearGuestCookie: boolean;
  mergeTrimmed: boolean;
}

/** Inside `tx`: the identity's cart row, locked (any merge already ran). `create` makes one when
 * missing (an add, whose upsert also bumps `last_activity_at`); otherwise a missing cart is
 * `cartId: null` (set quantity, remove). */
async function lockCartForWrite(tx: Tx, identity: CartIdentity, create: boolean): Promise<LockedCart & { touched: boolean }> {
  const { customerId, guestTokenHash } = identity;
  if (customerId) {
    const cartId = create ? await upsertCustomerCart(tx, customerId) : await findCustomerCartId(tx, customerId, true);
    return { cartId, clearGuestCookie: false, mergeTrimmed: false, touched: create };
  }
  if (!guestTokenHash) throw new Error("a cart write needs a customer or a guest cart token");
  if (!create) return { cartId: await findGuestCartId(tx, guestTokenHash, true), clearGuestCookie: false, mergeTrimmed: false, touched: false };
  return { cartId: await upsertGuestCart(tx, guestTokenHash), clearGuestCookie: false, mergeTrimmed: false, touched: true };
}

async function touchCart(tx: Tx, cartId: string): Promise<void> {
  await tx.update(carts).set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` }).where(eq(carts.id, cartId));
}

async function cartPieceCountById(tx: Database, cartId: string): Promise<number> {
  const [row] = await tx
    .select({ pieces: sql<number>`coalesce(sum(${cartItems.qty}), 0)::int` })
    .from(cartItems)
    .where(eq(cartItems.cartId, cartId));
  return row?.pieces ?? 0;
}

async function lineQty(tx: Tx, cartId: string, sku: string): Promise<number | null> {
  const [row] = await tx
    .select({ qty: cartItems.qty })
    .from(cartItems)
    .where(and(eq(cartItems.cartId, cartId), eq(cartItems.sku, sku)));
  return row?.qty ?? null;
}

/** Whether the SKU may be in a cart (active, published product; active variant) and how much of
 * it is sellable. The quantity stays inside this module. */
async function skuForSale(tx: Tx, sku: string): Promise<{ purchasable: boolean; sellable: number } | null> {
  const [row] = await tx
    .select({
      productActive: products.isActive,
      published: products.isPublishedOnStorefront,
      variantActive: productVariants.isActive,
      sellable: sellableQtySql(qualifiedColumn(productVariants, productVariants.sku)),
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.sku, sku));
  if (!row) return null;
  return { purchasable: row.productActive && row.published && row.variantActive, sellable: Number(row.sellable) };
}

function stockRefusal(sellable: number, wantedQty: number): "sold_out" | "insufficient_stock" | null {
  if (sellable <= 0) return "sold_out";
  if (sellable < wantedQty) return "insufficient_stock";
  return null;
}

async function runCartWrite(
  db: Database,
  identity: CartIdentity,
  create: boolean,
  apply: (tx: Tx, cartId: string | null) => Promise<void>,
): Promise<CartWriteResult> {
  const { customerId, guestTokenHash } = identity;
  // The merge commits on its own: a refused write below must not undo it.
  const merge = customerId && guestTokenHash ? await mergeIfGuestCartExists(db, customerId, guestTokenHash) : null;
  const writeIdentity: CartIdentity = customerId ? { customerId, guestTokenHash: null } : identity;
  try {
    return await db.transaction(async (tx) => {
      const locked = await lockCartForWrite(tx, writeIdentity, create);
      await apply(tx, locked.cartId);
      if (locked.cartId && !locked.touched) await touchCart(tx, locked.cartId);
      return {
        ok: true as const,
        cartId: locked.cartId,
        pieceCount: locked.cartId ? await cartPieceCountById(tx, locked.cartId) : 0,
        clearGuestCookie: merge !== null,
        mergeTrimmed: merge?.trimmed ?? false,
      };
    });
  } catch (error) {
    if (error instanceof CartRefused) return { ok: false, reason: error.reason };
    throw error;
  }
}

/** "Tambah ke keranjang": adds `qty` of `sku`, on top of what the line already holds. */
export async function addCartItem(db: Database, identity: CartIdentity, sku: string, qty: number): Promise<CartWriteResult> {
  if (!isValidLineQty(qty)) return { ok: false, reason: "invalid_qty" };
  return runCartWrite(db, identity, true, async (tx, cartId) => {
    if (!cartId) throw new Error("cart was not created");
    const sale = await skuForSale(tx, sku);
    if (!sale?.purchasable) throw new CartRefused("not_available");

    const current = (await lineQty(tx, cartId, sku)) ?? 0;
    const nextQty = current + qty;
    if (nextQty > CART_MAX_QTY_PER_LINE) throw new CartRefused("line_limit");
    if ((await cartPieceCountById(tx, cartId)) + qty > CART_MAX_PIECES) throw new CartRefused("cart_limit");
    const refusal = stockRefusal(sale.sellable, nextQty);
    if (refusal) throw new CartRefused(refusal);

    await tx
      .insert(cartItems)
      .values({ cartId, sku, qty: nextQty })
      .onConflictDoUpdate({ target: [cartItems.cartId, cartItems.sku], set: { qty: nextQty } });
  });
}

/** "Beli sekarang" (PDP, owner request 2026-10-21): makes sure the cart holds `sku`, then the buyer
 * goes straight to checkout with the whole cart. A line already there is left as it is (a second
 * tap, or a buyer who added it before, never stacks another piece the buyer did not ask for); it is
 * still checked for sale and stock so checkout does not open on a line it would refuse. A new line
 * is added with one piece under the same rules as addCartItem. */
export async function ensureCartItem(db: Database, identity: CartIdentity, sku: string): Promise<CartWriteResult> {
  return runCartWrite(db, identity, true, async (tx, cartId) => {
    if (!cartId) throw new Error("cart was not created");
    const sale = await skuForSale(tx, sku);
    if (!sale?.purchasable) throw new CartRefused("not_available");

    const current = await lineQty(tx, cartId, sku);
    if (current !== null) {
      const refusal = stockRefusal(sale.sellable, current);
      if (refusal) throw new CartRefused(refusal);
      return;
    }
    if ((await cartPieceCountById(tx, cartId)) + 1 > CART_MAX_PIECES) throw new CartRefused("cart_limit");
    const refusal = stockRefusal(sale.sellable, 1);
    if (refusal) throw new CartRefused(refusal);
    await tx.insert(cartItems).values({ cartId, sku, qty: 1 }).onConflictDoNothing({ target: [cartItems.cartId, cartItems.sku] });
  });
}

/** One line of an `addLinesToCart` call. `reason` is set whenever less than `requested` went in. */
export interface CartLinesAddLine {
  sku: string;
  requested: number;
  added: number;
  reason: Exclude<CartRefusal, "not_in_cart"> | null;
}

export interface CartLinesAddResult {
  cartId: string | null;
  pieceCount: number;
  clearGuestCookie: boolean;
  mergeTrimmed: boolean;
  /** One per distinct SKU, in the order given. */
  lines: CartLinesAddLine[];
}

/** Rolls back a refill that added nothing, so it never creates an empty cart or touches one. */
class NothingAdded extends Error {
  constructor(public readonly lines: CartLinesAddLine[]) {
    super("nothing added");
    this.name = "NothingAdded";
  }
}

/** "Pesan lagi" (plan §4.4, §9.1): puts the lines of a past order back into the cart, adding what
 * fits on top of what the cart holds, in one transaction under the cart row lock (the same rules
 * as addCartItem, line by line). The 10-per-line and 20-piece caps may cut a line down; a line
 * with less sellable stock than it asks for is skipped whole, never cut down to what is left, so
 * the quantity that lands in the cart never reveals a stock count (plan §4.2). A refill that adds
 * nothing writes nothing. */
export async function addLinesToCart(db: Database, identity: CartIdentity, lines: readonly { sku: string; qty: number }[]): Promise<CartLinesAddResult> {
  const wanted = new Map<string, number>();
  for (const line of lines) wanted.set(line.sku, (wanted.get(line.sku) ?? 0) + line.qty);

  const { customerId, guestTokenHash } = identity;
  // The merge commits on its own, like every other cart write.
  const merge = customerId && guestTokenHash ? await mergeIfGuestCartExists(db, customerId, guestTokenHash) : null;
  const writeIdentity: CartIdentity = customerId ? { customerId, guestTokenHash: null } : identity;
  const outcome = { clearGuestCookie: merge !== null, mergeTrimmed: merge?.trimmed ?? false };

  try {
    return await db.transaction(async (tx) => {
      const { cartId } = await lockCartForWrite(tx, writeIdentity, true);
      if (!cartId) throw new Error("cart was not created");
      let pieces = await cartPieceCountById(tx, cartId);
      const results: CartLinesAddLine[] = [];
      for (const [sku, requested] of wanted) {
        const skip = (reason: CartLinesAddLine["reason"]) => results.push({ sku, requested, added: 0, reason });
        if (!Number.isInteger(requested) || requested < 1) {
          skip("invalid_qty");
          continue;
        }
        const sale = await skuForSale(tx, sku);
        if (!sale?.purchasable) {
          skip("not_available");
          continue;
        }
        const current = (await lineQty(tx, cartId, sku)) ?? 0;
        const byLine = CART_MAX_QTY_PER_LINE - current;
        const byCart = CART_MAX_PIECES - pieces;
        const added = Math.max(0, Math.min(requested, byLine, byCart));
        const capReason = added < requested ? (byLine <= byCart ? "line_limit" : "cart_limit") : null;
        // A line the caps leave no room for says so, whatever its stock.
        if (added === 0) {
          skip(capReason);
          continue;
        }
        // Stock is checked on what would really go in; short stock skips the line whole.
        const refusal = stockRefusal(sale.sellable, current + added);
        if (refusal) {
          skip(refusal);
          continue;
        }
        await tx
          .insert(cartItems)
          .values({ cartId, sku, qty: current + added })
          .onConflictDoUpdate({ target: [cartItems.cartId, cartItems.sku], set: { qty: current + added } });
        pieces += added;
        results.push({ sku, requested, added, reason: capReason });
      }
      if (!results.some((line) => line.added > 0)) throw new NothingAdded(results);
      return { cartId, pieceCount: pieces, ...outcome, lines: results };
    });
  } catch (error) {
    if (!(error instanceof NothingAdded)) throw error;
    const cartId = (await resolveCart(db, writeIdentity)).cartId;
    return { cartId, pieceCount: cartId ? await cartPieceCountById(db, cartId) : 0, ...outcome, lines: error.lines };
  }
}

/** The cart stepper: sets the line to `qty`. A line whose product is no longer for sale can only
 * be removed. Otherwise lowering is always allowed (it is how a buyer fixes "Stok tidak cukup
 * untuk jumlah ini"); raising re-checks sellable stock and the cap. */
export async function setCartItemQty(db: Database, identity: CartIdentity, sku: string, qty: number): Promise<CartWriteResult> {
  if (!isValidLineQty(qty)) return { ok: false, reason: "invalid_qty" };
  return runCartWrite(db, identity, false, async (tx, cartId) => {
    const current = cartId ? await lineQty(tx, cartId, sku) : null;
    if (!cartId || current === null) throw new CartRefused("not_in_cart");
    const sale = await skuForSale(tx, sku);
    if (!sale?.purchasable) throw new CartRefused("not_available");

    if (qty > current) {
      if ((await cartPieceCountById(tx, cartId)) - current + qty > CART_MAX_PIECES) throw new CartRefused("cart_limit");
      const refusal = stockRefusal(sale.sellable, qty);
      if (refusal) throw new CartRefused(refusal);
    }
    await tx
      .update(cartItems)
      .set({ qty })
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.sku, sku)));
  });
}

/** Removes the line; removing a line that is not there is a no-op. */
export async function removeCartItem(db: Database, identity: CartIdentity, sku: string): Promise<CartWriteResult> {
  return runCartWrite(db, identity, false, async (tx, cartId) => {
    if (!cartId) return;
    await tx.delete(cartItems).where(and(eq(cartItems.cartId, cartId), eq(cartItems.sku, sku)));
  });
}

/** Pieces in the identity's cart (the header count). Merges like every other cart read. */
export async function getCartPieceCount(db: Database, identity: CartIdentity): Promise<number> {
  const { cartId } = await resolveCart(db, identity);
  return cartId ? cartPieceCountById(db, cartId) : 0;
}

function lineStatus(row: { productActive: boolean; published: boolean; variantActive: boolean; sellable: number; qty: number }): CartLineStatus {
  if (!(row.productActive && row.published && row.variantActive)) return "unavailable";
  if (row.sellable <= 0) return "sold_out";
  if (row.sellable < row.qty) return "insufficient";
  return "ok";
}

/** The cart page (plan §4.2), re-read uncached on every render: current prices and availability
 * per line, never a stock count. */
export async function getCartView(db: Database, identity: CartIdentity): Promise<CartView> {
  const resolution = await resolveCart(db, identity);
  if (!resolution.cartId) return { ...resolution, lines: [], pieceCount: 0, subtotal: 0, canCheckout: false };

  const rows = await db
    .select({
      sku: cartItems.sku,
      qty: cartItems.qty,
      productId: products.id,
      productName: products.name,
      productSlug: products.slug,
      basePrice: products.basePrice,
      thumbnailImageId: products.thumbnailImageId,
      productActive: products.isActive,
      published: products.isPublishedOnStorefront,
      variantActive: productVariants.isActive,
      size: productVariants.size,
      fabricColorId: productVariants.fabricColorId,
      colorName: fabricColors.name,
      sellable: sellableQtySql(qualifiedColumn(cartItems, cartItems.sku)),
    })
    .from(cartItems)
    .innerJoin(productVariants, eq(productVariants.sku, cartItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(cartItems.cartId, resolution.cartId))
    .orderBy(asc(cartItems.addedAt), asc(cartItems.sku));

  const productIds = [...new Set(rows.map((row) => row.productId))];
  const images =
    productIds.length === 0
      ? []
      : await db
          .select({
            id: productImages.id,
            productId: productImages.productId,
            fabricColorId: productImages.fabricColorId,
            storageKey: productImages.storageKey,
            altText: productImages.altText,
            width: productImages.width,
            height: productImages.height,
          })
          .from(productImages)
          .where(inArray(productImages.productId, productIds))
          .orderBy(asc(productImages.sortOrder), asc(productImages.id));

  // The line's own colour first, then the product's chosen thumbnail, then its first image.
  const pickImage = (row: (typeof rows)[number]): CartLineImage | null => {
    const own = images.filter((image) => image.productId === row.productId);
    const image =
      own.find((candidate) => candidate.fabricColorId === row.fabricColorId) ??
      own.find((candidate) => candidate.id === row.thumbnailImageId) ??
      own[0];
    return image ? { storageKey: image.storageKey, altText: image.altText, width: image.width, height: image.height } : null;
  };

  const lines: CartLine[] = rows.map((row) => ({
    sku: row.sku,
    productName: row.productName,
    productSlug: row.productSlug,
    colorName: row.colorName,
    sizeLabel: sizeLabel(row.size),
    qty: row.qty,
    unitPrice: row.basePrice,
    lineTotal: row.basePrice * row.qty,
    status: lineStatus({ ...row, sellable: Number(row.sellable) }),
    image: pickImage(row),
  }));

  const pieceCount = lines.reduce((sum, line) => sum + line.qty, 0);
  const subtotal = lines
    .filter((line) => line.status === "ok" || line.status === "insufficient")
    .reduce((sum, line) => sum + line.lineTotal, 0);
  const canCheckout = lines.length > 0 && pieceCount <= CART_MAX_PIECES && lines.every((line) => line.status === "ok");
  return { ...resolution, lines, pieceCount, subtotal, canCheckout };
}
