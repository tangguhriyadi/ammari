import { randomInt, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, test, vi } from "vitest";
import { testDb } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { customers, fabricColors, fabrics, orderAccessTokens, orderItems, orders, payments, products, productVariants } from "@ammari/db/schema";
import { generateOrderAccessToken, hashOrderAccessToken } from "@ammari/commerce/checkout";
import { customerOrderStatus } from "./status";

// docs/plans/cart-checkout.md §9.1, §9.2, session 15: who may see which order ("Pesanan saya", the
// order page, the "Lihat pesanan" token), what the customer reads, and which orders "Pesan lagi"
// accepts, against the real `ammari_test` database.

vi.mock("@/lib/db", async () => ({ defaultDb: (await import("@ammari/db/test-utils")).testDb }));

const { findAccessibleOrder, redeemOrderViewToken, visibleToCustomerSql } = await import("./access");
const { listCustomerOrders, loadCustomerOrderDetail, loadReorderLines, ORDERS_PAGE_SIZE } = await import("./queries");

const created = { orderIds: [] as string[], customerIds: [] as string[], skus: [] as string[], productIds: [] as string[], colorIds: [] as string[], fabricIds: [] as string[] };
let sequence = 0;

/** A valid, unused `ORD-YYYYMM-NNNN...` number (a far-future month, so it never meets a real one). */
function uniqueOrderNo(): string {
  sequence += 1;
  return `ORD-209911-${randomInt(10_000_000, 99_999_999)}${sequence}`;
}

afterAll(async () => {
  if (created.orderIds.length > 0) {
    await testDb.delete(payments).where(inArray(payments.orderId, created.orderIds));
    await testDb.delete(orderAccessTokens).where(inArray(orderAccessTokens.orderId, created.orderIds));
    await testDb.delete(orderItems).where(inArray(orderItems.orderId, created.orderIds));
    await testDb.delete(orders).where(inArray(orders.id, created.orderIds));
  }
  if (created.customerIds.length > 0) await testDb.delete(customers).where(inArray(customers.id, created.customerIds));
  await testDb.delete(productVariants).where(inArray(productVariants.sku, created.skus));
  await testDb.delete(products).where(inArray(products.id, created.productIds));
  await testDb.delete(fabricColors).where(inArray(fabricColors.id, created.colorIds));
  await testDb.delete(fabrics).where(inArray(fabrics.id, created.fabricIds));
});

async function customer(overrides: Partial<typeof customers.$inferInsert> = {}) {
  const row = await insertCustomer(testDb, { emailVerifiedAt: new Date(), ...overrides });
  created.customerIds.push(row.id);
  return row as typeof row & { email: string };
}

async function line(orderId: string, qty = 1, unitPrice = 259_000) {
  const { fabric, color, product, variant } = await insertProductVariant(testDb);
  created.skus.push(variant.sku);
  created.productIds.push(product.id);
  created.colorIds.push(color.id);
  created.fabricIds.push(fabric.id);
  await testDb.insert(orderItems).values({ orderId, sku: variant.sku, qty, unitPrice, unitCost: 7_654_321 });
  return { product, variant, color };
}

async function token(orderId: string, expiresAt = new Date(Date.now() + 86_400_000)) {
  const raw = generateOrderAccessToken();
  await testDb.insert(orderAccessTokens).values({ orderId, tokenHash: hashOrderAccessToken(raw), createdAt: new Date(expiresAt.getTime() - 2 * 86_400_000), expiresAt });
  return raw;
}

/** A checkout order with one Rp259.000 line and a Rp95.000 courier cost (buyer Rp75.000). */
async function checkoutOrder(overrides: Partial<typeof orders.$inferInsert> = {}) {
  const quote = shippingQuoteValues(95_000);
  const order = await insertOrder(testDb, {
    ...checkoutOrderValues(),
    ...quote,
    orderNo: uniqueOrderNo(),
    contactEmail: `orders-${randomUUID()}@example.test`,
    shippingAddress: "Siti, +6281234567890, Jl. Mawar 1, Kecamatan E2E, Kota, Provinsi 12345",
    subtotalAmount: 259_000,
    discountAmount: 0,
    totalAmount: 259_000 + (quote.shippingAmount ?? 0),
    ...overrides,
  });
  created.orderIds.push(order.id);
  const item = await line(order.id);
  return { order, item };
}

