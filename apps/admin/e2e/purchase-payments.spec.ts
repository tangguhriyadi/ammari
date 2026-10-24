import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { createPurchase, createSupplier } from "./helpers/purchase";
import { E2E_PAYMENTS_NO_FINANCE_EMAIL, E2E_SUPPLIER_PAYMENTS_EMAIL } from "./global-setup";

// docs/plans/purchase-payments.md session S3: supplier payments on a purchase document. The whole
// flow runs at 390px AND 1280px (CLAUDE.md's rule): the payment history and /purchases render two
// independent layouts (CardList for phones, TableContainer for desktop), so each pass asserts its
// own layout's rows and that the other layout's are hidden. Proofs go to the in-memory private
// storage (PRIVATE_STORAGE_DRIVER=memory in playwright.config.ts); nothing leaves the machine.

interface Layout {
  label: string;
  /** This layout's row for the /purchases list and for the payment history. */
  listRow: "li" | "tr";
  hiddenListRow: "li" | "tr";
  paymentRow: string;
  hiddenPaymentRow: string;
}

const MOBILE: Layout = {
  label: "mobile",
  listRow: "li",
  hiddenListRow: "tr",
  paymentRow: '[data-testid="payment-card"]',
  hiddenPaymentRow: '[data-testid="payment-row"]',
};
const DESKTOP: Layout = {
  label: "desktop",
  listRow: "tr",
  hiddenListRow: "li",
  paymentRow: '[data-testid="payment-row"]',
  hiddenPaymentRow: '[data-testid="payment-card"]',
};

function jakartaDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}

async function receiptPhoto(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 200, g: 190 - (seed % 50), b: 180 } } })
    .jpeg()
    .toBuffer();
}

async function receiptPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([300, 400]).drawText("Bukti transfer", { x: 40, y: 340 });
  return Buffer.from(await document.save());
}

// An ISO-BMFF "ftypheic" header: what an iPhone HEIC opened from the Files app looks like.
const HEIC_BYTES = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(16)]);

async function createFabric(page: Page, name: string): Promise<void> {
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(name);
  await page.getByLabel("Nama warna").fill("Hitam");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);
}

