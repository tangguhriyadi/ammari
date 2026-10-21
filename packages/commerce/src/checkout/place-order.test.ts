import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { testDb, withRollback, withTriggerDisabled, type TestDatabase } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder, insertProductVariant, insertStaffUser, insertThankYouCard } from "@ammari/db/test-fixtures";
import {
  auditLog,
  cartItems,
  carts,
  customers,
  fabricColors,
  fabrics,
  orderAccessTokens,
  orderItems,
  orders,
  payments,
  products,
  productVariants,
  shippingAreas,
  shippingRateCache,
  staffUsers,
  stockMovements,
  stockReservations,
  thankYouCards,
  vouchers,
} from "@ammari/db/schema";
import { hashCartToken } from "../cart/token";
import type { Database } from "../db";
import { transitionOrderStatus } from "../orders/lifecycle";
import { createFakePaymentProvider } from "../payments/fake";
import type { CreatePaymentInput, PaymentProvider } from "../payments/provider";
import { searchShippingAreas } from "../shipping/areas";
import type { ShippingArea, ShippingRateProvider } from "../shipping/provider";
import { SHIPPING_PACKAGING_GRAMS, type RatedService } from "../shipping/rules";
import { hashOrderAccessToken } from "./access-token";
import { placeOrder, type PlaceOrderDeps, type PlaceOrderInput } from "./place-order";

// docs/plans/cart-checkout.md §5, §4.5, session 9: placeOrder against the test database, with a
// stub shipping provider (fixed rates per area) and the fake payment provider. Nothing here
// reaches Biteship or Midtrans.

const PRICE = 259_000;
const WEIGHT = 700;
const UNIT_COST = 100_000;

// ---------- shipping stub ----------

interface StubArea extends ShippingArea {
  rates: RatedService[] | "unavailable";
}

const stubAreas = new Map<string, StubArea>();
let beforeQuote: (() => Promise<void>) | null = null;

const shippingProvider: ShippingRateProvider = {
  name: "fake",
  async searchAreas(query) {
    const area = stubAreas.get(query);
    return area ? [area] : [];
  },
  async quoteRates(input) {
    if (beforeQuote) await beforeQuote();
    const area = stubAreas.get(input.destinationAreaId);
    if (!area) return [];
    if (area.rates === "unavailable") {
      const { ShippingRateError } = await import("../shipping/provider");
      throw new ShippingRateError("unavailable", "stub outage");
    }
    return area.rates;
  },
};

/** A shipping_areas row (our own id) whose quote is `rates`. Each area is new, so the rate cache
 * never answers for another test. */
async function areaQuoting(db: Database, rates: RatedService[] | "unavailable" | number): Promise<string> {
  const providerAreaId = `TEST${randomUUID().replace(/-/g, "").toUpperCase()}`;
  stubAreas.set(providerAreaId, {
    providerAreaId,
    province: "Provinsi Uji",
    city: "Kota Uji",
    district: "Kecamatan Uji",
    subdistrict: null,
    postalCode: "40111",
    rates: typeof rates === "number" ? [{ courierCode: "jne", serviceCode: "reg", cost: rates }] : rates,
  });
  const [option] = await searchShippingAreas(db, shippingProvider, providerAreaId);
  if (!option) throw new Error("stub area was not stored");
  return option.id;
}

// ---------- payment stub ----------

function recordingPaymentProvider(base: PaymentProvider = createFakePaymentProvider({ baseUrl: "http://localhost:3000" })) {
  const calls: CreatePaymentInput[] = [];
  const provider: PaymentProvider = {
    ...base,
    createPayment: vi.fn(async (input: CreatePaymentInput) => {
      calls.push(input);
      return base.createPayment(input);
    }),
  };
  return { provider, calls };
}

function deps(payment: PaymentProvider = recordingPaymentProvider().provider): PlaceOrderDeps {
  return {
    shipping: { provider: shippingProvider, originAreaId: "TESTORIGIN", cacheMinutes: 360 },
    payment: { provider: payment, orderIdPrefix: "TEST-", paymentExpiryMinutes: 60, stockHoldMinutes: 75 },
    finishUrl: (orderNo) => `http://localhost:3000/checkout/finish?order=${orderNo}`,
  };
}

// ---------- catalog and cart fixtures ----------

async function sellableSku(db: TestDatabase, options: { stock?: number; price?: number; weight?: number | null } = {}) {
  const fixture = await insertProductVariant(db);
  await db
    .update(products)
    .set({
      isPublishedOnStorefront: true,
      basePrice: options.price ?? PRICE,
      shippingWeightGrams: options.weight === undefined ? WEIGHT : options.weight,
    })
    .where(eq(products.id, fixture.product.id));
  const stock = options.stock ?? 5;
  if (stock > 0) {
    await db.insert(stockMovements).values({ sku: fixture.variant.sku, qty: stock, valueAmount: stock * UNIT_COST, type: "production", refType: "manual" });
  }
  return fixture;
}

async function guestCart(db: TestDatabase, lines: readonly { sku: string; qty: number }[]) {
  const tokenHash = hashCartToken(randomUUID());
  const [cart] = await db.insert(carts).values({ tokenHash }).returning();
  if (!cart) throw new Error("cart fixture");
  if (lines.length > 0) await db.insert(cartItems).values(lines.map((line) => ({ cartId: cart.id, sku: line.sku, qty: line.qty })));
  return { cartId: cart.id, tokenHash };
}

async function customerCart(db: TestDatabase, customerId: string, lines: readonly { sku: string; qty: number }[]) {
  const [cart] = await db
    .insert(carts)
    .values({ customerId })
    .onConflictDoUpdate({ target: carts.customerId, set: { updatedAt: sql`now()` } })
    .returning();
  if (!cart) throw new Error("cart fixture");
  await db.insert(cartItems).values(lines.map((line) => ({ cartId: cart.id, sku: line.sku, qty: line.qty })));
  return cart.id;
}

