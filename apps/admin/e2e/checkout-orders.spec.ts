import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_CHECKOUT_LAYOUTS, E2E_CHECKOUT_ORDERS_EMAIL, e2eCheckoutOrderNo } from "./global-setup";

// docs/plans/cart-checkout.md session 16: staff work on web checkout orders. global-setup.ts seeds,
// per viewport, an unpaid order, a paid one (Siap Kirim), one paid while stock was short and a paid
// one flagged as a payment anomaly. List pages render two layouts (CardList for phones,
// TableContainer for desktop), so everything is asserted at 390px AND 1280px (CLAUDE.md). The admin
// runs with the fake payment gateway (playwright.config.ts), which knows no transaction for the
// seeded unpaid order, so its cancel closes nothing at a gateway and nothing reaches Midtrans.

const VIEWPORTS = {
  "390": { width: 390, height: 844, rowTag: "li", hiddenRowTag: "tr" },
  "1280": { width: 1280, height: 800, rowTag: "tr", hiddenRowTag: "li" },
} as const;

async function openOrder(page: Page, orderNo: string): Promise<void> {
  await page.goto(`/orders?q=${encodeURIComponent(orderNo)}`);
  await page.getByRole("link", { name: orderNo }).filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: orderNo })).toBeVisible();
}

function attention(page: Page) {
  return page.getByRole("region", { name: "Perlu dicek" });
}