/** A staff-entered marketplace order for the customer (no payment status). */
async function marketplaceOrder(customerId: string, orderDate = new Date()) {
  const order = await insertOrder(testDb, { orderNo: uniqueOrderNo(), customerId, orderDate, status: "shipped", courier: "J&T", trackingNumber: "JT123", shippedAt: orderDate });
  created.orderIds.push(order.id);
  await line(order.id, 2, 199_000);
  return order;
}

describe("customerOrderStatus", () => {
  const status = (status: string, paymentStatus: string | null, paymentWindowOpen = true) => customerOrderStatus({ status, paymentStatus, paymentWindowOpen });

  test("the six customer labels", () => {
    expect(status("awaiting_payment", "pending").label).toBe("Menunggu pembayaran");
    expect(status("to_ship", "paid").label).toBe("Diproses");
    expect(status("shipped", "paid").label).toBe("Dikirim");
    expect(status("completed", "paid").label).toBe("Selesai");
    expect(status("cancelled", "expired").label).toBe("Dibatalkan");
    expect(status("returned", null).label).toBe("Dikembalikan");
  });

  test("payable only inside the window; past it the order waits for confirmation (no lazy finalize)", () => {
    expect(status("awaiting_payment", "pending")).toMatchObject({ payable: true, confirming: false });
    expect(status("awaiting_payment", "pending", false)).toMatchObject({ label: "Menunggu konfirmasi pembayaran", payable: false, confirming: true });
    // A staff-entered order awaiting payment has no storefront payment page.
    expect(status("awaiting_payment", null)).toMatchObject({ label: "Menunggu pembayaran", payable: false });
  });

  test("paid while stock was short reads as being processed; paid after cancel says the money goes back", () => {
    expect(status("awaiting_payment", "paid")).toMatchObject({ label: "Diproses", payable: false });
    expect(status("cancelled", "paid")).toMatchObject({ label: "Dibatalkan", reorderable: false });
    expect(status("cancelled", "paid").note).toContain("kami kembalikan penuh");
  });

  test("Pesan lagi only for a cancelled checkout order that was never paid", () => {
    for (const paymentStatus of ["pending", "expired", "cancelled"]) expect(status("cancelled", paymentStatus).reorderable).toBe(true);
    for (const paymentStatus of ["paid", "refunded", "partially_refunded", "chargeback"]) expect(status("cancelled", paymentStatus).reorderable).toBe(false);
    expect(status("cancelled", null).reorderable).toBe(false);
    expect(status("completed", "paid").reorderable).toBe(false);
  });

  test("an unknown status never reads as finished", () => {
    expect(status("something_new", null)).toMatchObject({ stage: "processing", label: "Diproses" });
  });
});

