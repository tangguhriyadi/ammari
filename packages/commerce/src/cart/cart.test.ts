import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertCustomer, insertFabricColor, insertProductVariant, insertStockReservation, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { cartItems, carts, customers, fabricColors, fabrics, productImages, products, productVariants, stockMovements } from "@ammari/db/schema";
import { CART_MAX_PIECES, CART_MAX_QTY_PER_LINE } from "./limits";
import { generateCartToken, hashCartToken, isWellFormedCartToken } from "./token";
import {
  addCartItem,
  ensureCartItem,
  addLinesToCart,
  getCartPieceCount,
  getCartView,
  removeCartItem,
  resolveCart,
  setCartItemQty,
  type CartIdentity,
} from "./cart";

// docs/plans/cart-checkout.md §4.1, §4.2, session 5: database-backed cart, guest cookie hash or
// customer, merge on login, 10 per line and 20 per cart, re-checked availability.

async function seedStock(tx: TestDatabase, sku: string, qty: number) {
  await tx.insert(stockMovements).values({ sku, qty, valueAmount: qty * 100_000, type: "production", refType: "manual" });
}

/** An active, published product with one active variant (size M) and `stock` pieces. */
async function sellableVariant(tx: TestDatabase, stock = 20) {
  const fixture = await insertProductVariant(tx);
  await tx.update(products).set({ isPublishedOnStorefront: true }).where(eq(products.id, fixture.product.id));
  if (stock > 0) await seedStock(tx, fixture.variant.sku, stock);
  return fixture;
}

/** A second variant (another size) of the same published product. */
async function siblingVariant(tx: TestDatabase, base: Awaited<ReturnType<typeof sellableVariant>>, size: "L" | "XL", stock = 20) {
  const [variant] = await tx
    .insert(productVariants)
    .values({
      sku: `SKU-${randomUUID()}`,
      productId: base.product.id,
      fabricId: base.fabric.id,
      fabricColorId: base.color.id,
      closure: base.product.closure,
      size,
    })
    .returning();
  if (!variant) throw new Error("failed to insert sibling variant");
  if (stock > 0) await seedStock(tx, variant.sku, stock);
  return variant;
}

function guest(): CartIdentity & { guestTokenHash: string } {
  return { customerId: null, guestTokenHash: hashCartToken(generateCartToken()) };
}

async function linesOf(tx: TestDatabase, cartId: string) {
  const rows = await tx.select({ sku: cartItems.sku, qty: cartItems.qty }).from(cartItems).where(eq(cartItems.cartId, cartId));
  return Object.fromEntries(rows.map((row) => [row.sku, row.qty]));
}

async function expectAdded(result: Awaited<ReturnType<typeof addCartItem>>): Promise<string> {
  if (!result.ok) throw new Error(`expected the add to succeed, got ${result.reason}`);
  if (!result.cartId) throw new Error("expected a cart");
  return result.cartId;
}

describe("cart token", () => {
  test("is 32 random bytes in base64url, hashed with sha256 hex", () => {
    const token = generateCartToken();
    expect(isWellFormedCartToken(token)).toBe(true);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(generateCartToken()).not.toBe(token);
    expect(hashCartToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCartToken(token)).toBe(hashCartToken(token));
  });

  test("anything else in the cookie is not a token", () => {
    for (const value of ["", "abc", `${generateCartToken()}x`, "a".repeat(42) + "=", "a".repeat(42) + "+", " ".repeat(43)]) {
      expect(isWellFormedCartToken(value)).toBe(false);
    }
  });
});

describe("ensureCartItem (\"Beli sekarang\")", () => {
  test("adds one piece of a SKU the cart does not hold, and never stacks another on a repeat", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const identity = guest();
      const cartId = await expectAdded(await ensureCartItem(tx, identity, variant.sku));
      expect(await linesOf(tx, cartId)).toEqual({ [variant.sku]: 1 });
      expect(await ensureCartItem(tx, identity, variant.sku)).toMatchObject({ ok: true, cartId, pieceCount: 1 });
      await addCartItem(tx, identity, variant.sku, 2);
      expect(await ensureCartItem(tx, identity, variant.sku)).toMatchObject({ ok: true, cartId, pieceCount: 3 });
      expect(await linesOf(tx, cartId)).toEqual({ [variant.sku]: 3 });
    });
  });

  test("refuses what checkout would refuse: not for sale, sold out, a held line above stock, a full cart", async () => {
    await withRollback(async (tx) => {
      const unpublished = await insertProductVariant(tx);
      await seedStock(tx, unpublished.variant.sku, 5);
      expect(await ensureCartItem(tx, guest(), unpublished.variant.sku)).toEqual({ ok: false, reason: "not_available" });

      const soldOut = await sellableVariant(tx, 0);
      expect(await ensureCartItem(tx, guest(), soldOut.variant.sku)).toEqual({ ok: false, reason: "sold_out" });

      const { variant } = await sellableVariant(tx, 3);
      const identity = guest();
      await addCartItem(tx, identity, variant.sku, 3);
      // Another buyer's order now holds two of the three pieces.
      await insertStockReservation(tx, { sku: variant.sku, qty: 2 });
      expect(await ensureCartItem(tx, identity, variant.sku)).toEqual({ ok: false, reason: "insufficient_stock" });

      const full = guest();
      const many = await sellableVariant(tx, 30);
      await addCartItem(tx, full, many.variant.sku, CART_MAX_QTY_PER_LINE);
      const more = await sellableVariant(tx, 30);
      await addCartItem(tx, full, more.variant.sku, CART_MAX_PIECES - CART_MAX_QTY_PER_LINE);
      const another = await sellableVariant(tx, 30);
      expect(await ensureCartItem(tx, full, another.variant.sku)).toEqual({ ok: false, reason: "cart_limit" });
    });
  });
});

