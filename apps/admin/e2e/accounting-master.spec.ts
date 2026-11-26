import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { loginAs } from "./helpers/login";
import { E2E_ACCOUNTING_CS_EMAIL, E2E_ACCOUNTING_MASTER_CATEGORY, E2E_ACCOUNTING_MASTER_EMAIL, E2E_ACCOUNTING_VIEW_ONLY_EMAIL } from "./global-setup";

// docs/plans/accounting.md Session 3: Data Master Akun, Pemetaan akun, Pengaturan pajak, and the
// unmapped-category warning on Kategori Biaya (D-25). Every list is asserted at 390px AND 1280px
// (CLAUDE.md): the Akun and Pengaturan pajak lists render a CardList on phones and a table from md
// up, so each check reads THIS viewport's rows and proves the other layout's rows are hidden. The
// mapping page is one responsive list (each form exists once), checked at both widths too.
//
// Only an account this spec creates (1-1209) and the e2e category are changed: the default
// mappings accounting.spec.ts posts with stay as seeded.

interface Layout {
  label: string;
  viewport: { width: number; height: number };
  accountRow: string;
  hiddenAccountRow: string;
  taxRow: string;
  hiddenTaxRow: string;
}

const MOBILE: Layout = {
  label: "mobile",
  viewport: { width: 390, height: 844 },
  accountRow: '[data-testid="account-card"]',
  hiddenAccountRow: '[data-testid="account-row"]',
  taxRow: '[data-testid="tax-setting-card"]',
  hiddenTaxRow: '[data-testid="tax-setting-row"]',
};
const DESKTOP: Layout = {
  label: "desktop",
  viewport: { width: 1280, height: 800 },
  accountRow: '[data-testid="account-row"]',
  hiddenAccountRow: '[data-testid="account-card"]',
  taxRow: '[data-testid="tax-setting-row"]',
  hiddenTaxRow: '[data-testid="tax-setting-card"]',
};

async function checkCashBank(page: Page, layout: Layout, expected: string[]): Promise<void> {
  await page.goto("/accounting/accounts?filter=cash-bank");
  await expect(page.getByRole("heading", { name: "Akun", exact: true })).toBeVisible();
  const rows = page.locator(layout.accountRow);
  await expect(rows).toHaveCount(expected.length);
  for (const [index, text] of expected.entries()) {
    await expect(rows.nth(index)).toBeVisible();
    await expect(rows.nth(index)).toContainText(text);
  }
  const hidden = page.locator(layout.hiddenAccountRow);
  await expect(hidden).toHaveCount(expected.length);
  await expect(hidden.first()).toBeHidden();
}

