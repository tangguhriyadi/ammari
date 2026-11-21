import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { openCreated } from "./helpers/open-created";
import { createPurchase, createSupplier } from "./helpers/purchase";
import { E2E_FABRIC_COLOUR_EMAIL } from "./global-setup";

// docs/plans/fabric-colour-stock.md session S2: purchase lines per colour. Every flow runs at 390px
// AND 1280px (CLAUDE.md's rule): the purchase detail's Barang list renders two independent layouts
// (CardList for phones, TableContainer for desktop), so each pass asserts its own layout's rows
// and that the other layout's rows are hidden.

interface Layout {
  label: string;
  width: number;
  height: number;
  lineRow: string;
  hiddenLineRow: string;
}

const MOBILE: Layout = {
  label: "390px",
  width: 390,
  height: 844,
  lineRow: '[data-testid="purchase-line-card"]',
  hiddenLineRow: '[data-testid="purchase-line-row"]',
};
const DESKTOP: Layout = {
  label: "1280px",
  width: 1280,
  height: 800,
  lineRow: '[data-testid="purchase-line-row"]',
  hiddenLineRow: '[data-testid="purchase-line-card"]',
};

/** Creates a fabric with `colors` on /fabrics/new and returns its detail URL. */
async function createFabric(page: Page, name: string, colors: string[]): Promise<string> {
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(name);
  for (const [index, color] of colors.entries()) {
    if (index > 0) await page.getByRole("button", { name: "+ Tambah warna" }).click();
    await page.getByLabel("Nama warna").nth(index).fill(color);
  }
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);
  return page.url();
}

function selectedOption(page: Page, label: string) {
  return page.getByLabel(label, { exact: true }).locator("option:checked");
}

/** The detail page's Barang rows in this viewport's layout: exactly `expected` (fabric colour
 * labels, in order), and the other layout hidden. */
async function expectLines(page: Page, layout: Layout, fabricName: string, expected: string[]): Promise<void> {
  const rows = page.locator(layout.lineRow);
  await expect(rows).toHaveCount(expected.length);
  for (const [index, colorLabel] of expected.entries()) {
    await expect(rows.nth(index)).toContainText(fabricName);
    await expect(rows.nth(index).getByTestId("purchase-line-color")).toHaveText(colorLabel);
  }
  await expect(page.locator(layout.hiddenLineRow).first()).toBeHidden();
}

async function receiptPhoto(): Promise<Buffer> {
  return sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 200, g: 180, b: 170 } } })
    .jpeg()
    .toBuffer();
}

