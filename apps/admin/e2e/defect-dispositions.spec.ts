import { expect, test, type Page } from "@playwright/test";
import { generateSku } from "@ammari/db/catalog";
import { loginAs } from "./helpers/login";
import { openCreated } from "./helpers/open-created";
import { createPurchase, createSupplier, purchaseAndReceiveAll } from "./helpers/purchase";
import { postBatch } from "./helpers/production";
import { E2E_DISPOSITIONS_EMAIL } from "./global-setup";

// docs/plans/suppliers-goods-receipt.md session S6: returning defects for a replacement (and the
// re-open of a closed document it causes, D18), releases by Lelang / Hibah / Dibuang (D24/D29), a
// release reversal, and the read-only variance panel. The document line tables and the stock lists
// render two independent layouts (CardList for phones, TableContainer for desktop), so each is
// asserted at 390px AND at the project's default 1280px (CLAUDE.md).

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function createFabric(page: Page, name: string): Promise<void> {
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(name);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);
}

/** Receives one purchase line as `good` + `defective` and lands back on the document. */
async function receivePurchaseLine(page: Page, itemName: string, good: string, defective: string): Promise<void> {
  const documentUrl = page.url();
  await page.getByRole("link", { name: "Terima barang" }).click();
  await expect(page).toHaveURL(/\/receive$/);
  const line = page.getByTestId("receive-line").filter({ hasText: itemName });
  await line.getByLabel(itemName).fill(good);
  await line.getByLabel("Ditolak (cacat)").fill(defective);
  await page.getByRole("button", { name: "Simpan penerimaan" }).click();
  await expect(page).toHaveURL(documentUrl, { timeout: 15_000 });
}

/** The purchase line's quantities, read from whichever layout is visible. */
async function expectPurchaseLine(page: Page, itemName: string, expected: { cacat: string; ditukar: string; dilepas: string; sisa: string }) {
  for (const viewport of [MOBILE, DESKTOP]) {
    await page.setViewportSize(viewport);
    if (viewport === MOBILE) {
      const card = page.getByTestId("purchase-line-card").filter({ hasText: itemName });
      await expect(card).toBeVisible();
      await expect(page.getByTestId("purchase-line-row").filter({ hasText: itemName })).toBeHidden();
      await expect(card).toContainText(`Cacat${expected.cacat}`);
      await expect(card).toContainText(`Ditukar${expected.ditukar}`);
      await expect(card).toContainText(`Dilepas${expected.dilepas}`);
      await expect(card).toContainText(`Sisa${expected.sisa}`);
    } else {
      const row = page.getByTestId("purchase-line-row").filter({ hasText: itemName });
      await expect(row).toBeVisible();
      await expect(page.getByTestId("purchase-line-card").filter({ hasText: itemName })).toBeHidden();
      const cells = row.getByRole("cell");
      await expect(cells.nth(3)).toHaveText(expected.cacat);
      await expect(cells.nth(4)).toHaveText(expected.ditukar);
      await expect(cells.nth(5)).toHaveText(expected.dilepas);
      await expect(cells.nth(6)).toHaveText(expected.sisa);
    }
  }
}