for (const layout of E2E_CHECKOUT_LAYOUTS) {
  const viewport = VIEWPORTS[layout];
  const orderNo = (kind: Parameters<typeof e2eCheckoutOrderNo>[0]) => e2eCheckoutOrderNo(kind, layout);

  test.describe(`web checkout orders at ${layout}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await loginAs(page, E2E_CHECKOUT_ORDERS_EMAIL);
    });

    test('the list shows payment badges and a "Perlu dicek" filter of flagged orders', async ({ page }) => {
      await page.goto("/orders");
      const tab = page.getByRole("link", { name: /^Perlu dicek \(\d+\)$/ });
      await expect(tab).toBeVisible();
      await tab.click();
      await expect(page).toHaveURL(/status=perlu-dicek/);

      const shortRow = page.locator(viewport.rowTag).filter({ hasText: orderNo("short") });
      await expect(shortRow).toBeVisible();
      await expect(shortRow.getByText("Dibayar", { exact: true })).toBeVisible();
      await expect(shortRow.getByText("Perlu dicek", { exact: true })).toBeVisible();
      await expect(page.locator(viewport.rowTag).filter({ hasText: orderNo("flagged") })).toBeVisible();
      // Unflagged orders are not in the filter.
      await expect(page.locator(viewport.rowTag).filter({ hasText: orderNo("pending") })).toHaveCount(0);
      await expect(page.locator(viewport.hiddenRowTag).filter({ hasText: orderNo("short") }).first()).toBeHidden();

      // The unpaid order in the full list: its payment badge, no flag.
      await page.goto(`/orders?q=${encodeURIComponent(orderNo("pending"))}`);
      const pendingRow = page.locator(viewport.rowTag).filter({ hasText: orderNo("pending") });
      await expect(pendingRow.getByText("Belum dibayar", { exact: true })).toBeVisible();
      await expect(pendingRow.getByText("Perlu dicek", { exact: true })).toHaveCount(0);
    });

    test("packing shows the quoted service, no card for web orders, and prefills the courier", async ({ page }) => {
      await page.goto("/packing?channel=web&perPage=100");
      const row = page.locator(viewport.rowTag).filter({ hasText: orderNo("paid") });
      await expect(row).toBeVisible();
      await expect(row.getByText("Kirim: JNE Reguler")).toBeVisible();
      await expect(row.getByText("Tanpa kartu", { exact: true })).toBeVisible();

      // Selecting only web orders leaves nothing to print (they never get a card).
      await row.getByRole("checkbox").check();
      await expect(page.getByRole("button", { name: /^Cetak kartu/ })).toBeDisabled();
      await expect(page.getByRole("button", { name: /^Cetak stiker/ })).toBeDisabled();
      await row.getByRole("checkbox").uncheck();

      await row.getByRole("button", { name: "Tandai dikirim" }).click();
      const dialog = page.getByRole("dialog", { name: `Tandai dikirim: ${orderNo("paid")}` });
      await expect(dialog.getByLabel("Kurir")).toHaveValue("JNE Reguler");
      await expect(dialog.getByText("belum punya kartu terima kasih")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Batal" }).click();
      await expect(dialog).toBeHidden();
    });

    test("a web order needs courier and resi to ship: bulk skips it, the dialog requires both, the order page shows them", async ({ page }) => {
      await page.goto("/packing?channel=web&perPage=100");
      const row = page.locator(viewport.rowTag).filter({ hasText: orderNo("ship") });
      await expect(row).toBeVisible();
      // Selected alone, bulk "Tandai dikirim" has nothing it may ship (it has no resi field).
      await row.getByRole("checkbox").check();
      await expect(page.getByRole("button", { name: /^Tandai dikirim/ }).first()).toBeDisabled();
      await expect(page.getByText("Pesanan website juga perlu nomor resi")).toBeVisible();
      await row.getByRole("checkbox").uncheck();

      await row.getByRole("button", { name: "Tandai dikirim" }).click();
      const dialog = page.getByRole("dialog", { name: `Tandai dikirim: ${orderNo("ship")}` });
      await expect(dialog.getByLabel("Kurir")).toHaveValue("JNE Reguler");
      await dialog.getByRole("button", { name: "Tandai dikirim" }).click();
      await expect(dialog.getByText("Isi nomor resi.")).toBeVisible();
      await dialog.getByLabel("No. resi").fill("cgk 0123 4567 89");
      await dialog.getByRole("button", { name: "Tandai dikirim" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator(viewport.rowTag).filter({ hasText: orderNo("ship") })).toHaveCount(0);

      await openOrder(page, orderNo("ship"));
      const resi = page.getByRole("region", { name: "Resi" });
      await expect(resi.getByText("JNE Reguler")).toBeVisible();
      await expect(resi.getByText("CGK0123456789")).toBeVisible();
      await expect(resi.getByRole("button", { name: "Ubah resi" })).toBeVisible();
    });

    test("an order shipped without a resi says so, and staff can add it (the audit row is covered by lifecycle.test.ts)", async ({ page }) => {
      await openOrder(page, orderNo("noresi"));
      const resi = page.getByRole("region", { name: "Resi" });
      await expect(resi.getByText("Belum ada nomor resi.", { exact: false })).toBeVisible();
      await resi.getByRole("button", { name: "Tambah resi" }).click();
      const dialog = page.getByRole("dialog", { name: `Tambah resi: ${orderNo("noresi")}` });
      await expect(dialog.getByLabel("Kurir")).toHaveValue("J&T Reguler");
      await dialog.getByLabel("No. resi").fill("JP1234567890");
      await dialog.getByRole("button", { name: "Simpan" }).click();
      await expect(dialog).toBeHidden();
      await expect(resi.getByText("JP1234567890")).toBeVisible();
      await expect(resi.getByText("Belum ada nomor resi.", { exact: false })).toHaveCount(0);
      await expect(resi.getByRole("button", { name: "Ubah resi" })).toBeVisible();
    });

    test("a paid order: payment, locked quote and contact sections; cancel flags the refund, then the refund is recorded", async ({ page }) => {
      await openOrder(page, orderNo("paid"));
      const payment = page.getByRole("region", { name: "Pembayaran" });
      await expect(payment.getByText("Dibayar", { exact: true }).first()).toBeVisible();
      await expect(payment.getByText("QRIS").first()).toBeVisible();
      await expect(payment.getByText("Percobaan 1")).toBeVisible();
      const shipping = page.getByRole("region", { name: "Pengiriman" });
      await expect(shipping.getByText("JNE Reguler")).toBeVisible();
      await expect(shipping.getByText("900 g")).toBeVisible();
      await expect(shipping.getByText("Rp 35.000")).toBeVisible();
      await expect(shipping.getByText("Rp 20.000")).toBeVisible();
      await expect(shipping.getByText("Rp 15.000")).toBeVisible();
      const contact = page.getByRole("region", { name: "Kontak dan alamat" });
      await expect(contact.getByText("pembeli-web@e2e.ammari.test")).toBeVisible();
      await expect(contact.getByText("Coblong")).toBeVisible();
      await expect(page.getByText("item dan ongkir tidak bisa diubah")).toBeVisible();

      // No generic "Dibatalkan" button; the web cancel asks first.
      await expect(page.getByRole("button", { name: "Dibatalkan", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Batalkan dan kembalikan dana" }).click();
      const confirm = page.getByRole("dialog", { name: `Batalkan ${orderNo("paid")}?` });
      await expect(confirm).toContainText("Rp 274.000");
      await confirm.getByRole("button", { name: "Batalkan pesanan" }).click();
      await expect(confirm).toBeHidden();

      const panel = attention(page);
      await expect(panel.getByText("Dana perlu dikembalikan")).toBeVisible();
      await expect(page.getByText("Dibatalkan staf")).toBeVisible();
      await panel.getByRole("button", { name: "Catat dana dikembalikan" }).click();
      const refund = page.getByRole("dialog", { name: "Catat dana dikembalikan" });
      await expect(refund).toContainText("Rp 274.000");
      await refund.getByRole("button", { name: "Simpan" }).click();
      await expect(refund.getByText("Tulis catatan pengembalian dana")).toBeVisible();
      await refund.getByLabel("Catatan").fill("Transfer BCA ke rekening pembeli");
      await refund.getByRole("button", { name: "Simpan" }).click();
      await expect(refund).toBeHidden();
      await expect(attention(page)).toHaveCount(0);
      await expect(payment.getByText("Dana dikembalikan", { exact: true }).first()).toBeVisible();
    });

    test("an unpaid order offers only the web cancel, which ends it as a staff cancel", async ({ page }) => {
      await openOrder(page, orderNo("pending"));
      await expect(page.getByRole("button", { name: "Siap Kirim" })).toHaveCount(0);
      await page.getByRole("button", { name: "Batalkan pesanan" }).click();
      const confirm = page.getByRole("dialog", { name: `Batalkan ${orderNo("pending")}?` });
      await expect(confirm).toContainText("Midtrans");
      await confirm.getByRole("button", { name: "Batalkan pesanan" }).click();
      await expect(confirm).toBeHidden();
      await expect(page.getByText("Dibatalkan", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Dibatalkan staf")).toBeVisible();
      await expect(page.getByText("Pembayaran dibatalkan", { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Batalkan pesanan" })).toHaveCount(0);
    });

    test('paid while stock was short: the flag cannot be dismissed, "Proses" sells it and clears it', async ({ page }) => {
      await openOrder(page, orderNo("short"));
      const panel = attention(page);
      await expect(panel.getByText("Dibayar, stok kurang")).toBeVisible();
      await expect(panel.getByRole("button", { name: "Tandai beres" })).toHaveCount(0);
      await page.getByRole("button", { name: "Proses" }).click();
      await expect(attention(page)).toHaveCount(0);
      await expect(page.getByText("Siap Kirim", { exact: true }).first()).toBeVisible();
    });

    test('a flag is cleared with "Tandai beres"', async ({ page }) => {
      await openOrder(page, orderNo("flagged"));
      const panel = attention(page);
      await expect(panel.getByText("Pembayaran tidak wajar")).toBeVisible();
      await panel.getByRole("button", { name: "Tandai beres" }).click();
      await page.getByRole("dialog", { name: "Tandai beres?" }).getByRole("button", { name: "Tandai beres" }).click();
      await expect(attention(page)).toHaveCount(0);
    });
  });
}