async function voucherFor(db: TestDatabase, customerId: string, overrides: Partial<typeof vouchers.$inferInsert> = {}) {
  const sourceOrder = await insertOrder(db);
  const card = await insertThankYouCard(db, sourceOrder.id, { status: "claimed", claimedByCustomerId: customerId, claimedAt: new Date() });
  const [voucher] = await db
    .insert(vouchers)
    .values({ cardId: card.id, customerId, amount: 20_000, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), ...overrides })
    .returning();
  if (!voucher) throw new Error("voucher fixture");
  return voucher;
}

function guestInput(overrides: Partial<PlaceOrderInput> & { shippingAreaId: string; guestTokenHash: string | null; expectedTotal: number }): PlaceOrderInput {
  return {
    customer: null,
    checkoutAttemptId: randomUUID(),
    contact: { email: `buyer-${randomUUID()}@example.test`, phone: `08${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}` },
    address: { recipientName: "Siti Aminah", phone: "0812 3456 7890", addressLine: "Jl. Melati No. 5, RT 01/RW 02, Kel. Sukamaju", notes: "Pagar hijau" },
    voucherId: null,
    termsAccepted: true,
    promoOptIn: false,
    ...overrides,
  };
}

async function ordersByAttempt(db: TestDatabase, attemptId: string) {
  return db.select().from(orders).where(eq(orders.checkoutAttemptId, attemptId));
}

async function activeHolds(db: TestDatabase, sku: string) {
  return db.select().from(stockReservations).where(and(eq(stockReservations.sku, sku), eq(stockReservations.status, "active")));
}

// ---------- tests inside one rolled-back transaction ----------

