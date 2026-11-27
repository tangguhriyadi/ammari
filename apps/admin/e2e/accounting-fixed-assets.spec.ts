import { expect, test } from "./fixtures";
import { loginAs } from "./helpers/login";
import { E2E_ACCOUNTING_MASTER_EMAIL } from "./global-setup";

// docs/plans/accounting.md Session 11 (D-19, D-20): the fixed asset register at 390px AND 1280px
// (CLAUDE.md: a list renders a CardList on phones and a table from md up, so each check reads THIS
// viewport's rows and proves the other layout's rows are hidden), the capitalisation threshold
// refusal, edit and void, and the settings page. The asset this spec registers is voided at the end, so
// accounting.spec.ts's posting runs find nothing of it to post.

const NAME = "Mesin jahit e2e";

test("Aset tetap: register (threshold refused), list at 390px and 1280px, edit, then void", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_MASTER_EMAIL);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto("/accounting/fixed-assets");
  await expect(page.getByRole("heading", { name: "Aset Tetap", exact: true })).toBeVisible();
  await expect(page.getByTestId("fixed-asset-settings")).toContainText("Kelompok 1: 48 bulan");
  await expect(page.getByTestId("fixed-asset-settings")).toContainText("Kelompok 2: 96 bulan");

  await page.getByRole("link", { name: "Catat aset tetap" }).click();
  const form = page.getByRole("form", { name: "Aset tetap" });
  await form.getByLabel("Nama aset").fill(NAME);
  await form.getByLabel("Kelompok pajak").selectOption("group_1");
  await form.getByLabel("Tanggal perolehan").fill("2026-11-10");
  await form.getByLabel("Harga perolehan (Rp)").fill("999.999");
  await form.getByLabel("Akun aset").selectOption("1-2101");
  // The matching Akumulasi penyusutan is preselected from the asset account.
  await expect(form.getByLabel("Akun akumulasi penyusutan")).toHaveValue("1-2191");
  await form.getByRole("button", { name: "Simpan" }).click();
  await expect(form.getByText("di bawah batas kapitalisasi").first()).toBeVisible();
  await form.getByLabel("Harga perolehan (Rp)").fill("4.800.000");
  await form.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByRole("heading", { name: NAME })).toBeVisible();
  await expect(page.getByTestId("fixed-asset-detail")).toContainText("Rp 100.000");

  for (const layout of [
    { label: "mobile", viewport: { width: 390, height: 844 }, row: '[data-testid="fixed-asset-card"]', hidden: '[data-testid="fixed-asset-row"]' },
    { label: "desktop", viewport: { width: 1280, height: 800 }, row: '[data-testid="fixed-asset-row"]', hidden: '[data-testid="fixed-asset-card"]' },
  ]) {
    await test.step(layout.label, async () => {
      await page.setViewportSize(layout.viewport);
      await page.goto("/accounting/fixed-assets");
      const row = page.locator(layout.row).filter({ hasText: NAME });
      await expect(row).toBeVisible();
      await expect(row).toContainText("Kelompok 1");
      await expect(row).toContainText("Rp 4.800.000");
      await expect(row).toContainText("Rp 100.000");
      await expect(row).toContainText("Aktif");
      const hidden = page.locator(layout.hidden).filter({ hasText: NAME });
      await expect(hidden).toHaveCount(1);
      await expect(hidden).toBeHidden();
    });
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('[data-testid="fixed-asset-row"]').filter({ hasText: NAME }).getByRole("link", { name: NAME }).click();
  const edit = page.getByRole("form", { name: "Aset tetap" });
  await edit.getByLabel("Catatan").fill("Dibeli dari toko mesin");
  await edit.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/accounting\/fixed-assets$/);

  await page.locator('[data-testid="fixed-asset-row"]').filter({ hasText: NAME }).getByRole("link", { name: NAME }).click();
  await expect(page.getByTestId("fixed-asset-detail")).toContainText("Dibeli dari toko mesin");
  await page.getByRole("button", { name: "Batalkan aset" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Alasan").fill("Uji e2e");
  await dialog.getByRole("button", { name: "Batalkan aset" }).click();
  await expect(page.getByTestId("fixed-asset-detail")).toContainText("Dibatalkan");
  await expect(page.getByRole("form", { name: "Aset tetap" })).toHaveCount(0);
});

test("Pengaturan aset tetap: a group's life and the threshold at 390px and 1280px", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_MASTER_EMAIL);
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/accounting/fixed-assets/settings");
    await expect(page.getByRole("heading", { name: "Pengaturan Aset Tetap" })).toBeVisible();
    const group = page.getByRole("form", { name: "Kelompok Kelompok 2" });
    await expect(group.getByLabel("Umur manfaat (bulan)")).toHaveValue("96");
    await expect(page.getByRole("form", { name: "Batas kapitalisasi" }).getByLabel("Batas kapitalisasi (Rp)")).toHaveValue("1000000");
  }
  const group = page.getByRole("form", { name: "Kelompok Kelompok 2" });
  await group.getByLabel("Umur manfaat (bulan)").fill("0");
  await group.getByRole("button", { name: "Simpan" }).click();
  await expect(group.getByText("1 sampai 600 bulan")).toBeVisible();
  await group.getByLabel("Umur manfaat (bulan)").fill("96");
  await group.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByText("Kelompok disimpan")).toBeVisible();
});