describe("addCartItem", () => {
  test("a guest's first add creates a cart under the cookie hash only; a second add of the same SKU adds to the line", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const identity = guest();

      const first = await addCartItem(tx, identity, variant.sku, 2);
      const cartId = await expectAdded(first);
      expect(first).toMatchObject({ ok: true, pieceCount: 2 });

      const [cart] = await tx.select().from(carts).where(eq(carts.id, cartId));
      expect(cart).toMatchObject({ tokenHash: identity.guestTokenHash, customerId: null });

      const second = await addCartItem(tx, identity, variant.sku, 3);
      expect(second).toMatchObject({ ok: true, cartId, pieceCount: 5 });
      expect(await linesOf(tx, cartId)).toEqual({ [variant.sku]: 5 });
    });
  });

  test("a logged-in customer's cart is keyed by customer, never by a token", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const customer = await insertCustomer(tx);

      const cartId = await expectAdded(await addCartItem(tx, { customerId: customer.id, guestTokenHash: null }, variant.sku, 1));
      const [cart] = await tx.select().from(carts).where(eq(carts.id, cartId));
      expect(cart).toMatchObject({ customerId: customer.id, tokenHash: null });

      // The same customer later gets the same cart.
      const again = await addCartItem(tx, { customerId: customer.id, guestTokenHash: null }, variant.sku, 1);
      expect(again).toMatchObject({ ok: true, cartId, pieceCount: 2 });
    });
  });

  test("only active, published products and active variants can be added; a refusal leaves no cart behind", async () => {
    await withRollback(async (tx) => {
      const unpublished = await insertProductVariant(tx);
      await seedStock(tx, unpublished.variant.sku, 5);

      const inactiveVariant = await sellableVariant(tx);
      await tx.update(productVariants).set({ isActive: false }).where(eq(productVariants.sku, inactiveVariant.variant.sku));

      const inactiveProduct = await sellableVariant(tx);
      await tx
        .update(products)
        .set({ isActive: false, isPublishedOnStorefront: false })
        .where(eq(products.id, inactiveProduct.product.id));

      for (const sku of [unpublished.variant.sku, inactiveVariant.variant.sku, inactiveProduct.variant.sku, `SKU-${randomUUID()}`]) {
        const identity = guest();
        expect(await addCartItem(tx, identity, sku, 1)).toEqual({ ok: false, reason: "not_available" });
        expect(await tx.select().from(carts).where(eq(carts.tokenHash, identity.guestTokenHash))).toHaveLength(0);
      }
    });
  });

  test("refuses a sold-out SKU and a quantity above what is sellable; other orders' active holds count", async () => {
    await withRollback(async (tx) => {
      const soldOut = await sellableVariant(tx, 0);
      expect(await addCartItem(tx, guest(), soldOut.variant.sku, 1)).toEqual({ ok: false, reason: "sold_out" });

      const { variant } = await sellableVariant(tx, 3);
      await insertStockReservation(tx, { sku: variant.sku, qty: 2 });
      // 3 physical - 2 held = 1 sellable.
      expect(await addCartItem(tx, guest(), variant.sku, 2)).toEqual({ ok: false, reason: "insufficient_stock" });

      const identity = guest();
      const cartId = await expectAdded(await addCartItem(tx, identity, variant.sku, 1));
      // The line total counts: 1 already in the cart + 1 more is above the 1 sellable.
      expect(await addCartItem(tx, identity, variant.sku, 1)).toEqual({ ok: false, reason: "insufficient_stock" });
      expect(await linesOf(tx, cartId)).toEqual({ [variant.sku]: 1 });
    });
  });

  test("an expired hold no longer reduces what can be added", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx, 2);
      await insertStockReservation(tx, { sku: variant.sku, qty: 2, expiresAt: new Date(Date.now() - 60_000) });
      expect(await addCartItem(tx, guest(), variant.sku, 2)).toMatchObject({ ok: true });
    });
  });

  test(`at most ${CART_MAX_QTY_PER_LINE} per line, counting what is already in the cart`, async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const identity = guest();
      const cartId = await expectAdded(await addCartItem(tx, identity, variant.sku, 8));
      expect(await addCartItem(tx, identity, variant.sku, 3)).toEqual({ ok: false, reason: "line_limit" });
      expect(await addCartItem(tx, identity, variant.sku, 2)).toMatchObject({ ok: true, pieceCount: 10 });
      expect(await addCartItem(tx, identity, variant.sku, 1)).toEqual({ ok: false, reason: "line_limit" });
      expect(await linesOf(tx, cartId)).toEqual({ [variant.sku]: 10 });
    });
  });

  test(`at most ${CART_MAX_PIECES} pieces across the whole cart`, async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx);
      const second = await siblingVariant(tx, base, "L");
      const third = await siblingVariant(tx, base, "XL");
      const identity = guest();
      await expectAdded(await addCartItem(tx, identity, base.variant.sku, 10));
      await expectAdded(await addCartItem(tx, identity, second.sku, 9));
      expect(await addCartItem(tx, identity, third.sku, 2)).toEqual({ ok: false, reason: "cart_limit" });
      expect(await addCartItem(tx, identity, third.sku, 1)).toMatchObject({ ok: true, pieceCount: 20 });
      expect(await addCartItem(tx, identity, third.sku, 1)).toEqual({ ok: false, reason: "cart_limit" });
    });
  });

  test("refuses quantities that are not an integer from 1 to 10", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      for (const qty of [0, -1, 1.5, Number.NaN, 11]) {
        expect(await addCartItem(tx, guest(), variant.sku, qty)).toEqual({ ok: false, reason: "invalid_qty" });
      }
    });
  });

  test("a write without any identity is a programming error", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      await expect(addCartItem(tx, { customerId: null, guestTokenHash: null }, variant.sku, 1)).rejects.toThrow();
    });
  });

  test("every write moves last_activity_at forward (retention, plan §11)", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const identity = guest();
      const cartId = await expectAdded(await addCartItem(tx, identity, variant.sku, 1));
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await tx.update(carts).set({ lastActivityAt: old }).where(eq(carts.id, cartId));

      await addCartItem(tx, identity, variant.sku, 1);
      const [cart] = await tx.select().from(carts).where(eq(carts.id, cartId));
      expect(cart?.lastActivityAt.getTime()).toBeGreaterThan(old.getTime());
    });
  });
});

