import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, withTriggerDisabled } from "@ammari/db/test-utils";
import { insertCustomer, insertProductVariant } from "@ammari/db/test-fixtures";
import { cartItems, carts, claimRateLimits, customers, fabricColors, fabrics, products, productVariants, stockMovements } from "@ammari/db/schema";
import { hashCartToken } from "@ammari/commerce/cart";

// docs/plans/cart-checkout.md session 5: the server actions around @ammari/commerce/cart, run
// against the real `ammari_test` database (committed writes, cleaned up below), with Next's
// request APIs replaced by an in-memory cookie jar and a fixed client IP.

interface SetCookie {
  value: string;
  options: Record<string, unknown>;
}

const jar = new Map<string, string>();
const setCookies = new Map<string, SetCookie>();
const deletedCookies = new Set<string>();
const issuedTokens = new Set<string>();
let clientIp = "203.0.113.10";
let sessionCustomerId: string | null = null;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.set(name, value);
      setCookies.set(name, { value, options });
      issuedTokens.add(value);
    },
    delete: (name: string) => {
      jar.delete(name);
      deletedCookies.add(name);
    },
  }),
  headers: async () => new Headers(clientIp ? { "cf-connecting-ip": clientIp } : {}),
}));
vi.mock("@/lib/auth/customer-session", () => ({
  getCustomerSession: async () => (sessionCustomerId ? { id: sessionCustomerId } : null),
}));
vi.mock("@/lib/db", async () => ({ defaultDb: (await import("@ammari/db/test-utils")).testDb }));
const refresh = vi.fn();
vi.mock("next/cache", () => ({ refresh: () => refresh() }));

const { addToCartAction, removeCartItemAction, updateCartItemQtyAction } = await import("./actions");
const { loadCartPieceCount, loadCartView } = await import("./queries");
const { CART_CREATE_LIMIT, CART_WRITE_LIMIT } = await import("./messages");

const createdSkus: string[] = [];
const createdProductIds: string[] = [];
const createdFabricIds: string[] = [];
const createdColorIds: string[] = [];
const createdCustomerIds: string[] = [];
const usedIps = new Set<string>();

async function sellableSku(stock = 20): Promise<string> {
  const { fabric, color, product, variant } = await insertProductVariant(testDb);
  await testDb.update(products).set({ isPublishedOnStorefront: true }).where(eq(products.id, product.id));
  if (stock > 0) {
    await testDb.insert(stockMovements).values({ sku: variant.sku, qty: stock, valueAmount: stock * 100_000, type: "production", refType: "manual" });
  }
  createdSkus.push(variant.sku);
  createdProductIds.push(product.id);
  createdFabricIds.push(fabric.id);
  createdColorIds.push(color.id);
  return variant.sku;
}

function freshIp(): string {
  clientIp = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  // A random address in a documentation range; make sure this run starts with an empty bucket.
  usedIps.add(clientIp);
  return clientIp;
}

beforeEach(async () => {
  jar.clear();
  setCookies.clear();
  deletedCookies.clear();
  sessionCustomerId = null;
  process.env.STOREFRONT_CART_ENABLED = "true";
  await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, freshIp()));
});

afterEach(() => {
  delete process.env.STOREFRONT_CART_ENABLED;
});

afterAll(async () => {
  await testDb.delete(cartItems).where(inArray(cartItems.sku, createdSkus));
  await testDb.delete(carts).where(inArray(carts.customerId, createdCustomerIds));
  // Guest carts this run made, by the hash of every cookie it was handed.
  const hashes = [...issuedTokens].map(hashCartToken);
  if (hashes.length > 0) await testDb.delete(carts).where(inArray(carts.tokenHash, hashes));
  await testDb.delete(customers).where(inArray(customers.id, createdCustomerIds));
  await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () =>
    testDb.delete(stockMovements).where(inArray(stockMovements.sku, createdSkus)),
  );
  await testDb.delete(productVariants).where(inArray(productVariants.sku, createdSkus));
  await testDb.delete(products).where(inArray(products.id, createdProductIds));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, createdColorIds));
  await testDb.delete(fabrics).where(inArray(fabrics.id, createdFabricIds));
  await testDb.delete(claimRateLimits).where(inArray(claimRateLimits.ip, [...usedIps]));
});

async function guestCartIdFromCookie(): Promise<string | undefined> {
  const token = jar.get("ammari_cart");
  if (!token) return undefined;
  const [cart] = await testDb.select({ id: carts.id }).from(carts).where(eq(carts.tokenHash, hashCartToken(token)));
  return cart?.id;
}

