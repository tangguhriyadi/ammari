import { randomInt } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { seedCheckoutProduct } from "./helpers/checkout-db";
import { issueLoginLink, seedLinkCustomer } from "./helpers/login-link-db";
import { orderState, seedBookedShipment, seedCheckoutOrder } from "./helpers/orders-db";

// Courier tracking (docs/plans/cart-checkout.md §15 Phase K, K3): a web order booked from admin
// moves to "Dikirim" when the courier picks it up and to "Selesai" when it is delivered, driven by
// the courier's webhook. The gated /api/test/shipments/advance moves the fake courier along and posts
// through the real webhook route, which re-fetches from the fake and applies only that answer. A
// forged webhook changes nothing. Works with the cart flag off and on (orders already placed keep
// being tracked). At 390 px and 1280 px.

function randomIp(): string {
  return `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`;
}

async function advance(page: Page, orderNo: string, status: string): Promise<void> {
  const response = await page.request.post("/api/test/shipments/advance", { data: { orderNo, status } });
  expect(response.status(), await response.text()).toBe(202);
}

/** The order page shows `label` once the webhook's work (after its answer) has landed. */
async function expectStatus(page: Page, orderNo: string, label: string): Promise<void> {
  await expect(async () => {
    await page.goto(`/orders/${orderNo}`);
    await expect(page.getByTestId("order-status")).toHaveText(label, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

for (const viewport of [
  { name: "390", size: { width: 390, height: 844 } },
  { name: "1280", size: { width: 1280, height: 800 } },
]) {
  test.describe(`at ${viewport.name}px`, () => {
    test.use({ viewport: viewport.size });

    test("picked up shows Dikirim with the courier's waybill; delivered shows Selesai; a forged webhook changes nothing", async ({ page, context }) => {
      await context.setExtraHTTPHeaders({ "cf-connecting-ip": randomIp() });
      const customer = await seedLinkCustomer(`tracking-${viewport.name}`);
      const product = await seedCheckoutProduct({ label: `Lacak ${viewport.name}`, price: 250_000 });
      const order = await seedCheckoutOrder({ customerId: customer.id, email: customer.email, placedWithSession: true, lines: [{ sku: product.sku, qty: 1, unitPrice: 250_000 }], state: "paid" });
      const shipment = await seedBookedShipment(order);

      const token = await issueLoginLink(customer);
      await page.goto(`/login/link?token=${token}`);
      await page.getByRole("button", { name: "Masuk" }).click();
      await expect(page).toHaveURL(/\/orders$/);
      await page.goto(`/orders/${order.orderNo}`);
      await expect(page.getByTestId("order-status")).toHaveText("Diproses");
      await expect(page.getByText("Nomor resi dikirim lewat email setelah pesanan dikirim.")).toBeVisible();

      // A forged webhook (no path token, no header) is answered like any other and changes nothing,
      // even when it claims the parcel was delivered.
      const forged = await page.request.post("/api/shipping/biteship/webhook/not-the-token", {
        data: { event: "order.status", order_id: shipment.providerOrderId, status: "delivered" },
      });
      expect(forged.status()).toBe(200);
      expect(await forged.text()).toBe("ok");
      expect((await orderState(order.id)).status).toBe("to_ship");

      await advance(page, order.orderNo, "picked");
      await expectStatus(page, order.orderNo, "Dikirim");
      const tracking = page.getByTestId("order-tracking");
      await expect(tracking).toContainText("JNE Reguler");
      await expect(tracking).toContainText(shipment.awb);
      // The courier provider's name never reaches the storefront.
      await expect(page.locator("body")).not.toContainText(/biteship/i);

      await advance(page, order.orderNo, "delivered");
      await expectStatus(page, order.orderNo, "Selesai");
      expect(await orderState(order.id)).toMatchObject({ status: "completed", needsAttention: [], trackingNumber: shipment.awb });

      // No horizontal overflow on the phone width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
}