async function openRecordDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Catat pembayaran" }).click();
  const dialog = page.getByRole("dialog", { name: "Catat pembayaran" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The dialog's one file input (labelled "Bukti bayar" / "File nota"; the required-marker "*" in
 * the label's text keeps an exact label match from resolving). */
async function pickFile(dialog: Locator, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await dialog.locator('input[type="file"]').setInputFiles(file);
}

async function expectSummary(page: Page, status: string, paid: string, remaining: string): Promise<void> {
  const summary = page.getByTestId("payment-summary");
  await expect(summary.getByTestId("payment-status-badge")).toHaveText(status);
  await expect(summary.getByTestId("payment-paid")).toHaveText(paid);
  await expect(summary.getByTestId("payment-remaining")).toHaveText(remaining);
}

async function expectListRow(page: Page, layout: Layout, supplierName: string, filter: string | null, present: boolean): Promise<void> {
  await page.goto(`/purchases?q=${encodeURIComponent(supplierName)}`);
  if (filter) {
    await page.getByRole("navigation", { name: "Filter status pembayaran" }).getByRole("link", { name: filter, exact: true }).click();
    await expect(page).toHaveURL(/payment=/);
  }
  const row = page.locator(layout.listRow).filter({ hasText: supplierName });
  if (present) {
    await expect(row).toBeVisible();
    await expect(page.locator(layout.hiddenListRow).filter({ hasText: supplierName }).first()).toBeHidden();
  } else {
    await expect(row).toHaveCount(0);
  }
}

async function runPaymentFlow(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.label}-${Date.now()}`;
  const supplierName = `E2E Pemasok Bayar ${marker}`;
  const otherSupplierName = `E2E Pemasok Lain ${marker}`;
  const fabricName = `E2E Katun Bayar ${marker}`;
  await createSupplier(page, supplierName);
  await createSupplier(page, otherSupplierName);
  await createFabric(page, fabricName);
  await createPurchase(page, supplierName, [{ type: "Kain", itemName: fabricName, qty: "10", amount: "1.000.000" }]);
  const purchaseUrl = page.url();

  // 1. A new purchase is "Belum bayar" for its full order total.
  await expectSummary(page, "Belum bayar", "Rp 0", "Rp 1.000.000");
  await expect(page.getByTestId("payment-tagihan")).toHaveText("Rp 1.000.000");
  await expect(page.getByText("Belum ada pembayaran.")).toBeVisible();

  // 2. The proof is required.
  let dialog = await openRecordDialog(page);
  await expect(dialog.getByLabel("Jumlah")).toHaveValue("1.000.000");
  await expect(dialog.getByLabel("Tanggal bayar")).toHaveValue(jakartaDate(0));
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(dialog.getByText("Bukti bayar wajib diunggah.")).toBeVisible();

  // 3. A HEIC photo gets the "convert to JPG" message (A5).
  await pickFile(dialog, { name: "IMG_0001.HEIC", mimeType: "image/heic", buffer: HEIC_BYTES });
  await expect(dialog.getByText("Foto HEIC belum didukung. Ubah ke JPG lalu unggah ulang.")).toBeVisible();

  // 4. A future date is refused.
  await pickFile(dialog, { name: `struk-${marker}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto(1) });
  await expect(dialog.getByTestId("private-file-selected")).toContainText(`struk-${marker}.jpg`);
  await dialog.getByLabel("Tanggal bayar").fill(jakartaDate(1));
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(dialog.getByText("Tanggal bayar tidak boleh di masa depan.")).toBeVisible();

  // 5. An amount above the remaining balance is refused by the server with the exact message.
  await dialog.getByLabel("Tanggal bayar").fill(jakartaDate(0));
  await dialog.getByLabel("Jumlah").fill("1.000.001");
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(dialog.getByText("Jumlah melebihi sisa tagihan (Rp 1.000.000).")).toBeVisible({ timeout: 15_000 });

  // 6. DP: Rp 300.000 cash, with a note.
  await dialog.getByLabel("Jumlah").fill("300.000");
  await dialog.getByLabel("Metode").selectOption({ label: "Tunai" });
  await dialog.getByLabel("Catatan").fill("DP 30%");
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(page.getByRole("status")).toContainText("dicatat", { timeout: 15_000 });
  await expect(dialog).toBeHidden();
  await expectSummary(page, "DP", "Rp 300.000", "Rp 700.000");
  const payments = page.locator(layout.paymentRow);
  await expect(payments).toHaveCount(1);
  await expect(payments.first()).toContainText("Rp 300.000");
  await expect(payments.first()).toContainText("Tunai");
  await expect(payments.first()).toContainText("DP 30%");
  await expect(payments.first()).toContainText("E2E Supplier Payments");
  await expect(page.locator(layout.hiddenPaymentRow).first()).toBeHidden();
  const dpNo = (await payments.first().textContent())?.match(/BYR-\d{6}-\d{3}/)?.[0];
  expect(dpNo).toBeTruthy();

  // The proof opens in the viewer, through the permission-checked route.
  await payments.first().getByRole("button", { name: "Lihat bukti" }).click();
  const viewer = page.getByRole("dialog", { name: `Bukti ${dpNo}` });
  const proofSrc = await viewer.locator("img").getAttribute("src");
  expect(proofSrc).toMatch(/^\/api\/private-files\/[0-9a-f-]{36}$/);
  const proofResponse = await page.request.get(proofSrc!);
  expect(proofResponse.status()).toBe(200);
  expect(proofResponse.headers()["content-type"]).toBe("image/jpeg");
  await viewer.getByRole("button", { name: "Tutup" }).click();

  // 7. The list shows DP, and the payment filter follows it.
  await expectListRow(page, layout, supplierName, null, true);
  await expect(page.locator(layout.listRow).filter({ hasText: supplierName })).toContainText("DP");
  await expectListRow(page, layout, supplierName, "DP", true);
  await expectListRow(page, layout, supplierName, "Lunas", false);
  await expectListRow(page, layout, supplierName, "Belum bayar", false);

  // 8. Pelunasan with a PDF proof: Lunas, and "Catat pembayaran" is gone.
  await page.goto(purchaseUrl);
  dialog = await openRecordDialog(page);
  await expect(dialog.getByLabel("Jumlah")).toHaveValue("700.000");
  await pickFile(dialog, { name: "transfer.pdf", mimeType: "application/pdf", buffer: await receiptPdf() });
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(page.getByRole("status")).toContainText("Pesanan lunas", { timeout: 15_000 });
  await expectSummary(page, "Lunas", "Rp 1.000.000", "Rp 0");
  await expect(page.getByRole("button", { name: "Catat pembayaran" })).toHaveCount(0);
  await expect(payments).toHaveCount(2);
  await expect(payments.nth(1).getByRole("link", { name: /Lihat bukti/ })).toHaveAttribute("target", "_blank");
  await expectListRow(page, layout, supplierName, "Lunas", true);

  // 9. Void the pelunasan with a reason: struck "Dibatalkan" row, status back to DP.
  await page.goto(purchaseUrl);
  const pelunasanNo = (await payments.nth(1).textContent())?.match(/BYR-\d{6}-\d{3}/)?.[0];
  await payments.nth(1).getByRole("button", { name: `Batalkan pembayaran ${pelunasanNo}` }).click();
  const voidDialog = page.getByRole("dialog", { name: `Batalkan pembayaran ${pelunasanNo}?` });
  await voidDialog.getByRole("button", { name: "Batalkan pembayaran" }).click();
  await expect(voidDialog.getByText("Alasan pembatalan wajib diisi.")).toBeVisible();
  await voidDialog.getByLabel("Alasan pembatalan").fill("Salah nominal");
  await voidDialog.getByRole("button", { name: "Batalkan pembayaran" }).click();
  await expect(page.getByRole("status")).toContainText(`Pembayaran ${pelunasanNo} dibatalkan`, { timeout: 15_000 });
  await expectSummary(page, "DP", "Rp 300.000", "Rp 700.000");
  await expect(payments.nth(1)).toContainText("Dibatalkan");
  await expect(payments.nth(1)).toContainText("Salah nominal");
  await expect(payments.nth(1).getByRole("button", { name: /Batalkan pembayaran/ })).toHaveCount(0);

  // 10. The supplier can't be changed once a payment exists.
  await page.goto(`${purchaseUrl}/edit`);
  await page.locator("#purchase-supplier").selectOption({ label: otherSupplierName });
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByText("Pemasok tidak bisa diganti karena sudah ada pembayaran.")).toBeVisible({ timeout: 15_000 });

  // 11. The supplier's nota, optional, attached and listed.
  await page.goto(purchaseUrl);
  await page.getByRole("button", { name: "Lampirkan nota" }).click();
  const notaDialog = page.getByRole("dialog", { name: "Lampirkan nota pemasok" });
  await pickFile(notaDialog, { name: `nota-${marker}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto(7) });
  await notaDialog.getByRole("button", { name: "Simpan nota" }).click();
  await expect(page.getByRole("status")).toContainText("Nota dilampirkan", { timeout: 15_000 });
  await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  await expect(page.getByTestId("invoice-row")).toContainText(`nota-${marker}.jpg`);

  // 12. Staff without finance.view_profit: the badge only, never an amount, a proof, or a button.
  await page.context().clearCookies();
  await loginAs(page, E2E_PAYMENTS_NO_FINANCE_EMAIL);
  await page.goto(purchaseUrl);
  await expect(page.getByTestId("payment-status-badge")).toHaveText("DP");
  await expect(page.getByTestId("payment-summary")).toHaveCount(0);
  await expect(page.getByText("Riwayat pembayaran")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Catat pembayaran" })).toHaveCount(0);
  await expect(page.getByText("Nota pemasok")).toHaveCount(0);
  await expect(page.getByText("Rp 300.000")).toHaveCount(0);
  expect((await page.request.get(proofSrc!)).status()).toBe(403);

  await page.goto(`/purchases?q=${encodeURIComponent(supplierName)}`);
  const row = page.locator(layout.listRow).filter({ hasText: supplierName });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("payment-status-badge")).toHaveText("DP");
  await expect(row).not.toContainText("Rp");
  await expect(page.getByRole("columnheader", { name: "Sisa" })).toHaveCount(0);
  await expectListRow(page, layout, supplierName, "DP", true);
}

test.describe("Pembelian: pembayaran ke pemasok", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`DP then pelunasan, refusals, void, supplier lock, nota, no-finance view at ${layout.label === "mobile" ? "390px" : "1280px"}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(layout === MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await loginAs(page, E2E_SUPPLIER_PAYMENTS_EMAIL);
      await runPaymentFlow(page, layout);
    });
  }
});
