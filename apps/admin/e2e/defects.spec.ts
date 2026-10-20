import { expect, test, type Page } from "@playwright/test";
import { generateSku } from "@ammari/db/catalog";
import { loginAs } from "./helpers/login";
import { openCreated } from "./helpers/open-created";
import { createPurchase, createSupplier, purchaseAndReceiveAll } from "./helpers/purchase";
import { postBatch } from "./helpers/production";
import { E2E_DEFECTS_EMAIL } from "./global-setup";

// docs/plans/suppliers-goods-receipt.md session S5: rejects at receipt (both sources) go to defect
// stock with their value, never to sellable stock, and settle the line's quantity. Every list page
// touched here (/stock/defects, the document line tables, /stock/fabrics) renders two independent
// layouts (CardList for phones, TableContainer for desktop), so each is asserted at 390px AND at
// the project's default 1280px (CLAUDE.md).

interface Layout {
  rowTag: "li" | "tr";
  hiddenRowTag: "li" | "tr";
  label: string;
  width: number;
  height: number;
}

const MOBILE: Layout = { rowTag: "li", hiddenRowTag: "tr", label: "mobile", width: 390, height: 844 };
const DESKTOP: Layout = { rowTag: "tr", hiddenRowTag: "li", label: "desktop", width: 1280, height: 800 };

async function setLayout(page: Page, layout: Layout): Promise<void> {
  await page.setViewportSize({ width: layout.width, height: layout.height });
}

async function createFabric(page: Page, name: string): Promise<void> {
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(name);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);
}

/** The visible row for `text` in this layout's list, asserting the other layout's copy is hidden. */
async function layoutRow(page: Page, layout: Layout, text: string, extra?: string) {
  let row = page.locator(layout.rowTag).filter({ hasText: text });
  if (extra) row = row.filter({ hasText: extra });
  await expect(row).toBeVisible();
  let hidden = page.locator(layout.hiddenRowTag).filter({ hasText: text });
  if (extra) hidden = hidden.filter({ hasText: extra });
  await expect(hidden.first()).toBeHidden();
  return row;
}