describe("setCartItemQty and removeCartItem", () => {
  test("sets a line's quantity; refuses a line that is not in the cart", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const other = await sellableVariant(tx);
      const identity = guest();
      const cartId = await expectAdded(await addCartItem(tx, identity, variant.sku, 2));

      expect(await setCartItemQty(tx, identity, variant.sku, 7)).toMatchObject({ ok: true, cartId, pieceCount: 7 });
      expect(await setCartItemQty(tx, identity, variant.sku, 1)).toMatchObject({ ok: true, pieceCount: 1 });
      expect(await setCartItemQty(tx, identity, other.variant.sku, 1)).toEqual({ ok: false, reason: "not_in_cart" });
      expect(await setCartItemQty(tx, identity, variant.sku, 11)).toEqual({ ok: false, reason: "invalid_qty" });
      expect(await setCartItemQty(tx, identity, variant.sku, 0)).toEqual({ ok: false, reason: "invalid_qty" });
      expect(await linesOf(tx, cartId)).toEqual({ [variant.sku]: 1 });
    });
  });

  test("a guest with no cart yet gets not_in_cart and no cart is created", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const identity = guest();
      expect(await setCartItemQty(tx, identity, variant.sku, 1)).toEqual({ ok: false, reason: "not_in_cart" });
      expect(await tx.select().from(carts).where(eq(carts.tokenHash, identity.guestTokenHash))).toHaveLength(0);
    });
  });

  test("lowering is always allowed while stock is short; raising checks sellable stock and the cart cap", async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx, 5);
      const second = await siblingVariant(tx, base, "L");
      const identity = guest();
      await expectAdded(await addCartItem(tx, identity, base.variant.sku, 5));
      await expectAdded(await addCartItem(tx, identity, second.sku, 10));

      // Someone else's checkout now holds 4 of the 5.
      await insertStockReservation(tx, { sku: base.variant.sku, qty: 4 });
      expect(await setCartItemQty(tx, identity, base.variant.sku, 3)).toMatchObject({ ok: true });
      expect(await setCartItemQty(tx, identity, base.variant.sku, 2)).toMatchObject({ ok: true });
      expect(await setCartItemQty(tx, identity, base.variant.sku, 3)).toEqual({ ok: false, reason: "insufficient_stock" });

      // 10 + 10 = 20 is fine for stock-rich lines; the cap is the cart's.
      await seedStock(tx, base.variant.sku, 50);
      expect(await setCartItemQty(tx, identity, base.variant.sku, 10)).toMatchObject({ ok: true, pieceCount: 20 });
      const third = await siblingVariant(tx, base, "XL");
      expect(await addCartItem(tx, identity, third.sku, 1)).toEqual({ ok: false, reason: "cart_limit" });
    });
  });

  test("a line whose product was unpublished can only be removed", async () => {
    await withRollback(async (tx) => {
      const { variant, product } = await sellableVariant(tx);
      const identity = guest();
      const cartId = await expectAdded(await addCartItem(tx, identity, variant.sku, 3));
      await tx.update(products).set({ isPublishedOnStorefront: false }).where(eq(products.id, product.id));

      expect(await setCartItemQty(tx, identity, variant.sku, 1)).toEqual({ ok: false, reason: "not_available" });
      expect(await removeCartItem(tx, identity, variant.sku)).toMatchObject({ ok: true, cartId, pieceCount: 0 });
      expect(await linesOf(tx, cartId)).toEqual({});
      // Removing it again is a no-op, not an error.
      expect(await removeCartItem(tx, identity, variant.sku)).toMatchObject({ ok: true, pieceCount: 0 });
    });
  });

  test("one buyer's cart is never reachable from another identity", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const owner = guest();
      const ownerCart = await expectAdded(await addCartItem(tx, owner, variant.sku, 2));

      const stranger = guest();
      expect(await removeCartItem(tx, stranger, variant.sku)).toMatchObject({ ok: true, pieceCount: 0 });
      expect(await setCartItemQty(tx, stranger, variant.sku, 1)).toEqual({ ok: false, reason: "not_in_cart" });
      const customer = await insertCustomer(tx);
      expect(await getCartPieceCount(tx, { customerId: customer.id, guestTokenHash: null })).toBe(0);
      expect(await linesOf(tx, ownerCart)).toEqual({ [variant.sku]: 2 });
    });
  });
});

