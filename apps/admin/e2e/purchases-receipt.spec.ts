import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { createPurchase, createSupplier } from "./helpers/purchase";
import { E2E_PURCHASES_EMAIL } from "./global-setup";

// docs/plans/suppliers-goods-receipt.md session S3: purchase documents and goods receipts. The
// whole flow runs at 390px AND at the project's default 1280px (CLAUDE.md's rule): /purchases and
// the stock lists render two independent layouts (CardList for phones, TableContainer for
// desktop), so each pass asserts its own layout's row and that the other one is hidden.
interface Layout {
  rowTag: "li" | "tr";
  hiddenRowTag: "li" | "tr";
  label: string;
}

const MOBILE: Layout = { rowTag: "li", hiddenRowTag: "tr", label: "mobile" };
const DESKTOP: Layout = { rowTag: "tr", hiddenRowTag: "li", label: "desktop" };

async function createFabric(page: Page, name: string): Promise<void> {
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(name);
  await page.getByLabel("Nama warna").fill("Hitam");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);
}

async function createAccessory(page: Page, name: string): Promise<void> {
  await page.goto("/accessories/new");
  await page.locator("#accessory-name").fill(name);
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/accessories$/);
}

/** The fabric's row on /stock/fabrics, in this viewport's layout. */
async function expectFabricStock(page: Page, layout: Layout, fabricName: string, qtyText: string): Promise<void> {
  await page.goto(`/stock/fabrics?q=${encodeURIComponent(fabricName)}`);
  const row = page.locator(layout.rowTag).filter({ hasText: fabricName });
  await expect(row).toBeVisible();
  await expect(row).toContainText(qtyText);
  await expect(page.locator(layout.hiddenRowTag).filter({ hasText: fabricName }).first()).toBeHidden();
}

async function goToReceive(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Terima barang" }).click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]+\/receive$/);
}

