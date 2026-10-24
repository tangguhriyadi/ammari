import { expect, test, type Locator, type Page } from "@playwright/test";
import { csvBytes, shopeeRows, SHOPEE_HEADER, xlsxBytes, type FixtureOrder } from "../test/marketplace-fixtures";
import { loginAs } from "./helpers/login";
import { E2E_IMPORT_EMAIL, E2E_IMPORT_NO_FINANCE_EMAIL, E2E_IMPORT_SKU_L, E2E_IMPORT_SKU_M } from "./global-setup";

// /import (docs/plans/marketplace-import.md §11, §14 tests 47 to 50), at 390px (cards) and the
// project's default 1280px (tables), CLAUDE.md. Fixtures are synthetic, built in memory from the
// same builder the unit tests use, and handed to the file input as a buffer (nothing on disk).
//
// SHOPEE_MAPPING_VERIFIED stays false in code. The save-path test unlocks it for its own browser
// context only, through the e2e-only cookie (lib/marketplace-import/e2e-unlock.ts, honoured only
// with E2E_TEST_LOGIN in a non-production build). The lock test runs without it and asserts the
// notice and the disabled Simpan.
//
// Every uploaded order is dated January 2026 and Selesai, so Ringkasan's periods, the oldest Siap
// Kirim order and Packing, which other specs assert, never move.

const UNLOCK_COOKIE = "e2e_marketplace_mapping_verified";

interface Layout {
  rowTag: "li" | "tr";
  hiddenRowTag: "li" | "tr";
  label: string;
  width: number;
  height: number;
  /** Order numbers differ per layout: both runs share one database. */
  prefix: string;
}

const MOBILE: Layout = { rowTag: "li", hiddenRowTag: "tr", label: "mobile", width: 390, height: 844, prefix: "E2EM" };
const DESKTOP: Layout = { rowTag: "tr", hiddenRowTag: "li", label: "desktop", width: 1280, height: 800, prefix: "E2ED" };

/** An unknown SKU that only "Cocokkan ke varian" can place. */
const UNKNOWN_SKU = "E2E-IMPOR-LL-SALAH";

function fixtureOrders(prefix: string, tag: string): FixtureOrder[] {
  return [
    { orderNo: `${prefix}${tag}001`, status: "Selesai", orderedAt: "2026-01-15 10:00", lines: [{ sku: E2E_IMPORT_SKU_M, qty: 1, lineTotal: 249_000 }] },
    { orderNo: `${prefix}${tag}002`, status: "Selesai", orderedAt: "2026-01-15 11:30", sellerVoucher: 10_000, lines: [{ sku: E2E_IMPORT_SKU_M, qty: 1, lineTotal: 249_000 }, { sku: E2E_IMPORT_SKU_L, qty: 1, lineTotal: 249_000 }] },
    { orderNo: `${prefix}${tag}003`, status: "Selesai", orderedAt: "2026-01-16 09:00", lines: [{ sku: UNKNOWN_SKU, qty: 1, lineTotal: 249_000, productName: "Gamis Uji Impor", variationName: "Sage,L" }] },
    { orderNo: `${prefix}${tag}004`, status: "Belum Bayar", orderedAt: "2026-01-16 09:30", lines: [{ sku: E2E_IMPORT_SKU_M, qty: 1, lineTotal: 249_000 }] },
  ];
}

function xlsxFile(name: string, orders: readonly FixtureOrder[]) {
  return { name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(xlsxBytes(shopeeRows(orders))) };
}

async function upload(page: Page, channel: "Shopee" | "TikTok Shop", file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.getByRole("radio", { name: channel }).check();
  await page.getByLabel(/File export pesanan/).setInputFiles(file);
  await page.getByRole("button", { name: "Periksa file" }).click();
}

/** A row of `scope` in the layout's own list, and the other layout's copy hidden. */
async function visibleRow(scope: Locator, layout: Layout, text: string): Promise<Locator> {
  const row = scope.locator(layout.rowTag).filter({ hasText: text });
  await expect(row).toBeVisible();
  await expect(scope.locator(layout.hiddenRowTag).filter({ hasText: text }).first()).toBeHidden();
  return row;
}

async function expectCounts(page: Page, counts: { create: number; update: number; unchanged: number; review: number; skip: number }) {
  for (const [key, value] of Object.entries(counts)) await expect(page.getByTestId(`count-${key}`)).toContainText(String(value));
}

async function matchUnknownSku(page: Page) {
  await page.getByRole("button", { name: "Cocokkan ke varian" }).click();
  const dialog = page.getByRole("dialog", { name: "Cocokkan ke varian" });
  await expect(dialog).toContainText(UNKNOWN_SKU);
  await dialog.getByLabel("Cari varian admin").fill("E2E-IMPOR");
  await dialog.getByRole("button", { name: "Cari" }).click();
  await dialog.getByRole("button", { name: `Pilih ${E2E_IMPORT_SKU_L}` }).click();
  await expect(dialog).toBeHidden();
}