/** A purchase of 10 yards for Rp 1.000.000, received as 8 good + 2 defective. */
async function purchaseWithRejects(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.label}-${Date.now()}`;
  const supplierName = `E2E Supplier Cacat ${marker}`;
  const fabricName = `E2E Katun Cacat ${marker}`;
  await createSupplier(page, supplierName);
  await createFabric(page, fabricName);
  await createPurchase(page, supplierName, [{ type: "Kain", itemName: fabricName, qty: "10", amount: "1.000.000" }]);
  const purchaseUrl = page.url();

  await page.getByRole("link", { name: "Terima barang" }).click();
  await expect(page).toHaveURL(/\/receive$/);
  const line = page.getByTestId("receive-line").filter({ hasText: fabricName });
  await expect(line.getByLabel(fabricName)).toHaveValue("10.00"); // prefilled with what is left
  await expect(line.getByLabel("Ditolak (cacat)")).toHaveValue(""); // defects are the exception
  // Good + defective together may not exceed what is left (D17), blocked before the server.
  await line.getByLabel(fabricName).fill("9");
  await line.getByLabel("Ditolak (cacat)").fill("2");
  await expect(line.getByText("Diterima ditambah ditolak melebihi sisa pesanan (10.00 yard).")).toBeVisible();
  await line.getByLabel(fabricName).fill("8");
  await expect(line.getByText(/melebihi/)).toHaveCount(0);
  await page.getByRole("button", { name: "Simpan penerimaan" }).click();
  await expect(page).toHaveURL(purchaseUrl, { timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText(/Penerimaan GR-\d{6}-\d{3} berhasil dicatat/);

  // Everything arrived (8 + 2), so nothing is left to receive, but only accepted units complete a
  // line: the document stays "Diterima sebagian" until it is closed.
  await expect(page.getByText("Diterima sebagian").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Terima barang" })).toHaveCount(0);
  // On phones the receipt and defect history cards are list items too: the line card is the one
  // with "Dipesan". The desktop table's rows are only the lines.
  const lineRow = await layoutRow(page, layout, fabricName, layout.rowTag === "li" ? "Dipesan" : "yard");
  if (layout.rowTag === "tr") {
    // Dipesan / Diterima / Cacat / Ditukar / Dilepas / Sisa (S6), then the line's defect actions.
    await expect(lineRow.getByRole("cell")).toHaveText([
      "E2E Katun Cacat " + marker,
      "10.00 yard",
      "8.00 yard",
      "2.00 yard",
      "0.00 yard",
      "0.00 yard",
      "0.00 yard",
      "Rp 1.000.000",
      /^Kembalikan ke supplier/,
    ]);
  } else {
    await expect(lineRow).toContainText("Cacat2.00 yard");
    await expect(lineRow).toContainText("Sisa0.00 yard");
  }
  await expect(page.getByTestId("receipt-row")).toContainText("ditolak (cacat) 2.00 yard");
  const defectRow = page.getByTestId("defect-row");
  await expect(defectRow).toHaveCount(1);
  await expect(defectRow).toContainText("Ditolak saat diterima");
  await expect(defectRow).toContainText("2.00 yard");
  await expect(defectRow).toContainText("Nilai Rp 200.000");
  await expect(page.getByTestId("variance-panel").getByText("Nilai cacat masih disimpan")).toBeVisible();

  // Sellable stock rose by the accepted 8 only.
  await page.goto(`/stock/fabrics?q=${encodeURIComponent(fabricName)}`);
  await expect(await layoutRow(page, layout, fabricName)).toContainText("8.00 yard");

  // The "Cacat" tab lists the 2 defective yards with their value.
  await page.getByRole("link", { name: "Cacat", exact: true }).click();
  await expect(page).toHaveURL(/\/stock\/defects$/);
  await expect(page.getByRole("heading", { name: "Stok barang cacat" })).toBeVisible();
  const defectStockRow = await layoutRow(page, layout, fabricName);
  await expect(defectStockRow).toContainText("Kain");
  await expect(defectStockRow).toContainText("2.00 yard");
  await expect(defectStockRow).toContainText("Rp 200.000");
}

test.describe("Barang cacat: ditolak saat penerimaan", () => {
  test("a purchase received with rejects: defect stock, document figures and the Cacat tab, at 390px and 1280px", async ({ page }) => {
    test.setTimeout(150_000);
    await loginAs(page, E2E_DEFECTS_EMAIL);
    await setLayout(page, MOBILE);
    await purchaseWithRejects(page, MOBILE);
    await setLayout(page, DESKTOP);
    await purchaseWithRejects(page, DESKTOP);
  });

  test("a batch received with rejects: sellable gets the good pcs only, defects show on the batch, the Cacat tab and the stock count, at 390px and 1280px", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await setLayout(page, MOBILE);
    await loginAs(page, E2E_DEFECTS_EMAIL);
    const unique = Date.now();

    const fabricName = `E2E Bahan Cacat ${unique}`;
    await createFabric(page, fabricName);
    const productName = `Contoh Gamis Cacat E2E ${unique}`;
    await page.goto("/products/new");
    await page.getByLabel("Nama produk").fill(productName);
    await page.locator("#product-fabric").selectOption({ label: fabricName });
    await page.getByLabel("Harga dasar").fill("269.000");
    const code = await page.getByLabel("Kode produk").inputValue();
    await page.getByRole("switch", { name: "Aktif" }).click(); // product left inactive; variants are created active either way
    await page.getByRole("button", { name: "Simpan" }).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
    const productId = page.url().split("/products/")[1]!;
    await page.getByRole("checkbox", { name: /Sage/ }).check();
    await page.getByRole("checkbox", { name: "M", exact: true }).check();
    await page.getByRole("button", { name: "Tambah varian" }).click();
    const sku = generateSku({ code, closure: "front_zip", color: "Sage", size: "M" });
    await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

    // 2 yards for Rp 200.000 into a batch of 4 pcs: HPP/pcs = Rp 50.000.
    await purchaseAndReceiveAll(page, [{ type: "Kain", itemName: fabricName, qty: "2", amount: "200.000" }]);
    await page.goto("/production/new");
    await page.locator("#batch-fabric").selectOption({ label: fabricName });
    await page.locator("#batch-fabric-yards").fill("2");
    await page.getByLabel("M", { exact: true }).fill("4");
    await page.getByRole("button", { name: "Simpan draf" }).click();
    await openCreated(page, "/production");
    await postBatch(page);
    const batchUrl = page.url();
    const variantLabel = `${productName} · Sage · M`;

    // Receive 2 good + 1 defective of the 4.
    await page.getByRole("link", { name: "Terima hasil" }).click();
    await expect(page).toHaveURL(/\/receive$/);
    const line = page.getByTestId("receive-line").filter({ hasText: variantLabel });
    await line.getByLabel(variantLabel).fill("4");
    await line.getByLabel("Ditolak (cacat)").fill("1");
    await expect(line.getByText("Diterima ditambah ditolak melebihi sisa batch (4 pcs).")).toBeVisible();
    await line.getByLabel(variantLabel).fill("2");
    await page.getByRole("button", { name: "Simpan penerimaan" }).click();
    await expect(page).toHaveURL(batchUrl, { timeout: 15_000 });

    const output = page.getByRole("region", { name: "Hasil produksi" });
    await expect(output.getByText("Diterima sebagian", { exact: true })).toBeVisible();
    await expect(output.getByTestId("output-line")).toContainText("Cacat1 pcs");
    await expect(output.getByTestId("output-line")).toContainText("Sisa1 pcs");
    await expect(output.getByTestId("defect-row")).toContainText("Ditolak saat diterima");
    await expect(output.getByTestId("defect-row")).toContainText("1 pcs");
    await expect(output.getByTestId("defect-row")).toContainText("Nilai Rp 50.000");
    await setLayout(page, DESKTOP);
    await expect(output.getByTestId("output-row").getByRole("cell")).toHaveText([
      variantLabel,
      sku,
      "4 pcs",
      "2 pcs",
      "1 pcs",
      "0 pcs",
      "0 pcs",
      "1 pcs",
      /^Kembalikan ke penjahit/,
    ]);
    await setLayout(page, MOBILE);

    // Sellable stock is the 2 good pcs only.
    await page.goto(`/stock/${sku}`);
    await expect(page.getByText("2 pcs", { exact: true })).toBeVisible({ timeout: 15_000 });

    // The stock count shows the defect figure read-only, next to (not inside) the system count.
    for (const layout of [MOBILE, DESKTOP]) {
      await setLayout(page, layout);
      await page.goto(`/stock/count/${productId}`);
      await expect(page.getByText(`${sku} · Sistem: 2`)).toBeVisible();
      await expect(page.getByTestId("count-defect-qty")).toHaveText("Cacat: 1 pcs (tidak ikut dihitung)");
      await expect(page.locator(`#count-${sku}`)).toHaveAttribute("placeholder", "2");
      await expect(page.getByRole("note").getByText(/sisa 1 pcs/)).toBeVisible();
    }
    await setLayout(page, MOBILE);

    // The last pc arrives defective too: the line is fully settled, nothing is left to receive,
    // and the count-page "unreceived" warning is gone, while the batch stays partially received.
    await page.goto(batchUrl);
    await page.getByRole("link", { name: "Terima hasil" }).click();
    const lastLine = page.getByTestId("receive-line").filter({ hasText: variantLabel });
    await expect(lastLine.getByText("Rencana 4 · Diterima 2 · Cacat 1 · Sisa 1 pcs")).toBeVisible();
    await lastLine.getByLabel(variantLabel).fill("0");
    await lastLine.getByLabel("Ditolak (cacat)").fill("1");
    await page.getByRole("button", { name: "Simpan penerimaan" }).click();
    await expect(page).toHaveURL(batchUrl, { timeout: 15_000 });
    await expect(output.getByText("Diterima sebagian", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Terima hasil" })).toHaveCount(0);
    await expect(output.getByTestId("defect-row")).toHaveCount(2);

    // The Cacat tab, both layouts: 2 pcs at Rp 50.000 each; still only 2 sellable.
    for (const layout of [MOBILE, DESKTOP]) {
      await setLayout(page, layout);
      await page.goto("/stock");
      await page.getByRole("link", { name: "Cacat", exact: true }).click();
      await expect(page).toHaveURL(/\/stock\/defects$/);
      const row = await layoutRow(page, layout, sku);
      await expect(row).toContainText(productName);
      await expect(row).toContainText("2 pcs");
      await expect(row).toContainText("Rp 100.000");

      await page.goto(`/stock/count/${productId}`);
      await expect(page.getByTestId("count-defect-qty")).toHaveText("Cacat: 2 pcs (tidak ikut dihitung)");
      await expect(page.getByText(`${sku} · Sistem: 2`)).toBeVisible();
      await expect(page.getByRole("note")).toHaveCount(0);
    }
  });
});
