import { eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, withTriggerDisabled } from "@ammari/db/test-utils";
import { insertProductVariant } from "@ammari/db/test-fixtures";
import { cartItems, carts, claimRateLimits, fabricColors, fabrics, products, productVariants, stockMovements } from "@ammari/db/schema";
import { generateCartToken, hashCartToken } from "@ammari/commerce/cart";
import { createFakeShippingRateProvider, searchShippingAreas } from "@ammari/commerce/shipping";

// docs/plans/cart-checkout.md §4.5.4, §4.5.5, session 10: the checkout page's quote action against
// the real `ammari_test` database with the fake shipping provider, an in-memory cookie jar and a
// fixed client IP. Nothing here reaches a provider.

const jar = new Map<string, string>();
const deletedCookies = new Set<string>();
let clientIp = "203.0.113.30";
let quoteThrows = false;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => {
      jar.delete(name);
      deletedCookies.add(name);
    },
  }),
  headers: async () => new Headers({ "cf-connecting-ip": clientIp }),
}));
vi.mock("@/lib/auth/customer-session", () => ({ getCustomerSession: async () => null }));
vi.mock("@/lib/db", async () => ({ defaultDb: (await import("@ammari/db/test-utils")).testDb }));
vi.mock("@ammari/commerce/shipping", async (importOriginal) => {
  const original = await importOriginal<typeof import("@ammari/commerce/shipping")>();
  return {
    ...original,
    quoteShipping: (...args: Parameters<typeof original.quoteShipping>) => {
      if (quoteThrows) return Promise.reject(Object.assign(new Error("Failed query: select ... params: siti@example.test"), { code: "57P01" }));
      return original.quoteShipping(...args);
    },
  };
});

const { quoteShippingAction } = await import("./quote-actions");
const { SHIPPING_QUOTE_CART_LIMIT, SHIPPING_QUOTE_IP_LIMIT } = await import("./messages");
const { cartQuoteAction } = await import("./cart-quote-limit");

const created = { skus: [] as string[], productIds: [] as string[], colorIds: [] as string[], fabricIds: [] as string[], cartIds: [] as string[] };
const usedIps = new Set<string>();
const areaIds: Record<"murah" | "jauh" | "tanpaLayanan" | "gangguan", string> = { murah: "", jauh: "", tanpaLayanan: "", gangguan: "" };

const ENV = { STOREFRONT_CART_ENABLED: "true", SHIPPING_RATE_PROVIDER: "fake", E2E_TEST_LOGIN: "true" };

async function sellableSku(options: { weightGrams?: number | null; published?: boolean } = {}): Promise<string> {
  const { fabric, color, product, variant } = await insertProductVariant(testDb);
  await testDb
    .update(products)
    .set({ isPublishedOnStorefront: options.published ?? true, shippingWeightGrams: options.weightGrams === undefined ? 700 : options.weightGrams })
    .where(eq(products.id, product.id));
  await testDb.insert(stockMovements).values({ sku: variant.sku, qty: 5, valueAmount: 500_000, type: "production", refType: "manual" });
  created.skus.push(variant.sku);
  created.productIds.push(product.id);
  created.colorIds.push(color.id);
  created.fabricIds.push(fabric.id);
  return variant.sku;
}

async function guestCartWith(skus: string[]): Promise<string> {
  const token = generateCartToken();
  const [cart] = await testDb.insert(carts).values({ tokenHash: hashCartToken(token) }).returning();
  created.cartIds.push(cart!.id);
  for (const sku of skus) await testDb.insert(cartItems).values({ cartId: cart!.id, sku, qty: 1 });
  jar.set("ammari_cart", token);
  return cart!.id;
}

beforeAll(async () => {
  const fake = createFakeShippingRateProvider();
  areaIds.murah = (await searchShippingAreas(testDb, fake, "Murah"))[0]!.id;
  areaIds.jauh = (await searchShippingAreas(testDb, fake, "Jauh"))[0]!.id;
  areaIds.tanpaLayanan = (await searchShippingAreas(testDb, fake, "Tanpa Layanan"))[0]!.id;
  areaIds.gangguan = (await searchShippingAreas(testDb, fake, "Gangguan"))[0]!.id;
});

beforeEach(async () => {
  jar.clear();
  deletedCookies.clear();
  quoteThrows = false;
  Object.assign(process.env, ENV);
  clientIp = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  usedIps.add(clientIp);
  await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, clientIp));
});

afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
});

afterAll(async () => {
  await testDb.delete(claimRateLimits).where(inArray(claimRateLimits.action, created.cartIds.map(cartQuoteAction)));
  await testDb.delete(cartItems).where(inArray(cartItems.sku, created.skus));
  if (created.cartIds.length > 0) await testDb.delete(carts).where(inArray(carts.id, created.cartIds));
  await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () =>
    testDb.delete(stockMovements).where(inArray(stockMovements.sku, created.skus)),
  );
  await testDb.delete(productVariants).where(inArray(productVariants.sku, created.skus));
  await testDb.delete(products).where(inArray(products.id, created.productIds));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, created.colorIds));
  await testDb.delete(fabrics).where(inArray(fabrics.id, created.fabricIds));
  await testDb.delete(claimRateLimits).where(inArray(claimRateLimits.ip, [...usedIps]));
});