test("Data Master Akun: Kas & Bank, add a second bank as a sub-account, rename, deactivate, at 390px and 1280px", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_MASTER_EMAIL);

  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(`${layout.label}: Kas & Bank is Kas tunai and Bank utama (D-17)`, async () => {
      await page.setViewportSize(layout.viewport);
      await checkCashBank(page, layout, ["1-1101", "1-1201"]);
      // The full list holds the system inventory account, marked Sistem.
      await page.goto("/accounting/accounts");
      const inventory = page.locator(layout.accountRow).filter({ hasText: "Persediaan bahan kain" });
      await expect(inventory).toBeVisible();
      await expect(inventory).toContainText("Sistem");
    });
  }

  await test.step("mobile: add 1-1209 under the Bank header", async () => {
    await page.setViewportSize(MOBILE.viewport);
    await page.goto("/accounting/accounts/1-1200");
    await page.getByRole("link", { name: "Tambah sub-akun" }).click();
    await expect(page.getByRole("heading", { name: "Tambah Akun" })).toBeVisible();
    const form = page.getByRole("form", { name: "Tambah akun" });
    await expect(form.getByLabel("Akun induk")).toHaveValue("1-1200");
    await expect(form.getByLabel("Jenis")).toHaveValue("asset");
    await form.getByLabel("Kode akun").fill("1-1209");
    await form.getByLabel("Nama akun").fill("Bank cadangan E2E");
    await form.getByLabel("Nama bank").fill("BRI");
    await form.getByLabel("4 digit terakhir rekening").fill("4321");
    await form.getByRole("button", { name: "Simpan akun" }).click();
    await expect(page).toHaveURL(/\/accounting\/accounts\/1-1209$/);
    await expect(page.getByRole("heading", { name: "1-1209 Bank cadangan E2E" })).toBeVisible();
  });

  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(`${layout.label}: the new bank is in Kas & Bank with its bank fields`, async () => {
      await page.setViewportSize(layout.viewport);
      await checkCashBank(page, layout, ["1-1101", "1-1201", "1-1209"]);
      await expect(page.locator(layout.accountRow).nth(2)).toContainText("BRI");
      await expect(page.locator(layout.accountRow).nth(2)).toContainText("4321");
    });
  }

  await test.step("desktop: a code of the wrong class for the parent's type is refused", async () => {
    await page.setViewportSize(DESKTOP.viewport);
    await page.goto("/accounting/accounts/new");
    const form = page.getByRole("form", { name: "Tambah akun" });
    await form.getByLabel("Akun induk").selectOption("1-1200");
    await form.getByLabel("Kode akun").fill("6-5101");
    await form.getByLabel("Nama akun").fill("Salah kelas");
    await form.getByRole("button", { name: "Simpan akun" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "tidak cocok untuk jenis Aset" }).first()).toBeVisible();
    await expect(page).toHaveURL(/\/accounting\/accounts\/new$/);
  });

  await test.step("desktop: rename, then deactivate; it leaves Kas & Bank", async () => {
    await page.goto("/accounting/accounts/1-1209");
    const form = page.getByRole("form", { name: "Ubah akun" });
    await form.getByLabel("Nama akun").fill("Bank cadangan BRI");
    await form.getByRole("button", { name: "Simpan perubahan" }).click();
    await expect(page.getByRole("heading", { name: "1-1209 Bank cadangan BRI" })).toBeVisible();
    await page.getByRole("button", { name: "Nonaktifkan akun" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Nonaktifkan" }).click();
    await expect(page.getByText("Nonaktif", { exact: true }).first()).toBeVisible();
    await checkCashBank(page, DESKTOP, ["1-1101", "1-1201"]);
  });

  await test.step("a system account offers no Nonaktifkan", async () => {
    await page.goto("/accounting/accounts/1-1501");
    await expect(page.getByText("Akun sistem dipakai jurnal otomatis")).toBeVisible();
    await expect(page.getByRole("button", { name: "Nonaktifkan akun" })).toHaveCount(0);
  });
});

