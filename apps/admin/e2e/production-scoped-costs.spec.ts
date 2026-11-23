import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { openCreated } from "./helpers/open-created";
import { addVariants, createProductDraft } from "./helpers/product";
import { postBatch } from "./helpers/production";
import { createSupplier, purchaseAndReceiveAll } from "./helpers/purchase";
import { E2E_SCOPED_COSTS_EMAIL } from "./global-setup";

// "Berlaku untuk" on a batch cost line (migration 0047): one batch of two products on the same
// fabric, sewn by one tailor at a different price per product. The real case: Haura Rp39.000/pcs
// and Cyra Rp37.000/pcs, one bill to the tailor. Runs at 390px and 1280px.

async function createComponent(page: Page, input: { name: string; price: string; supplierName: string }): Promise<void> {
  await page.goto("/production/cost-components/new");
  await page.locator("#component-name").fill(input.name);
  await page.locator("#component-price").fill(input.price);
  await page.locator("#component-supplier").selectOption({ label: input.supplierName });
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/production\/cost-components$/);
}

/** The "M" qty input under one product's heading in the SKU picker. */
function qtyInput(page: Page, productName: string): Locator {
  return page.getByRole("heading", { level: 3, name: productName }).locator("..").getByLabel("M", { exact: true });
}

async function runFlow(page: Page, label: string): Promise<void> {
  const marker = `${label}-${Date.now()}`;
  const fabricName = `E2E Bahan Ongkos ${marker}`;
  const haura = `E2E Haura ${marker}`;
  const cyra = `E2E Cyra ${marker}`;
  const tailor = `E2E Konveksi ${marker}`;
  const sewing = `E2E Ongkos jahit ${marker}`;

  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Hitam");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);
  for (const name of [haura, cyra]) {
    await createProductDraft(page, { name, fabricName, active: false });
    await addVariants(page, /Hitam/, ["M"]);
  }
  // 18 yards at Rp100.000: the fabric costs Rp100.000 per pcs of an 18-pcs batch.
  await purchaseAndReceiveAll(page, [{ type: "Kain", itemName: fabricName, qty: "18", amount: "1.800.000" }]);
  await createSupplier(page, tailor);
  await createComponent(page, { name: sewing, price: "39.000", supplierName: tailor });

  await page.goto("/production/new");
  await page.locator("#batch-fabric").selectOption({ label: fabricName });
  await page.locator("#batch-fabric-yards").fill("18");
  await qtyInput(page, haura).fill("10");
  await qtyInput(page, cyra).fill("8");

  // Two sewing lines, one per product, both to the same tailor.
  await page.getByRole("button", { name: "+ Tambah biaya" }).click();
  await page.locator("#extra-cost-component-0").selectOption({ label: sewing });
  await page.locator("#extra-cost-scope-0").selectOption({ label: haura });
  await page.getByRole("button", { name: "+ Tambah biaya" }).click();
  await page.locator("#extra-cost-component-1").selectOption({ label: sewing });
  await page.locator("#extra-cost-price-1").fill("37000");
  await page.locator("#extra-cost-scope-1").selectOption({ label: cyra });
  await expect(page.getByText(`× 10 pcs ${haura}`)).toBeVisible();
  await expect(page.getByText(`× 8 pcs ${cyra}`)).toBeVisible();
  await expect(page.getByText("Total biaya lain: Rp 686.000")).toBeVisible();

  // The draft estimate: shared fabric Rp100.000/pcs + each product's own sewing.
  const estimate = page.getByTestId("hpp-estimate");
  await expect(estimate.getByTestId("hpp-estimate-row").filter({ hasText: haura })).toContainText("Rp 139.000/pcs");
  await expect(estimate.getByTestId("hpp-estimate-row").filter({ hasText: cyra })).toContainText("Rp 137.000/pcs");

  // Removing Cyra's SKUs while a line is scoped to Cyra: flagged on the line and refused on save.
  await qtyInput(page, cyra).fill("0");
  await expect(page.getByText(`${cyra} tidak punya SKU di batch ini.`)).toBeVisible();
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await expect(page.locator("p[role=alert]").filter({ hasText: /^Biaya "/ })).toContainText(`berlaku untuk ${cyra}, tetapi ${cyra} tidak punya SKU di batch ini`);
  await qtyInput(page, cyra).fill("8");

  await page.getByRole("button", { name: "Simpan draf" }).click();
  await openCreated(page, "/production");
  // The scope survives the round trip.
  await expect(page.locator("#extra-cost-scope-0 option:checked")).toHaveText(haura);
  await expect(page.locator("#extra-cost-scope-1 option:checked")).toHaveText(cyra);

  await postBatch(page);

  // Posted: HPP per product, and each line names its product.
  const hppRows = page.getByTestId("batch-product-hpp");
  await expect(hppRows.filter({ hasText: haura }).getByTestId("batch-product-hpp-value")).toHaveText("Rp 139.000/pcs");
  await expect(hppRows.filter({ hasText: cyra }).getByTestId("batch-product-hpp-value")).toHaveText("Rp 137.000/pcs");
  await expect(page.getByText(`Berlaku untuk: ${haura}`)).toBeVisible();
  await expect(page.getByText(`Berlaku untuk: ${cyra}`)).toBeVisible();

  // One bill to the tailor for the batch: 10 x 39.000 + 8 x 37.000.
  await expect(page.getByTestId("payment-tagihan")).toHaveText("Rp 686.000");
  await expect(page.getByTestId("payment-summary")).toContainText("Rp 686.000");

  // No horizontal scroll at this width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.describe("Produksi: biaya per produk dalam satu batch", () => {
  for (const viewport of [
    { label: "mobile", width: 390, height: 844 },
    { label: "desktop", width: 1280, height: 800 },
  ]) {
    test(`ongkos jahit berbeda per produk, HPP per produk dan satu tagihan at ${viewport.width}px`, async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await loginAs(page, E2E_SCOPED_COSTS_EMAIL);
      await runFlow(page, viewport.label);
    });
  }
});
