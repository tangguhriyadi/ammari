import { randomInt, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, test, vi } from "vitest";
import { testDb } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, insertThankYouCard, shippingQuoteValues } from "@ammari/db/test-fixtures";
import {
  customers,
  fabricColors,
  fabrics,
  orderAccessTokens,
  orderItems,
  orders,
  payments,
  products,
  productVariants,
  staffUsers,
  thankYouCards,
  vouchers,
} from "@ammari/db/schema";
import { generateOrderAccessToken, hashOrderAccessToken } from "@ammari/commerce/checkout";

// docs/plans/cart-checkout.md §4.3, §4.4, session 10: who may see a finish page, what state it
// shows, and the logged-in voucher dropdown, against the real `ammari_test` database.

vi.mock("@/lib/db", async () => ({ defaultDb: (await import("@ammari/db/test-utils")).testDb }));

const { findOwnedCheckoutOrderId, listUsableVouchers, loadFinishOrder } = await import("./queries");

const created = { orderIds: [] as string[], customerIds: [] as string[], skus: [] as string[], productIds: [] as string[], colorIds: [] as string[], fabricIds: [] as string[], cardIds: [] as string[] };
let sequence = 0;

/** A valid, unused `ORD-YYYYMM-NNNN...` number (a far-future month, so it never meets a real one). */
function uniqueOrderNo(): string {
  sequence += 1;
  return `ORD-209912-${randomInt(10_000_000, 99_999_999)}${sequence}`;
}

afterAll(async () => {
  await testDb.delete(vouchers).where(inArray(vouchers.customerId, created.customerIds));
  const staffIds = (await testDb.select({ id: thankYouCards.printedByStaffUserId }).from(thankYouCards).where(inArray(thankYouCards.id, created.cardIds))).map((row) => row.id);
  if (created.cardIds.length > 0) await testDb.delete(thankYouCards).where(inArray(thankYouCards.id, created.cardIds));
  if (staffIds.length > 0) await testDb.delete(staffUsers).where(inArray(staffUsers.id, staffIds));
  if (created.orderIds.length > 0) {
    await testDb.delete(payments).where(inArray(payments.orderId, created.orderIds));
    await testDb.delete(orderAccessTokens).where(inArray(orderAccessTokens.orderId, created.orderIds));
    await testDb.delete(orders).where(inArray(orders.id, created.orderIds));
  }
  if (created.customerIds.length > 0) await testDb.delete(customers).where(inArray(customers.id, created.customerIds));
  await testDb.delete(productVariants).where(inArray(productVariants.sku, created.skus));
  await testDb.delete(products).where(inArray(products.id, created.productIds));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, created.colorIds));
  await testDb.delete(fabrics).where(inArray(fabrics.id, created.fabricIds));
});

async function customer() {
  const row = await insertCustomer(testDb, { emailVerifiedAt: new Date() });
  created.customerIds.push(row.id);
  return row;
}

/** A checkout order with one Rp259.000 line, Rp95.000 courier cost (buyer Rp75.000), its payment
 * attempt and a checkout access token. */
async function checkoutOrder(overrides: Partial<typeof orders.$inferInsert> = {}) {
  const { fabric, color, product, variant } = await insertProductVariant(testDb);
  created.skus.push(variant.sku);
  created.productIds.push(product.id);
  created.colorIds.push(color.id);
  created.fabricIds.push(fabric.id);
  const orderNo = uniqueOrderNo();
  const quote = shippingQuoteValues(95_000);
  const order = await insertOrder(testDb, {
    ...checkoutOrderValues(),
    ...quote,
    orderNo,
    contactEmail: `finish-${randomUUID()}@example.test`,
    subtotalAmount: 259_000,
    discountAmount: 0,
    totalAmount: 259_000 + (quote.shippingAmount ?? 0),
    ...overrides,
  });
  created.orderIds.push(order.id);
  await testDb.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });
  await testDb.insert(payments).values({
    orderId: order.id,
    provider: "midtrans",
    providerOrderId: `${order.orderNo}-1-${randomUUID()}`,
    attempt: 1,
    grossAmount: order.totalAmount,
    redirectUrl: "http://localhost:3000/api/test/payments/x",
  });
  const token = generateOrderAccessToken();
  await testDb.insert(orderAccessTokens).values({ orderId: order.id, tokenHash: hashOrderAccessToken(token), expiresAt: new Date(Date.now() + 86_400_000) });
  return { order, token };
}