describe("who may see an order", () => {
  test("a session sees its manual/marketplace orders, orders placed logged in, and guest orders under its current email only", async () => {
    const owner = await customer();
    const manual = await marketplaceOrder(owner.id);
    const placed = await checkoutOrder({ customerId: owner.id, placedWithSession: true });
    const guestSameEmail = await checkoutOrder({ customerId: owner.id, contactEmail: owner.email.toUpperCase() });
    const guestOtherEmail = await checkoutOrder({ customerId: owner.id });

    for (const order of [manual, placed.order, guestSameEmail.order]) {
      expect(await findAccessibleOrder({ orderNo: order.orderNo, sessionCustomerId: owner.id, accessTokens: [] }, testDb)).toEqual({ orderId: order.id, via: "session" });
    }
    expect(await findAccessibleOrder({ orderNo: guestOtherEmail.order.orderNo, sessionCustomerId: owner.id, accessTokens: [] }, testDb)).toBeNull();

    // An account whose email was never verified sees no guest order typed with it.
    const unverified = await customer({ emailVerifiedAt: null });
    const typed = await checkoutOrder({ customerId: unverified.id, contactEmail: unverified.email });
    expect(await findAccessibleOrder({ orderNo: typed.order.orderNo, sessionCustomerId: unverified.id, accessTokens: [] }, testDb)).toBeNull();

    // The account's email changes: the guest order typed with the old one drops out.
    await testDb.update(customers).set({ email: `changed-${randomUUID()}@example.test` }).where(eq(customers.id, owner.id));
    expect(await findAccessibleOrder({ orderNo: guestSameEmail.order.orderNo, sessionCustomerId: owner.id, accessTokens: [] }, testDb)).toBeNull();
    expect(await findAccessibleOrder({ orderNo: placed.order.orderNo, sessionCustomerId: owner.id, accessTokens: [] }, testDb)).not.toBeNull();
  });

  test("another customer's session, an unknown number and a malformed number all get null", async () => {
    const owner = await customer();
    const stranger = await customer();
    const { order } = await checkoutOrder({ customerId: owner.id, placedWithSession: true });
    expect(await findAccessibleOrder({ orderNo: order.orderNo, sessionCustomerId: stranger.id, accessTokens: [] }, testDb)).toBeNull();
    expect(await findAccessibleOrder({ orderNo: uniqueOrderNo(), sessionCustomerId: owner.id, accessTokens: [] }, testDb)).toBeNull();
    expect(await findAccessibleOrder({ orderNo: "ORD-x'; --", sessionCustomerId: owner.id, accessTokens: [] }, testDb)).toBeNull();
  });

  test("a token opens its own order only, while unexpired; malformed values are never looked up", async () => {
    const first = await checkoutOrder();
    const second = await checkoutOrder();
    const valid = await token(first.order.id);
    const expired = await token(first.order.id, new Date(Date.now() - 1000));
    const lookup = (orderNo: string, accessTokens: (string | null)[]) => findAccessibleOrder({ orderNo, sessionCustomerId: null, accessTokens }, testDb);

    expect(await lookup(first.order.orderNo, [null, valid])).toEqual({ orderId: first.order.id, via: "token" });
    expect(await lookup(second.order.orderNo, [valid])).toBeNull();
    expect(await lookup(first.order.orderNo, [expired])).toBeNull();
    expect(await lookup(first.order.orderNo, [generateOrderAccessToken(), "short", null])).toBeNull();
  });

  test("redeemOrderViewToken: the order's unexpired token is marked used and its expiry returned; anything else is null", async () => {
    const { order } = await checkoutOrder();
    const other = await checkoutOrder();
    const expiresAt = new Date(Date.now() + 5 * 86_400_000);
    const valid = await token(order.id, expiresAt);
    const expired = await token(order.id, new Date(Date.now() - 1000));

    expect(await redeemOrderViewToken(other.order.orderNo, valid, testDb)).toBeNull();
    expect(await redeemOrderViewToken(order.orderNo, expired, testDb)).toBeNull();
    expect(await redeemOrderViewToken(order.orderNo, "not-a-token", testDb)).toBeNull();
    expect(await redeemOrderViewToken("ORD-bad", valid, testDb)).toBeNull();

    const redeemed = await redeemOrderViewToken(order.orderNo, valid, testDb);
    expect(redeemed?.expiresAt.getTime()).toBe(expiresAt.getTime());
    const [row] = await testDb.select({ lastUsedAt: orderAccessTokens.lastUsedAt }).from(orderAccessTokens).where(eq(orderAccessTokens.tokenHash, hashOrderAccessToken(valid)));
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  test("the visibility condition is a plain WHERE clause usable on its own", async () => {
    const owner = await customer();
    const order = await marketplaceOrder(owner.id);
    const rows = await testDb.select({ id: orders.id }).from(orders).where(visibleToCustomerSql(owner.id));
    expect(rows.map((row) => row.id)).toEqual([order.id]);
  });
});

describe("Pesanan saya reads", () => {
  test("the list: newest first, paginated, totals for checkout orders only, never a cost", async () => {
    const owner = await customer();
    const older = await marketplaceOrder(owner.id, new Date(Date.now() - 3 * 86_400_000));
    const newer = await checkoutOrder({ customerId: owner.id, placedWithSession: true });
    const hidden = await checkoutOrder({ customerId: owner.id });

    const page = await listCustomerOrders(owner.id, 1, testDb);
    expect(page).toMatchObject({ page: 1, pageCount: 1 });
    expect(page.rows.map((row) => row.orderNo)).toEqual([newer.order.orderNo, older.orderNo]);
    expect(page.rows.map((row) => row.orderNo)).not.toContain(hidden.order.orderNo);
    expect(page.rows[0]).toMatchObject({ isCheckout: true, total: 334_000, status: { label: "Menunggu pembayaran" } });
    expect(page.rows[1]).toMatchObject({ isCheckout: false, total: null, status: { label: "Dikirim" }, items: [{ qty: 2 }] });
    expect(JSON.stringify(page)).not.toMatch(/7654321|unitCost|unit_cost/);

    // A page past the end is the last page.
    expect((await listCustomerOrders(owner.id, 99, testDb)).page).toBe(1);
  });

  test(`more than ${ORDERS_PAGE_SIZE} orders split into pages`, async () => {
    const owner = await customer();
    for (let index = 0; index < ORDERS_PAGE_SIZE + 1; index += 1) await marketplaceOrder(owner.id, new Date(Date.now() - index * 60_000));
    const first = await listCustomerOrders(owner.id, 1, testDb);
    const second = await listCustomerOrders(owner.id, 2, testDb);
    expect(first).toMatchObject({ page: 1, pageCount: 2 });
    expect(first.rows).toHaveLength(ORDERS_PAGE_SIZE);
    expect(second.rows).toHaveLength(1);
  });

  test("the detail: lines with totals, ongkir as paid, address, timeline, payment link while payable, no cost data", async () => {
    const { order } = await checkoutOrder();
    await testDb.insert(payments).values({ orderId: order.id, provider: "midtrans", providerOrderId: `${order.orderNo}-1`, attempt: 1, grossAmount: order.totalAmount, redirectUrl: "https://app.sandbox.example/pay/1" });
    const detail = await loadCustomerOrderDetail(order.id, testDb);
    expect(detail).toMatchObject({
      orderNo: order.orderNo,
      status: { label: "Menunggu pembayaran", payable: true },
      // The locked ongkir quote is the buyer's own checkout figure (shown since 2026-10-21).
      totals: { subtotal: 259_000, shipping: 75_000, shippingCost: 95_000, shippingSubsidy: 20_000, discount: 0, total: 334_000, courierLabel: "JNE Reguler" },
      lines: [{ qty: 1, lineTotal: 259_000 }],
      address: expect.stringContaining("Jl. Mawar 1"),
      shipment: { courier: null, trackingNumber: null },
      paymentUrl: "https://app.sandbox.example/pay/1",
    });
    expect(detail?.payBy).toMatch(/ WIB$/);
    expect(detail?.timeline.map((entry) => entry.label)).toEqual(["Dipesan"]);
    expect(JSON.stringify(detail)).not.toMatch(/7654321|unitCost|unitPrice/i);
  });

  test("a shipped marketplace order: courier and resi, no prices", async () => {
    const owner = await customer();
    const order = await marketplaceOrder(owner.id);
    const detail = await loadCustomerOrderDetail(order.id, testDb);
    expect(detail).toMatchObject({ totals: null, shipment: { courier: "J&T", trackingNumber: "JT123" }, lines: [{ qty: 2, lineTotal: null }], paymentUrl: null });
    expect(detail?.timeline.map((entry) => entry.label)).toEqual(["Dipesan", "Dikirim"]);
  });

  test("loadReorderLines: only cancelled, never-paid checkout orders", async () => {
    const cancelled = await checkoutOrder({ status: "cancelled", paymentStatus: "expired", cancelReason: "payment_expired", cancelledAt: new Date() });
    expect(await loadReorderLines(cancelled.order.id, testDb)).toEqual([{ sku: cancelled.item.variant.sku, name: cancelled.item.product.name, variant: `${cancelled.item.color.name} · M`, qty: 1 }]);

    const pending = await checkoutOrder();
    const paidAfterCancel = await checkoutOrder({ status: "cancelled", paymentStatus: "paid", paidAt: new Date(), cancelReason: "payment_expired", cancelledAt: new Date() });
    const owner = await customer();
    const manualCancelled = await insertOrder(testDb, { orderNo: uniqueOrderNo(), customerId: owner.id, status: "cancelled", cancelledAt: new Date() });
    created.orderIds.push(manualCancelled.id);
    for (const id of [pending.order.id, paidAfterCancel.order.id, manualCancelled.id]) expect(await loadReorderLines(id, testDb)).toBeNull();
  });
});
