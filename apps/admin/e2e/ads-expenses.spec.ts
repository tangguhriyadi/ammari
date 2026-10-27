import { expect, test, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { E2E_EXPENSES_CS_EMAIL, E2E_EXPENSES_EMAIL } from "./global-setup";

// docs/plans/growth.md session S2: "Iklan & Biaya", Pengeluaran. The whole flow runs at 390px AND
// 1280px (CLAUDE.md's rule): the list renders a CardList on phones and a TableContainer on
// tablet/desktop, so each pass asserts its own layout's rows and that the other layout's are
// hidden. Proofs go to the in-memory private storage (PRIVATE_STORAGE_DRIVER=memory); nothing
// leaves the machine. Every pass searches by its own marker, so rows from other runs never match.

interface Layout {
  label: string;
  row: string;
  hiddenRow: string;
  viewport: { width: number; height: number };
}

const MOBILE: Layout = { label: "mobile", row: '[data-testid="expense-card"]', hiddenRow: '[data-testid="expense-row"]', viewport: { width: 390, height: 844 } };
const DESKTOP: Layout = { label: "desktop", row: '[data-testid="expense-row"]', hiddenRow: '[data-testid="expense-card"]', viewport: { width: 1280, height: 800 } };

function jakartaDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + offsetDays * 86_400_000),
  );
}

async function receiptPhoto(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 190, g: 200 - (seed % 50), b: 180 } } })
    .jpeg()
    .toBuffer();
}

