import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_ACTIVITY_LOG_ADMIN_EMAIL,
  E2E_ACTIVITY_LOG_OWNER_EMAIL,
  E2E_ACTIVITY_LOG_SUPPLIER_NAME,
  E2E_ACTIVITY_LOG_TOKEN_HASH,
  E2E_ACTIVITY_LOG_UNKNOWN_ACTION,
} from "./global-setup";

// docs/plans/activity-log.md §5. Both list layouts (390px cards, 1280px table), per CLAUDE.md.
// The three audit rows read here are seeded by global-setup.ts.

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Activity rows of whichever layout is displayed at this viewport. */
function rows(page: Page) {
  return page.locator('[data-testid="activity-row"]:visible');
}

for (const viewport of VIEWPORTS) {
  test(`super_admin reads, filters and opens activity entries (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await loginAs(page, E2E_ACTIVITY_LOG_ADMIN_EMAIL);

    await page.goto("/activity-log");
    await expect(page.getByRole("heading", { name: "Log Aktivitas", exact: true })).toBeVisible();

    // Default view: the seeded rows, with staff, buyer and unknown-key rendering.
    const supplierRow = rows(page).filter({ hasText: "Supplier diubah" });
    await expect(supplierRow).toHaveCount(1);
    await expect(supplierRow).toContainText("E2E Log Super Admin");
    await expect(supplierRow).toContainText(E2E_ACTIVITY_LOG_ADMIN_EMAIL);
    await expect(supplierRow.getByRole("link", { name: E2E_ACTIVITY_LOG_SUPPLIER_NAME })).toHaveAttribute("href", new RegExp(`^/suppliers/${UUID}$`));
    await expect(rows(page).filter({ hasText: "Voucher diklaim dari kartu" })).toContainText("Pembeli");
    const unknownRow = rows(page).filter({ hasText: E2E_ACTIVITY_LOG_UNKNOWN_ACTION });
    await expect(unknownRow).toContainText("e2e_widget");
    await expect(unknownRow).toContainText("Lainnya");

    // Combined filters, all kept in the URL.
    await page.getByLabel("Cari data").fill(E2E_ACTIVITY_LOG_SUPPLIER_NAME);
    await page.getByLabel("Bagian").selectOption({ label: "Produksi & Pembelian" });
    await page.getByLabel("Pelaku").selectOption({ label: "E2E Log Super Admin" });
    await page.getByRole("button", { name: "Terapkan" }).click();
    await expect(page).toHaveURL(new RegExp(`area=production.*q=E2E`));
    await expect(page).toHaveURL(new RegExp(`actor=${UUID}`));
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText("Supplier diubah");
    await expect(page.getByRole("link", { name: "Unduh CSV" })).toHaveAttribute("href", /^\/activity-log\/export\?.*area=production/);

    // A filter that matches nothing.
    await page.goto("/activity-log?area=import");
    await expect(page.getByText("Tidak ada aktivitas yang cocok")).toBeVisible();

    // Detail: field-by-field diff with Indonesian labels; unchanged fields collapsed.
    await page.goto(`/activity-log?q=${encodeURIComponent(E2E_ACTIVITY_LOG_SUPPLIER_NAME)}`);
    await rows(page).getByRole("link", { name: "Supplier diubah" }).click();
    await expect(page).toHaveURL(new RegExp(`/activity-log/${UUID}$`));
    await expect(page.getByRole("heading", { name: "Supplier diubah" })).toBeVisible();
    const nameRow = page.locator('[data-testid="diff-row"]:visible').filter({ hasText: "Nama" });
    await expect(nameRow).toContainText("E2E Log Supplier Lama");
    await expect(nameRow).toContainText(E2E_ACTIVITY_LOG_SUPPLIER_NAME);
    await expect(page.getByText("3 field tidak berubah")).toBeVisible();

    // A card claim: the token hash is never rendered.
    await page.goto("/activity-log?area=cards&actor=system");
    await rows(page).getByRole("link", { name: "Voucher diklaim dari kartu" }).click();
    await expect(page.getByText("Kartu ucapan", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("(disembunyikan)").first()).toBeAttached();
    expect(await page.content()).not.toContain(E2E_ACTIVITY_LOG_TOKEN_HASH);

    // Read-only: no edit or delete control anywhere on the detail page.
    await expect(page.locator("main").getByRole("button", { name: /hapus|ubah|edit/i })).toHaveCount(0);
  });

  test(`owner (no audit_log.view) gets 403 on the page, the detail and the CSV (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await loginAs(page, E2E_ACTIVITY_LOG_OWNER_EMAIL);
    for (const path of ["/activity-log", "/activity-log?area=orders", "/activity-log/00000000-0000-4000-8000-000000000001"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: "Akses ditolak" }), path).toBeVisible();
    }
    const csv = await page.request.get("/activity-log/export");
    expect(csv.status()).toBe(403);
    // The nav never offers it either.
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Log Aktivitas" })).toHaveCount(0);
  });
}