describe("resolveCart and the login merge", () => {
  test("no cookie and no session, an unknown cookie, or a customer without a cart: no cart and nothing written", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx);
      expect(await resolveCart(tx, { customerId: null, guestTokenHash: null })).toEqual({
        cartId: null,
        clearGuestCookie: false,
        mergeTrimmed: false,
      });
      expect(await resolveCart(tx, guest())).toEqual({ cartId: null, clearGuestCookie: false, mergeTrimmed: false });
      expect(await resolveCart(tx, { customerId: customer.id, guestTokenHash: null })).toEqual({
        cartId: null,
        clearGuestCookie: false,
        mergeTrimmed: false,
      });
      expect(await tx.select().from(carts).where(eq(carts.customerId, customer.id))).toHaveLength(0);
    });
  });

  test("session + guest cookie: lines merge into the customer cart (LEAST(old + new, 10)), the guest cart is deleted", async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx);
      const onlyGuest = await siblingVariant(tx, base, "L");
      const customer = await insertCustomer(tx);
      const customerIdentity = { customerId: customer.id, guestTokenHash: null };
      const customerCart = await expectAdded(await addCartItem(tx, customerIdentity, base.variant.sku, 6));

      const guestIdentity = guest();
      const guestCart = await expectAdded(await addCartItem(tx, guestIdentity, base.variant.sku, 7));
      await expectAdded(await addCartItem(tx, guestIdentity, onlyGuest.sku, 2));

      const resolved = await resolveCart(tx, { customerId: customer.id, guestTokenHash: guestIdentity.guestTokenHash });
      expect(resolved).toEqual({ cartId: customerCart, clearGuestCookie: true, mergeTrimmed: false });
      expect(await linesOf(tx, customerCart)).toEqual({ [base.variant.sku]: 10, [onlyGuest.sku]: 2 });
      expect(await tx.select().from(carts).where(eq(carts.id, guestCart))).toHaveLength(0);

      // A replay (the cookie was not cleared yet) is a no-op that still asks to clear it.
      expect(await resolveCart(tx, { customerId: customer.id, guestTokenHash: guestIdentity.guestTokenHash })).toEqual({
        cartId: customerCart,
        clearGuestCookie: true,
        mergeTrimmed: false,
      });
      expect(await linesOf(tx, customerCart)).toEqual({ [base.variant.sku]: 10, [onlyGuest.sku]: 2 });
    });
  });

  test("a customer without a cart takes over the guest's lines", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const customer = await insertCustomer(tx);
      const guestIdentity = guest();
      await expectAdded(await addCartItem(tx, guestIdentity, variant.sku, 3));

      const resolved = await resolveCart(tx, { customerId: customer.id, guestTokenHash: guestIdentity.guestTokenHash });
      if (!resolved.cartId) throw new Error("expected a cart");
      const [cart] = await tx.select().from(carts).where(eq(carts.id, resolved.cartId));
      expect(cart).toMatchObject({ customerId: customer.id, tokenHash: null });
      expect(await linesOf(tx, resolved.cartId)).toEqual({ [variant.sku]: 3 });
      expect(await tx.select().from(carts).where(eq(carts.tokenHash, guestIdentity.guestTokenHash))).toHaveLength(0);
    });
  });

  test(`a merge above ${CART_MAX_PIECES} pieces is trimmed, keeping the guest's (newest) lines first`, async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx);
      const l = await siblingVariant(tx, base, "L");
      const xl = await siblingVariant(tx, base, "XL");
      const customer = await insertCustomer(tx);
      const customerIdentity = { customerId: customer.id, guestTokenHash: null };
      const customerCart = await expectAdded(await addCartItem(tx, customerIdentity, base.variant.sku, 10));
      await expectAdded(await addCartItem(tx, customerIdentity, l.sku, 8));

      const guestIdentity = guest();
      await expectAdded(await addCartItem(tx, guestIdentity, xl.sku, 9));
      await expectAdded(await addCartItem(tx, guestIdentity, l.sku, 1));

      const resolved = await resolveCart(tx, { customerId: customer.id, guestTokenHash: guestIdentity.guestTokenHash });
      expect(resolved).toEqual({ cartId: customerCart, clearGuestCookie: true, mergeTrimmed: true });
      // Guest first: XL 9, then L 1 + 8 = 9 (merged line keeps the guest's position), then the
      // customer's M 10 is cut to the 2 pieces left under the cap.
      expect(await linesOf(tx, customerCart)).toEqual({ [xl.sku]: 9, [l.sku]: 9, [base.variant.sku]: 2 });
      expect(await getCartPieceCount(tx, customerIdentity)).toBe(CART_MAX_PIECES);
    });
  });

  test("a merge drops lines that no longer fit at all", async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx);
      const l = await siblingVariant(tx, base, "L");
      const xl = await siblingVariant(tx, base, "XL");
      const customer = await insertCustomer(tx);
      const customerIdentity = { customerId: customer.id, guestTokenHash: null };
      const customerCart = await expectAdded(await addCartItem(tx, customerIdentity, base.variant.sku, 5));

      const guestIdentity = guest();
      await expectAdded(await addCartItem(tx, guestIdentity, xl.sku, 10));
      await expectAdded(await addCartItem(tx, guestIdentity, l.sku, 10));

      await resolveCart(tx, { customerId: customer.id, guestTokenHash: guestIdentity.guestTokenHash });
      expect(await linesOf(tx, customerCart)).toEqual({ [xl.sku]: 10, [l.sku]: 10 });
    });
  });

  test("the session's write also merges first, then applies the change", async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx);
      const l = await siblingVariant(tx, base, "L");
      const customer = await insertCustomer(tx);
      const guestIdentity = guest();
      await expectAdded(await addCartItem(tx, guestIdentity, base.variant.sku, 2));

      const result = await addCartItem(tx, { customerId: customer.id, guestTokenHash: guestIdentity.guestTokenHash }, l.sku, 1);
      expect(result).toMatchObject({ ok: true, pieceCount: 3, clearGuestCookie: true });
      const cartId = await expectAdded(result);
      expect(await linesOf(tx, cartId)).toEqual({ [base.variant.sku]: 2, [l.sku]: 1 });
    });
  });

  test("a refused write still keeps the login merge it ran first", async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx);
      const soldOut = await sellableVariant(tx, 0);
      const customer = await insertCustomer(tx);
      const guestIdentity = guest();
      const guestCart = await expectAdded(await addCartItem(tx, guestIdentity, base.variant.sku, 2));

      const both = { customerId: customer.id, guestTokenHash: guestIdentity.guestTokenHash };
      expect(await addCartItem(tx, both, soldOut.variant.sku, 1)).toEqual({ ok: false, reason: "sold_out" });
      expect(await tx.select().from(carts).where(eq(carts.id, guestCart))).toHaveLength(0);
      expect(await getCartPieceCount(tx, { customerId: customer.id, guestTokenHash: null })).toBe(2);
    });
  });

  test("an empty guest cart is dropped at login without creating a customer cart", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx);
      const tokenHash = hashCartToken(generateCartToken());
      await tx.insert(carts).values({ tokenHash });

      expect(await resolveCart(tx, { customerId: customer.id, guestTokenHash: tokenHash })).toEqual({
        cartId: null,
        clearGuestCookie: true,
        mergeTrimmed: false,
      });
      expect(await tx.select().from(carts).where(eq(carts.tokenHash, tokenHash))).toHaveLength(0);
      expect(await tx.select().from(carts).where(eq(carts.customerId, customer.id))).toHaveLength(0);
    });
  });

  test("a customer's first set-quantity or remove, with no cart yet, creates nothing", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const customer = await insertCustomer(tx);
      const identity = { customerId: customer.id, guestTokenHash: null };
      expect(await setCartItemQty(tx, identity, variant.sku, 1)).toEqual({ ok: false, reason: "not_in_cart" });
      expect(await removeCartItem(tx, identity, variant.sku)).toEqual({ ok: true, cartId: null, pieceCount: 0, clearGuestCookie: false, mergeTrimmed: false });
      expect(await tx.select().from(carts).where(eq(carts.customerId, customer.id))).toHaveLength(0);
    });
  });

  test("a guest cookie never opens a cart that belongs to a customer", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const customer = await insertCustomer(tx);
      const tokenHash = hashCartToken(generateCartToken());
      // Both owners set (the schema allows it; this code never writes it): the cookie alone
      // must not be enough.
      const [cart] = await tx.insert(carts).values({ customerId: customer.id, tokenHash }).returning();
      if (!cart) throw new Error("failed to insert cart");
      await tx.insert(cartItems).values({ cartId: cart.id, sku: variant.sku, qty: 1 });

      expect(await resolveCart(tx, { customerId: null, guestTokenHash: tokenHash })).toMatchObject({ cartId: null });
      expect(await getCartPieceCount(tx, { customerId: null, guestTokenHash: tokenHash })).toBe(0);
      await expect(addCartItem(tx, { customerId: null, guestTokenHash: tokenHash }, variant.sku, 1)).rejects.toThrow();
    });
  });

  test("deleting the customer deletes their cart", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const customer = await insertCustomer(tx);
      const cartId = await expectAdded(await addCartItem(tx, { customerId: customer.id, guestTokenHash: null }, variant.sku, 1));
      await tx.delete(customers).where(eq(customers.id, customer.id));
      expect(await tx.select().from(carts).where(eq(carts.id, cartId))).toHaveLength(0);
    });
  });
});

