import { expect, test, type Locator, type Page } from "@playwright/test";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { openCreated } from "./helpers/open-created";
import { addVariants, createProductDraft } from "./helpers/product";
import { postBatch } from "./helpers/production";
import { createSupplier, purchaseAndReceiveAll } from "./helpers/purchase";
import { E2E_PRODUCTION_PAYMENTS_EMAIL, E2E_PRODUCTION_PAYMENTS_NO_FINANCE_EMAIL } from "./global-setup";

// docs/plans/purchase-payments.md session S4: supplier payments on a production batch, tracked
// per payee. The whole flow runs at 390px AND 1280px (CLAUDE.md's rule): the payee summary, the
// payment history and /production each render two independent layouts (CardList for phones,
// TableContainer for desktop), so each pass asserts its own layout's rows and that the other
// layout's are hidden. Proofs go to the in-memory private storage (PRIVATE_STORAGE_DRIVER=memory).

interface Layout {
  label: string;
  listRow: "li" | "tr";
  hiddenListRow: "li" | "tr";
  payeeRow: string;
  hiddenPayeeRow: string;
  paymentRow: string;
  hiddenPaymentRow: string;
}

const MOBILE: Layout = {
  label: "mobile",
  listRow: "li",
  hiddenListRow: "tr",
  payeeRow: '[data-testid="payee-card"]',
  hiddenPayeeRow: '[data-testid="payee-row"]',
  paymentRow: '[data-testid="payment-card"]',
  hiddenPaymentRow: '[data-testid="payment-row"]',
};
const DESKTOP: Layout = {
  label: "desktop",
  listRow: "tr",
  hiddenListRow: "li",
  payeeRow: '[data-testid="payee-row"]',
  hiddenPayeeRow: '[data-testid="payee-card"]',
  paymentRow: '[data-testid="payment-row"]',
  hiddenPaymentRow: '[data-testid="payment-card"]',
};

async function receiptPhoto(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 180, g: 200 - (seed % 50), b: 190 } } })
    .jpeg()
    .toBuffer();
}

async function createComponent(page: Page, input: { name: string; fixed: boolean; price: string; supplierName: string }): Promise<void> {
  await page.goto("/production/cost-components/new");
  await page.locator("#component-name").fill(input.name);
  if (input.fixed) await page.locator("#component-cost-type").selectOption("fixed");
  await page.locator("#component-price").fill(input.price);
  await page.locator("#component-supplier").selectOption({ label: input.supplierName });
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/production\/cost-components$/);
}

/** A draft batch of 5 pcs with two service lines: sewing 5 x Rp 20.000 to the tailor and
 * finishing Rp 50.000 to the finisher. The fabric (Rp 1.000.000) is never due here (A2). Lands on
 * the draft's detail page. */
