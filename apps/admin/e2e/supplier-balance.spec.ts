import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { createPurchase, createSupplier } from "./helpers/purchase";
import { E2E_PAYMENTS_NO_FINANCE_EMAIL, E2E_SUPPLIER_PAYMENTS_EMAIL } from "./global-setup";

// docs/plans/purchase-payments.md session S5: "Total utang" per supplier on /suppliers and the
// breakdown on /suppliers/[id]. Runs at 390px AND 1280px (CLAUDE.md's rule): both pages render a
// CardList for phones and a TableContainer for desktop, so each pass asserts its own layout's
// rows and that the other layout's are hidden. The batch half of the balance (A3) is covered by
// supplier-balance.test.ts; this spec drives the purchase half through the real UI.

interface Layout {
  label: string;
  listRow: "li" | "tr";
  hiddenListRow: "li" | "tr";
  payableRow: string;
  hiddenPayableRow: string;
}

const MOBILE: Layout = {
  label: "mobile",
  listRow: "li",
  hiddenListRow: "tr",
  payableRow: '[data-testid="payable-card"]',
  hiddenPayableRow: '[data-testid="payable-row"]',
};
const DESKTOP: Layout = {
  label: "desktop",
  listRow: "tr",
  hiddenListRow: "li",
  payableRow: '[data-testid="payable-row"]',
  hiddenPayableRow: '[data-testid="payable-card"]',
};

async function receiptPhoto(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 190, g: 180 - (seed % 50), b: 170 } } })
    .jpeg()
    .toBuffer();
}

async function createFabric(page: Page, name: string): Promise<void> {
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(name);
  await page.getByLabel("Nama warna").fill("Hitam");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);
}