for (const layout of [MOBILE, DESKTOP]) {
  test(`Impor: lock notice, refusals and no money without finance (${layout.label})`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await loginAs(page, E2E_IMPORT_NO_FINANCE_EMAIL);
    await page.goto("/import");
    await expect(page.getByRole("heading", { name: "Impor pesanan marketplace" })).toBeVisible();

    // TikTok Shop: refused until its export is mapped (test 50).
    await upload(page, "TikTok Shop", xlsxFile("tiktok.xlsx", fixtureOrders(layout.prefix, "T")));
    await expect(page.getByTestId("import-error")).toContainText("Format export TikTok Shop belum dikonfirmasi");

    // A file without a required column names it (test 50).
    const index = SHOPEE_HEADER.indexOf("Jumlah");
    const rows = shopeeRows(fixtureOrders(layout.prefix, "T")).map((row) => row.filter((_, column) => column !== index).map((cell) => (typeof cell === "object" && cell !== null ? null : cell)));
    await upload(page, "Shopee", { name: "tanpa-jumlah.csv", mimeType: "text/csv", buffer: Buffer.from(csvBytes(rows as (string | number | null)[][])) });
    await expect(page.getByTestId("import-error")).toContainText("Kolom wajib tidak ditemukan: Jumlah");

    // The real preview, with the lock on: counts, Perlu dicek in this layout, the notice, Simpan disabled (test 47).
    await upload(page, "Shopee", xlsxFile("pesanan.xlsx", fixtureOrders(layout.prefix, "L")));
    await expectCounts(page, { create: 2, update: 0, unchanged: 0, review: 1, skip: 1 });
    const review = page.getByTestId("section-review");
    const reviewRow = await visibleRow(review, layout, `${layout.prefix}L003`);
    await expect(reviewRow).toContainText(`SKU tidak dikenal: ${UNKNOWN_SKU}`);
    await expect(page.getByTestId("unknown-skus")).toContainText("Gamis Uji Impor");
    await expect(page.getByTestId("import-save-blockers")).toContainText("Pemetaan kolom Shopee belum diverifikasi dengan file asli");
    await expect(page.getByRole("button", { name: "Simpan 2 pesanan" })).toBeDisabled();
    // No finance.view_profit: no rupiah anywhere in the preview.
    await expect(page.getByTestId("import-new-totals")).toHaveText("Pesanan baru: 3 pcs");
    await expect(page.getByTestId("import-preview")).not.toContainText("Rp");
  });

  test(`Impor: match, Simpan, history, orders, then the same file again (${layout.label})`, async ({ page, context }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    // Unlocks Shopee Simpan for THIS browser context only (see the header comment).
    await context.addCookies([{ name: UNLOCK_COOKIE, value: "shopee", domain: "localhost", path: "/" }]);
    await loginAs(page, E2E_IMPORT_EMAIL);
    await page.goto("/import");

    const file = xlsxFile(`pesanan-${layout.label}.xlsx`, fixtureOrders(layout.prefix, "S"));
    await upload(page, "Shopee", file);
    await expect(page.getByTestId("import-file-name")).toContainText(`pesanan-${layout.label}.xlsx`);
    await expect(page.getByTestId("import-file-summary")).toContainText("5 baris, 4 pesanan");
    await expectCounts(page, { create: 2, update: 0, unchanged: 0, review: 1, skip: 1 });
    await expect(page.getByTestId("import-new-totals")).toContainText("omzet Rp");
    await visibleRow(page.getByTestId("section-review"), layout, `${layout.prefix}S003`);
    await expect(page.getByTestId("section-skip")).toContainText("Belum Bayar 1");

    // Cocokkan ke varian: the held order becomes new (test 49).
    await matchUnknownSku(page);
    await expectCounts(page, { create: 3, update: 0, unchanged: 0, review: 0, skip: 1 });
    await expect(page.getByTestId("unknown-skus")).toContainText(`${UNKNOWN_SKU} dicocokkan ke ${E2E_IMPORT_SKU_L}`);
    await page.getByTestId("section-create").locator("summary").click();
    const matched = await visibleRow(page.getByTestId("section-create"), layout, `${layout.prefix}S003`);
    await expect(matched).toContainText(`Dicocokkan: ${UNKNOWN_SKU} ke ${E2E_IMPORT_SKU_L}`);
    await expect(matched).toContainText("Selesai");

    // Simpan (test 47).
    await page.getByRole("button", { name: "Simpan 3 pesanan" }).click();
    await expect(page.getByTestId("import-notice")).toContainText("3 pesanan disimpan (3 baru, 0 diperbarui).");
    await expect(page.getByTestId("import-preview")).toBeHidden();

    // The history lists it; its detail links the orders.
    const history = page.getByRole("region", { name: "Riwayat impor" });
    const historyRow = await visibleRow(history, layout, `pesanan-${layout.label}.xlsx`);
    await expect(historyRow).toContainText("3 baru, 0 diperbarui, 0 perlu dicek");
    await historyRow.getByRole("link").first().click();
    await expect(page.getByTestId("import-batch-counts")).toContainText("3 baru");
    const batchOrder = await visibleRow(page.locator("main"), layout, `${layout.prefix}S002`);
    await expect(batchOrder).toContainText("Selesai");

    // The order on /orders, channel Shopee.
    await page.goto(`/orders?q=${layout.prefix}S002`);
    const orderRow = page.locator(layout.rowTag).filter({ hasText: "Shopee" });
    await expect(orderRow).toBeVisible();
    await orderRow.getByRole("link").first().click();
    await expect(page.getByTestId("marketplace-section")).toContainText("Selesai");
    await expect(page.getByTestId("marketplace-section")).toContainText("Biaya platform");

    // The same file again: everything unchanged once the same match is made, Simpan disabled (test 48).
    await page.goto("/import");
    await upload(page, "Shopee", file);
    await expect(page.getByTestId("import-preview")).toContainText("File ini sudah pernah disimpan");
    await expectCounts(page, { create: 0, update: 0, unchanged: 2, review: 1, skip: 1 });
    await matchUnknownSku(page);
    await expectCounts(page, { create: 0, update: 0, unchanged: 3, review: 0, skip: 1 });
    await expect(page.getByRole("button", { name: "Simpan 0 pesanan" })).toBeDisabled();
  });
}