async function createDraftBatch(page: Page, marker: string, tailorName: string, finisherName: string): Promise<void> {
  const fabricName = `E2E Bahan Bayar Produksi ${marker}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Hitam");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);
  await createProductDraft(page, { name: `E2E Gamis Bayar Produksi ${marker}`, fabricName, active: false });
  await addVariants(page, /Hitam/, ["M"]);
  await purchaseAndReceiveAll(page, [{ type: "Kain", itemName: fabricName, qty: "10", amount: "1.000.000" }]);

  await createSupplier(page, tailorName);
  await createSupplier(page, finisherName);
  const sewing = `E2E Jahit ${marker}`;
  const finishing = `E2E Finishing ${marker}`;
  await createComponent(page, { name: sewing, fixed: false, price: "20.000", supplierName: tailorName });
  await createComponent(page, { name: finishing, fixed: true, price: "50.000", supplierName: finisherName });

  await page.goto("/production/new");
  await page.locator("#batch-fabric").selectOption({ label: fabricName });
  await page.locator("#batch-fabric-yards").fill("10");
  await page.getByRole("button", { name: "+ Tambah biaya" }).click();
  await page.locator("#extra-cost-component-0").selectOption({ label: sewing });
  await page.getByRole("button", { name: "+ Tambah biaya" }).click();
  await page.locator("#extra-cost-component-1").selectOption({ label: finishing });
  // Each line's supplier is prefilled from its component's default.
  await expect(page.locator("#extra-cost-supplier-0 option:checked")).toHaveText(tailorName);
  await expect(page.locator("#extra-cost-supplier-1 option:checked")).toHaveText(finisherName);
  await page.getByLabel("M", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await openCreated(page, "/production");
}

async function openRecordDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Catat pembayaran" }).click();
  const dialog = page.getByRole("dialog", { name: "Catat pembayaran" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectOverall(page: Page, status: string, paid: string, remaining: string): Promise<void> {
  const summary = page.getByTestId("payment-summary");
  await expect(summary.getByTestId("payment-status-badge")).toHaveText(status);
  await expect(summary.getByTestId("payment-paid")).toHaveText(paid);
  await expect(summary.getByTestId("payment-remaining")).toHaveText(remaining);
}

async function expectPayee(page: Page, layout: Layout, name: string, status: string, texts: string[]): Promise<void> {
  const row = page.locator(layout.payeeRow).filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("payment-status-badge")).toHaveText(status);
  for (const text of texts) await expect(row).toContainText(text);
  await expect(page.locator(layout.hiddenPayeeRow).filter({ hasText: name })).toBeHidden();
}

async function expectListRow(page: Page, layout: Layout, batchNo: string, filter: string | null, present: boolean): Promise<void> {
  await page.goto("/production");
  if (filter) {
    await page.getByRole("navigation", { name: "Filter status pembayaran" }).getByRole("link", { name: filter, exact: true }).click();
    await expect(page).toHaveURL(/payment=/);
  }
  const row = page.locator(layout.listRow).filter({ hasText: batchNo });
  if (present) {
    await expect(row).toBeVisible();
    await expect(page.locator(layout.hiddenListRow).filter({ hasText: batchNo }).first()).toBeHidden();
  } else {
    await expect(row).toHaveCount(0);
  }
}

async function runFlow(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.label}-${Date.now()}`;
  const tailorName = `E2E Penjahit Bayar ${marker}`;
  const finisherName = `E2E Finishing Bayar ${marker}`;
  await createDraftBatch(page, marker, tailorName, finisherName);
  const batchUrl = page.url();
  const batchNo = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();

  // 1. A draft has no tagihan: the rule is explained, and there is nothing to pay yet.
  await expect(page.getByTestId("draft-payment-notice")).toContainText("belum ada tagihan");
  await expect(page.getByRole("button", { name: "Catat pembayaran" })).toHaveCount(0);
  await expect(page.getByTestId("payment-status-badge")).toHaveCount(0);
  // ...and it matches no payment tab on the list.
  await expectListRow(page, layout, batchNo, "Belum bayar", false);
  await page.goto(batchUrl);

  // 2. Posted: due Rp 150.000 = service lines only (not the Rp 1.000.000 fabric), per payee.
  await postBatch(page);
  await expectOverall(page, "Belum bayar", "Rp 0", "Rp 150.000");
  await expect(page.getByTestId("payment-tagihan")).toHaveText("Rp 150.000");
  await expectPayee(page, layout, tailorName, "Belum bayar", ["Rp 100.000"]);
  await expectPayee(page, layout, finisherName, "Belum bayar", ["Rp 50.000"]);
  await expect(page.getByText("Belum ada pembayaran.")).toBeVisible();

  // 3. The cap is per payee: Rp 100.001 to the tailor is refused, although the batch owes 150.000.
  let dialog = await openRecordDialog(page);
  await dialog.getByLabel("Dibayar kepada").selectOption({ label: `${tailorName} (sisa Rp 100.000)` });
  await expect(dialog.getByLabel("Jumlah")).toHaveValue("100.000");
  await dialog.locator('input[type="file"]').setInputFiles({ name: `struk-${marker}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto(1) });
  await expect(dialog.getByTestId("private-file-selected")).toContainText(`struk-${marker}.jpg`);
  await dialog.getByLabel("Jumlah").fill("100.001");
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(dialog.getByText("Jumlah melebihi sisa tagihan (Rp 100.000).")).toBeVisible({ timeout: 15_000 });

  // 4. DP Rp 40.000 cash to the tailor: tailor DP, finisher still Belum bayar, batch DP.
  await dialog.getByLabel("Jumlah").fill("40.000");
  await dialog.getByLabel("Metode").selectOption({ label: "Tunai" });
  await dialog.getByLabel("Catatan").fill("DP jahit");
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(page.getByRole("status")).toContainText("dicatat", { timeout: 15_000 });
  await expect(dialog).toBeHidden();
  await expectOverall(page, "DP", "Rp 40.000", "Rp 110.000");
  await expectPayee(page, layout, tailorName, "DP", ["Rp 60.000"]);
  await expectPayee(page, layout, finisherName, "Belum bayar", []);
  const payments = page.locator(layout.paymentRow);
  await expect(payments).toHaveCount(1);
  await expect(payments.first()).toContainText(tailorName);
  await expect(payments.first()).toContainText("Rp 40.000");
  await expect(payments.first()).toContainText("Tunai");
  await expect(page.locator(layout.hiddenPaymentRow).first()).toBeHidden();

  // 5. The list shows DP, and the payment filter follows it.
  await expectListRow(page, layout, batchNo, null, true);
  await expect(page.locator(layout.listRow).filter({ hasText: batchNo }).getByTestId("payment-status-badge")).toHaveText("DP");
  await expectListRow(page, layout, batchNo, "DP", true);
  await expectListRow(page, layout, batchNo, "Lunas", false);
  await expectListRow(page, layout, batchNo, "Belum bayar", false);

  // 6. Pelunasan to the tailor: tailor Lunas, the batch overall still DP (the finisher is unpaid).
  await page.goto(batchUrl);
  dialog = await openRecordDialog(page);
  await dialog.getByLabel("Dibayar kepada").selectOption({ label: `${tailorName} (sisa Rp 60.000)` });
  await expect(dialog.getByLabel("Jumlah")).toHaveValue("60.000");
  await dialog.locator('input[type="file"]').setInputFiles({ name: `struk2-${marker}.jpg`, mimeType: "image/jpeg", buffer: await receiptPhoto(2) });
  await expect(dialog.getByTestId("private-file-selected")).toContainText(`struk2-${marker}.jpg`);
  await dialog.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(page.getByRole("status")).toContainText(`Tagihan ${tailorName} lunas.`, { timeout: 15_000 });
  await expectPayee(page, layout, tailorName, "Lunas", []);
  await expectPayee(page, layout, finisherName, "Belum bayar", []);
  await expectOverall(page, "DP", "Rp 100.000", "Rp 50.000");
  // The tailor is no longer offered: only the finisher is left to pay.
  dialog = await openRecordDialog(page);
  await expect(dialog.getByLabel("Dibayar kepada").locator("option")).toHaveText([`${finisherName} (sisa Rp 50.000)`]);
  await dialog.getByRole("button", { name: "Batal" }).click();
  await expect(payments).toHaveCount(2);

  // 7. Void the pelunasan with a reason: struck "Dibatalkan" row, the tailor back to DP.
  const pelunasanNo = (await payments.nth(1).textContent())?.match(/BYR-\d{6}-\d{3}/)?.[0];
  expect(pelunasanNo).toBeTruthy();
  await payments.nth(1).getByRole("button", { name: `Batalkan pembayaran ${pelunasanNo}` }).click();
  const voidDialog = page.getByRole("dialog", { name: `Batalkan pembayaran ${pelunasanNo}?` });
  await voidDialog.getByRole("button", { name: "Batalkan pembayaran" }).click();
  await expect(voidDialog.getByText("Alasan pembatalan wajib diisi.")).toBeVisible();
  await voidDialog.getByLabel("Alasan pembatalan").fill("Salah transfer");
  await voidDialog.getByRole("button", { name: "Batalkan pembayaran" }).click();
  await expect(page.getByRole("status")).toContainText(`Pembayaran ${pelunasanNo} dibatalkan`, { timeout: 15_000 });
  await expectPayee(page, layout, tailorName, "DP", ["Rp 60.000"]);
  await expectOverall(page, "DP", "Rp 40.000", "Rp 110.000");
  await expect(payments.nth(1)).toContainText("Dibatalkan");
  await expect(payments.nth(1)).toContainText("Salah transfer");
  await expect(payments.nth(1).getByRole("button", { name: /Batalkan pembayaran/ })).toHaveCount(0);

  // 8. Staff without finance.view_profit: the badge only, never an amount or a button.
  await page.context().clearCookies();
  await loginAs(page, E2E_PRODUCTION_PAYMENTS_NO_FINANCE_EMAIL);
  await page.goto(batchUrl);
  await expect(page.getByTestId("payment-status-badge")).toHaveText("DP");
  await expect(page.getByTestId("payment-summary")).toHaveCount(0);
  await expect(page.getByText("Riwayat pembayaran")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Catat pembayaran" })).toHaveCount(0);
  await expect(page.getByText("Rp 40.000")).toHaveCount(0);

  await page.goto("/production");
  const row = page.locator(layout.listRow).filter({ hasText: batchNo });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("payment-status-badge")).toHaveText("DP");
  await expect(row).not.toContainText("Rp");
  await expect(page.getByRole("columnheader", { name: "Sisa" })).toHaveCount(0);
  await expectListRow(page, layout, batchNo, "DP", true);
}

test.describe("Produksi: pembayaran ke penjahit dan penyedia jasa", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`per-payee DP and pelunasan, per-payee cap, void, draft refused, no-finance view at ${layout === MOBILE ? "390px" : "1280px"}`, async ({ page }) => {
      test.setTimeout(300_000);
      await page.setViewportSize(layout === MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 });
      await loginAs(page, E2E_PRODUCTION_PAYMENTS_EMAIL);
      await runFlow(page, layout);
    });
  }
});
