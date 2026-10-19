import { expect, type Page } from "@playwright/test";

/** On a draft batch's detail page: "Posting batch" and confirm. Since S4
 * (docs/plans/suppliers-goods-receipt.md) posting consumes material and freezes HPP but adds NO
 * finished-goods stock — use `receiveAllBatchOutput` for that. */
export async function postBatch(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Posting batch" }).click();
  await page.getByRole("button", { name: "Posting", exact: true }).click();
  await expect(page.getByRole("button", { name: "Posting batch" })).toHaveCount(0, { timeout: 15_000 });
}

/** On a posted batch's detail page: "Terima hasil", keep the prefilled remaining pcs, save, and
 * land back on the batch with everything received. */
export async function receiveAllBatchOutput(page: Page): Promise<void> {
  const detailUrl = page.url();
  await page.getByRole("link", { name: "Terima hasil" }).click();
  await expect(page).toHaveURL(/\/receive$/);
  await page.getByRole("button", { name: "Simpan penerimaan" }).click();
  try {
    await page.waitForURL(detailUrl, { timeout: 10_000 });
  } catch {
    // Same WebKit + `next dev` dropped-redirect fallback as helpers/purchase.ts's saveAndLand:
    // re-clicking would receive twice, and the assertion below still catches a real failure.
    await page.goto(detailUrl);
  }
  await expect(page.getByRole("region", { name: "Hasil produksi" }).getByText("Diterima lengkap", { exact: true })).toBeVisible();
}

/** The old one-step "posting adds stock" flow, expressed in the new model: post, then receive
 * every planned pcs — so specs that only need finished-goods stock end up with exactly the same
 * stock and value as before. */
export async function postBatchAndReceiveAll(page: Page): Promise<void> {
  await postBatch(page);
  await receiveAllBatchOutput(page);
}
