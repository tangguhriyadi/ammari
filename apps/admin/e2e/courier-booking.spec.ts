import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_CHECKOUT_LAYOUTS, E2E_CHECKOUT_ORDERS_EMAIL, e2eCheckoutOrderNo } from "./global-setup";

// docs/plans/cart-checkout.md §15 Phase K, K2: "Pesan kurir", "Cetak label", "Batalkan pengiriman",
// "Cek ulang pemesanan" and the resi check; K4: the Biteship order id, the courier history, the
// shipping flags in context, "Pakai resi pesanan kurir" and "Tandai selesai", with the in-memory courier provider
// (SHIPPING_ORDER_PROVIDER=fake in playwright.config.ts; nothing reaches Biteship). global-setup.ts
// seeds, per viewport, a paid web order at a normal fake area (`book`) and one whose booking answer
// is lost once (`lost`). /packing renders two layouts (CardList for phones, TableContainer for
// desktop), so everything is asserted at 390px AND 1280px (CLAUDE.md).

const VIEWPORTS = {
  "390": { width: 390, height: 844, rowTag: "li" },
  "1280": { width: 1280, height: 800, rowTag: "tr" },
} as const;

async function openOrder(page: Page, orderNo: string): Promise<void> {
  await page.goto(`/orders?q=${encodeURIComponent(orderNo)}`);
  await page.getByRole("link", { name: orderNo }).filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: orderNo })).toBeVisible();
}

function shipping(page: Page) {
  return page.getByRole("region", { name: "Pengiriman" });
}