describe("placeOrder", () => {
  test("a guest order: awaiting payment, quote locked, stock held, payment attempt and access token, cart emptied", async () => {
    await withRollback(async (tx) => {
      const { variant, product } = await sellableSku(tx);
      const areaId = await areaQuoting(tx, 12_000);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 2 }]);
      const { provider, calls } = recordingPaymentProvider();
      const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: 2 * PRICE, promoOptIn: true });

      const result = await placeOrder(tx, deps(provider), input);
      if (!result.ok) throw new Error(`expected an order, got ${result.reason}`);
      expect(result.orderNo).toMatch(/^ORD-\d{6}-\d{4}$/);
      expect(result.replayed).toBe(false);
      expect(result.productSlugs).toEqual([product.slug]);
      expect(result.redirectUrl).toBe(`http://localhost:3000/api/test/payments/TEST-${result.orderNo}-1`);

      const [order] = await ordersByAttempt(tx, input.checkoutAttemptId);
      expect(order).toMatchObject({
        id: result.orderId,
        channelId: "web",
        status: "awaiting_payment",
        paymentStatus: "pending",
        subtotalAmount: 2 * PRICE,
        shippingAmount: 0,
        discountAmount: 0,
        totalAmount: 2 * PRICE,
        shippingCostAmount: 12_000,
        shippingSubsidyAmount: 12_000,
        shippingCourierCode: "jne",
        shippingServiceCode: "reg",
        shippingCourierLabel: "JNE Reguler",
        shippingWeightGrams: 2 * WEIGHT + SHIPPING_PACKAGING_GRAMS,
        shippingAreaId: areaId,
        contactEmail: String(input.contact.email),
        recipientName: "Siti Aminah",
        placedWithSession: false,
        promoOptIn: true,
        createdByStaffUserId: null,
      });
      expect(order?.contactPhone).toMatch(/^\+628/);
      expect(stubAreas.has(order?.shippingDestinationId ?? "")).toBe(true);
      expect(order?.shippingAddressSnapshot).toMatchObject({ version: 2, shippingAreaId: areaId, district: "Kecamatan Uji", postalCode: "40111", phone: "+6281234567890" });
      expect(order?.shippingAddress).toBe(
        "Siti Aminah, +6281234567890, Jl. Melati No. 5, RT 01/RW 02, Kel. Sukamaju, Kecamatan Uji, Kota Uji, Provinsi Uji 40111. Catatan: Pagar hijau",
      );
      const [{ paymentMinutes, holdMinutes } = { paymentMinutes: -1, holdMinutes: -1 }] = await tx.execute<{ paymentMinutes: number; holdMinutes: number }>(sql`
        select round(extract(epoch from (o.payment_expires_at - now())) / 60)::int as "paymentMinutes",
               round(extract(epoch from (r.expires_at - now())) / 60)::int as "holdMinutes"
        from orders o join stock_reservations r on r.order_id = o.id where o.id = ${result.orderId}`);
      expect(paymentMinutes).toBe(60);
      expect(holdMinutes).toBe(75);

      // unit_cost stays 0 until payment (set by the paid transition, test below).
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, result.orderId));
      expect(items).toMatchObject([{ sku: variant.sku, qty: 2, unitPrice: PRICE, unitCost: 0 }]);
      expect(await activeHolds(tx, variant.sku)).toMatchObject([{ orderId: result.orderId, qty: 2 }]);
      // Holds are not sales: the ledger is untouched.
      expect(await tx.select().from(stockMovements).where(eq(stockMovements.sku, variant.sku))).toHaveLength(1);

      const [payment] = await tx.select().from(payments).where(eq(payments.orderId, result.orderId));
      expect(payment).toMatchObject({
        provider: "midtrans",
        providerOrderId: `TEST-${result.orderNo}-1`,
        attempt: 1,
        grossAmount: 2 * PRICE,
        status: "created",
        redirectUrl: result.redirectUrl,
      });
      expect(payment?.snapToken).toMatch(/^fake-/);
      expect(payment?.expiresAt?.getTime()).toBe(order?.paymentExpiresAt?.getTime());

      // Only the hash of the access token is stored, valid 120 days.
      expect(result.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const tokens = await tx.select().from(orderAccessTokens).where(eq(orderAccessTokens.orderId, result.orderId));
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.tokenHash).toBe(hashOrderAccessToken(result.accessToken!));
      expect(JSON.stringify(tokens)).not.toContain(result.accessToken!);

      expect(await tx.select().from(cartItems).where(eq(cartItems.cartId, cart.cartId))).toHaveLength(0);

      // A new customer for the (unverified) email: only the email and a name. The phone and the
      // consent evidence stay on the order until a login proves the email.
      const [customer] = await tx.select().from(customers).where(eq(customers.id, order!.customerId!));
      expect(customer).toMatchObject({
        email: String(input.contact.email),
        name: "Siti Aminah",
        phone: null,
        emailVerifiedAt: null,
        pdpConsentAt: null,
        promoConsentAt: null,
      });
      expect(order?.termsAcceptedAt).toBeInstanceOf(Date);

      // Audit row without contact or address data.
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, result.orderId), eq(auditLog.action, "web_checkout")));
      expect(audit?.actorStaffUserId).toBeNull();
      expect(JSON.stringify(audit?.after)).not.toMatch(/Siti|Melati|example\.test|\+628/);

      // The payment page request: the buyer's contact, the product line, no Ongkir line at Rp0.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        providerOrderId: `TEST-${result.orderNo}-1`,
        grossAmount: 2 * PRICE,
        expiryMinutes: 60,
        finishUrl: `http://localhost:3000/checkout/finish?order=${result.orderNo}`,
        lines: [{ id: variant.sku, name: "Gamis Basic Black M", price: PRICE, quantity: 2 }],
      });
    });
  });

  test.each([
    { cost: 19_999, subsidy: 19_999, buyer: 0 },
    { cost: 20_000, subsidy: 20_000, buyer: 0 },
    { cost: 20_001, subsidy: 20_000, buyer: 1 },
    { cost: 200_000, subsidy: 20_000, buyer: 180_000 },
  ])("subsidy split at a courier cost of $cost: buyer pays $buyer", async ({ cost, subsidy, buyer }) => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const areaId = await areaQuoting(tx, cost);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const result = await placeOrder(tx, deps(), guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE + buyer }));
      if (!result.ok) throw new Error(result.reason);
      const [order] = await tx.select().from(orders).where(eq(orders.id, result.orderId));
      expect(order).toMatchObject({ shippingCostAmount: cost, shippingSubsidyAmount: subsidy, shippingAmount: buyer, totalAmount: PRICE + buyer });
    });
  });

  test("a courier cost of Rp0 is never picked: no service, nothing created", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const areaId = await areaQuoting(tx, 0);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE });
      const result = await placeOrder(tx, deps(), input);
      expect(result).toMatchObject({ ok: false, reason: "shipping_no_service" });
      expect(await ordersByAttempt(tx, input.checkoutAttemptId)).toHaveLength(0);
    });
  });

  test("a logged-in buyer with a voucher and a non-zero ongkir share: voucher on goods only, Ongkir and Voucher payment lines", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const customer = await insertCustomer(tx, { phone: null, pdpConsentAt: null, promoConsentAt: null });
      const voucher = await voucherFor(tx, customer.id);
      await customerCart(tx, customer.id, [{ sku: variant.sku, qty: 1 }]);
      const areaId = await areaQuoting(tx, 95_000);
      const { provider, calls } = recordingPaymentProvider();

      const result = await placeOrder(tx, deps(provider), {
        ...guestInput({ shippingAreaId: areaId, guestTokenHash: null, expectedTotal: PRICE + 75_000 - 20_000 }),
        customer: { id: customer.id, email: customer.email },
        // A session's contact email comes from the account, whatever the form sent.
        contact: { email: "someone-else@example.test", phone: "0812-9999-0001" },
        voucherId: voucher.id,
      });
      if (!result.ok) throw new Error(result.reason);

      const [order] = await tx.select().from(orders).where(eq(orders.id, result.orderId));
      expect(order).toMatchObject({
        customerId: customer.id,
        contactEmail: customer.email,
        placedWithSession: true,
        subtotalAmount: PRICE,
        shippingAmount: 75_000,
        discountAmount: 20_000,
        totalAmount: PRICE + 55_000,
        shippingCostAmount: 95_000,
        shippingSubsidyAmount: 20_000,
      });
      const [used] = await tx.select().from(vouchers).where(eq(vouchers.id, voucher.id));
      expect(used).toMatchObject({ status: "used", usedOrderId: result.orderId });
      expect(calls[0]?.lines).toEqual([
        { id: variant.sku, name: "Gamis Basic Black M", price: PRICE, quantity: 1 },
        { id: "SHIPPING", name: "Ongkir", price: 75_000, quantity: 1 },
        { id: "VOUCHER", name: "Voucher", price: -20_000, quantity: 1 },
      ]);
      // The session customer's missing consent and phone are filled from this checkout.
      const [after] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(after?.pdpConsentAt).toBeInstanceOf(Date);
      expect(after?.promoConsentAt).toBeNull();
      expect(after?.phone).toBe("+6281299990001");
    });
  });

  test("a session customer's existing phone, name and consent are kept; someone else's number never lands on the account", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const other = await insertCustomer(tx);
      const customer = await insertCustomer(tx, { phone: null });
      const areaId = await areaQuoting(tx, 12_000);
      await customerCart(tx, customer.id, [{ sku: variant.sku, qty: 1 }]);
      const result = await placeOrder(tx, deps(), {
        ...guestInput({ shippingAreaId: areaId, guestTokenHash: null, expectedTotal: PRICE }),
        customer: { id: customer.id, email: customer.email },
        contact: { phone: other.phone! },
      });
      if (!result.ok) throw new Error(result.reason);
      const [after] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(after).toMatchObject({ phone: null, name: customer.name, pdpConsentAt: customer.pdpConsentAt });
      expect((await tx.select().from(orders).where(eq(orders.id, result.orderId)))[0]?.contactPhone).toBe(other.phone);
    });
  });

  test("a guest whose email matches an existing customer is linked to it, and that customer is never changed", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const existing = await insertCustomer(tx, { pdpConsentAt: null, promoConsentAt: null });
      const areaId = await areaQuoting(tx, 12_000);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const result = await placeOrder(
        tx,
        deps(),
        guestInput({
          shippingAreaId: areaId,
          guestTokenHash: cart.tokenHash,
          expectedTotal: PRICE,
          promoOptIn: true,
          contact: { email: existing.email!.toUpperCase(), phone: "081377778888" },
        }),
      );
      if (!result.ok) throw new Error(result.reason);
      const [order] = await tx.select().from(orders).where(eq(orders.id, result.orderId));
      expect(order?.customerId).toBe(existing.id);
      // The order keeps its own contact snapshot and consent evidence.
      expect(order).toMatchObject({ contactPhone: "+6281377778888", promoOptIn: true });
      const [after] = await tx.select().from(customers).where(eq(customers.id, existing.id));
      expect(after).toMatchObject({ name: existing.name, phone: existing.phone, pdpConsentAt: null, promoConsentAt: null, emailVerifiedAt: null });
    });
  });

  test("a logged-in buyer with a leftover guest cookie: the guest cart is merged first and the cookie can go", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const customer = await insertCustomer(tx);
      const guest = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const areaId = await areaQuoting(tx, 12_000);
      const result = await placeOrder(tx, deps(), {
        ...guestInput({ shippingAreaId: areaId, guestTokenHash: guest.tokenHash, expectedTotal: PRICE }),
        customer: { id: customer.id, email: customer.email },
      });
      if (!result.ok) throw new Error(result.reason);
      expect(result.clearGuestCookie).toBe(true);
      expect(await tx.select().from(carts).where(eq(carts.id, guest.cartId))).toHaveLength(0);
    });
  });

  test("the guest cookie is reported clearable only once the merge ran, refusals included", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const customer = await insertCustomer(tx);
      const guest = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const areaId = await areaQuoting(tx, 12_000);
      const base = { ...guestInput({ shippingAreaId: areaId, guestTokenHash: guest.tokenHash, expectedTotal: PRICE }), customer: { id: customer.id, email: customer.email } };

      // Refused at validation: nothing merged yet, the guest cart must survive for a later merge.
      expect(await placeOrder(tx, deps(), { ...base, termsAccepted: false })).toMatchObject({ ok: false, clearGuestCookie: false });
      expect(await tx.select().from(carts).where(eq(carts.id, guest.cartId))).toHaveLength(1);
      // Refused after the merge: the cookie names nothing any more.
      expect(await placeOrder(tx, deps(), { ...base, expectedTotal: 1 })).toMatchObject({ ok: false, reason: "total_changed", clearGuestCookie: true });
    });
  });

  test("the rate limit hook runs only for a valid, new submit, before the cart or the provider", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const areaId = await areaQuoting(tx, 12_000);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const admit = vi.fn(async () => false);
      const quoteSpy = vi.spyOn(shippingProvider, "quoteRates");
      const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE });

      expect(await placeOrder(tx, { ...deps(), admit }, { ...input, termsAccepted: false })).toMatchObject({ ok: false, reason: "invalid_input" });
      expect(admit).not.toHaveBeenCalled();
      expect(await placeOrder(tx, { ...deps(), admit }, input)).toMatchObject({
        ok: false,
        reason: "rate_limited",
        message: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.",
      });
      expect(admit).toHaveBeenCalledTimes(1);
      expect(quoteSpy).not.toHaveBeenCalled();
    });
  });

  test("validation: every problem at once in form order, nothing read from the cart or written", async () => {
    await withRollback(async (tx) => {
      const quoteSpy = vi.spyOn(shippingProvider, "quoteRates");
      const input = guestInput({
        shippingAreaId: randomUUID(),
        guestTokenHash: null,
        expectedTotal: PRICE,
        contact: { email: "not-an-email", phone: "021 555 1234" },
        address: { recipientName: "", phone: "12", addressLine: "Jl" },
        voucherId: randomUUID(),
        termsAccepted: false,
      });
      const result = await placeOrder(tx, deps(), input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("invalid_input");
      expect(result.fieldErrors.map((error) => error.field)).toEqual([
        "contactEmail",
        "contactPhone",
        "recipientName",
        "phone",
        "shippingAreaId",
        "addressLine",
        "voucherId",
        "termsAccepted",
      ]);
      expect(result.fieldErrors.find((error) => error.field === "voucherId")?.message).toBe("Masuk untuk pakai voucher.");
      expect(quoteSpy).not.toHaveBeenCalled();
      expect(await ordersByAttempt(tx, input.checkoutAttemptId)).toHaveLength(0);
    });
  });

  test("an empty cart or no cart is refused", async () => {
    await withRollback(async (tx) => {
      const areaId = await areaQuoting(tx, 12_000);
      const empty = await guestCart(tx, []);
      expect(await placeOrder(tx, deps(), guestInput({ shippingAreaId: areaId, guestTokenHash: empty.tokenHash, expectedTotal: 0 }))).toMatchObject({
        ok: false,
        reason: "cart_empty",
      });
      expect(await placeOrder(tx, deps(), guestInput({ shippingAreaId: areaId, guestTokenHash: null, expectedTotal: 0 }))).toMatchObject({
        ok: false,
        reason: "cart_empty",
      });
    });
  });

  test.each([
    { name: "provider down", rates: "unavailable" as const, reason: "shipping_unavailable", message: "Ongkir belum bisa dihitung. Coba lagi sebentar lagi." },
    {
      name: "no allowlisted service",
      rates: [{ courierCode: "jne", serviceCode: "ctc", cost: 9_000 }],
      reason: "shipping_no_service",
      message: "Pengiriman ke alamat ini belum tersedia lewat website. Hubungi kami lewat WhatsApp.",
    },
  ])("a quote refusal ($name) creates nothing and holds no stock", async ({ rates, reason, message }) => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const areaId = await areaQuoting(tx, rates);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE });
      expect(await placeOrder(tx, deps(), input)).toMatchObject({ ok: false, reason, message });
      expect(await ordersByAttempt(tx, input.checkoutAttemptId)).toHaveLength(0);
      expect(await activeHolds(tx, variant.sku)).toHaveLength(0);
      expect(await tx.select().from(cartItems).where(eq(cartItems.cartId, cart.cartId))).toHaveLength(1);
    });
  });

  test("a product without a shipping weight cannot be checked out; the SKUs are reported", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx, { weight: null });
      const areaId = await areaQuoting(tx, 12_000);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const result = await placeOrder(tx, deps(), guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE }));
      expect(result).toMatchObject({
        ok: false,
        reason: "shipping_missing_weight",
        message: "Ongkir belum bisa dihitung untuk pesanan ini. Hubungi kami lewat WhatsApp.",
        missingSkus: [variant.sku],
      });
    });
  });

  test("an unpublished product, a deactivated variant or a cart over the caps is refused before anything is written", async () => {
    await withRollback(async (tx) => {
      const unpublished = await sellableSku(tx);
      await tx.update(products).set({ isPublishedOnStorefront: false }).where(eq(products.id, unpublished.product.id));
      const areaId = await areaQuoting(tx, 12_000);
      const cart = await guestCart(tx, [{ sku: unpublished.variant.sku, qty: 1 }]);
      const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE });
      expect(await placeOrder(tx, deps(), input)).toMatchObject({ ok: false, reason: "cart_unavailable" });

      const inactive = await sellableSku(tx);
      await tx.update(productVariants).set({ isActive: false }).where(eq(productVariants.sku, inactive.variant.sku));
      const cart2 = await guestCart(tx, [{ sku: inactive.variant.sku, qty: 1 }]);
      expect(await placeOrder(tx, deps(), guestInput({ shippingAreaId: areaId, guestTokenHash: cart2.tokenHash, expectedTotal: PRICE }))).toMatchObject({
        ok: false,
        reason: "cart_unavailable",
      });

      // Written straight to the table: the cart code itself never lets a cart get here.
      const a = await sellableSku(tx, { stock: 30 });
      const b = await sellableSku(tx, { stock: 30 });
      const c = await sellableSku(tx, { stock: 30 });
      const over = await guestCart(tx, [
        { sku: a.variant.sku, qty: 10 },
        { sku: b.variant.sku, qty: 10 },
        { sku: c.variant.sku, qty: 1 },
      ]);
      expect(await placeOrder(tx, deps(), guestInput({ shippingAreaId: areaId, guestTokenHash: over.tokenHash, expectedTotal: 21 * PRICE }))).toMatchObject({
        ok: false,
        reason: "cart_limit",
        message: "Maksimal 20 barang per pesanan.",
      });
      expect(await activeHolds(tx, a.variant.sku)).toHaveLength(0);
    });
  });

  test("not enough stock: refused with the product, colour and size named, nothing held or written", async () => {
    await withRollback(async (tx) => {
      const { variant, product, color } = await sellableSku(tx, { stock: 1 });
      const areaId = await areaQuoting(tx, 12_000);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 2 }]);
      const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: 2 * PRICE });
      const result = await placeOrder(tx, deps(), input);
      expect(result).toMatchObject({
        ok: false,
        reason: "insufficient_stock",
        message: `Stok ${product.name} warna ${color.name} ukuran M tidak cukup.`,
        fieldErrors: [{ field: variant.sku }],
      });
      expect(await ordersByAttempt(tx, input.checkoutAttemptId)).toHaveLength(0);
      expect(await tx.select().from(customers).where(eq(customers.email, String(input.contact.email)))).toHaveLength(0);
      expect(await tx.select().from(cartItems).where(eq(cartItems.cartId, cart.cartId))).toHaveLength(1);
    });
  });

  test("the cart changes between the quote and the transaction (quantity, or a product's weight): rolled back", async () => {
    await withRollback(async (tx) => {
      const { variant, product } = await sellableSku(tx);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);

      beforeQuote = async () => {
        await tx.update(cartItems).set({ qty: 2 }).where(eq(cartItems.cartId, cart.cartId));
      };
      try {
        const input = guestInput({ shippingAreaId: await areaQuoting(tx, 12_000), guestTokenHash: cart.tokenHash, expectedTotal: PRICE });
        expect(await placeOrder(tx, deps(), input)).toMatchObject({ ok: false, reason: "cart_changed", message: "Isi keranjang berubah. Cek ringkasan lagi." });
        expect(await ordersByAttempt(tx, input.checkoutAttemptId)).toHaveLength(0);

        beforeQuote = async () => {
          await tx.update(products).set({ shippingWeightGrams: WEIGHT + 300 }).where(eq(products.id, product.id));
        };
        const second = guestInput({ shippingAreaId: await areaQuoting(tx, 12_000), guestTokenHash: cart.tokenHash, expectedTotal: 2 * PRICE });
        expect(await placeOrder(tx, deps(), second)).toMatchObject({ ok: false, reason: "cart_changed" });
        expect(await activeHolds(tx, variant.sku)).toHaveLength(0);
      } finally {
        beforeQuote = null;
      }
    });
  });

  test("a total different from what the buyer saw (price changed) is rolled back, voucher untouched", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const customer = await insertCustomer(tx);
      const voucher = await voucherFor(tx, customer.id);
      await customerCart(tx, customer.id, [{ sku: variant.sku, qty: 1 }]);
      const areaId = await areaQuoting(tx, 12_000);
      const result = await placeOrder(tx, deps(), {
        ...guestInput({ shippingAreaId: areaId, guestTokenHash: null, expectedTotal: PRICE }),
        customer: { id: customer.id, email: customer.email },
        voucherId: voucher.id,
      });
      expect(result).toMatchObject({ ok: false, reason: "total_changed", message: "Harga, ongkir atau voucher berubah. Cek ringkasan lagi." });
      expect((await tx.select().from(vouchers).where(eq(vouchers.id, voucher.id)))[0]).toMatchObject({ status: "active", usedOrderId: null });
      expect(await activeHolds(tx, variant.sku)).toHaveLength(0);
    });
  });

  test("a voucher that is someone else's, expired or already used is refused and nothing is written", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx, { stock: 10 });
      const customer = await insertCustomer(tx);
      const stranger = await insertCustomer(tx);
      const areaId = await areaQuoting(tx, 12_000);
      const notMine = await voucherFor(tx, stranger.id);
      const expired = await voucherFor(tx, customer.id, { issuedAt: new Date(Date.now() - 10 * 86_400_000), expiresAt: new Date(Date.now() - 60_000) });
      // Every refusal rolls back, so the one cart line is still there for the next try.
      await customerCart(tx, customer.id, [{ sku: variant.sku, qty: 1 }]);
      for (const voucherId of [notMine.id, expired.id, randomUUID()]) {
        const input = {
          ...guestInput({ shippingAreaId: areaId, guestTokenHash: null, expectedTotal: PRICE - 20_000 }),
          customer: { id: customer.id, email: customer.email },
          voucherId,
        };
        expect(await placeOrder(tx, deps(), input)).toMatchObject({ ok: false, reason: "voucher_unusable", message: "Voucher tidak bisa dipakai." });
        expect(await ordersByAttempt(tx, input.checkoutAttemptId)).toHaveLength(0);
      }
      expect(await activeHolds(tx, variant.sku)).toHaveLength(0);
    });
  });

  test("a repeat submit of the same attempt answers with the same order; another buyer reusing the id is refused", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const areaId = await areaQuoting(tx, 12_000);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const { provider } = recordingPaymentProvider();
      const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE });
      const first = await placeOrder(tx, deps(provider), input);
      if (!first.ok) throw new Error(first.reason);
      const second = await placeOrder(tx, deps(provider), { ...input, orderAccessToken: first.accessToken });
      if (!second.ok) throw new Error(second.reason);
      expect(second).toMatchObject({ orderNo: first.orderNo, redirectUrl: first.redirectUrl, replayed: true, accessToken: null });
      expect(await ordersByAttempt(tx, input.checkoutAttemptId)).toHaveLength(1);
      expect(provider.createPayment).toHaveBeenCalledTimes(1);

      // A guest without the checkout cookie's token gets the order number, not the payment page.
      expect(await placeOrder(tx, deps(provider), input)).toMatchObject({ ok: true, orderNo: first.orderNo, redirectUrl: null });
      expect(await placeOrder(tx, deps(provider), { ...input, orderAccessToken: "x".repeat(43) })).toMatchObject({ ok: true, redirectUrl: null });
      // Nor once the order no longer awaits payment.
      await tx.update(orders).set({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" }).where(eq(orders.id, first.orderId));
      expect(await placeOrder(tx, deps(provider), { ...input, orderAccessToken: first.accessToken })).toMatchObject({ ok: true, redirectUrl: null });

      const intruder = await placeOrder(tx, deps(provider), { ...input, contact: { ...input.contact, email: "intruder@example.test" } });
      expect(intruder).toMatchObject({ ok: false, reason: "invalid_input" });
    });
  });

  test("at most 3 unpaid orders per contact email in 2 hours", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx, { stock: 10 });
      const areaId = await areaQuoting(tx, 12_000);
      const email = `hoarder-${randomUUID()}@example.test`;
      for (let index = 0; index < 4; index++) {
        const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
        const result = await placeOrder(tx, deps(), guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE, contact: { email, phone: "081211112222" } }));
        if (index < 3) expect(result.ok).toBe(true);
        else expect(result).toMatchObject({ ok: false, reason: "too_many_unpaid" });
      }
      expect(await activeHolds(tx, variant.sku)).toHaveLength(3);
    });
  });

  test("guest orders placed with a customer's email never block that customer's own logged-in checkout", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx, { stock: 10 });
      const victim = await insertCustomer(tx);
      const areaId = await areaQuoting(tx, 12_000);
      for (let index = 0; index < 3; index++) {
        const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
        const result = await placeOrder(tx, deps(), guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE, contact: { email: victim.email!, phone: "081211112222" } }));
        expect(result.ok).toBe(true);
      }
      await customerCart(tx, victim.id, [{ sku: variant.sku, qty: 1 }]);
      const own = await placeOrder(tx, deps(), {
        ...guestInput({ shippingAreaId: areaId, guestTokenHash: null, expectedTotal: PRICE }),
        customer: { id: victim.id, email: victim.email },
      });
      expect(own.ok).toBe(true);
    });
  });

  test("a payment provider failure keeps the order pending without a payment page", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx);
      const areaId = await areaQuoting(tx, 12_000);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 1 }]);
      const failing = createFakePaymentProvider({ baseUrl: "http://localhost:3000", failWith: "unavailable" });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const result = await placeOrder(tx, deps(failing), guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE }));
      if (!result.ok) throw new Error(result.reason);
      expect(result.redirectUrl).toBeNull();
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("payment page not created"), expect.objectContaining({ reason: "unavailable" }));
      const [payment] = await tx.select().from(payments).where(eq(payments.orderId, result.orderId));
      expect(payment).toMatchObject({ status: "created", snapToken: null, redirectUrl: null });
      expect(await activeHolds(tx, variant.sku)).toHaveLength(1);
    });
  });

  test("when the order is paid, unit_cost is locked at the moving average and the holds are consumed", async () => {
    await withRollback(async (tx) => {
      const { variant } = await sellableSku(tx, { stock: 4 });
      const staff = await insertStaffUser(tx);
      const areaId = await areaQuoting(tx, 12_000);
      const cart = await guestCart(tx, [{ sku: variant.sku, qty: 2 }]);
      const result = await placeOrder(tx, deps(), guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: 2 * PRICE }));
      if (!result.ok) throw new Error(result.reason);

      // The payment state machine goes through this same transition (payments/apply-status.test.ts
      // checks it from a notification).
      await transitionOrderStatus(result.orderId, "to_ship", staff.id, tx);

      const [item] = await tx.select().from(orderItems).where(eq(orderItems.orderId, result.orderId));
      expect(item?.unitCost).toBe(UNIT_COST);
      const sale = await tx.select().from(stockMovements).where(and(eq(stockMovements.sku, variant.sku), eq(stockMovements.type, "sale")));
      expect(sale).toMatchObject([{ qty: -2, valueAmount: -2 * UNIT_COST, refId: item?.id }]);
      expect((await tx.select().from(stockReservations).where(eq(stockReservations.orderId, result.orderId)))[0]?.status).toBe("consumed");
    });
  });
});