describe("getCartView", () => {
  test("lines carry name, colour, size, the current base price and the colour's image; statuses follow availability", async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx, 5);
      const short = await siblingVariant(tx, base, "L", 1);
      const gone = await siblingVariant(tx, base, "XL", 0);
      const otherColor = await insertFabricColor(tx, base.fabric.id, { name: "Beige" });
      const unpublished = await insertVariantForProduct(tx, base.fabric.id, otherColor.id, { isPublishedOnStorefront: false });
      await seedStock(tx, unpublished.variant.sku, 5);

      const [blackImage, beigeImage] = await tx
        .insert(productImages)
        .values([
          { productId: base.product.id, fabricId: base.fabric.id, fabricColorId: base.color.id, storageKey: `img/${randomUUID()}`, width: 800, height: 1000, sortOrder: 0 },
          { productId: base.product.id, fabricId: base.fabric.id, fabricColorId: otherColor.id, storageKey: `img/${randomUUID()}`, width: 800, height: 1000, sortOrder: 1 },
        ])
        .returning();

      const identity = guest();
      const cartId = await expectAdded(await addCartItem(tx, identity, base.variant.sku, 2));
      await tx.insert(cartItems).values([
        { cartId, sku: short.sku, qty: 3 },
        { cartId, sku: gone.sku, qty: 1 },
        { cartId, sku: unpublished.variant.sku, qty: 1 },
      ]);
      // The price is read at render, never stored on the line.
      await tx.update(products).set({ basePrice: 279_000 }).where(eq(products.id, base.product.id));

      const view = await getCartView(tx, identity);
      expect(view.cartId).toBe(cartId);
      const bySku = Object.fromEntries(view.lines.map((line) => [line.sku, line]));
      expect(bySku[base.variant.sku]).toMatchObject({
        productName: "Gamis Basic",
        productSlug: base.product.slug,
        colorName: "Black",
        sizeLabel: "M",
        qty: 2,
        unitPrice: 279_000,
        lineTotal: 558_000,
        status: "ok",
        image: { storageKey: blackImage?.storageKey, width: 800, height: 1000 },
      });
      expect(bySku[short.sku]).toMatchObject({ status: "insufficient", qty: 3 });
      expect(bySku[gone.sku]).toMatchObject({ status: "sold_out" });
      expect(bySku[unpublished.variant.sku]).toMatchObject({ status: "unavailable", productName: "Produk Test", colorName: "Beige" });
      expect(beigeImage).toBeDefined();

      expect(view.pieceCount).toBe(7);
      // Sold-out and unavailable lines are not in the subtotal.
      expect(view.subtotal).toBe(279_000 * 5);
      expect(view.canCheckout).toBe(false);
    });
  });

  test("an all-ok cart can check out; an empty or missing cart cannot", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const identity = guest();
      expect(await getCartView(tx, identity)).toEqual({ cartId: null, lines: [], pieceCount: 0, subtotal: 0, canCheckout: false, clearGuestCookie: false, mergeTrimmed: false });

      await expectAdded(await addCartItem(tx, identity, variant.sku, 2));
      const view = await getCartView(tx, identity);
      expect(view).toMatchObject({ pieceCount: 2, subtotal: 518_000, canCheckout: true });

      await removeCartItem(tx, identity, variant.sku);
      expect(await getCartView(tx, identity)).toMatchObject({ lines: [], canCheckout: false });
    });
  });

  test("never carries a stock count or any cost/value field", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx, 7);
      const identity = guest();
      await expectAdded(await addCartItem(tx, identity, variant.sku, 1));
      const view = await getCartView(tx, identity);
      const serialized = JSON.stringify(view);
      for (const key of ["cost", "Cost", "valueAmount", "priceAmount", "sellable", "stock", "available"]) {
        expect(serialized).not.toContain(key);
      }
      // 7 in stock must not appear as a number anywhere (qty is 1, prices are 259000).
      expect(view.lines[0] && Object.values(view.lines[0])).not.toContain(7);
    });
  });
});

