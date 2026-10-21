import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant } from "@ammari/db/test-fixtures";
import { orderAccessTokens, orderItems, payments } from "@ammari/db/schema";
import { generateOrderAccessToken, hashOrderAccessToken } from "@ammari/commerce/checkout";

// The "menunggu pembayaran" reminder (2026-10-21 sandbox run): only the visitor's own payable order.

vi.mock("@/lib/auth/customer-session", () => ({ getCustomerSession: async () => null }));
vi.mock("@/lib/checkout/order-access-cookie", () => ({ readOrderAccessCookie: async () => null }));

const { findPendingCheckoutOrder } = await import("./pending-order");

let sequence = 0;
function orderNo(): string {
  sequence += 1;
  return `ORD-209911-${Math.floor(Math.random() * 90_000_000 + 10_000_000)}${sequence}`;
}

/** A payable checkout order with one line and a stored payment page; `token` gives the checkout
 * cookie's access to it. */
async function pendingOrder(tx: TestTx, values: Parameters<typeof insertOrder>[1] = {}) {
  const { product, variant } = await insertProductVariant(tx);
  const order = await insertOrder(tx, { ...checkoutOrderValues(), orderNo: orderNo(), ...values });
  await tx.insert(orderItems).values({ orderId: order.id, sku: variant.sku, qty: 1, unitPrice: 259_000, unitCost: 0 });
  await tx.insert(payments).values({
    orderId: order.id,
    provider: "midtrans",
    providerOrderId: `TEST-${order.orderNo}-1`,
    attempt: 1,
    grossAmount: order.totalAmount,
    status: "pending",
    redirectUrl: "https://pay.example/snap/v4/redirection/abc",
  });
  const token = generateOrderAccessToken();
  await tx.insert(orderAccessTokens).values({ orderId: order.id, tokenHash: hashOrderAccessToken(token), expiresAt: new Date(Date.now() + 86_400_000) });
  return { order, token, productId: product.id };
}

describe("findPendingCheckoutOrder", () => {
  test("the checkout cookie's order while payable: number, deadline, payment page, its products", async () => {
    await withRollback(async (tx) => {
      const { order, token, productId } = await pendingOrder(tx);
      const found = await findPendingCheckoutOrder({ sessionCustomerId: null, accessToken: token }, tx);
      expect(found).toMatchObject({ orderNo: order.orderNo, paymentUrl: "https://pay.example/snap/v4/redirection/abc", productIds: [productId] });
      expect(found?.payBy).toMatch(/WIB$/);
    });
  });

  test("a session's own order (placed logged in); never another customer's", async () => {
    await withRollback(async (tx) => {
      const buyer = await insertCustomer(tx, { emailVerifiedAt: new Date() });
      const stranger = await insertCustomer(tx, { emailVerifiedAt: new Date() });
      const { order } = await pendingOrder(tx, { customerId: buyer.id, placedWithSession: true });
      expect((await findPendingCheckoutOrder({ sessionCustomerId: buyer.id, accessToken: null }, tx))?.orderNo).toBe(order.orderNo);
      expect(await findPendingCheckoutOrder({ sessionCustomerId: stranger.id, accessToken: null }, tx)).toBeNull();
    });
  });

  test("nothing without proof, with a wrong or expired token, or once the order is no longer payable", async () => {
    await withRollback(async (tx) => {
      const { token } = await pendingOrder(tx);
      expect(await findPendingCheckoutOrder({ sessionCustomerId: null, accessToken: null }, tx)).toBeNull();
      expect(await findPendingCheckoutOrder({ sessionCustomerId: null, accessToken: generateOrderAccessToken() }, tx)).toBeNull();
      expect(await findPendingCheckoutOrder({ sessionCustomerId: null, accessToken: "not-a-token" }, tx)).toBeNull();

      const expired = await pendingOrder(tx, { paymentExpiresAt: new Date(Date.now() - 60_000) });
      expect(await findPendingCheckoutOrder({ sessionCustomerId: null, accessToken: expired.token }, tx)).toBeNull();
      const paid = await pendingOrder(tx, { status: "to_ship", paymentStatus: "paid", paidAt: new Date() });
      expect(await findPendingCheckoutOrder({ sessionCustomerId: null, accessToken: paid.token }, tx)).toBeNull();

      const old = await pendingOrder(tx);
      await tx
        .update(orderAccessTokens)
        .set({ createdAt: new Date(Date.now() - 2 * 86_400_000), expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(orderAccessTokens.orderId, old.order.id));
      expect(await findPendingCheckoutOrder({ sessionCustomerId: null, accessToken: old.token }, tx)).toBeNull();
      // The first order's own token still works (the check above was per token).
      expect(await findPendingCheckoutOrder({ sessionCustomerId: null, accessToken: token }, tx)).not.toBeNull();
    });
  });
});
