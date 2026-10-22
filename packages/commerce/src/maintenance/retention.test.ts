import { randomBytes, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder, insertProductVariant } from "@ammari/db/test-fixtures";
import { cartItems, carts, claimRateLimits, customerLoginLinks, orderAccessTokens, paymentNotifications, shippingRateCache, shippingWebhookEvents } from "@ammari/db/schema";
import { runRetention } from "./retention";

// docs/plans/cart-checkout.md §11, session 12: each rule deletes exactly the rows past their
// retention and keeps the ones just inside it.

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function ids<T extends { id: string }>(rows: Promise<T[]>): Promise<string[]> {
  return (await rows).map((row) => row.id);
}

async function remaining(db: TestDatabase, table: typeof paymentNotifications | typeof claimRateLimits | typeof shippingRateCache | typeof carts | typeof orderAccessTokens | typeof customerLoginLinks | typeof shippingWebhookEvents, wanted: string[]) {
  return (await db.select({ id: table.id }).from(table).where(inArray(table.id, wanted))).map((row) => row.id).sort();
}

describe("runRetention", () => {
  test("deletes exactly what is past retention, keeps what is inside it", async () => {
    await withRollback(async (tx) => {
      const [oldNotification, newNotification] = await ids(
        tx
          .insert(paymentNotifications)
          .values([
            { providerOrderId: "OLD", signatureValid: true, payload: {}, receivedAt: ago(370 * DAY) },
            { providerOrderId: "NEW", signatureValid: false, payload: {}, receivedAt: ago(300 * DAY) },
          ])
          .returning({ id: paymentNotifications.id }),
      );

      // Per-IP rows, the 0.0.0.0 provider budgets and the per-cart quote rows all go after a day.
      const limitRows = await ids(
        tx
          .insert(claimRateLimits)
          .values([
            { ip: "203.0.113.7", action: "cart_write", createdAt: ago(DAY + 60_000) },
            { ip: "0.0.0.0", action: "shipping_rates", createdAt: ago(DAY + 60_000) },
            { ip: "0.0.0.0", action: `shipping_quote_cart:${randomUUID()}`, createdAt: ago(2 * DAY) },
            { ip: "0.0.0.0", action: "payment_notification_unverified", createdAt: ago(3 * DAY) },
            { ip: "203.0.113.7", action: "cart_write", createdAt: ago(DAY - 60_000) },
            { ip: "0.0.0.0", action: "shipping_maps", createdAt: ago(23 * 60 * 60 * 1000) },
          ])
          .returning({ id: claimRateLimits.id }),
      );

      const [oldRate, freshRate] = await ids(
        tx
          .insert(shippingRateCache)
          .values([
            { originId: "ORIGIN", destinationId: `D-${randomUUID()}`, weightGrams: 900, servicesKey: "k", result: [], fetchedAt: ago(8 * DAY) },
            { originId: "ORIGIN", destinationId: `D-${randomUUID()}`, weightGrams: 900, servicesKey: "k", result: [], fetchedAt: ago(6 * DAY) },
          ])
          .returning({ id: shippingRateCache.id }),
      );

      const { variant } = await insertProductVariant(tx);
      const token = () => randomBytes(32).toString("hex");
      const [oldCustomer, youngCustomer] = [await insertCustomer(tx), await insertCustomer(tx)];
      const cartRows = await ids(
        tx
          .insert(carts)
          .values([
            { tokenHash: token(), lastActivityAt: ago(31 * DAY) },
            { tokenHash: token(), lastActivityAt: ago(29 * DAY) },
            { customerId: oldCustomer.id, lastActivityAt: ago(181 * DAY) },
            { customerId: youngCustomer.id, lastActivityAt: ago(100 * DAY) },
          ])
          .returning({ id: carts.id }),
      );
      await tx.insert(cartItems).values(cartRows.map((cartId) => ({ cartId, sku: variant.sku, qty: 1 })));

      const order = await insertOrder(tx);
      const [oldToken, youngToken] = await ids(
        tx
          .insert(orderAccessTokens)
          .values([
            { orderId: order.id, tokenHash: token(), createdAt: ago(151 * DAY), expiresAt: ago(31 * DAY) },
            { orderId: order.id, tokenHash: token(), createdAt: ago(149 * DAY), expiresAt: ago(29 * DAY) },
          ])
          .returning({ id: orderAccessTokens.id }),
      );

      // Login links: 30 days after expiry (a used one too); the young one stays.
      const [oldLink, oldUsedLink, youngLink] = await ids(
        tx
          .insert(customerLoginLinks)
          .values([
            { customerId: oldCustomer.id, email: oldCustomer.email!, tokenHash: token(), createdAt: ago(32 * DAY), expiresAt: ago(31 * DAY), supersededAt: ago(31 * DAY) },
            { customerId: oldCustomer.id, email: oldCustomer.email!, tokenHash: token(), createdAt: ago(32 * DAY), expiresAt: ago(31 * DAY), consumedAt: ago(32 * DAY) },
            { customerId: youngCustomer.id, email: youngCustomer.email!, tokenHash: token(), createdAt: ago(30 * DAY), expiresAt: ago(29 * DAY) },
          ])
          .returning({ id: customerLoginLinks.id }),
      );

      // Courier webhook log (K3): 12 months.
      const [oldWebhook, newWebhook] = await ids(
        tx
          .insert(shippingWebhookEvents)
          .values([
            { event: "order.status", providerOrderId: "OLDWEBHOOK", payload: { order_id: "OLDWEBHOOK" }, bodyBytes: 26, receivedAt: ago(370 * DAY) },
            { event: "order.status", providerOrderId: "NEWWEBHOOK", rawText: "odd", bodyBytes: 3, receivedAt: ago(300 * DAY) },
          ])
          .returning({ id: shippingWebhookEvents.id }),
      );

      const summary = await runRetention(tx);
      expect(summary.failed).toEqual([]);
      expect(summary.truncated).toEqual([]);
      expect(summary.deleted).toMatchObject({
        payment_notifications: expect.any(Number),
        claim_rate_limits: expect.any(Number),
        guest_carts: expect.any(Number),
      });

      expect(await remaining(tx, paymentNotifications, [oldNotification!, newNotification!])).toEqual([newNotification]);
      expect(await remaining(tx, claimRateLimits, limitRows)).toEqual(limitRows.slice(4).sort());
      expect(await remaining(tx, shippingRateCache, [oldRate!, freshRate!])).toEqual([freshRate]);
      expect(await remaining(tx, carts, cartRows)).toEqual([cartRows[1]!, cartRows[3]!].sort());
      // Lines go with their cart.
      expect((await tx.select({ cartId: cartItems.cartId }).from(cartItems).where(inArray(cartItems.cartId, cartRows))).map((row) => row.cartId).sort()).toEqual(
        [cartRows[1]!, cartRows[3]!].sort(),
      );
      expect(await remaining(tx, orderAccessTokens, [oldToken!, youngToken!])).toEqual([youngToken]);
      expect(await remaining(tx, customerLoginLinks, [oldLink!, oldUsedLink!, youngLink!])).toEqual([youngLink]);
      expect(await remaining(tx, shippingWebhookEvents, [oldWebhook!, newWebhook!])).toEqual([newWebhook]);

      // A second run has nothing of these left to delete.
      await runRetention(tx);
      expect(await remaining(tx, carts, cartRows)).toHaveLength(2);
    });
  });

  test("batches: deletes everything over several statements, and says when it stopped early", async () => {
    await withRollback(async (tx) => {
      const rows = await ids(
        tx
          .insert(claimRateLimits)
          .values(Array.from({ length: 7 }, () => ({ ip: "198.51.100.9", action: "area_search", createdAt: ago(2 * DAY) })))
          .returning({ id: claimRateLimits.id }),
      );
      const stopped = await runRetention(tx, { batchSize: 2, maxBatches: 2 });
      expect(stopped.truncated).toContain("claim_rate_limits");
      expect(await remaining(tx, claimRateLimits, rows)).toHaveLength(3);
      await runRetention(tx, { batchSize: 2 });
      expect(await remaining(tx, claimRateLimits, rows)).toHaveLength(0);
    });
  });

  test("one table failing is logged by name and code; the others still run", async () => {
    await withRollback(async (tx) => {
      const [old] = await ids(
        tx.insert(shippingRateCache).values({ originId: "ORIGIN", destinationId: `D-${randomUUID()}`, weightGrams: 900, servicesKey: "k", result: [], fetchedAt: ago(8 * DAY) }).returning({ id: shippingRateCache.id }),
      );
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const original = tx.execute.bind(tx);
      let calls = 0;
      // The first statement (payment_notifications) fails; inside a transaction a failure aborts
      // it, so the failure is simulated before reaching the database.
      const failing = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "execute") {
            return (...args: Parameters<typeof original>) => {
              calls += 1;
              if (calls === 1) return Promise.reject(Object.assign(new Error("boom with a parameter value"), { code: "57014" }));
              return original(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const summary = await runRetention(failing);
      expect(summary.failed).toEqual(["payment_notifications"]);
      expect(await remaining(tx, shippingRateCache, [old!])).toEqual([]);
      expect(errors).toHaveBeenCalledWith("[retention] delete failed; other tables still run", { rule: "payment_notifications", error: "Error", code: "57014" });
      expect(JSON.stringify(errors.mock.calls)).not.toContain("parameter value");
    });
  });
});