// Outside withRollback: the race needs two real, separately committed transactions (same as the
// last-piece race in stock/reservations.test.ts). Cleans up its own rows.
describe("concurrency", () => {
  test(`two concurrent adds to the same cart never exceed ${CART_MAX_PIECES} pieces`, async () => {
    const base = await sellableVariant(testDb);
    const l = await siblingVariant(testDb, base, "L");
    const xl = await siblingVariant(testDb, base, "XL");
    const identity = guest();
    let cartId: string | null = null;
    try {
      cartId = await expectAdded(await addCartItem(testDb, identity, base.variant.sku, 10));
      const outcomes = await Promise.all([addCartItem(testDb, identity, l.sku, 6), addCartItem(testDb, identity, xl.sku, 6)]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([{ ok: false, reason: "cart_limit" }]);
      expect(await getCartPieceCount(testDb, identity)).toBe(16);
    } finally {
      if (cartId) await testDb.delete(carts).where(eq(carts.id, cartId));
      await cleanupProduct(base, [l.sku, xl.sku]);
    }
  });

  test("two concurrent first adds from one new guest cookie share one cart", async () => {
    const base = await sellableVariant(testDb);
    const l = await siblingVariant(testDb, base, "L");
    const identity = guest();
    try {
      const outcomes = await Promise.all([addCartItem(testDb, identity, base.variant.sku, 1), addCartItem(testDb, identity, l.sku, 1)]);
      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      const rows = await testDb.select().from(carts).where(eq(carts.tokenHash, identity.guestTokenHash));
      expect(rows).toHaveLength(1);
      expect(await getCartPieceCount(testDb, identity)).toBe(2);
    } finally {
      await testDb.delete(carts).where(eq(carts.tokenHash, identity.guestTokenHash));
      await cleanupProduct(base, [l.sku]);
    }
  });

  test("two concurrent merges of the same guest cart merge it once", async () => {
    const { variant, ...rest } = await sellableVariant(testDb);
    const customer = await insertCustomer(testDb);
    const guestIdentity = guest();
    try {
      await expectAdded(await addCartItem(testDb, guestIdentity, variant.sku, 3));
      const merged = { customerId: customer.id, guestTokenHash: guestIdentity.guestTokenHash };
      const [a, b] = await Promise.all([resolveCart(testDb, merged), resolveCart(testDb, merged)]);
      expect(a.cartId).not.toBeNull();
      expect(b.cartId).toBe(a.cartId);
      expect(await getCartPieceCount(testDb, { customerId: customer.id, guestTokenHash: null })).toBe(3);
    } finally {
      await testDb.delete(customers).where(eq(customers.id, customer.id));
      await testDb.delete(carts).where(eq(carts.tokenHash, guestIdentity.guestTokenHash));
      await cleanupProduct({ variant, ...rest }, []);
    }
  });
});

describe("addLinesToCart (\"Pesan lagi\", plan §4.4, §9.1)", () => {
  test("adds every line of a past order on top of what the cart holds; a guest's first refill creates the cart", async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx);
      const l = await siblingVariant(tx, base, "L");
      const identity = guest();

      const result = await addLinesToCart(tx, identity, [
        { sku: base.variant.sku, qty: 2 },
        { sku: l.sku, qty: 1 },
      ]);
      expect(result).toMatchObject({ pieceCount: 3, clearGuestCookie: false, mergeTrimmed: false });
      expect(result.lines).toEqual([
        { sku: base.variant.sku, requested: 2, added: 2, reason: null },
        { sku: l.sku, requested: 1, added: 1, reason: null },
      ]);
      if (!result.cartId) throw new Error("expected a cart");
      const [cart] = await tx.select().from(carts).where(eq(carts.id, result.cartId));
      expect(cart).toMatchObject({ tokenHash: identity.guestTokenHash, customerId: null });

      // A second refill adds on top of the existing lines.
      const again = await addLinesToCart(tx, identity, [{ sku: base.variant.sku, qty: 2 }]);
      expect(again).toMatchObject({ cartId: result.cartId, pieceCount: 5 });
      expect(await linesOf(tx, result.cartId)).toEqual({ [base.variant.sku]: 4, [l.sku]: 1 });
    });
  });

  test("a sold-out line and a line no longer for sale are skipped; the rest is still added", async () => {
    await withRollback(async (tx) => {
      const ok = await sellableVariant(tx);
      const soldOut = await sellableVariant(tx, 0);
      const unpublished = await sellableVariant(tx);
      await tx.update(products).set({ isPublishedOnStorefront: false }).where(eq(products.id, unpublished.product.id));
      const identity = guest();

      const result = await addLinesToCart(tx, identity, [
        { sku: soldOut.variant.sku, qty: 1 },
        { sku: ok.variant.sku, qty: 1 },
        { sku: unpublished.variant.sku, qty: 1 },
        { sku: `SKU-${randomUUID()}`, qty: 1 },
      ]);
      expect(result.pieceCount).toBe(1);
      expect(result.lines.map((line) => [line.added, line.reason])).toEqual([
        [0, "sold_out"],
        [1, null],
        [0, "not_available"],
        [0, "not_available"],
      ]);
    });
  });

  test("a line with less sellable stock than ordered is skipped whole, never cut down to the stock (no count leaks); holds count", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx, 3);
      await insertStockReservation(tx, { sku: variant.sku, qty: 1 });
      const identity = guest();

      // 3 physical - 1 held = 2 sellable, 3 ordered.
      const result = await addLinesToCart(tx, identity, [{ sku: variant.sku, qty: 3 }]);
      expect(result.lines).toEqual([{ sku: variant.sku, requested: 3, added: 0, reason: "insufficient_stock" }]);
      expect(result).toMatchObject({ cartId: null, pieceCount: 0 });

      // What is already in the cart counts toward the line.
      await expectAdded(await addCartItem(tx, identity, variant.sku, 1));
      const second = await addLinesToCart(tx, identity, [{ sku: variant.sku, qty: 2 }]);
      expect(second.lines[0]).toMatchObject({ added: 0, reason: "insufficient_stock" });
      expect(second.pieceCount).toBe(1);
    });
  });

  test(`the ${CART_MAX_QTY_PER_LINE}-per-line and ${CART_MAX_PIECES}-piece caps cut a line down (that reveals no stock)`, async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx);
      const l = await siblingVariant(tx, base, "L");
      const xl = await siblingVariant(tx, base, "XL");
      const identity = guest();
      await expectAdded(await addCartItem(tx, identity, base.variant.sku, 8));
      await expectAdded(await addCartItem(tx, identity, l.sku, 9));

      const result = await addLinesToCart(tx, identity, [
        { sku: base.variant.sku, qty: 5 },
        { sku: xl.sku, qty: 3 },
        { sku: l.sku, qty: 1 },
      ]);
      expect(result.lines).toEqual([
        { sku: base.variant.sku, requested: 5, added: 2, reason: "line_limit" },
        { sku: xl.sku, requested: 3, added: 1, reason: "cart_limit" },
        { sku: l.sku, requested: 1, added: 0, reason: "cart_limit" },
      ]);
      expect(result.pieceCount).toBe(CART_MAX_PIECES);
    });
  });

  test("a line the caps leave no room for reports the cap, not its stock", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx, 10);
      const identity = guest();
      await expectAdded(await addCartItem(tx, identity, variant.sku, 10));
      const result = await addLinesToCart(tx, identity, [{ sku: variant.sku, qty: 1 }]);
      expect(result.lines).toEqual([{ sku: variant.sku, requested: 1, added: 0, reason: "line_limit" }]);
    });
  });

  test("the same SKU twice is one line; quantities outside 1..10 are refused per line", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableVariant(tx);
      const other = await sellableVariant(tx);
      const result = await addLinesToCart(tx, guest(), [
        { sku: variant.sku, qty: 2 },
        { sku: other.variant.sku, qty: 0 },
        { sku: variant.sku, qty: 3 },
      ]);
      expect(result.lines).toEqual([
        { sku: variant.sku, requested: 5, added: 5, reason: null },
        { sku: other.variant.sku, requested: 0, added: 0, reason: "invalid_qty" },
      ]);
      expect(result.pieceCount).toBe(5);
    });
  });

  test("nothing addable: no cart is created and an existing cart is left exactly as it was", async () => {
    await withRollback(async (tx) => {
      const soldOut = await sellableVariant(tx, 0);
      const identity = guest();
      const none = await addLinesToCart(tx, identity, [{ sku: soldOut.variant.sku, qty: 1 }]);
      expect(none).toMatchObject({ cartId: null, pieceCount: 0 });
      expect(await tx.select().from(carts).where(eq(carts.tokenHash, identity.guestTokenHash))).toHaveLength(0);

      const customer = await insertCustomer(tx);
      const { variant } = await sellableVariant(tx);
      const owner = { customerId: customer.id, guestTokenHash: null };
      const cartId = await expectAdded(await addCartItem(tx, owner, variant.sku, 2));
      const [before] = await tx.select({ at: carts.lastActivityAt }).from(carts).where(eq(carts.id, cartId));
      const kept = await addLinesToCart(tx, owner, [{ sku: soldOut.variant.sku, qty: 1 }]);
      expect(kept).toMatchObject({ cartId, pieceCount: 2 });
      const [after] = await tx.select({ at: carts.lastActivityAt }).from(carts).where(eq(carts.id, cartId));
      expect(after?.at).toEqual(before?.at);
    });
  });

  test("a session with a guest cookie merges the guest cart first, then refills the customer's", async () => {
    await withRollback(async (tx) => {
      const base = await sellableVariant(tx);
      const l = await siblingVariant(tx, base, "L");
      const customer = await insertCustomer(tx);
      const device = guest();
      await expectAdded(await addCartItem(tx, device, base.variant.sku, 1));

      const result = await addLinesToCart(tx, { customerId: customer.id, guestTokenHash: device.guestTokenHash }, [{ sku: l.sku, qty: 2 }]);
      expect(result).toMatchObject({ pieceCount: 3, clearGuestCookie: true });
      if (!result.cartId) throw new Error("expected a cart");
      const [cart] = await tx.select().from(carts).where(eq(carts.id, result.cartId));
      expect(cart).toMatchObject({ customerId: customer.id, tokenHash: null });
      expect(await linesOf(tx, result.cartId)).toEqual({ [base.variant.sku]: 1, [l.sku]: 2 });
    });
  });

  test(`two refills of the same cart at once never exceed ${CART_MAX_PIECES} pieces`, async () => {
    const base = await sellableVariant(testDb);
    const l = await siblingVariant(testDb, base, "L");
    const identity = guest();
    try {
      await Promise.all([
        addLinesToCart(testDb, identity, [{ sku: base.variant.sku, qty: 10 }, { sku: l.sku, qty: 5 }]),
        addLinesToCart(testDb, identity, [{ sku: l.sku, qty: 5 }, { sku: base.variant.sku, qty: 10 }]),
      ]);
      expect(await getCartPieceCount(testDb, identity)).toBe(CART_MAX_PIECES);
    } finally {
      await testDb.delete(carts).where(eq(carts.tokenHash, identity.guestTokenHash));
      await cleanupProduct(base, [l.sku]);
    }
  });
});

