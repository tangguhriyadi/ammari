import { expect, type Locator, type Page } from "@playwright/test";
import { openCreated } from "./open-created";

/** Clicks a form's save button and waits for its redirect. Under WebKit + `next dev` the
 * client-side redirect after a SUCCESSFUL server action is intermittently dropped (see
 * playwright.config.ts and docs/plans/packing-cards.md); re-clicking would save twice, so on a
 * missed redirect this navigates to where the redirect would have gone. A save that really
 * failed is still caught: every caller asserts the saved state on the page it lands on. */
async function saveAndLand(page: Page, button: Locator, landing: RegExp, fallbackUrl: string): Promise<void> {
  await button.click();
  try {
    await expect(page).toHaveURL(landing, { timeout: 10_000 });
  } catch {
    await page.goto(fallbackUrl);
  }
}

export interface PurchaseLineSpec {
  type: "Kain" | "Aksesoris";
  itemName: string;
  qty: string;
  amount: string;
}

/** Creates a supplier with only a name (plan D13) and waits for the redirect to the list. */
export async function createSupplier(page: Page, name: string): Promise<void> {
  await page.goto("/suppliers/new");
  await page.getByLabel("Nama supplier").fill(name);
  await saveAndLand(page, page.getByRole("button", { name: "Simpan", exact: true }), /\/suppliers$/, "/suppliers");
}

/** Fills and saves /purchases/new with `lines`, then opens the new document's detail page. Since
 * purchase documents (docs/plans/suppliers-goods-receipt.md S3) recording a purchase moves NO
 * stock; use `receiveAllOutstanding` (or `purchaseAndReceiveAll`) for that. */
export async function createPurchase(page: Page, supplierName: string, lines: PurchaseLineSpec[]): Promise<void> {
  await page.goto("/purchases/new");
  await page.locator("#purchase-supplier").selectOption({ label: supplierName });
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (index > 0) await page.getByRole("button", { name: "+ Tambah barang" }).click();
    await page.getByLabel(`Jenis barang ${number}`).selectOption({ label: line.type });
    await page.getByLabel(`Barang ${number}`, { exact: true }).selectOption({ label: line.itemName });
    await page.getByLabel(`Jumlah barang ${number}`).fill(line.qty);
    await page.getByLabel(`Total harga barang ${number}`).fill(line.amount);
  }
  await saveAndLand(page, page.getByRole("button", { name: "Simpan", exact: true }), /\/purchases$/, "/purchases");
  await openCreated(page, "/purchases", supplierName);
}

/** On a purchase detail page: "Terima barang", keep the prefilled remaining quantities, save. */
export async function receiveAllOutstanding(page: Page): Promise<void> {
  const detailUrl = page.url();
  await page.getByRole("link", { name: "Terima barang" }).click();
  await expect(page).toHaveURL(/\/receive$/);
  await saveAndLand(page, page.getByRole("button", { name: "Simpan penerimaan" }), new RegExp(`^${detailUrl}$`), detailUrl);
  await expect(page.getByText("Diterima lengkap").first()).toBeVisible();
}

/** The old one-step "purchase adds stock" flow, expressed in the new model: a fresh supplier, a
 * purchase document, and one receipt of everything — so specs that only need raw-material stock
 * to exist end up with exactly the same stock and value as before. */
export async function purchaseAndReceiveAll(page: Page, lines: PurchaseLineSpec[]): Promise<void> {
  const supplierName = `E2E Supplier ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await createSupplier(page, supplierName);
  await createPurchase(page, supplierName, lines);
  await receiveAllOutstanding(page);
}