for (const layout of E2E_CHECKOUT_LAYOUTS) {
  const viewport = VIEWPORTS[layout];
  const orderNo = (kind: Parameters<typeof e2eCheckoutOrderNo>[0]) => e2eCheckoutOrderNo(kind, layout);

  test.describe(`courier booking at ${layout}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await loginAs(page, E2E_CHECKOUT_ORDERS_EMAIL);
    });

    test("Pesan kurir on /packing books, shows the waybill and prints our label; the order page cancels, rebooks and checks the resi", async ({ page }) => {
      await page.goto("/packing");
      const row = page.locator(viewport.rowTag).filter({ hasText: orderNo("book") });
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Pesan kurir" }).click();
      await expect(page.getByText(/^Kurir dipesan\. Resi E2E[0-9]{13}\.$/)).toBeVisible();
      await expect(row.getByText("Kurir dipesan", { exact: true })).toBeVisible();
      const waybillText = await row.getByText(/^Resi E2E[0-9]{13}$/).textContent();
      const waybill = waybillText!.replace("Resi ", "");
      await expect(row.getByRole("button", { name: "Pesan kurir" })).toHaveCount(0);

      // Our own 120 x 100 mm label, as a real PDF download.
      const [download] = await Promise.all([page.waitForEvent("download"), row.getByRole("button", { name: "Cetak label" }).click()]);
      expect(download.suggestedFilename()).toMatch(/^ammari-label-\d{4}-\d{2}-\d{2}-\d{4}\.pdf$/);

      // The order page's "Pengiriman": booking, pickup state, cut-off hint, actual cost next to the quote.
      await openOrder(page, orderNo("book"));
      const section = shipping(page);
      // The status badge (the courier history below repeats the words).
      await expect(section.getByText("Kurir dipesan", { exact: true }).first()).toBeVisible();
      await expect(section.getByText(waybill, { exact: true })).toBeVisible();
      await expect(section.getByText("Menunggu kurir", { exact: true })).toBeVisible();
      await expect(section.getByText(/^Pesan sebelum 14\.00 WIB/)).toBeVisible();
      await expect(section.getByText(/^Rp\s?12\.000 \(checkout Rp\s?35\.000\)$/)).toBeVisible();

      // Cancel before pickup: the attempt ends and the order can be booked again.
      await section.getByRole("button", { name: "Batalkan pengiriman" }).click();
      const confirm = page.getByRole("dialog", { name: `Batalkan pengiriman ${orderNo("book")}?` });
      await confirm.getByLabel("Alasan").selectOption("change_courier");
      await confirm.getByRole("button", { name: "Batalkan pengiriman" }).click();
      await expect(page.getByText("Pengiriman dibatalkan. Kurir bisa dipesan lagi.")).toBeVisible();
      await expect(section.getByText("Kurir belum dipesan.")).toBeVisible();
      await expect(section.getByText(/^Percobaan 1: Dibatalkan · resi /)).toBeVisible();

      await section.getByRole("button", { name: "Pesan kurir" }).click();
      await expect(page.getByText(/^Kurir dipesan\. Resi E2E[0-9]{13}\.$/)).toBeVisible();
      const newWaybill = (await section.getByText(/^E2E[0-9]{13}$/).textContent())!;
      expect(newWaybill).not.toBe(waybill);

      // "Dikirim" prefills the booked waybill; a different resi is warned about and flagged.
      await page.getByRole("button", { name: "Dikirim", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Tandai dikirim: ${orderNo("book")}` });
      await expect(dialog.getByLabel("No. resi")).toHaveValue(newWaybill);
      await dialog.getByLabel("No. resi").fill("JNE1234567");
      await expect(dialog.getByText("Nomor resi ini berbeda dengan resi dari pemesanan kurir. Pesanan akan ditandai Perlu dicek.")).toBeVisible();
      await dialog.getByRole("button", { name: "Tandai dikirim" }).click();
      const panel = page.getByRole("region", { name: "Perlu dicek" });
      await expect(panel.getByText("Resi beda dengan pesanan kurir", { exact: true })).toBeVisible();

      // K4: the flag in context (both resis), the Biteship order id to copy, the courier history.
      await expect(section.getByTestId("shipping-flag-tracking_number_mismatch")).toContainText(`Resi di pesanan: JNE1234567. Resi dari pesanan kurir: ${newWaybill}.`);
      await expect(section.getByTestId("buyer-timeline-hidden")).toBeVisible();
      const providerOrderId = section.getByTestId("provider-order-id-2");
      await expect(providerOrderId).toHaveText(/^[0-9a-f]{24}$/);
      await expect(section.getByTestId("provider-order-id-1")).toHaveText(/^[0-9a-f]{24}$/);
      await expect(section.getByRole("button", { name: "Salin ID pesanan Biteship percobaan 2" })).toBeVisible();
      const history = section.getByTestId("admin-tracking-history");
      await expect(history.getByText("Kurir dipesan", { exact: true }).first()).toBeVisible();
      await expect(history.getByText("Staf (pesan kurir, cek ulang)").first()).toBeVisible();
      await expect(history.getByText(/· percobaan 1$/).first()).toBeVisible();

      // "Pakai resi pesanan kurir": the order's resi becomes the booked waybill and the flag ends.
      await panel.getByRole("button", { name: `Pakai resi pesanan kurir (${newWaybill})` }).click();
      await expect(page.getByText(`Resi pesanan diganti ke ${newWaybill}.`, { exact: false })).toBeVisible();
      await expect(page.getByRole("region", { name: "Perlu dicek" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Resi" }).getByText(newWaybill, { exact: true })).toBeVisible();

      // "Tandai selesai" while the courier has not reported the delivery asks first.
      await page.getByRole("button", { name: "Tandai selesai" }).click();
      const complete = page.getByRole("dialog", { name: `Tandai selesai: ${orderNo("book")}?` });
      await expect(complete).toContainText("Kurir belum melaporkan paket sampai.");
      await expect(complete).toContainText('Pembeli tidak mendapat email "sudah sampai"');
      await complete.getByRole("button", { name: "Tandai selesai" }).click();
      await expect(page.getByText("Selesai", { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Tandai selesai" })).toHaveCount(0);
      await expect(section.getByTestId("poll-stopped")).toBeVisible();
      const email = page.getByRole("region", { name: "Voucher dan email" });
      await expect(email.getByText("Email: Pesanan sampai")).toBeVisible();
      await expect(email.getByText("Tidak dikirim (sudah tidak perlu)")).toBeVisible();

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });

    test("a lost booking answer stays belum pasti until Cek ulang pemesanan settles it", async ({ page }) => {
      await openOrder(page, orderNo("lost"));
      const section = shipping(page);
      await section.getByRole("button", { name: "Pesan kurir" }).click();
      await expect(section.getByRole("alert")).toHaveText(/Jawaban Biteship belum diterima, kurir mungkin sudah dipesan\./);
      await expect(section.getByText("Pemesanan belum pasti", { exact: true })).toBeVisible();
      await expect(section.getByRole("button", { name: "Batalkan pengiriman" })).toHaveCount(0);
      await expect(section.getByRole("button", { name: "Pesan kurir" })).toHaveCount(0);

      // /packing offers the check too, never a second booking.
      await page.goto("/packing");
      const row = page.locator(viewport.rowTag).filter({ hasText: orderNo("lost") });
      await expect(row.getByText("Pemesanan belum pasti", { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Pesan kurir" })).toHaveCount(0);
      await row.getByRole("button", { name: "Cek ulang pemesanan" }).click();
      await expect(page.getByText(/^Kurir dipesan\. Resi E2E[0-9]{13}\.$/)).toBeVisible();
      await expect(row.getByText("Kurir dipesan", { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Cetak label" })).toBeVisible();
    });
  });
}