describe("concurrency: two devices", () => {
  test("two different guest carts merging into one customer at once both land, without a deadlock", async () => {
    const base = await sellableVariant(testDb);
    const l = await siblingVariant(testDb, base, "L");
    const customer = await insertCustomer(testDb);
    const phone = guest();
    const laptop = guest();
    try {
      await expectAdded(await addCartItem(testDb, phone, base.variant.sku, 2));
      await expectAdded(await addCartItem(testDb, laptop, l.sku, 3));
      await Promise.all([
        resolveCart(testDb, { customerId: customer.id, guestTokenHash: phone.guestTokenHash }),
        resolveCart(testDb, { customerId: customer.id, guestTokenHash: laptop.guestTokenHash }),
      ]);
      const view = await getCartView(testDb, { customerId: customer.id, guestTokenHash: null });
      expect(Object.fromEntries(view.lines.map((line) => [line.sku, line.qty]))).toEqual({ [base.variant.sku]: 2, [l.sku]: 3 });
    } finally {
      await testDb.delete(customers).where(eq(customers.id, customer.id));
      await testDb.delete(carts).where(inArray(carts.tokenHash, [phone.guestTokenHash, laptop.guestTokenHash]));
      await cleanupProduct(base, [l.sku]);
    }
  });
});

async function cleanupProduct(base: Awaited<ReturnType<typeof sellableVariant>>, extraSkus: string[]) {
  const skus = [base.variant.sku, ...extraSkus];
  await testDb.delete(cartItems).where(inArray(cartItems.sku, skus));
  await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () =>
    testDb.delete(stockMovements).where(inArray(stockMovements.sku, skus)),
  );
  await testDb.delete(productVariants).where(inArray(productVariants.sku, skus));
  await testDb.delete(products).where(eq(products.id, base.product.id));
  await testDb.delete(fabricColors).where(eq(fabricColors.id, base.color.id));
  await testDb.delete(fabrics).where(eq(fabrics.id, base.fabric.id));
}