/** On a purchase detail page: records one payment of `amount` with a photo proof. */
async function recordPayment(page: Page, amount: string, seed: number): Promise<void> {
  await page.getByRole("button", { name: "Catat pembayaran" }).click();
  const dialog = page.getByRole("dialog", { name: "Catat pembayaran" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Jumlah").fill(amount);
  await dialog.locator('input[type="file"]').setInputFiles({ name: `bukti-${seed}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto(seed) });
  await expect(dialog.getByTestId("private-file-selected")).toContainText(`bukti-${seed}.jpg`);
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(page.getByRole("status")).toContainText("dicatat", { timeout: 15_000 });
  await expect(dialog).toBeHidden();
}

async function purchaseNo(page: Page): Promise<string> {
  return (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
}

async function openSupplierList(page: Page, supplierName: string, owedOnly: boolean): Promise<void> {
  await page.goto(`/suppliers?q=${encodeURIComponent(supplierName)}`);
  if (owedOnly) {
    await page.getByRole("navigation", { name: "Filter utang supplier" }).getByRole("link", { name: "Ada utang", exact: true }).click();
    await expect(page).toHaveURL(/balance=owed/);
    // The search survives the tab switch.
    await expect(page).toHaveURL(/q=/);
  }
}

async function runFlow(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.label}-${Date.now()}`;
  const supplierName = `E2E Pemasok Utang ${marker}`;
  const settledName = `E2E Pemasok Lunas ${marker}`;
  const fabricName = `E2E Katun Utang ${marker}`;
  await createSupplier(page, supplierName);
  await createSupplier(page, settledName);
  await createFabric(page, fabricName);
  const line = (amount: string) => [{ type: "Kain" as const, itemName: fabricName, qty: "10", amount }];

  // Unpaid Rp 1.000.000.
  await createPurchase(page, supplierName, line("1.000.000"));
  const unpaidNo = await purchaseNo(page);
  // DP Rp 200.000 of Rp 500.000 -> Rp 300.000 left.
  await createPurchase(page, supplierName, line("500.000"));
  const dpNo = await purchaseNo(page);
  await recordPayment(page, "200.000", 1);
  // DP Rp 100.000 then cancelled (nothing arrived): "Lebih bayar Rp 100.000", owes nothing (A4).
  await createPurchase(page, supplierName, line("250.000"));
  const cancelledNo = await purchaseNo(page);
  await recordPayment(page, "100.000", 2);
  await page.getByRole("button", { name: "Tutup pesanan" }).click();
  const closeDialog = page.getByRole("dialog");
  await expect(closeDialog.getByTestId("close-overpaid-warning")).toBeVisible();
  await closeDialog.getByLabel("Alasan").fill("Supplier batal kirim");
  await closeDialog.getByRole("button", { name: "Tutup pesanan" }).click();
  await expect(page.getByRole("status")).toContainText("Pesanan dibatalkan", { timeout: 15_000 });
  // The other supplier is paid in full.
  await createPurchase(page, settledName, line("300.000"));
  await recordPayment(page, "300.000", 3);

  // 1. /suppliers: "Total utang" Rp 1.300.000 and "Lebih bayar Rp 100.000" in this layout's row.
  await openSupplierList(page, supplierName, false);
  const row = page.locator(layout.listRow).filter({ hasText: supplierName });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("supplier-outstanding")).toHaveText("Rp 1.300.000");
  await expect(row.getByTestId("supplier-overpaid")).toHaveText("Lebih bayar Rp 100.000");
  await expect(page.locator(layout.hiddenListRow).filter({ hasText: supplierName }).first()).toBeHidden();
  if (layout === DESKTOP) await expect(page.getByRole("columnheader", { name: "Total utang" })).toBeVisible();

  // 2. "Ada utang" keeps the supplier who is owed and drops the settled one.
  await openSupplierList(page, supplierName, true);
  await expect(page.locator(layout.listRow).filter({ hasText: supplierName })).toBeVisible();
  await openSupplierList(page, settledName, false);
  await expect(page.locator(layout.listRow).filter({ hasText: settledName }).getByTestId("supplier-outstanding")).toHaveText("Rp 0");
  await openSupplierList(page, settledName, true);
  await expect(page.locator(layout.listRow).filter({ hasText: settledName })).toHaveCount(0);
  await expect(page.getByText("Tidak ada utang")).toBeVisible();

  // 3. Detail: the breakdown, newest first, the settled purchase never listed, each row a link.
  await openSupplierList(page, supplierName, false);
  await page.locator(layout.listRow).filter({ hasText: supplierName }).getByRole("link", { name: supplierName }).first().click();
  await expect(page).toHaveURL(/\/suppliers\/[0-9a-f-]+$/);
  const supplierUrl = page.url();
  const summary = page.getByTestId("supplier-payables-summary");
  await expect(summary.getByTestId("supplier-outstanding")).toHaveText("Rp 1.300.000");
  await expect(summary.getByTestId("supplier-overpaid")).toHaveText("Lebih bayar Rp 100.000");
  const payables = page.locator(layout.payableRow);
  await expect(payables).toHaveCount(3);
  await expect(payables.nth(0)).toContainText(cancelledNo);
  await expect(payables.nth(0)).toContainText("Lebih bayar Rp 100.000");
  await expect(payables.nth(0).getByTestId("payment-status-badge")).toHaveText("Lebih bayar");
  await expect(payables.nth(1)).toContainText(dpNo);
  await expect(payables.nth(1)).toContainText("Rp 300.000");
  await expect(payables.nth(1).getByTestId("payment-status-badge")).toHaveText("DP");
  await expect(payables.nth(2)).toContainText(unpaidNo);
  await expect(payables.nth(2)).toContainText("Rp 1.000.000");
  await expect(payables.nth(2).getByTestId("payment-status-badge")).toHaveText("Belum bayar");
  await expect(page.locator(layout.hiddenPayableRow).first()).toBeHidden();
  await payables.nth(1).getByRole("link").first().click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(dpNo);

  // 4. Staff without finance.view_profit: no amount anywhere, no "Ada utang" tab, and the
  //    filter param is ignored rather than revealing who is owed money.
  await page.context().clearCookies();
  await loginAs(page, E2E_PAYMENTS_NO_FINANCE_EMAIL);
  await page.goto(`/suppliers?balance=owed&q=${encodeURIComponent(settledName)}`);
  const plainRow = page.locator(layout.listRow).filter({ hasText: settledName });
  await expect(plainRow).toBeVisible();
  await expect(plainRow).not.toContainText("Rp");
  await expect(page.getByTestId("supplier-balance")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Filter utang supplier" })).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Total utang" })).toHaveCount(0);
  await page.goto(supplierUrl);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(supplierName);
  await expect(page.getByText("Utang ke supplier")).toHaveCount(0);
  await expect(page.getByTestId("supplier-payables-summary")).toHaveCount(0);
  await expect(page.getByText("Rp 1.300.000")).toHaveCount(0);
}

test.describe("Supplier: total utang dan rincian dokumen", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`total utang, lebih bayar, Ada utang filter, detail breakdown, no-finance view at ${layout === MOBILE ? "390px" : "1280px"}`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize(layout === MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await loginAs(page, E2E_SUPPLIER_PAYMENTS_EMAIL);
      await runFlow(page, layout);
    });
  }
});