async function runPurchaseFlow(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.label}-${Date.now()}`;
  const supplierName = `E2E Supplier Pembelian ${marker}`;
  const fabricName = `E2E Katun Pembelian ${marker}`;
  const accessoryName = `E2E Kancing Pembelian ${marker}`;
  await createSupplier(page, supplierName);
  await createFabric(page, fabricName);
  await createAccessory(page, accessoryName);

  // 1. "Batal" on the create form goes back to the list without creating anything.
  await page.goto("/purchases/new");
  await page.getByRole("link", { name: "Batal" }).click();
  await expect(page).toHaveURL(/\/purchases$/);

  // 2. A two-line purchase: 10 yards for Rp 1.000.000 (ongkir included) and 3 pcs for Rp 30.000.
  await page.goto("/purchases/new");
  await page.locator("#purchase-supplier").selectOption({ label: supplierName });
  await page.getByLabel("Jenis barang 1").selectOption({ label: "Kain" });
  await page.getByLabel("Barang 1", { exact: true }).selectOption({ label: fabricName });
  await page.getByLabel("Jumlah barang 1").fill("10");
  await page.getByLabel("Total dibayar barang 1").fill("1.000.000");
  await expect(page.getByText("≈ Rp 100.000/yard (otomatis)")).toBeVisible();
  await page.getByRole("button", { name: "+ Tambah barang" }).click();
  await page.getByLabel("Jenis barang 2").selectOption({ label: "Aksesoris" });
  await page.getByLabel("Barang 2", { exact: true }).selectOption({ label: accessoryName });
  await page.getByLabel("Jumlah barang 2").fill("3");
  await page.getByLabel("Total dibayar barang 2").fill("30.000");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  // Create redirects to the LIST with a toast, and the new document shows there as "Dipesan".
  await expect(page).toHaveURL(/\/purchases$/);
  await expect(page.getByRole("status")).toContainText("Pesanan pembelian berhasil dibuat");
  await page.goto(`/purchases?q=${encodeURIComponent(supplierName)}`);
  const listRow = page.locator(layout.rowTag).filter({ hasText: supplierName });
  await expect(listRow).toBeVisible();
  await expect(listRow).toContainText("Dipesan");
  await expect(listRow).toContainText("Rp 1.030.000");
  await expect(page.locator(layout.hiddenRowTag).filter({ hasText: supplierName }).first()).toBeHidden();
  await listRow.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}$/);
  const purchaseUrl = page.url();

  // Recording the purchase moved no stock.
  await expectFabricStock(page, layout, fabricName, "0.00 yard");

  // 3. Partial receipt: 4 of 10 yards, none of the accessory yet.
  await page.goto(purchaseUrl);
  await goToReceive(page);
  await expect(page.getByLabel("Tanggal terima")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByLabel(fabricName).fill("4");
  await page.getByLabel(accessoryName).fill("0");
  await page.getByLabel("Diterima oleh").fill("Pak Satpam");
  await page.getByRole("button", { name: "Simpan penerimaan" }).click();
  await expect(page).toHaveURL(purchaseUrl, { timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText(/Penerimaan GR-\d{6}-\d{3} berhasil dicatat/);
  await expect(page.getByText("Diterima sebagian").first()).toBeVisible();
  await expect(page.getByTestId("receipt-row")).toHaveCount(1);
  await expect(page.getByTestId("receipt-row")).toContainText("oleh Pak Satpam");

  // Stock rose by exactly the accepted quantity.
  await expectFabricStock(page, layout, fabricName, "4.00 yard");

  // 4. Over-receipt is blocked with a clear Indonesian error naming what is left.
  await page.goto(purchaseUrl);
  await goToReceive(page);
  await page.getByLabel(fabricName).fill("7");
  await expect(page.getByText("Melebihi sisa pesanan (6.00 yard).")).toBeVisible();
  await page.getByRole("button", { name: "Simpan penerimaan" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("Periksa lagi jumlah yang diterima.");
  await expect(page).toHaveURL(/\/receive$/);

  // 5. Second receipt completes the document: the remaining quantities are prefilled.
  await page.getByLabel(fabricName).fill("6.00");
  await expect(page.getByLabel(accessoryName)).toHaveValue("3");
  await page.getByRole("button", { name: "Simpan penerimaan" }).click();
  await expect(page).toHaveURL(purchaseUrl, { timeout: 15_000 });
  await expect(page.getByText("Diterima lengkap").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Terima barang" })).toHaveCount(0);
  await expectFabricStock(page, layout, fabricName, "10.00 yard");

  // 6. Reversing the second receipt puts its stock back and reopens the document.
  await page.goto(purchaseUrl);
  const latestReceipt = page.getByTestId("receipt-row").first();
  await latestReceipt.getByRole("button", { name: /Batalkan penerimaan/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Batalkan penerimaan" }).click();
  await expect(page.getByText("Diterima sebagian").first()).toBeVisible({ timeout: 15_000 });
  await expectFabricStock(page, layout, fabricName, "4.00 yard");

  // 7. Close the rest with a required reason: something arrived, so it is "Ditutup".
  await page.goto(purchaseUrl);
  await page.getByRole("button", { name: "Tutup pesanan" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Tutup pesanan" }).click();
  await expect(dialog.locator("p[role=alert]")).toContainText("Alasan wajib diisi.");
  await dialog.getByLabel("Alasan").fill("Sisa kain tidak tersedia di toko");
  await dialog.getByRole("button", { name: "Tutup pesanan" }).click();
  await expect(page.getByRole("status")).toContainText("Pesanan ditutup", { timeout: 15_000 });
  await expect(page.getByText("Ditutup", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Sisa kain tidak tersedia di toko")).toBeVisible();
  await expect(page.getByRole("link", { name: "Terima barang" })).toHaveCount(0);
  await expectFabricStock(page, layout, fabricName, "4.00 yard");

  // 8. A purchase where nothing ever arrived closes as "Dibatalkan", and the list shows it.
  await createPurchase(page, supplierName, [{ type: "Aksesoris", itemName: accessoryName, qty: "5", amount: "5.000" }]);
  await page.getByRole("button", { name: "Tutup pesanan" }).click();
  await page.getByRole("dialog").getByLabel("Alasan").fill("Supplier batal kirim");
  await page.getByRole("dialog").getByRole("button", { name: "Tutup pesanan" }).click();
  await expect(page.getByRole("status")).toContainText("Pesanan dibatalkan", { timeout: 15_000 });
  await page.goto(`/purchases?status=cancelled&q=${encodeURIComponent(supplierName)}`);
  await expect(page.locator(layout.rowTag).filter({ hasText: supplierName })).toHaveCount(1);
}

test.describe("Pembelian: pesanan dan penerimaan barang", () => {
  test("create, partial receive, over-receipt blocked, complete, reverse, close with reason, at 390px and 1280px", async ({ page }) => {
    test.setTimeout(180_000);
    await loginAs(page, E2E_PURCHASES_EMAIL);

    await page.setViewportSize({ width: 390, height: 844 });
    await runPurchaseFlow(page, MOBILE);

    await page.setViewportSize({ width: 1280, height: 800 });
    await runPurchaseFlow(page, DESKTOP);
  });
});