// ---------- races: real, separately committed transactions (cleaned up below) ----------

interface Created {
  skus: string[];
  productIds: string[];
  colorIds: string[];
  fabricIds: string[];
  emails: string[];
  customerIds: string[];
  cartIds: string[];
  areaIds: string[];
}

async function cleanUp(created: Created): Promise<void> {
  const orderRows = await testDb
    .select({ id: orders.id })
    .from(orders)
    .where(created.emails.length > 0 ? inArray(orders.contactEmail, created.emails) : sql`false`);
  const orderIds = orderRows.map((row) => row.id);
  if (orderIds.length > 0) {
    await testDb.update(vouchers).set({ status: "active", usedOrderId: null, usedAt: null }).where(inArray(vouchers.usedOrderId, orderIds));
    await testDb.delete(stockReservations).where(inArray(stockReservations.orderId, orderIds));
    await testDb.delete(payments).where(inArray(payments.orderId, orderIds));
    await testDb.delete(orderAccessTokens).where(inArray(orderAccessTokens.orderId, orderIds));
    await testDb.delete(auditLog).where(inArray(auditLog.entityId, orderIds));
    await testDb.delete(orders).where(inArray(orders.id, orderIds));
  }
  const voucherRows = created.customerIds.length > 0 ? await testDb.select().from(vouchers).where(inArray(vouchers.customerId, created.customerIds)) : [];
  if (voucherRows.length > 0) {
    await testDb.delete(vouchers).where(inArray(vouchers.id, voucherRows.map((row) => row.id)));
    const cards = await testDb.select().from(thankYouCards).where(inArray(thankYouCards.id, voucherRows.map((row) => row.cardId)));
    await testDb.delete(thankYouCards).where(inArray(thankYouCards.id, cards.map((card) => card.id)));
    await testDb.delete(orders).where(inArray(orders.id, cards.map((card) => card.orderId)));
    await testDb.delete(staffUsers).where(inArray(staffUsers.id, cards.map((card) => card.printedByStaffUserId)));
  }
  if (created.cartIds.length > 0) await testDb.delete(carts).where(inArray(carts.id, created.cartIds));
  const customerRows = await testDb
    .select({ id: customers.id })
    .from(customers)
    .where(created.emails.length > 0 ? inArray(customers.email, created.emails) : sql`false`);
  const customerIds = [...new Set([...created.customerIds, ...customerRows.map((row) => row.id)])];
  if (customerIds.length > 0) {
    await testDb.delete(carts).where(inArray(carts.customerId, customerIds));
    await testDb.delete(customers).where(inArray(customers.id, customerIds));
  }
  if (created.skus.length > 0) {
    await withTriggerDisabled(testDb, "stock_movements", "prevent_stock_movement_mutation", () =>
      testDb.delete(stockMovements).where(inArray(stockMovements.sku, created.skus)),
    );
    await testDb.delete(productVariants).where(inArray(productVariants.sku, created.skus));
  }
  if (created.productIds.length > 0) await testDb.delete(products).where(inArray(products.id, created.productIds));
  if (created.colorIds.length > 0) await testDb.delete(fabricColors).where(inArray(fabricColors.id, created.colorIds));
  if (created.fabricIds.length > 0) await testDb.delete(fabrics).where(inArray(fabrics.id, created.fabricIds));
  if (created.areaIds.length > 0) {
    const areaRows = await testDb.select().from(shippingAreas).where(inArray(shippingAreas.id, created.areaIds));
    await testDb.delete(shippingRateCache).where(inArray(shippingRateCache.destinationId, areaRows.map((row) => row.providerAreaId!)));
    await testDb.delete(shippingAreas).where(inArray(shippingAreas.id, created.areaIds));
  }
}