async function runCreateWithColours(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.width}-${Date.now()}`;
  const supplierName = `E2E Pemasok Warna ${marker}`;
  const fabricName = `E2E Marbella Warna ${marker}`;
  await createSupplier(page, supplierName);
  await createFabric(page, fabricName, ["Sage", "Mocca", "Tosca"]);

  await page.goto("/purchases/new");
  await page.locator("#purchase-supplier").selectOption({ label: supplierName });
  await page.getByLabel("Jenis barang 1").selectOption({ label: "Kain" });
  await page.getByLabel("Barang 1", { exact: true }).selectOption({ label: fabricName });
  await expect(page.getByLabel("Warna barang 1", { exact: true })).toBeVisible();

  // Harga/yard first, then "Tambah semua warna": one line per colour (by name), each keeping it.
  await page.getByLabel("Harga per yard barang 1").fill("19.500");
  await page.getByRole("button", { name: "Tambah semua warna barang 1" }).click();
  await expect(page.getByTestId("purchase-line")).toHaveCount(3);
  for (const [index, color] of ["Mocca", "Sage", "Tosca"].entries()) {
    await expect(selectedOption(page, `Warna barang ${index + 1}`)).toHaveText(color);
    await expect(page.getByLabel(`Harga per yard barang ${index + 1}`)).toHaveValue("19.500");
  }
  // Every colour is on the document now: nothing left to add.
  await expect(page.getByRole("button", { name: /^Tambah semua warna/ })).toHaveCount(0);

  // Jumlah × Harga/yard fills Total harga; the footer sums yards per fabric and the document.
  await page.getByLabel("Jumlah barang 1").fill("10");
  await page.getByLabel("Jumlah barang 2").fill("8");
  await page.getByLabel("Jumlah barang 3").fill("5");
  await expect(page.getByLabel("Total harga barang 1")).toHaveValue("195.000");
  await expect(page.getByLabel("Total harga barang 2")).toHaveValue("156.000");
  await expect(page.getByLabel("Total harga barang 3")).toHaveValue("97.500");
  const totals = page.getByTestId("purchase-form-totals");
  await expect(totals).toContainText(`${fabricName}23.00 yard · Rp 448.500`);
  await expect(totals).toContainText("Total pesanan");
  await expect(totals).toContainText("Rp 448.500");

  // A 4th line of the same fabric without a colour is refused before anything is sent.
  await page.getByRole("button", { name: "+ Tambah barang" }).click();
  await page.getByLabel("Jenis barang 4").selectOption({ label: "Kain" });
  await page.getByLabel("Barang 4", { exact: true }).selectOption({ label: fabricName });
  await page.getByLabel("Jumlah barang 4").fill("1");
  await page.getByLabel("Total harga barang 4").fill("1");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.locator('form [role="alert"]')).toHaveText(`Pilih warna untuk ${fabricName}.`);
  await page.getByRole("button", { name: "Hapus barang 4" }).click();

  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await openCreated(page, "/purchases", supplierName);
  const purchaseUrl = page.url();
  await expectLines(page, layout, fabricName, ["Mocca", "Sage", "Tosca"]);

  // Edit: remove Tosca, change Sage, save; the detail follows.
  await page.getByRole("link", { name: "Ubah pesanan" }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await expect(selectedOption(page, "Warna barang 3")).toHaveText("Tosca");
  await page.getByRole("button", { name: "Hapus barang 3" }).click();
  await page.getByLabel("Jumlah barang 2").fill("12");
  await page.getByLabel("Total harga barang 2").fill("234.000");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases$/, { timeout: 15_000 });
  await page.goto(purchaseUrl);
  await expectLines(page, layout, fabricName, ["Mocca", "Sage"]);
  await expect(page.locator(layout.lineRow).nth(1)).toContainText("12.00 yard");
}

/** PO-202611-001's case: a colourless line ordered (and partly paid) before the fabric had active
 * colours; once it has, the owner replaces it with per-colour lines covering at least the DP. */
async function runLegacyLineEdit(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.width}-${Date.now()}`;
  const supplierName = `E2E Pemasok Lama ${marker}`;
  const fabricName = `E2E Marbella Lama ${marker}`;
  await createSupplier(page, supplierName);
  const fabricUrl = await createFabric(page, fabricName, ["Sage"]);
  // No active colour → the purchase line is "Tanpa warna", exactly like data from before S2.
  await page.getByRole("switch", { name: "Aktif" }).click();
  await expect(page.getByRole("switch", { name: "Aktif" })).toHaveAttribute("aria-checked", "false");

  await createPurchase(page, supplierName, [{ type: "Kain", itemName: fabricName, qty: "30", amount: "585.000" }]);
  const purchaseUrl = page.url();
  await expectLines(page, layout, fabricName, ["Tanpa warna"]);

  // DP Rp 300.000.
  await page.getByRole("button", { name: "Catat pembayaran" }).click();
  const dialog = page.getByRole("dialog", { name: "Catat pembayaran" });
  await dialog.getByLabel("Jumlah").fill("300.000");
  await dialog.locator('input[type="file"]').setInputFiles({ name: `dp-${marker}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto() });
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(page.getByRole("status")).toContainText("dicatat", { timeout: 15_000 });

  // The fabric gets its colours afterwards.
  await page.goto(fabricUrl);
  await page.getByRole("switch", { name: "Aktif" }).click();
  await expect(page.getByRole("switch", { name: "Aktif" })).toHaveAttribute("aria-checked", "true");
  await page.locator("#new-fabric-color-name").fill("Mocca");
  await page.getByRole("button", { name: "Tambah warna", exact: true }).click();
  await expect(page.locator('input[value="Mocca"]')).toBeVisible();

  // Edit: the old line shows as "Tanpa warna (data lama)"; add every colour, delete the old line.
  await page.goto(`${purchaseUrl}/edit`);
  await expect(selectedOption(page, "Warna barang 1")).toHaveText("Tanpa warna (data lama)");
  await expect(page.getByText("Baris lama tanpa warna.")).toBeVisible();
  await page.getByLabel("Harga per yard barang 1").fill("19.500");
  await page.getByRole("button", { name: "Tambah semua warna barang 1" }).click();
  await expect(page.getByTestId("purchase-line")).toHaveCount(3);
  await page.getByRole("button", { name: "Hapus barang 1" }).click();
  await expect(selectedOption(page, "Warna barang 1")).toHaveText("Mocca");
  await expect(selectedOption(page, "Warna barang 2")).toHaveText("Sage");

  // Below what was already paid: refused by the server.
  await page.getByLabel("Jumlah barang 1").fill("5");
  await page.getByLabel("Jumlah barang 2").fill("5");
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.locator('form [role="alert"]')).toContainText("tidak boleh lebih kecil dari yang sudah dibayar (Rp 300.000)", { timeout: 15_000 });

  // 30 yard again, split per colour: saved.
  await page.getByLabel("Jumlah barang 1").fill("20");
  await page.getByLabel("Jumlah barang 2").fill("10");
  await expect(page.getByTestId("purchase-form-totals")).toContainText(`${fabricName}30.00 yard · Rp 585.000`);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/purchases$/, { timeout: 15_000 });
  await page.goto(purchaseUrl);
  await expectLines(page, layout, fabricName, ["Mocca", "Sage"]);
}

test.describe("Pembelian kain per warna", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`create a PO with every colour via "Tambah semua warna", then remove one, at ${layout.label}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await loginAs(page, E2E_FABRIC_COLOUR_EMAIL);
      await runCreateWithColours(page, layout);
    });

    test(`replace a paid colourless line with per-colour lines, at ${layout.label}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await loginAs(page, E2E_FABRIC_COLOUR_EMAIL);
      await runLegacyLineEdit(page, layout);
    });
  }
});
