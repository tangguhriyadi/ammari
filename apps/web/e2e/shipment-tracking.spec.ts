import { randomInt } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { seedCheckoutProduct } from "./helpers/checkout-db";
import { issueLoginLink, seedLinkCustomer } from "./helpers/login-link-db";
import { orderState, seedBookedShipment, seedCheckoutOrder, setOrderTrackingNumber, setShipmentReadError } from "./helpers/orders-db";

// Courier tracking (docs/plans/cart-checkout.md §15 Phase K, K3): a web order booked from admin
// moves to "Dikirim" when the courier picks it up and to "Selesai" when it is delivered, driven by
// the courier's webhook. The gated /api/test/shipments/advance moves the fake courier along and posts
// through the real webhook route, which re-fetches from the fake and applies only that answer. A
// forged webhook changes nothing. Works with the cart flag off and on (orders already placed keep
// being tracked). K4: the courier timeline in "Lacak pengiriman" (latest on top, our words, WIB), the
// resi copy button, the gentle delay note, and no timeline for a resi that is not the booking's. At
// 390 px and 1280 px.

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
      // A clipboard both browsers accept without a permission prompt; it records what was copied.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text: string) => void ((window as unknown as { __copied?: string }).__copied = text) },
        });
      });
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

      // K4: the courier timeline, latest on top, in our words and WIB.
      const timeline = page.getByTestId("tracking-timeline");
      const entries = timeline.getByRole("listitem");
      await expect(entries.first()).toContainText("Paket dijemput kurir");
      await expect(entries.first()).toContainText(/\d{1,2} \w+ 20\d{2}, \d{2}\.\d{2} WIB/);
      await expect(entries.first()).toContainText("E2E: Paket sudah dijemput kurir.");
      await expect(timeline).not.toContainText("picked");
      // The resi copies with one tap.
      await page.getByRole("button", { name: "Salin nomor resi" }).click();
      await expect(page.getByTestId("copy-tracking-number")).toHaveText("Tersalin nomor resi");
      expect(await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)).toBe(shipment.awb);

      // A failed automatic read: a gentle note, no technical words.
      await setShipmentReadError(order.id, "read:unavailable");
      await page.reload();
      await expect(page.getByTestId("tracking-delay")).toHaveText("Kabar pengiriman terbaru belum bisa kami tampilkan. Kami cek lagi otomatis, coba lihat lagi nanti.");
      await setShipmentReadError(order.id, null);

      await advance(page, order.orderNo, "delivered");
      await expectStatus(page, order.orderNo, "Selesai");
      expect(await orderState(order.id)).toMatchObject({ status: "completed", needsAttention: [], trackingNumber: shipment.awb });
      await expect(page.getByTestId("tracking-timeline").getByRole("listitem").first()).toContainText("Paket sudah sampai");
      await expect(page.getByTestId("tracking-delay")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(/biteship/i);

      // No horizontal overflow on the phone width.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      // A resi on the order that is not the booking's waybill: the timeline would be another parcel's.
      await setOrderTrackingNumber(order.id, "JNE0001234567");
      await page.reload();
      await expect(page.getByTestId("order-tracking-number")).toHaveText("JNE0001234567");
      await expect(page.getByTestId("tracking-timeline")).toHaveCount(0);
    });
  });
}