function emptyCreated(): Created {
  return { skus: [], productIds: [], colorIds: [], fabricIds: [], emails: [], customerIds: [], cartIds: [], areaIds: [] };
}

async function committedSku(created: Created, stock: number) {
  const fixture = await sellableSku(testDb, { stock });
  created.skus.push(fixture.variant.sku);
  created.productIds.push(fixture.product.id);
  created.colorIds.push(fixture.color.id);
  created.fabricIds.push(fixture.fabric.id);
  return fixture;
}

describe("placeOrder races", () => {
  test("a variant lock held past lock_timeout refuses with a retry message instead of queueing", async () => {
    const created = emptyCreated();
    try {
      const { variant } = await committedSku(created, 5);
      const areaId = await areaQuoting(testDb, 12_000);
      created.areaIds.push(areaId);
      const cart = await guestCart(testDb, [{ sku: variant.sku, qty: 1 }]);
      created.cartIds.push(cart.cartId);
      const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE });
      created.emails.push(String(input.contact.email));

      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // An admin stock write holding the variant, as saveStockCount would.
      const holder = testDb.transaction(async (other) => {
        await other.execute(sql`select sku from product_variants where sku = ${variant.sku} for update`);
        locked();
        await released;
      });
      await isLocked;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const result = await placeOrder(testDb, deps(), input).finally(release);
      await holder;
      expect(result).toMatchObject({ ok: false, reason: "busy", message: "Pesanan belum bisa diproses. Coba lagi sebentar lagi." });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("lock_timeout"));
      expect(await ordersByAttempt(testDb, input.checkoutAttemptId)).toHaveLength(0);
    } finally {
      await cleanUp(created);
    }
  });

  test("two buyers racing for the last piece: exactly one order, the other is told which item ran out", async () => {
    const created = emptyCreated();
    try {
      const { variant, product, color } = await committedSku(created, 1);
      const areaId = await areaQuoting(testDb, 12_000);
      created.areaIds.push(areaId);
      const inputs = await Promise.all(
        [0, 1].map(async () => {
          const cart = await guestCart(testDb, [{ sku: variant.sku, qty: 1 }]);
          created.cartIds.push(cart.cartId);
          const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE });
          created.emails.push(String(input.contact.email));
          return input;
        }),
      );

      const results = await Promise.all(inputs.map((input) => placeOrder(testDb, deps(), input)));
      const placed = results.filter((result) => result.ok);
      const refused = results.filter((result) => !result.ok);
      expect(placed).toHaveLength(1);
      expect(refused).toMatchObject([{ ok: false, reason: "insufficient_stock", message: `Stok ${product.name} warna ${color.name} ukuran M tidak cukup.` }]);
      expect(await activeHolds(testDb, variant.sku)).toHaveLength(1);
      const orderRows = await testDb.select().from(orders).where(inArray(orders.contactEmail, created.emails));
      expect(orderRows).toHaveLength(1);
      // The loser's cart is untouched, ready for another try.
      const loser = inputs[results.findIndex((result) => !result.ok)]!;
      const [loserCart] = await testDb.select().from(carts).where(eq(carts.tokenHash, loser.guestTokenHash!));
      expect(await testDb.select().from(cartItems).where(eq(cartItems.cartId, loserCart!.id))).toHaveLength(1);
    } finally {
      await cleanUp(created);
    }
  });

  test("a double submit racing itself creates one order; both answers carry it", async () => {
    const created = emptyCreated();
    try {
      const { variant } = await committedSku(created, 5);
      const areaId = await areaQuoting(testDb, 12_000);
      created.areaIds.push(areaId);
      const cart = await guestCart(testDb, [{ sku: variant.sku, qty: 1 }]);
      created.cartIds.push(cart.cartId);
      const input = guestInput({ shippingAreaId: areaId, guestTokenHash: cart.tokenHash, expectedTotal: PRICE });
      created.emails.push(String(input.contact.email));

      const [a, b] = await Promise.all([placeOrder(testDb, deps(), input), placeOrder(testDb, deps(), input)]);
      if (!a?.ok || !b?.ok) throw new Error(`expected both to answer with the order: ${JSON.stringify([a, b])}`);
      expect(a.orderNo).toBe(b.orderNo);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      expect(await ordersByAttempt(testDb, input.checkoutAttemptId)).toHaveLength(1);
      expect(await activeHolds(testDb, variant.sku)).toHaveLength(1);
    } finally {
      await cleanUp(created);
    }
  });

  test("the same voucher in two tabs: used once; the second tab is refused and no second order exists", async () => {
    const created = emptyCreated();
    try {
      const { variant } = await committedSku(created, 5);
      const customer = await insertCustomer(testDb);
      created.customerIds.push(customer.id);
      created.emails.push(customer.email!);
      const voucher = await voucherFor(testDb, customer.id);
      await customerCart(testDb, customer.id, [{ sku: variant.sku, qty: 1 }]);
      const areaId = await areaQuoting(testDb, 12_000);
      created.areaIds.push(areaId);
      const tab = () => ({
        ...guestInput({ shippingAreaId: areaId, guestTokenHash: null, expectedTotal: PRICE - 20_000 }),
        customer: { id: customer.id, email: customer.email },
        voucherId: voucher.id,
      });

      const results = await Promise.all([placeOrder(testDb, deps(), tab()), placeOrder(testDb, deps(), tab())]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      // The loser waited on the cart lock and found it already ordered.
      expect(results.filter((result) => !result.ok)).toMatchObject([{ ok: false, reason: "cart_empty" }]);

      // Refilling the cart in the second tab does not make the voucher usable again.
      const [cart] = await testDb.select().from(carts).where(eq(carts.customerId, customer.id));
      await testDb.insert(cartItems).values({ cartId: cart!.id, sku: variant.sku, qty: 1 });
      expect(await placeOrder(testDb, deps(), tab())).toMatchObject({ ok: false, reason: "voucher_unusable" });

      const orderRows = await testDb.select().from(orders).where(eq(orders.customerId, customer.id));
      expect(orderRows.filter((row) => row.paymentStatus !== null)).toHaveLength(1);
      expect((await testDb.select().from(vouchers).where(eq(vouchers.id, voucher.id)))[0]).toMatchObject({ status: "used", usedOrderId: orderRows.find((row) => row.paymentStatus)?.id });
    } finally {
      await cleanUp(created);
    }
  });
});