test.describe("Barang cacat: tukar dan pelepasan", () => {
  test("return to the supplier + replacement receipt brings a purchase to fully received", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(MOBILE);
    await loginAs(page, E2E_DISPOSITIONS_EMAIL);
    const marker = Date.now();
    const supplierName = `E2E Supplier Tukar ${marker}`;
    const fabricName = `E2E Katun Tukar ${marker}`;
    await createSupplier(page, supplierName);
    await createFabric(page, fabricName);
    await createPurchase(page, supplierName, [{ type: "Kain", itemName: fabricName, qty: "10", amount: "1.000.000" }]);
    await receivePurchaseLine(page, fabricName, "8", "2");
    await expectPurchaseLine(page, fabricName, { cacat: "2.00 yard", ditukar: "0.00 yard", dilepas: "0.00 yard", sisa: "0.00 yard" });

    // Return the 2 defective yards, from the phone layout.
    await page.setViewportSize(MOBILE);
    await page.getByRole("button", { name: `Kembalikan ke supplier: ${fabricName}` }).click();
    const dialog = page.getByRole("dialog", { name: `Kembalikan ${fabricName}` });
    await expect(dialog.getByLabel(/Jumlah/)).toHaveValue("2");
    await dialog.getByLabel(/Jumlah/).fill("3");
    await dialog.getByLabel("Alasan").fill("Ada noda, supplier ganti");
    await dialog.getByRole("button", { name: "Kembalikan", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("melebihi stok cacat tersedia (2.00 yard)");
    await dialog.getByLabel(/Jumlah/).fill("2");
    await dialog.getByRole("button", { name: "Kembalikan", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Barang cacat dikembalikan ke supplier");

    // Exactly the returned 2 are outstanding again; the replacement goes through Terima barang.
    await expectPurchaseLine(page, fabricName, { cacat: "0.00 yard", ditukar: "2.00 yard", dilepas: "0.00 yard", sisa: "2.00 yard" });
    await expect(page.getByTestId("defect-row").filter({ hasText: "Dikembalikan untuk ditukar" })).toContainText("Ada noda, supplier ganti");
    await expect(page.getByTestId("variance-panel")).toContainText("Nilai ditukar");
    await page.setViewportSize(MOBILE);
    await page.getByRole("link", { name: "Terima barang" }).click();
    const line = page.getByTestId("receive-line").filter({ hasText: fabricName });
    await expect(line.getByLabel(fabricName)).toHaveValue("2.00");
    await page.getByRole("button", { name: "Simpan penerimaan" }).click();
    await expect(page.getByText("Diterima lengkap").first()).toBeVisible({ timeout: 15_000 });
    await expectPurchaseLine(page, fabricName, { cacat: "0.00 yard", ditukar: "2.00 yard", dilepas: "0.00 yard", sisa: "0.00 yard" });

    // All 10 yards are sellable, at both layouts of the stock list; no defect left.
    for (const viewport of [MOBILE, DESKTOP]) {
      await page.setViewportSize(viewport);
      await page.goto(`/stock/fabrics?q=${encodeURIComponent(fabricName)}`);
      const visible = page.locator(viewport === MOBILE ? "li" : "tr").filter({ hasText: fabricName });
      await expect(visible).toContainText("10.00 yard");
      await expect(visible).not.toContainText("Cacat");
    }
  });

  test("a return to the tailor re-opens a closed batch, and the replacement completes it", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(MOBILE);
    await loginAs(page, E2E_DISPOSITIONS_EMAIL);
    const unique = Date.now();
    const fabricName = `E2E Bahan Buka ${unique}`;
    await createFabric(page, fabricName);
    const productName = `Contoh Gamis Buka E2E ${unique}`;
    await page.goto("/products/new");
    await page.getByLabel("Nama produk").fill(productName);
    await page.locator("#product-fabric").selectOption({ label: fabricName });
    // Required since docs/plans/product-types.md; "Gamis" is the seeded DRESS type.
    await page.locator("#product-type").selectOption("DRESS");
    await page.getByLabel("Harga dasar").fill("269.000");
    const code = await page.getByLabel("Kode produk").inputValue();
    await page.getByRole("switch", { name: "Aktif" }).click();
    await page.getByRole("button", { name: "Simpan" }).click();
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);
    await page.getByRole("checkbox", { name: /Sage/ }).check();
    await page.getByRole("checkbox", { name: "M", exact: true }).check();
    await page.getByRole("button", { name: "Tambah varian" }).click();
    const sku = generateSku({ code, closure: "front_zip", color: "Sage", size: "M" });
    await expect(page.locator(`:text-is("${sku}"):visible`)).toBeVisible();

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

    // 3 good + 1 defective, then short-close.
    await page.getByRole("link", { name: "Terima hasil" }).click();
    const receiveLine = page.getByTestId("receive-line").filter({ hasText: variantLabel });
    await receiveLine.getByLabel(variantLabel).fill("3");
    await receiveLine.getByLabel("Ditolak (cacat)").fill("1");
    await page.getByRole("button", { name: "Simpan penerimaan" }).click();
    await expect(page).toHaveURL(batchUrl, { timeout: 15_000 });
    const output = page.getByRole("region", { name: "Hasil produksi" });
    await page.getByRole("button", { name: "Tutup batch" }).click();
    const closeDialog = page.getByRole("dialog", { name: "Tutup batch ini?" });
    await closeDialog.getByLabel("Alasan").fill("Yang cacat dibiarkan dulu");
    await closeDialog.getByRole("button", { name: "Tutup batch" }).click();
    await expect(output.getByText("Ditutup", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // Return the defective pc to the tailor: the batch is re-opened.
    await page.getByRole("button", { name: `Kembalikan ke penjahit: ${variantLabel}` }).click();
    const dialog = page.getByRole("dialog", { name: `Kembalikan ${variantLabel}` });
    await expect(dialog).toContainText("dibuka kembali");
    await dialog.getByLabel("Alasan").fill("Jahitan lepas, diperbaiki penjahit");
    await dialog.getByRole("button", { name: "Kembalikan", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("batch dibuka kembali");
    await expect(output.getByText("Dibuka kembali", { exact: true }).first()).toBeVisible();
    await expect(output.getByText("Diterima sebagian", { exact: true })).toBeVisible();
    await expect(output.getByText("Jahitan lepas, diperbaiki penjahit").first()).toBeVisible();

    for (const viewport of [MOBILE, DESKTOP]) {
      await page.setViewportSize(viewport);
      if (viewport === MOBILE) {
        const card = output.getByTestId("output-line");
        await expect(card).toContainText("Cacat0 pcs");
        await expect(card).toContainText("Ditukar1 pcs");
        await expect(card).toContainText("Sisa1 pcs");
      } else {
        await expect(output.getByTestId("output-row").getByRole("cell")).toHaveText([variantLabel, sku, "4 pcs", "3 pcs", "0 pcs", "1 pcs", "0 pcs", "1 pcs"]);
      }
    }

    // The repaired pc arrives: fully received.
    await page.setViewportSize(MOBILE);
    await page.getByRole("link", { name: "Terima hasil" }).click();
    await expect(page.getByTestId("receive-line").filter({ hasText: variantLabel }).getByLabel(variantLabel)).toHaveValue("1");
    await page.getByRole("button", { name: "Simpan penerimaan" }).click();
    await expect(page).toHaveURL(batchUrl, { timeout: 15_000 });
    await expect(output.getByText("Diterima lengkap", { exact: true })).toBeVisible();

    // The SKU detail shows 4 sellable and an empty defect stock with its history.
    await page.goto(`/stock/${sku}`);
    await expect(page.getByText("4 pcs", { exact: true })).toBeVisible();
    await expect(page.getByTestId("item-defect-qty")).toHaveText("0 pcs");
    await expect(page.getByTestId("item-defect-row")).toHaveCount(2);
  });

  test("one release of each type (Lelang, Hibah, Dibuang), a reversal, and the variance panel", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(MOBILE);
    await loginAs(page, E2E_DISPOSITIONS_EMAIL);
    const marker = Date.now();
    const supplierName = `E2E Supplier Lepas ${marker}`;
    const fabricName = `E2E Katun Lepas ${marker}`;
    await createSupplier(page, supplierName);
    await createFabric(page, fabricName);
    // 9 yards for Rp 900.000 (Rp 100.000 per yard): 6 good, 3 defective.
    await createPurchase(page, supplierName, [{ type: "Kain", itemName: fabricName, qty: "9", amount: "900.000" }]);
    await receivePurchaseLine(page, fabricName, "6", "3");

    async function release(type: "Lelang" | "Hibah" | "Dibuang/Dimusnahkan", note: string, proceeds?: string) {
      await page.getByRole("button", { name: `Pelepasan barang cacat: ${fabricName}` }).click();
      const dialog = page.getByRole("dialog", { name: `Pelepasan ${fabricName}` });
      await dialog.getByLabel(/Jumlah/).fill("1");
      await dialog.getByRole("radio", { name: new RegExp(`^${type.replace("/", "\\/")}`) }).check();
      if (proceeds !== undefined) {
        await dialog.getByLabel("Hasil lelang").fill(proceeds);
        // The consequence shows before saving: Rp 100.000 released minus the proceeds.
        await expect(dialog.getByTestId("dispose-preview")).toContainText("Kerugian bersih≈ Rp 70.000");
      } else {
        // Hibah and Dibuang have no proceeds: the field is hidden (forced to Rp 0).
        await expect(dialog.getByLabel("Hasil lelang")).toHaveCount(0);
        await expect(dialog.getByTestId("dispose-preview")).toContainText("Kerugian bersih≈ Rp 100.000");
      }
      await dialog.getByLabel("Catatan").fill(note);
      await dialog.getByRole("button", { name: "Lepas barang" }).click();
      await expect(page.getByRole("status")).toContainText(`Barang cacat dilepas (${type})`);
      await expect(dialog).toBeHidden();
    }

    // Lelang needs proceeds > 0, blocked before the server.
    await page.getByRole("button", { name: `Pelepasan barang cacat: ${fabricName}` }).click();
    const firstDialog = page.getByRole("dialog", { name: `Pelepasan ${fabricName}` });
    await firstDialog.getByLabel(/Jumlah/).fill("1");
    await firstDialog.getByLabel("Catatan").fill("Lelang");
    await firstDialog.getByRole("button", { name: "Lepas barang" }).click();
    await expect(firstDialog.getByRole("alert")).toHaveText("Hasil lelang wajib diisi dan lebih dari Rp 0.");
    await firstDialog.getByRole("button", { name: "Batal" }).click();

    await release("Lelang", "Dilelang ke tetangga", "30.000");
    await release("Hibah", "Disedekahkan ke panti");
    await release("Dibuang/Dimusnahkan", "Robek parah, dibuang");

    // Releases never create outstanding.
    await expectPurchaseLine(page, fabricName, { cacat: "0.00 yard", ditukar: "0.00 yard", dilepas: "3.00 yard", sisa: "0.00 yard" });
    await expect(page.getByRole("link", { name: "Terima barang" })).toHaveCount(0);

    const panel = page.getByTestId("variance-panel");
    await expect(panel).toContainText("Total pesananRp 900.000");
    await expect(panel).toContainText("Nilai diterimaMasuk stok yang bisa dipakaiRp 600.000");
    await expect(panel).toContainText("Nilai cacat dilepas: LelangRp 100.000");
    await expect(panel).toContainText("Nilai cacat dilepas: HibahRp 100.000");
    await expect(panel).toContainText("Nilai cacat dilepas: Dibuang/DimusnahkanRp 100.000");
    await expect(panel).toContainText(/Hasil pelepasan.*Rp 30\.000/);
    await expect(panel).toContainText("Kerugian bersih barang cacatRp 270.000");
    const lelangRow = page.getByTestId("defect-row").filter({ hasText: "Lelang" });
    await expect(lelangRow).toContainText("Hasil Rp 30.000");
    await expect(lelangRow).toContainText("Dilelang ke tetangga");

    // Close: everything that arrived is accounted for, nothing unabsorbed.
    await page.getByRole("button", { name: "Tutup pesanan" }).click();
    const closeDialog = page.getByRole("dialog", { name: "Tutup pesanan ini?" });
    await closeDialog.getByLabel("Alasan").fill("Selesai");
    await closeDialog.getByRole("button", { name: "Tutup pesanan" }).click();
    await expect(page.getByText("Ditutup", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(panel).toContainText("Nilai belum terserapSudah dibayar tapi tidak pernah datangRp 0");

    // Reverse the auction: its value AND proceeds come back out of the figures, the yard is
    // defect stock again, and a release never re-opens the closed document.
    await lelangRow.getByRole("button", { name: "Batalkan" }).click();
    await page.getByRole("dialog", { name: "Batalkan catatan ini?" }).getByRole("button", { name: "Batalkan catatan" }).click();
    await expect(page.getByRole("status")).toContainText("Catatan barang cacat dibatalkan");
    await expect(panel).not.toContainText("Nilai cacat dilepas: Lelang");
    await expect(panel).toContainText("Kerugian bersih barang cacatRp 200.000");
    await expect(page.getByText("Dibuka kembali", { exact: true })).toHaveCount(0);
    await expectPurchaseLine(page, fabricName, { cacat: "1.00 yard", ditukar: "0.00 yard", dilepas: "2.00 yard", sisa: "0.00 yard" });

    // S5b: the "Cacat" column on the stock list (both layouts) and the item's defect section.
    for (const viewport of [MOBILE, DESKTOP]) {
      await page.setViewportSize(viewport);
      await page.goto(`/stock/fabrics?q=${encodeURIComponent(fabricName)}`);
      if (viewport === MOBILE) {
        await expect(page.locator("li").filter({ hasText: fabricName })).toContainText("Cacat 1.00 yard");
      } else {
        await expect(page.locator("tr").filter({ hasText: fabricName }).getByTestId("fabric-defect-qty")).toHaveText("1.00 yard");
      }
    }
    await page.locator("tr").filter({ hasText: fabricName }).getByRole("link", { name: fabricName }).click();
    await expect(page.getByTestId("item-defect-qty")).toHaveText("1.00 yard");
    const ledger = page.getByTestId("item-defect-row");
    await expect(ledger.filter({ hasText: "Dibuang/Dimusnahkan" })).toContainText("Robek parah, dibuang");
    await expect(ledger.filter({ hasText: "Hibah" }).getByRole("link", { name: /^PO-/ })).toBeVisible();
  });
});