test("Pemetaan akun: an unmapped category is warned on Kategori Biaya until mapped; expenses are never offered an inventory account", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_MASTER_EMAIL);
  const row = page.locator(`[data-mapping-key="expense.category.${E2E_ACCOUNTING_MASTER_CATEGORY.code}"]`);

  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(`${layout.label}: warned on Kategori Biaya and on the mapping page`, async () => {
      await page.setViewportSize(layout.viewport);
      await page.goto("/expense-categories");
      const banner = page.getByRole("region", { name: "Pemetaan akun" });
      await expect(banner).toContainText(E2E_ACCOUNTING_MASTER_CATEGORY.name);
      await expect(banner.getByRole("link", { name: "Atur pemetaan akun" })).toBeVisible();

      await page.goto("/accounting/mappings");
      await expect(page.getByRole("heading", { name: "Pemetaan Akun" })).toBeVisible();
      await expect(row).toBeVisible();
      await expect(row).toContainText("Belum dipetakan");
      // D-14: no inventory account (1-15xx) is offered for an expense.
      const options = await row.getByRole("combobox").locator("option").allTextContents();
      expect(options.some((option) => option.startsWith("6-2501"))).toBe(true);
      expect(options.some((option) => option.startsWith("1-15"))).toBe(false);
      // Payment methods are offered Kas & Bank only.
      const transferOptions = await page.locator('[data-mapping-key="cash.method.transfer"]').getByRole("combobox").locator("option").allTextContents();
      expect(transferOptions.every((option) => /^1-1[12]/.test(option))).toBe(true);
    });
  }

  await test.step("desktop: map it to Beban langganan aplikasi; the warning is gone", async () => {
    await row.getByRole("combobox").selectOption("6-2501");
    await row.getByRole("button", { name: "Simpan" }).click();
    await expect(page.getByRole("status").getByText(`Pemetaan ${E2E_ACCOUNTING_MASTER_CATEGORY.name} disimpan`)).toBeVisible();
    await expect(row).not.toContainText("Belum dipetakan");
    await page.goto(`/expense-categories/${E2E_ACCOUNTING_MASTER_CATEGORY.code}`);
    await expect(page.getByTestId("category-account")).toContainText("6-2501 Beban langganan aplikasi");
    await page.goto("/expense-categories");
    await expect(page.locator('[data-testid="expense-category-row"]').filter({ hasText: E2E_ACCOUNTING_MASTER_CATEGORY.name })).not.toContainText("Belum dipetakan");
  });
});

test("Pengaturan pajak: list at 390px and 1280px, then the rate's end date is edited", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_MASTER_EMAIL);

  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(layout.label, async () => {
      await page.setViewportSize(layout.viewport);
      await page.goto("/accounting/tax-settings");
      await expect(page.getByRole("heading", { name: "Pengaturan Pajak" })).toBeVisible();
      const initial = page.locator(layout.taxRow).filter({ hasText: "Des 2026" });
      await expect(initial).toBeVisible();
      await expect(initial).toContainText("0,5%");
      await expect(initial).toContainText("Rp 500.000.000");
      const hidden = page.locator(layout.hiddenTaxRow).filter({ hasText: "Des 2026" });
      await expect(hidden).toHaveCount(1);
      await expect(hidden).toBeHidden();
    });
  }

  await page.locator(DESKTOP.taxRow).filter({ hasText: "Des 2026" }).getByRole("link", { name: "Ubah" }).click();
  const form = page.getByRole("form", { name: "Pengaturan pajak" });
  await form.getByLabel("Tarif (%)").fill("0,125");
  await form.getByRole("button", { name: "Simpan" }).click();
  await expect(form.getByText("paling banyak 2 angka di belakang koma").first()).toBeVisible();
  await form.getByLabel("Tarif (%)").fill("0,5");
  await form.getByLabel("Tarif berlaku sampai").fill("2029-12-31");
  await form.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/accounting\/tax-settings$/);
  await expect(page.locator(DESKTOP.taxRow).filter({ hasText: "Des 2026" })).toContainText("31 Des 2029");
});

test("a view-only role reads Akun, Pemetaan akun and Pengaturan pajak without any edit control; CS gets Akses ditolak", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_VIEW_ONLY_EMAIL);
  await page.goto("/accounting/accounts");
  await expect(page.getByRole("heading", { name: "Akun", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Tambah akun" })).toHaveCount(0);
  await page.goto("/accounting/accounts/1-1201");
  await expect(page.getByRole("form", { name: "Ubah akun" })).toHaveCount(0);
  await page.goto("/accounting/accounts/new");
  await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  await page.goto("/accounting/mappings");
  await expect(page.getByRole("heading", { name: "Pemetaan Akun" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan" })).toHaveCount(0);
  await page.goto("/accounting/tax-settings");
  await expect(page.getByRole("heading", { name: "Pengaturan Pajak" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ubah" })).toHaveCount(0);

  await page.context().clearCookies();
  await loginAs(page, E2E_ACCOUNTING_CS_EMAIL);
  for (const path of ["/accounting/accounts", "/accounting/mappings", "/accounting/tax-settings"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  }
});
