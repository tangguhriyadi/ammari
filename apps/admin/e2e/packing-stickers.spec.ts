import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { loginAs } from "./helpers/login";
import { E2E_PACKING_STICKERS_EMAIL } from "./global-setup";
import { generateSku } from "@ammari/db/catalog";

/** `packing-print.spec.ts`'s own page-counting trick (a dependency-free regex over Chromium's
 * `page.pdf()` bytes) doesn't work here — `pdf-lib`'s `.save()` compresses the page tree into
 * object streams by default, so the literal "/Type /Page" text isn't present in the raw bytes.
 * Loading it back through `pdf-lib` itself (the same library that built it) is the correct tool
 * here instead. */
async function countPdfPages(pdfPath: string): Promise<number> {
  const doc = await PDFDocument.load(readFileSync(pdfPath));
  return doc.getPageCount();
}

/** Creates ONE printable, to_ship order and returns its order number — the minimum setup
 * `/packing` needs (fabric -> product/variant -> purchase -> production -> stock -> order),
 * mirroring `packing-print.spec.ts`'s own setup helper. */
async function createPrintableOrder(page: Page, label: string): Promise<string> {
  const unique = `${label}-${Date.now()}`;

  const fabricName = `E2E Bahan Stiker ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Stiker");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Stiker E2E ${unique}`;
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  const code = await page.getByLabel("Kode produk").inputValue();
  await page.getByRole("switch", { name: "Aktif" }).click();
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);

  await page.getByRole("checkbox", { name: /Stiker/ }).check();
  await page.getByRole("checkbox", { name: "M", exact: true }).check();
  await page.getByRole("button", { name: "Tambah varian" }).click();
  const sku = generateSku({ code, closure: "front_zip", color: "Stiker", size: "M" });
  await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

  await page.goto("/purchases/new");
  await page.locator("#purchase-type").selectOption({ label: "Kain" });
  await page.locator("#purchase-item").selectOption({ label: fabricName });
  await page.locator("#purchase-qty").fill("10");
  await page.locator("#purchase-amount").fill("1.000.000");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]+$/);

  await page.goto("/production/new");
  await page.locator("#batch-fabric").selectOption({ label: fabricName });
  await page.locator("#batch-fabric-yards").fill("10");
  await page.locator(`#qty-${sku}`).fill("1");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await expect(page).toHaveURL(/\/production\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Posting ke stok" }).click();
  await page.getByRole("button", { name: "Posting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Posting ke stok" })).toHaveCount(0, { timeout: 15_000 });

  await page.goto("/orders/new");
  await page.locator("#order-channel").selectOption({ label: "WhatsApp" });
  await page.locator(`#qty-${sku}`).fill("1");
  await page.getByRole("button", { name: "Simpan pesanan" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
  return (await page.locator("h1").textContent())!.trim();
}

test.describe("thermal QR stickers on /packing", () => {
  test("selecting orders and clicking \"Cetak stiker\" downloads a real PDF, at both mobile and desktop viewport", async ({ page }) => {
    await loginAs(page, E2E_PACKING_STICKERS_EMAIL);

    // --- Mobile (390px): CardList's own checkboxes ---
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOrderNo = await createPrintableOrder(page, "mobile");

    await page.goto("/packing");
    await page.locator("li").filter({ hasText: mobileOrderNo }).getByRole("checkbox").check();

    const [mobileDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /^Cetak stiker/ }).click(),
    ]);
    expect(mobileDownload.suggestedFilename()).toMatch(/^ammari-stiker-\d{4}-\d{2}-\d{2}-\d{4}\.pdf$/);
    const mobilePath = await mobileDownload.path();
    expect(mobilePath).not.toBeNull();
    expect(await countPdfPages(mobilePath!)).toBe(1);

    // The order now shows a real (non-preview) sticker code and "Tercetak" status.
    await expect(page.locator("li").filter({ hasText: mobileOrderNo }).getByText(/WA-/)).toBeVisible({ timeout: 15_000 });

    // Ships this order so it leaves the to_ship queue — same cleanup `packing-print.spec.ts`'s
    // own test does, so repeated runs (and OTHER packing e2e specs' own "select all"/count
    // assertions, which see the whole shared `ammari_e2e` to_ship queue) never accumulate stray
    // orders left behind by this spec. The print didn't touch selection, so the checkbox checked
    // above is still checked.
    await page.getByRole("button", { name: "Tandai dikirim (1)" }).click();
    await expect(page.locator("li").filter({ hasText: mobileOrderNo })).toHaveCount(0, { timeout: 15_000 });

    // --- Desktop (project default, 1280px): TableContainer's own checkboxes ---
    await page.setViewportSize({ width: 1280, height: 800 });
    const desktopOrderNo = await createPrintableOrder(page, "desktop");

    await page.goto("/packing");
    await page.locator("tr").filter({ hasText: desktopOrderNo }).getByRole("checkbox").check();

    const [desktopDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /^Cetak stiker/ }).click(),
    ]);
    expect(desktopDownload.suggestedFilename()).toMatch(/^ammari-stiker-\d{4}-\d{2}-\d{2}-\d{4}\.pdf$/);
    const desktopPath = await desktopDownload.path();
    expect(desktopPath).not.toBeNull();
    expect(await countPdfPages(desktopPath!)).toBe(1);

    await expect(page.locator("tr").filter({ hasText: desktopOrderNo }).getByText(/WA-/)).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Tandai dikirim (1)" }).click();
    await expect(page.locator("tr").filter({ hasText: desktopOrderNo })).toHaveCount(0, { timeout: 15_000 });
  });
});
