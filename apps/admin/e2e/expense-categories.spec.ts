import { test as baseTest, type Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { loginAs } from "./helpers/login";
import { E2E_EXPENSE_CATEGORIES_CS_EMAIL, E2E_EXPENSE_CATEGORIES_EMAIL } from "./global-setup";

// docs/plans/expense-master-data.md session S3: the "Kategori Biaya" Data Master. The whole flow
// runs at 390px AND 1280px (CLAUDE.md's rule): the category list and the item list each render a
// CardList on phones and a TableContainer on tablet/desktop, so every list assertion goes through
// THIS viewport's row and also checks the other layout's row is hidden, not missing. Category names
// are unique across the table, so each pass carries its own marker.

interface Layout {
  label: string;
  categoryRow: string;
  hiddenCategoryRow: string;
  itemRow: string;
  hiddenItemRow: string;
  viewport: { width: number; height: number };
}

const MOBILE: Layout = {
  label: "mobile",
  categoryRow: '[data-testid="expense-category-card"]',
  hiddenCategoryRow: '[data-testid="expense-category-row"]',
  itemRow: '[data-testid="expense-item-card"]',
  hiddenItemRow: '[data-testid="expense-item-row"]',
  viewport: { width: 390, height: 844 },
};
const DESKTOP: Layout = {
  label: "desktop",
  categoryRow: '[data-testid="expense-category-row"]',
  hiddenCategoryRow: '[data-testid="expense-category-card"]',
  itemRow: '[data-testid="expense-item-row"]',
  hiddenItemRow: '[data-testid="expense-item-card"]',
  viewport: { width: 1280, height: 800 },
};

function categoryRow(page: Page, layout: Layout, name: string) {
  return page.locator(layout.categoryRow).filter({ has: page.getByRole("link", { name, exact: true }) });
}

function itemRow(page: Page, layout: Layout, name: string) {
  return page.locator(layout.itemRow).filter({ has: page.getByText(name, { exact: true }) });
}

async function addItem(page: Page, name: string, defaultAmount?: string): Promise<void> {
  await page.getByRole("button", { name: "Tambah item", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Tambah item biaya" });
  await dialog.getByLabel("Nama item").fill(name);
  if (defaultAmount) await dialog.getByLabel("Jumlah default (opsional)").fill(defaultAmount);
  await dialog.getByRole("button", { name: "Simpan item" }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText(`Item ${name} ditambahkan`);
}

async function runFlow(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.label}-${Date.now()}`;
  const categoryName = `Langganan ${marker}`;
  const renamedCategory = `Langganan Tools ${marker}`;

  // 1. The list renders the seeded system categories in this layout only.
  await page.goto("/expense-categories");
  const meta = categoryRow(page, layout, "Iklan Meta");
  await expect(meta).toBeVisible();
  await expect(meta).toContainText("Iklan");
  await expect(meta).toContainText("Sistem");
  await expect(page.locator(layout.hiddenCategoryRow).filter({ hasText: "Iklan Meta" }).first()).toBeHidden();

  // 2. The reserved name is refused with a clear message, and nothing is created.
  await page.getByRole("link", { name: "Tambah kategori" }).click();
  await expect(page).toHaveURL(/\/expense-categories\/new$/);
  await page.getByLabel("Nama kategori").fill("Biaya produksi");
  await page.getByLabel("Operasional").check();
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByText('"Biaya produksi" dipakai untuk pengeluaran produksi dan tidak bisa jadi nama kategori.')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/expense-categories\/new$/);

  // 3. Create "Langganan" (Operasional). The code is generated and the detail page opens.
  await page.getByLabel("Nama kategori").fill(categoryName);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page).toHaveURL(/\/expense-categories\/langganan_[a-z0-9_]+$/, { timeout: 15_000 });
  await expect(page.getByRole("status")).toContainText("Kategori biaya berhasil ditambahkan");
  await expect(page.getByRole("heading", { name: categoryName })).toBeVisible();
  await expect(page.getByLabel("Jenis")).toHaveValue("Operasional");
  await expect(page.getByLabel("Jenis")).toBeDisabled();
  const detailUrl = page.url();

  // 4. Items: Biteship Grow with a default amount, Claude and VPS without.
  await expect(page.getByText("Belum ada item.")).toBeVisible();
  await addItem(page, "Biteship Grow", "149.000");
  await addItem(page, "Claude");
  await addItem(page, "VPS");
  await expect(itemRow(page, layout, "Biteship Grow")).toContainText("Rp 149.000");
  await expect(itemRow(page, layout, "Biteship Grow")).toContainText("Belum dipakai");
  await expect(page.locator(layout.hiddenItemRow).filter({ hasText: "Biteship Grow" }).first()).toBeHidden();

  // A duplicate name in the same category is a field error inside the dialog.
  await page.getByRole("button", { name: "Tambah item", exact: true }).click();
  const addDialog = page.getByRole("dialog", { name: "Tambah item biaya" });
  await addDialog.getByLabel("Nama item").fill("vps");
  await addDialog.getByRole("button", { name: "Simpan item" }).click();
  await expect(addDialog.getByText("Nama sudah dipakai di kategori ini.")).toBeVisible({ timeout: 15_000 });
  await addDialog.getByRole("button", { name: "Batal" }).click();
  await expect(addDialog).toBeHidden();

  // 5. Rename an item.
  await itemRow(page, layout, "Claude").getByRole("button", { name: "Ubah Claude" }).click();
  const editDialog = page.getByRole("dialog", { name: "Ubah item Claude" });
  await expect(editDialog.getByLabel("Nama item")).toHaveValue("Claude");
  await editDialog.getByLabel("Nama item").fill("Claude Pro");
  await editDialog.getByRole("button", { name: "Simpan item" }).click();
  await expect(editDialog).toBeHidden({ timeout: 15_000 });
  await expect(itemRow(page, layout, "Claude Pro")).toBeVisible();
  await expect(itemRow(page, layout, "Claude")).toHaveCount(0);

  // 6. Deactivate an item; it can be reactivated (nothing is deleted).
  await itemRow(page, layout, "VPS").getByRole("button", { name: "Nonaktifkan VPS" }).click();
  await expect(page.getByRole("status")).toContainText("Item VPS dinonaktifkan", { timeout: 15_000 });
  await expect(itemRow(page, layout, "VPS")).toContainText("Nonaktif");
  await expect(itemRow(page, layout, "VPS").getByRole("button", { name: "Aktifkan VPS" })).toBeVisible();

  // 7. Rename the category: the code and kind stay.
  await page.getByLabel("Nama kategori").fill(renamedCategory);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Perubahan berhasil disimpan", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: renamedCategory })).toBeVisible();
  expect(page.url()).toBe(detailUrl);

  // 8. Deactivate the (non-system) category, through the confirmation.
  await page.getByRole("button", { name: "Nonaktifkan kategori" }).click();
  const confirm = page.getByRole("dialog", { name: `Nonaktifkan ${renamedCategory}?` });
  await confirm.getByRole("button", { name: "Nonaktifkan", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(`Kategori ${renamedCategory} dinonaktifkan`, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Aktifkan kategori" })).toBeVisible();

  // 9. The list shows it renamed, inactive, with its three items; the status filter agrees.
  await page.goto("/expense-categories");
  const row = categoryRow(page, layout, renamedCategory);
  await expect(row).toContainText("Operasional");
  await expect(row).toContainText("3 item");
  await expect(row).toContainText("Nonaktif");
  await expect(categoryRow(page, layout, categoryName)).toHaveCount(0);
  await page.goto("/expense-categories?status=inactive");
  await expect(categoryRow(page, layout, renamedCategory)).toBeVisible();
  await expect(categoryRow(page, layout, "Iklan Meta")).toHaveCount(0);
  await page.goto("/expense-categories?status=active");
  await expect(categoryRow(page, layout, renamedCategory)).toHaveCount(0);
  await expect(categoryRow(page, layout, "Iklan Meta")).toBeVisible();

  // 10. A system category can be opened and renamed, but shows no Nonaktifkan.
  await categoryRow(page, layout, "Iklan Meta").getByRole("link", { name: "Iklan Meta" }).click();
  await expect(page).toHaveURL(/\/expense-categories\/ads_meta$/);
  await expect(page.getByRole("heading", { name: "Iklan Meta" })).toBeVisible();
  await expect(page.getByText(/Kategori sistem: dipakai perhitungan ROAS\/laporan/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Nonaktifkan kategori" })).toHaveCount(0);
  await expect(page.getByLabel("Jenis")).toHaveValue("Iklan");
}

test.describe("Kategori Biaya (Data Master)", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`create Langganan with items, rename, deactivate, system and reserved-name rules (${layout.viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize(layout.viewport);
      await loginAs(page, E2E_EXPENSE_CATEGORIES_EMAIL);
      await runFlow(page, layout);
    });

    // The plain Playwright test: "Akses ditolak" is not the shell's hydrated page that
    // fixtures.ts's waitForPageReady waits for.
    baseTest(`a role without ads_expenses.manage gets Akses ditolak and no nav entry (${layout.viewport.width}px)`, async ({ page }) => {
      await page.setViewportSize(layout.viewport);
      await loginAs(page, E2E_EXPENSE_CATEGORIES_CS_EMAIL);
      for (const path of ["/expense-categories", "/expense-categories/new", "/expense-categories/ads_meta"]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
      }
      await page.goto("/orders");
      await expect(page.getByRole("heading", { name: "Akses ditolak" })).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Kategori Biaya" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Kategori Biaya" })).toHaveCount(0);
    });
  }
});