describe("loadFinishOrder", () => {
  test("a guest with the checkout cookie sees a pending order, its deadline, payment link and totals (no cost)", async () => {
    const { order, token } = await checkoutOrder();
    const view = await loadFinishOrder({ orderNo: order.orderNo, sessionCustomerId: null, accessTokens: [token] }, testDb);
    expect(view).toMatchObject({
      orderNo: order.orderNo,
      state: "pending",
      isGuestOrder: true,
      guestContactEmail: order.contactEmail,
      subtotal: 259_000,
      shipping: 75_000,
      discount: 0,
      total: 334_000,
      courierLabel: "JNE Reguler",
      paymentUrl: "http://localhost:3000/api/test/payments/x",
      lines: [{ qty: 1, lineTotal: 259_000 }],
    });
    expect(view?.payBy).toMatch(/ WIB$/);
    expect(JSON.stringify(view)).not.toMatch(/unitCost|unit_cost/);
  });

  test("a line snapshotted below its normal price: struck total and Hemat from list_unit_price; NULL shows neither", async () => {
    const { order, token } = await checkoutOrder();
    await testDb.update(orderItems).set({ listUnitPrice: 350_000 }).where(eq(orderItems.orderId, order.id));
    const view = await loadFinishOrder({ orderNo: order.orderNo, sessionCustomerId: null, accessTokens: [token] }, testDb);
    expect(view).toMatchObject({ subtotal: 259_000, savings: 91_000, lines: [{ lineTotal: 259_000, listLineTotal: 350_000 }] });

    const plain = await checkoutOrder();
    const plainView = await loadFinishOrder({ orderNo: plain.order.orderNo, sessionCustomerId: null, accessTokens: [plain.token] }, testDb);
    expect(plainView).toMatchObject({ savings: 0, lines: [{ lineTotal: 259_000, listLineTotal: null }] });
  });

  test("no proof, a wrong or malformed token, an expired token, or a bad order number: null", async () => {
    const { order } = await checkoutOrder();
    expect(await loadFinishOrder({ orderNo: order.orderNo, sessionCustomerId: null, accessTokens: [null] }, testDb)).toBeNull();
    expect(await loadFinishOrder({ orderNo: order.orderNo, sessionCustomerId: null, accessTokens: [generateOrderAccessToken()] }, testDb)).toBeNull();
    expect(await loadFinishOrder({ orderNo: order.orderNo, sessionCustomerId: null, accessTokens: ["short"] }, testDb)).toBeNull();
    expect(await loadFinishOrder({ orderNo: "not-an-order", sessionCustomerId: null, accessTokens: [null] }, testDb)).toBeNull();

    const expired = generateOrderAccessToken();
    await testDb.insert(orderAccessTokens).values({ orderId: order.id, tokenHash: hashOrderAccessToken(expired), createdAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 1000) });
    expect(await loadFinishOrder({ orderNo: order.orderNo, sessionCustomerId: null, accessTokens: [expired] }, testDb)).toBeNull();
  });

  test("another order's token does not open this one", async () => {
    const first = await checkoutOrder();
    const second = await checkoutOrder();
    expect(await loadFinishOrder({ orderNo: second.order.orderNo, sessionCustomerId: null, accessTokens: [first.token] }, testDb)).toBeNull();
  });

  test("a session opens orders it placed while logged in, and guest orders only while their email is still the account's (session 15)", async () => {
    const owner = await customer();
    const placed = await checkoutOrder({ customerId: owner.id, placedWithSession: true });
    const linked = await checkoutOrder({ customerId: owner.id, placedWithSession: false, contactEmail: owner.email });
    const otherEmail = await checkoutOrder({ customerId: owner.id, placedWithSession: false });
    const view = await loadFinishOrder({ orderNo: placed.order.orderNo, sessionCustomerId: owner.id, accessTokens: [null] }, testDb);
    expect(view).toMatchObject({ state: "pending", isGuestOrder: false, guestContactEmail: null });
    expect(await loadFinishOrder({ orderNo: linked.order.orderNo, sessionCustomerId: owner.id, accessTokens: [null] }, testDb)).toMatchObject({ isGuestOrder: true });
    expect(await loadFinishOrder({ orderNo: otherEmail.order.orderNo, sessionCustomerId: owner.id, accessTokens: [null] }, testDb)).toBeNull();
    const stranger = await customer();
    expect(await loadFinishOrder({ orderNo: placed.order.orderNo, sessionCustomerId: stranger.id, accessTokens: [null] }, testDb)).toBeNull();
  });

  test("states: paid, past the payment window (confirming), cancelled; no payment link outside pending", async () => {
    const paid = await checkoutOrder({ status: "to_ship", paymentStatus: "paid", paidAt: new Date() });
    expect(await loadFinishOrder({ orderNo: paid.order.orderNo, sessionCustomerId: null, accessTokens: [paid.token] }, testDb)).toMatchObject({
      state: "paid",
      paymentUrl: null,
      payBy: null,
    });
    // Past the window but not finalized: a last-minute payment may still be confirmed.
    const late = await checkoutOrder({ paymentExpiresAt: new Date(Date.now() - 60_000) });
    expect(await loadFinishOrder({ orderNo: late.order.orderNo, sessionCustomerId: null, accessTokens: [late.token] }, testDb)).toMatchObject({
      state: "confirming",
      paymentUrl: null,
      payBy: null,
    });
    const cancelled = await checkoutOrder({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired" });
    expect(await loadFinishOrder({ orderNo: cancelled.order.orderNo, sessionCustomerId: null, accessTokens: [cancelled.token] }, testDb)).toMatchObject({
      state: "failed",
    });
    // Paid after the order was cancelled: never "Pembayaran berhasil", the money goes back.
    const refund = await checkoutOrder({ status: "cancelled", paymentStatus: "paid", paidAt: new Date(), cancelReason: "payment_expired" });
    expect(await loadFinishOrder({ orderNo: refund.order.orderNo, sessionCustomerId: null, accessTokens: [refund.token] }, testDb)).toMatchObject({
      state: "refund_pending",
    });
  });

  test("findOwnedCheckoutOrderId: the buyer's order id, null for a stranger or a malformed number", async () => {
    const placed = await checkoutOrder({});
    expect(await findOwnedCheckoutOrderId({ orderNo: placed.order.orderNo, sessionCustomerId: null, accessTokens: [placed.token] }, testDb)).toBe(placed.order.id);
    expect(await findOwnedCheckoutOrderId({ orderNo: placed.order.orderNo, sessionCustomerId: null, accessTokens: [null] }, testDb)).toBeNull();
    expect(await findOwnedCheckoutOrderId({ orderNo: "ORD-x", sessionCustomerId: null, accessTokens: [placed.token] }, testDb)).toBeNull();
  });

  test("a non-checkout order is never shown", async () => {
    const order = await insertOrder(testDb, { orderNo: uniqueOrderNo() });
    created.orderIds.push(order.id);
    const owner = await customer();
    expect(await loadFinishOrder({ orderNo: order.orderNo, sessionCustomerId: owner.id, accessTokens: [null] }, testDb)).toBeNull();
  });
});

describe("listUsableVouchers", () => {
  test("active and unexpired only, largest amount first, then soonest expiry", async () => {
    const owner = await customer();
    const other = await customer();
    async function voucher(customerId: string, values: Partial<typeof vouchers.$inferInsert>) {
      // One card per order: each voucher gets its own marketplace order.
      const order = await insertOrder(testDb, { orderNo: uniqueOrderNo() });
      created.orderIds.push(order.id);
      const card = await insertThankYouCard(testDb, order.id);
      created.cardIds.push(card.id);
      const [row] = await testDb
        .insert(vouchers)
        .values({ cardId: card.id, customerId, expiresAt: new Date(Date.now() + 30 * 86_400_000), ...values })
        .returning();
      return row!;
    }
    const later = await voucher(owner.id, { amount: 20_000, expiresAt: new Date(Date.now() + 60 * 86_400_000) });
    const sooner = await voucher(owner.id, { amount: 20_000, expiresAt: new Date(Date.now() + 10 * 86_400_000) });
    const bigger = await voucher(owner.id, { amount: 30_000 });
    await voucher(owner.id, { status: "expired", expiresAt: new Date(Date.now() + 86_400_000) });
    await voucher(owner.id, { issuedAt: new Date(Date.now() - 10 * 86_400_000), expiresAt: new Date(Date.now() - 1000) });
    await voucher(other.id, { amount: 50_000 });

    const list = await listUsableVouchers(owner.id, testDb);
    expect(list.map((row) => row.id)).toEqual([bigger.id, sooner.id, later.id]);
    expect(list[0]).toMatchObject({ amount: 30_000, expiresOn: expect.stringMatching(/^\d{1,2} \S+ \d{4}$/) });
  });
});