describe("cart actions", () => {
  test("flag off: refused without touching the database or cookies", async () => {
    delete process.env.STOREFRONT_CART_ENABLED;
    const sku = await sellableSku();
    expect(await addToCartAction({ sku, qty: 1 })).toEqual({ ok: false, message: "Keranjang belum tersedia." });
    expect(setCookies.size).toBe(0);
    expect(await testDb.select().from(claimRateLimits).where(eq(claimRateLimits.ip, clientIp))).toHaveLength(0);
    expect(await loadCartPieceCount()).toBe(0);
    expect((await loadCartView()).lines).toEqual([]);
  });

  test("a guest's first add sets an httpOnly, SameSite=Lax, 60-day cookie whose hash (never the value) is stored", async () => {
    const sku = await sellableSku();
    expect(await addToCartAction({ sku, qty: 2 })).toEqual({ ok: true, pieceCount: 2, mergeTrimmed: false });

    const cookie = setCookies.get("ammari_cart");
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 24 * 60 * 60 });
    const [cart] = await testDb.select().from(carts).where(eq(carts.tokenHash, hashCartToken(cookie?.value ?? "")));
    expect(cart).toBeDefined();
    expect(await testDb.select().from(carts).where(eq(carts.tokenHash, cookie?.value ?? ""))).toHaveLength(0);

    // The same cookie keeps using the same cart.
    expect(await addToCartAction({ sku, qty: 1 })).toMatchObject({ ok: true, pieceCount: 3 });
    expect(await guestCartIdFromCookie()).toBe(cart?.id);
    expect(await loadCartPieceCount()).toBe(3);
    const view = await loadCartView();
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]).toMatchObject({ sku, qty: 3, status: "ok" });
  });

  test("a tampered cookie is ignored: a new token replaces it", async () => {
    const sku = await sellableSku();
    jar.set("ammari_cart", "not-a-real-token");
    expect(await addToCartAction({ sku, qty: 1 })).toMatchObject({ ok: true });
    expect(setCookies.get("ammari_cart")?.value).not.toBe("not-a-real-token");
    expect(setCookies.get("ammari_cart")?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("refusals come back as Indonesian messages and set no cookie", async () => {
    const soldOut = await sellableSku(0);
    expect(await addToCartAction({ sku: soldOut, qty: 1 })).toEqual({ ok: false, message: "Maaf, stok habis." });
    expect(setCookies.size).toBe(0);

    const sku = await sellableSku(30);
    await addToCartAction({ sku, qty: 10 });
    expect(await addToCartAction({ sku, qty: 1 })).toEqual({ ok: false, message: "Maksimal 10 per item." });
    expect(await updateCartItemQtyAction({ sku: soldOut, qty: 1 })).toEqual({
      ok: false,
      message: "Barang ini sudah tidak ada di keranjang.",
    });
  });

  test("malformed input is refused before the database", async () => {
    for (const input of [{ sku: "", qty: 1 }, { sku: "X".repeat(101), qty: 1 }, { sku: "SKU", qty: 0 }, { sku: "SKU", qty: 2.5 }, { sku: "SKU", qty: 11 }]) {
      expect(await addToCartAction(input)).toEqual({ ok: false, message: "Permintaan tidak valid. Muat ulang halaman lalu coba lagi." });
    }
    expect(await addToCartAction({ sku: 1 as unknown as string, qty: 1 })).toMatchObject({ ok: false });
    expect(await removeCartItemAction({} as { sku: string })).toMatchObject({ ok: false });
  });

  test("update and remove change the guest's lines", async () => {
    const sku = await sellableSku();
    await addToCartAction({ sku, qty: 1 });
    refresh.mockClear();
    expect(await updateCartItemQtyAction({ sku, qty: 4 })).toEqual({ ok: true, pieceCount: 4, mergeTrimmed: false });
    // The /cart page's fresh render rides on the action's answer (optimistic stepper).
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await removeCartItemAction({ sku })).toEqual({ ok: true, pieceCount: 0, mergeTrimmed: false });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(await loadCartPieceCount()).toBe(0);
  });

  test("after login the next cart write merges the guest cart and clears the cookie", async () => {
    const sku = await sellableSku();
    const other = await sellableSku();
    await addToCartAction({ sku, qty: 2 });
    const guestCartId = await guestCartIdFromCookie();
    expect(guestCartId).toBeDefined();

    const customer = await insertCustomer(testDb);
    createdCustomerIds.push(customer.id);
    sessionCustomerId = customer.id;
    setCookies.clear();

    expect(await addToCartAction({ sku: other, qty: 1 })).toEqual({ ok: true, pieceCount: 3, mergeTrimmed: false });
    expect(deletedCookies.has("ammari_cart")).toBe(true);
    // A customer's write never sets a guest cookie.
    expect(setCookies.has("ammari_cart")).toBe(false);
    expect(await testDb.select().from(carts).where(eq(carts.id, guestCartId ?? randomUUID()))).toHaveLength(0);
    const [customerCart] = await testDb.select().from(carts).where(eq(carts.customerId, customer.id));
    expect(customerCart).toBeDefined();
    expect(await loadCartPieceCount()).toBe(3);
  });

  test("a page read after login merges too (the cookie is cleared by the next action)", async () => {
    const sku = await sellableSku();
    await addToCartAction({ sku, qty: 2 });

    const customer = await insertCustomer(testDb);
    createdCustomerIds.push(customer.id);
    sessionCustomerId = customer.id;

    const view = await loadCartView();
    expect(view).toMatchObject({ pieceCount: 2, clearGuestCookie: true });
    const [customerCart] = await testDb.select().from(carts).where(eq(carts.customerId, customer.id));
    expect(view.cartId).toBe(customerCart?.id);
  });

  test("a well-formed token the server never issued is replaced, never adopted as a cart", async () => {
    const sku = await sellableSku();
    const planted = "A".repeat(43);
    jar.set("ammari_cart", planted);
    expect(await addToCartAction({ sku, qty: 1 })).toMatchObject({ ok: true });
    expect(setCookies.get("ammari_cart")?.value).not.toBe(planted);
    expect(await testDb.select().from(carts).where(eq(carts.tokenHash, hashCartToken(planted)))).toHaveLength(0);
  });

  test("a logged-in buyer's refused write still merges and clears the guest cookie", async () => {
    const sku = await sellableSku();
    const soldOut = await sellableSku(0);
    await addToCartAction({ sku, qty: 2 });
    const customer = await insertCustomer(testDb);
    createdCustomerIds.push(customer.id);
    sessionCustomerId = customer.id;

    expect(await addToCartAction({ sku: soldOut, qty: 1 })).toEqual({ ok: false, message: "Maaf, stok habis." });
    expect(deletedCookies.has("ammari_cart")).toBe(true);
    expect(await loadCartPieceCount()).toBe(2);
  });

  test("a customer's first remove or update needs no cart and creates none", async () => {
    const sku = await sellableSku();
    const customer = await insertCustomer(testDb);
    createdCustomerIds.push(customer.id);
    sessionCustomerId = customer.id;
    expect(await removeCartItemAction({ sku })).toEqual({ ok: true, pieceCount: 0, mergeTrimmed: false });
    refresh.mockClear();
    expect(await updateCartItemQtyAction({ sku, qty: 2 })).toEqual({ ok: false, message: "Barang ini sudah tidak ada di keranjang." });
    // A refusal changed nothing: no render is sent with it.
    expect(refresh).not.toHaveBeenCalled();
    expect(await testDb.select().from(carts).where(eq(carts.customerId, customer.id))).toHaveLength(0);
  });

  test("new guest carts have their own, tighter per-IP limit", async () => {
    const sku = await sellableSku();
    await testDb.insert(claimRateLimits).values(Array.from({ length: CART_CREATE_LIMIT }, () => ({ ip: clientIp, action: "cart_create" })));
    expect(await addToCartAction({ sku, qty: 1 })).toEqual({ ok: false, message: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi." });
    expect(setCookies.size).toBe(0);
  });

  test("a missing client IP outside production uses the local bucket", async () => {
    const sku = await sellableSku();
    clientIp = "";
    usedIps.add("127.0.0.1");
    await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, "127.0.0.1"));
    expect(await addToCartAction({ sku, qty: 1 })).toMatchObject({ ok: true });
    expect(await testDb.select().from(claimRateLimits).where(eq(claimRateLimits.ip, "127.0.0.1"))).toHaveLength(2);
  });

  test("an unexpected failure becomes a generic message, not a thrown action", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      clientIp = "999.1.1.1"; // not an IP: local fallback, then force a database failure below
      const spy = vi.spyOn(testDb, "transaction").mockRejectedValueOnce(new Error("connection lost"));
      const sku = await sellableSku();
      jar.set("ammari_cart", "B".repeat(43));
      await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, "127.0.0.1"));
      usedIps.add("127.0.0.1");
      expect(await addToCartAction({ sku, qty: 1 })).toEqual({ ok: false, message: "Terjadi kesalahan. Coba lagi." });
      expect(error).toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      error.mockRestore();
    }
  });

  test(`cart writes are rate limited per IP (${CART_WRITE_LIMIT} per 10 minutes)`, async () => {
    const sku = await sellableSku();
    await testDb.insert(claimRateLimits).values(Array.from({ length: CART_WRITE_LIMIT }, () => ({ ip: clientIp, action: "cart_write" })));
    expect(await addToCartAction({ sku, qty: 1 })).toEqual({
      ok: false,
      message: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.",
    });
    expect(setCookies.size).toBe(0);

    // Another address is unaffected.
    freshIp();
    await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, clientIp));
    expect(await addToCartAction({ sku, qty: 1 })).toMatchObject({ ok: true });
  });
});