async function openRecordDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Catat biaya" }).click();
  const dialog = page.getByRole("dialog", { name: "Catat biaya" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function search(page: Page, marker: string, extra = ""): Promise<void> {
  await page.goto(`/ads-expenses?q=${encodeURIComponent(marker)}${extra}`);
  await expect(page.getByRole("heading", { name: "Iklan & Biaya" })).toBeVisible();
}

async function runExpenseFlow(page: Page, layout: Layout): Promise<void> {
  const marker = `E2E-${layout.label}-${Date.now()}`;
  await search(page, marker);
  await expect(page.getByText("Belum ada biaya", { exact: true })).toBeVisible();

  // 1. Category and proof are required.
  let dialog = await openRecordDialog(page);
  await expect(dialog.getByLabel("Tanggal bayar")).toHaveValue(jakartaDate(0));
  await dialog.getByRole("button", { name: "Simpan biaya" }).click();
  await expect(dialog.getByText("Pilih kategori.")).toBeVisible();
  await expect(dialog.getByText("Bukti bayar wajib diunggah.")).toBeVisible();

  // 2. Iklan Shopee is always for the Shopee channel; the hint for affiliate is not shown here.
  await dialog.getByLabel("Kategori").selectOption("ads_shopee");
  await expect(dialog.getByLabel("Kanal")).toBeDisabled();
  await expect(dialog.getByLabel("Kanal")).toHaveValue("shopee");
  await expect(dialog.getByLabel("Metode")).toHaveValue("platform_balance");
  await dialog.getByLabel("Jumlah").fill("750.000");
  await dialog.getByLabel("Kampanye").fill(marker);
  await dialog.locator('input[type="file"]').setInputFiles({ name: `iklan-${marker}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto(1) });
  await expect(dialog.getByTestId("private-file-selected")).toContainText(`iklan-${marker}.jpg`);
  await dialog.getByRole("button", { name: "Simpan biaya" }).click();
  await expect(page.getByRole("status")).toContainText(/Biaya BYA-\d{6}-\d{3} dicatat\./, { timeout: 15_000 });
  await expect(dialog).toBeHidden();

  const row = page.locator(layout.row).filter({ hasText: marker });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Iklan Shopee");
  await expect(row).toContainText("Shopee");
  await expect(row).toContainText("Rp 750.000");
  await expect(row).toContainText("Saldo platform");
  await expect(page.locator(layout.hiddenRow).filter({ hasText: marker }).first()).toBeHidden();
  await expect(page.getByTestId("expense-total")).toContainText("Rp 750.000");
  const expenseNo = (await row.textContent())?.match(/BYA-\d{6}-\d{3}/)?.[0];
  expect(expenseNo).toBeTruthy();

  // 3. Lainnya needs a note; with one it saves, as an operating cost without a channel.
  dialog = await openRecordDialog(page);
  await dialog.getByLabel("Kategori").selectOption("other");
  await expect(dialog.getByLabel("Kanal")).toHaveCount(0);
  await dialog.getByLabel("Jumlah").fill("120.000");
  await dialog.getByLabel("Metode").selectOption("cash");
  await dialog.locator('input[type="file"]').setInputFiles({ name: `servis-${marker}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto(2) });
  await dialog.getByRole("button", { name: "Simpan biaya" }).click();
  await expect(dialog.getByText("Untuk kategori Lainnya, tulis di catatan biaya apa ini.")).toBeVisible();
  await dialog.getByLabel("Catatan").fill(`Servis mesin jahit ${marker}`);
  await dialog.getByRole("button", { name: "Simpan biaya" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(layout.row).filter({ hasText: marker })).toHaveCount(2);
  await expect(page.getByTestId("expense-total")).toContainText("Rp 870.000");

  // 4. The group tabs: "Iklan" shows the ad only.
  await page.getByRole("navigation", { name: "Filter jenis biaya" }).getByRole("link", { name: "Iklan", exact: true }).click();
  await expect(page).toHaveURL(/group=marketing/);
  await expect(page.locator(layout.row).filter({ hasText: marker })).toHaveCount(1);
  await expect(page.getByTestId("expense-total")).toContainText("Rp 750.000");

  // 5. The proof opens through the permission-checked route only.
  await search(page, marker);
  const adRow = page.locator(layout.row).filter({ hasText: expenseNo! });
  await adRow.getByRole("button", { name: /Lihat bukti/ }).click();
  const viewer = page.getByRole("dialog", { name: `Bukti ${expenseNo}` });
  const image = viewer.getByRole("img", { name: `Bukti ${expenseNo}` });
  await expect(image).toBeVisible();
  const proofSrc = await image.getAttribute("src");
  expect(proofSrc).toMatch(/^\/api\/private-files\/[0-9a-f-]{36}$/);
  const proofResponse = await page.request.get(proofSrc!);
  expect(proofResponse.status()).toBe(200);
  expect(proofResponse.headers()["content-type"]).toBe("image/jpeg");
  expect(proofResponse.headers()["content-disposition"]).toBe(`inline; filename="${expenseNo}.jpg"`);
  await viewer.getByRole("button", { name: "Tutup" }).click();

  // 6. Void with a reason: gone from the default list and the total, struck under "Tampilkan yang dibatalkan".
  await adRow.getByRole("button", { name: `Batalkan biaya ${expenseNo}` }).click();
  const voidDialog = page.getByRole("dialog", { name: `Batalkan biaya ${expenseNo}?` });
  await voidDialog.getByRole("button", { name: "Batalkan biaya" }).click();
  await expect(voidDialog.getByText("Alasan pembatalan wajib diisi.")).toBeVisible();
  await voidDialog.getByLabel("Alasan pembatalan").fill("Salah nominal");
  await voidDialog.getByRole("button", { name: "Batalkan biaya" }).click();
  await expect(page.getByRole("status")).toContainText(`Biaya ${expenseNo} dibatalkan`, { timeout: 15_000 });
  await expect(page.locator(layout.row).filter({ hasText: expenseNo! })).toHaveCount(0);
  await expect(page.getByTestId("expense-total")).toContainText("Rp 120.000");

  await search(page, marker, "&voided=1");
  const voidedRow = page.locator(layout.row).filter({ hasText: expenseNo! });
  await expect(voidedRow).toBeVisible();
  await expect(voidedRow).toContainText("Dibatalkan");
  await expect(voidedRow).toContainText("Salah nominal");
  await expect(voidedRow.getByRole("button", { name: `Batalkan biaya ${expenseNo}` })).toHaveCount(0);
  await expect(page.getByTestId("expense-total")).toContainText("Rp 120.000");

  // 7. CS (no ads_expenses.manage, no finance.view_profit): the page and the proof are refused.
  await page.context().clearCookies();
  await loginAs(page, E2E_EXPENSES_CS_EMAIL);
  await page.goto("/ads-expenses");
  await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  expect((await page.request.get(proofSrc!)).status()).toBe(403);
}

test.describe("Iklan & Biaya: pengeluaran", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`record with proof, Lainnya note, group filter, proof viewer, void, CS refused at ${layout.label === "mobile" ? "390px" : "1280px"}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(layout.viewport);
      await loginAs(page, E2E_EXPENSES_EMAIL);
      await runExpenseFlow(page, layout);
    });
  }
});