describe("quoteShippingAction", () => {
  test("flag off: refused without touching the database", async () => {
    delete process.env.STOREFRONT_CART_ENABLED;
    const result = await quoteShippingAction({ shippingAreaId: areaIds.murah });
    expect(result).toEqual({ ok: false, kind: "cart", message: "Checkout belum tersedia." });
    expect(await testDb.select().from(claimRateLimits).where(eq(claimRateLimits.ip, clientIp))).toHaveLength(0);
  });

  test("a cost the subsidy covers: buyer pays Rp0; only display figures come back", async () => {
    await guestCartWith([await sellableSku()]);
    const result = await quoteShippingAction({ shippingAreaId: areaIds.murah });
    expect(result).toEqual({
      ok: true,
      quote: { label: "JNE Reguler", costAmount: 12_000, subsidyAmount: 12_000, buyerAmount: 0 },
      subtotal: expect.any(Number),
      cartKey: expect.stringMatching(/:1\|259000$/),
    });
    // Never the provider's area id, the weight or the courier codes.
    expect(JSON.stringify(result)).not.toMatch(/E2EMURAH|weight|jne"/i);
  });

  test("a cost above the subsidy: buyer pays the rest, subtotal is the cart's", async () => {
    await guestCartWith([await sellableSku(), await sellableSku()]);
    const result = await quoteShippingAction({ shippingAreaId: areaIds.jauh });
    if (!result.ok) throw new Error(result.message);
    expect(result.quote).toEqual({ label: "POS Kilat Khusus", costAmount: 95_000, subsidyAmount: 20_000, buyerAmount: 75_000 });
    expect(result.subtotal).toBe(2 * 259_000);
  });

  test("no allowlisted service and a provider outage map to their section 3 states", async () => {
    await guestCartWith([await sellableSku()]);
    expect(await quoteShippingAction({ shippingAreaId: areaIds.tanpaLayanan })).toEqual({
      ok: false,
      kind: "no_service",
      message: "Pengiriman ke alamat ini belum tersedia lewat website. Hubungi kami lewat WhatsApp.",
    });
    expect(await quoteShippingAction({ shippingAreaId: areaIds.gangguan })).toEqual({
      ok: false,
      kind: "retry",
      message: "Ongkir belum bisa dihitung. Coba lagi sebentar lagi.",
    });
  });

  test("a product without a weight, an unknown area and a malformed id", async () => {
    await guestCartWith([await sellableSku({ weightGrams: null })]);
    expect(await quoteShippingAction({ shippingAreaId: areaIds.murah })).toMatchObject({ ok: false, kind: "missing_weight" });
    expect(await quoteShippingAction({ shippingAreaId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({
      ok: false,
      kind: "pick_area",
      message: "Pilih kecamatan dari daftar.",
    });
    expect(await quoteShippingAction({ shippingAreaId: "x".repeat(65) })).toMatchObject({ ok: false, kind: "pick_area" });
  });

  test("no cart, or a line that can no longer be bought: back to the cart, no quote", async () => {
    expect(await quoteShippingAction({ shippingAreaId: areaIds.murah })).toEqual({ ok: false, kind: "cart", message: "Keranjang kamu kosong." });
    await guestCartWith([await sellableSku({ published: false })]);
    expect(await quoteShippingAction({ shippingAreaId: areaIds.murah })).toEqual({
      ok: false,
      kind: "cart",
      message: "Ada barang yang habis atau tidak tersedia lagi. Cek keranjang dulu.",
    });
  });

  test("per-IP limit: refused at the limit, before the cart is read", async () => {
    await guestCartWith([await sellableSku()]);
    await testDb.insert(claimRateLimits).values(Array.from({ length: SHIPPING_QUOTE_IP_LIMIT }, () => ({ ip: clientIp, action: "shipping_quote" })));
    const result = await quoteShippingAction({ shippingAreaId: areaIds.murah });
    expect(result).toEqual({ ok: false, kind: "rate_limited", message: "Terlalu banyak percobaan hitung ongkir. Coba lagi beberapa menit lagi." });
  });

  test("per-cart limit: the same cart from many addresses is refused once its own limit is used", async () => {
    const cartId = await guestCartWith([await sellableSku()]);
    for (let index = 0; index < SHIPPING_QUOTE_CART_LIMIT; index += 1) {
      clientIp = `192.0.2.${index + 1}`;
      usedIps.add(clientIp);
      expect((await quoteShippingAction({ shippingAreaId: areaIds.murah })).ok).toBe(true);
    }
    clientIp = "192.0.2.200";
    usedIps.add(clientIp);
    expect(await quoteShippingAction({ shippingAreaId: areaIds.murah })).toMatchObject({ ok: false, kind: "rate_limited" });
    const rows = await testDb.select().from(claimRateLimits).where(like(claimRateLimits.action, `shipping_quote_cart:${cartId}`));
    expect(rows.every((row) => row.ip === "0.0.0.0")).toBe(true);
  });

  test("a database error is logged without its message and answered with the retry message", async () => {
    await guestCartWith([await sellableSku()]);
    quoteThrows = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await quoteShippingAction({ shippingAreaId: areaIds.murah })).toEqual({
        ok: false,
        kind: "retry",
        message: "Ongkir belum bisa dihitung. Coba lagi sebentar lagi.",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("siti@example.test");
      expect(log).toHaveBeenCalledWith("[checkout] shipping quote failed", expect.objectContaining({ code: "57P01" }));
    } finally {
      log.mockRestore();
    }
  });
});
