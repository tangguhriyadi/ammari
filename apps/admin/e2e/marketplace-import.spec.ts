import { expect, test, type Locator, type Page } from "@playwright/test";
import { csvBytes, shopeeRows, SHOPEE_HEADER, xlsxBytes, type FixtureOrder } from "../test/marketplace-fixtures";
import { loginAs } from "./helpers/login";
import { E2E_IMPORT_EMAIL, E2E_IMPORT_NO_FINANCE_EMAIL, E2E_IMPORT_SKU_L, E2E_IMPORT_SKU_M } from "./global-setup";

// /import (docs/plans/marketplace-import.md §11, §14 tests 47 to 50), at 390px (cards) and the
// project's default 1280px (tables), CLAUDE.md. Fixtures are synthetic, built in memory from the
// same builder the unit tests use, and handed to the file input as a buffer (nothing on disk).
//
// SHOPEE_MAPPING_VERIFIED is true since session 7c (guarded unlock, plan §19.9): every test here
// runs exactly as production does, without the e2e-only unlock cookie.
//
// Every uploaded order is dated January 2026 and Selesai, so Ringkasan's periods, the oldest Siap
// Kirim order and Packing, which other specs assert, never move. The one Perlu Dikirim order (the 7c
// test) is cancelled again by a Batal export inside the same test, which returns its stock.

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
    // Ship and complete times (plan §19.3): stored on Simpan, shown on the order page.
    // Two rows, no discount (a discounted multi-row order is held since 7c).
    { orderNo: `${prefix}${tag}002`, status: "Selesai", orderedAt: "2026-01-15 11:30", shippedAt: "2026-01-16 08:00", completedAt: "2026-01-18 10:00", lines: [{ sku: E2E_IMPORT_SKU_M, qty: 1, lineTotal: 249_000 }, { sku: E2E_IMPORT_SKU_L, qty: 1, lineTotal: 249_000 }] },
    { orderNo: `${prefix}${tag}003`, status: "Selesai", orderedAt: "2026-01-16 09:00", lines: [{ sku: UNKNOWN_SKU, qty: 1, lineTotal: 249_000, productName: "Gamis Uji Impor", variationName: "Sage,L" }] },
    // As the real unpaid export writes it: "-" in Waktu Pembayaran Dilakukan (plan §19.10).
    { orderNo: `${prefix}${tag}004`, status: "Belum Bayar", orderedAt: "2026-01-16 09:30", paymentTime: "-", lines: [{ sku: E2E_IMPORT_SKU_M, qty: 1, lineTotal: 249_000 }] },
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
  test(`Impor: refusals, preview and no money without finance (${layout.label})`, async ({ page }) => {
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

    // The real preview (test 47): counts, Perlu dicek in this layout; no lock notice since 7c, so
    // Simpan is enabled (not clicked here: the save path is the next tests).
    await upload(page, "Shopee", xlsxFile("pesanan.xlsx", fixtureOrders(layout.prefix, "L")));
    await expectCounts(page, { create: 2, update: 0, unchanged: 0, review: 1, skip: 1 });
    const review = page.getByTestId("section-review");
    const reviewRow = await visibleRow(review, layout, `${layout.prefix}L003`);
    await expect(reviewRow).toContainText(`SKU tidak dikenal: ${UNKNOWN_SKU}`);
    await expect(page.getByTestId("unknown-skus")).toContainText("Gamis Uji Impor");
    await expect(page.getByTestId("import-save-blockers")).toHaveCount(0);
    await expect(page.getByTestId("import-unpaid-skipped")).toContainText("1 pesanan belum dibayar (dilewati)");
    await expect(page.getByRole("button", { name: "Simpan 2 pesanan" })).toBeEnabled();
    // No finance.view_profit: no rupiah anywhere in the preview.
    await expect(page.getByTestId("import-new-totals")).toHaveText("Pesanan baru: 3 pcs");
    await expect(page.getByTestId("import-preview")).not.toContainText("Rp");

    // A changed header row and a blank variant SKU (plan §19.2, §19.6): previewed, held, never saved.
    // K002: a ship time on an order Shopee still has waiting to ship is counted, never stored (§19.3).
    const changed = shopeeRows([
      { orderNo: `${layout.prefix}K001`, status: "Selesai", orderedAt: "2026-01-17 10:00", lines: [{ sku: null, qty: 1, lineTotal: 249_000, parentSku: E2E_IMPORT_SKU_M }] },
      { orderNo: `${layout.prefix}K002`, status: "Perlu Dikirim", orderedAt: "2026-01-17 10:00", shippedAt: "2026-01-17 15:00", lines: [{ sku: E2E_IMPORT_SKU_M, qty: 1, lineTotal: 249_000 }] },
    ]);
    changed[0]![SHOPEE_HEADER.indexOf("Total Berat")] = "Total Berat (kg)";
    await upload(page, "Shopee", { name: "berubah.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(xlsxBytes(changed)) });
    await expect(page.getByTestId("import-save-blockers")).toContainText('Format export Shopee berubah sejak 27 Nov 2026: kolom "Total Berat" tidak ada, kolom baru "Total Berat (kg)"');
    await expect(page.getByTestId("import-blank-sku-count")).toContainText("1 pesanan tertahan karena SKU kosong di Shopee");
    await expect(page.getByTestId("import-arranged-not-shipped")).toContainText("1 pesanan sudah diatur pengirimannya, belum dikirim");
    await expect(page.getByTestId("import-marketplace-dates")).toHaveCount(0);
    const held = await visibleRow(page.getByTestId("section-review"), layout, `${layout.prefix}K001`);
    await expect(held).toContainText("SKU kosong di Shopee (Nomor Referensi SKU)");
    await expect(held.getByRole("link", { name: "Buka Daftar SKU" })).toHaveAttribute("href", "/stock/sku-list");
    // No manual match for a blank SKU.
    await expect(page.getByTestId("unknown-skus")).toHaveCount(0);
  });

  test(`Impor: match, Simpan, history, orders, then the same file again (${layout.label})`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await loginAs(page, E2E_IMPORT_EMAIL);
    await page.goto("/import");

    const file = xlsxFile(`pesanan-${layout.label}.xlsx`, fixtureOrders(layout.prefix, "S"));
    await upload(page, "Shopee", file);
    await expect(page.getByTestId("import-file-name")).toContainText(`pesanan-${layout.label}.xlsx`);
    await expect(page.getByTestId("import-file-summary")).toContainText("5 baris, 4 pesanan");
    await expectCounts(page, { create: 2, update: 0, unchanged: 0, review: 1, skip: 1 });
    await expect(page.getByTestId("import-new-totals")).toContainText("omzet Rp");
    await expect(page.getByTestId("import-marketplace-dates")).toContainText("1 pesanan dapat waktu kirim, 1 pesanan dapat waktu selesai");
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
    await expect(page.getByTestId("marketplace-section")).toContainText("Diserahkan ke kurir (marketplace)");
    await expect(page.getByTestId("marketplace-section")).toContainText("16 Jan 2026, 08.00");
    await expect(page.getByTestId("marketplace-section")).toContainText("18 Jan 2026, 10.00");
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

  test(`Impor 7c: a clean Perlu Dikirim file saves, stock leaves; a held order stays in Perlu dicek (${layout.label})`, async ({ page }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await loginAs(page, E2E_IMPORT_EMAIL);
    const stockOfM = async () => {
      await page.goto(`/stock/${E2E_IMPORT_SKU_M}`);
      const text = await page.getByText(/^\d[\d.]* pcs$/).first().textContent();
      return Number((text ?? "").replace(/\D/g, ""));
    };
    const before = await stockOfM();

    const ready = `${layout.prefix}P001`;
    const held = `${layout.prefix}H001`;
    const unpaid = `${layout.prefix}U001`;
    const orders: FixtureOrder[] = [
      { orderNo: ready, status: "Perlu Dikirim", orderedAt: "2026-01-19 10:00", lines: [{ sku: E2E_IMPORT_SKU_M, qty: 1, lineTotal: 249_000 }] },
      // Two rows with a seller voucher: held (O1-a/O1-b unverified).
      { orderNo: held, status: "Perlu Dikirim", orderedAt: "2026-01-19 10:05", sellerVoucher: 10_000, lines: [{ sku: E2E_IMPORT_SKU_M, qty: 1, lineTotal: 249_000 }, { sku: E2E_IMPORT_SKU_L, qty: 1, lineTotal: 249_000 }] },
      { orderNo: unpaid, status: "Belum Bayar", orderedAt: "2026-01-19 10:10", paymentTime: "-", lines: [{ sku: E2E_IMPORT_SKU_M, qty: 1, lineTotal: 249_000 }] },
    ];
    await page.goto("/import");
    await upload(page, "Shopee", xlsxFile(`perlu-dikirim-${layout.label}.xlsx`, orders));
    await expectCounts(page, { create: 1, update: 0, unchanged: 0, review: 1, skip: 1 });
    await expect(page.getByTestId("import-save-blockers")).toHaveCount(0);
    await expect(page.getByTestId("import-unpaid-skipped")).toContainText("1 pesanan belum dibayar (dilewati)");
    const heldRow = await visibleRow(page.getByTestId("section-review"), layout, held);
    await expect(heldRow).toContainText("Pesanan multi-barang dengan diskon belum terverifikasi");

    await page.getByRole("button", { name: "Simpan 1 pesanan" }).click();
    await expect(page.getByTestId("import-notice")).toContainText("1 pesanan disimpan (1 baru, 0 diperbarui).");
    const historyRow = await visibleRow(page.getByRole("region", { name: "Riwayat impor" }), layout, `perlu-dikirim-${layout.label}.xlsx`);
    await expect(historyRow).toContainText("1 baru, 0 diperbarui, 1 perlu dicek");

    // In /orders as Siap Kirim; the held and the unpaid order are not.
    await page.goto(`/orders?q=${ready}`);
    const orderRow = page.locator(layout.rowTag).filter({ hasText: "Shopee" });
    await expect(orderRow).toBeVisible();
    await expect(orderRow).toContainText("Siap Kirim");
    for (const absent of [held, unpaid]) {
      await page.goto(`/orders?q=${absent}`);
      await expect(page.locator(layout.rowTag).filter({ hasText: "Shopee" })).toHaveCount(0);
    }
    expect(await stockOfM()).toBe(before - 1);

    // Clean-up through the real flow: Shopee reports it Batal, the order is cancelled, stock returns.
    await page.goto("/import");
    await upload(page, "Shopee", xlsxFile(`batal-${layout.label}.xlsx`, [{ ...orders[0]!, status: "Batal" }]));
    await expectCounts(page, { create: 0, update: 1, unchanged: 0, review: 0, skip: 0 });
    await page.getByRole("button", { name: "Simpan 1 pesanan" }).click();
    await expect(page.getByTestId("import-notice")).toContainText("1 pesanan disimpan (0 baru, 1 diperbarui).");
    expect(await stockOfM()).toBe(before);
  });
}
