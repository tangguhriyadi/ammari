import { expect, test, type Browser, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_CONTENT_ADMIN_EMAIL,
  E2E_ROLES_STAFF_ADMIN_EMAIL,
  E2E_ROLES_STAFF_OWNER_EMAIL,
  E2E_ROLES_STAFF_PACKING_EMAIL,
  E2E_SUPER_ADMIN_EMAIL,
} from "./global-setup";

// docs/plans/roles-staff.md §10 e2e 12 to 16 (sessions S3 and S4). Both list layouts (390px
// cards, 1280px table) for every list this touches, per CLAUDE.md. Each role has its own fixture
// email (global-setup.ts) so no other spec's OTP throttle budget is spent here; every invitee is a
// fresh address under the e2e-only suffix.

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The one staff row for `email` in whichever layout is displayed at this viewport. */
function staffRow(page: Page, email: string) {
  return page.locator('[data-testid="staff-row"]:visible').filter({ hasText: email });
}

async function openStaff(page: Page, email: string): Promise<void> {
  await staffRow(page, email).getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/roles-staff/staff/${UUID}$`));
}

/** A second, independent browser session (the invitee's own phone). */
async function newSession(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  return context.newPage();
}

for (const viewport of VIEWPORTS) {
  test(`super_admin invites, the invitee logs in, is moved to Packing/Gudang, then deactivated (${viewport.width}px)`, async ({ page, browser }) => {
    await page.setViewportSize(viewport);
    await loginAs(page, E2E_ROLES_STAFF_ADMIN_EMAIL);
    const email = `undangan-${viewport.width}-${Date.now()}@e2e.ammari.test`;

    // e2e 12: invite, shown as "Undangan" with the WhatsApp reminder.
    await page.goto("/roles-staff");
    await page.getByRole("button", { name: "Undang staf" }).click();
    const dialog = page.getByRole("dialog", { name: "Undang staf" });
    await dialog.locator("#invite-name").fill("Rina Keuangan");
    await dialog.locator("#invite-email").fill(email);
    await dialog.locator("#invite-role").selectOption({ label: "Keuangan" });
    await expect(dialog.getByText("Bisa lihat laba")).toBeVisible();
    await dialog.getByRole("button", { name: "Kirim undangan" }).click();

    const notice = page.getByTestId("invite-notice");
    await expect(notice).toContainText("Undangan dibuat. Berlaku sampai", { timeout: 15_000 });
    await expect(notice.getByTestId("whatsapp-reminder")).toContainText(email);
    await expect(staffRow(page, email)).toHaveCount(1);
    await expect(staffRow(page, email).getByTestId("staff-status")).toHaveText("Undangan");
    await expect(staffRow(page, email)).toContainText("Belum pernah masuk");

    // The invitee logs in on their own device: "Aktif" with a last login time.
    const invitee = await newSession(browser);
    await invitee.setViewportSize(viewport);
    await loginAs(invitee, email);
    await invitee.goto("/");
    await expect(invitee.getByRole("heading", { name: "Akses ditolak" })).toHaveCount(0);

    await page.reload();
    await expect(staffRow(page, email).getByTestId("staff-status")).toHaveText("Aktif");
    await expect(staffRow(page, email)).not.toContainText("Belum pernah masuk");

    // e2e 13: role change, live on the invitee's next navigation.
    await openStaff(page, email);
    await page.locator("#staff-role").selectOption({ label: "Packing/Gudang" });
    const confirmRole = page.getByRole("dialog", { name: "Ganti peran?" });
    await expect(confirmRole).toContainText("Perubahan berlaku langsung.");
    await confirmRole.getByRole("button", { name: "Ganti peran" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("dl")).toContainText("Packing/Gudang");

    await invitee.goto("/");
    await expect(invitee).toHaveURL(/\/packing$/);
    const inviteeNav = invitee.getByRole("navigation", { name: "Navigasi utama" });
    await expect(inviteeNav.getByRole("link", { name: "Packing" })).toBeVisible();
    await expect(inviteeNav.getByRole("link", { name: "Ringkasan" })).toHaveCount(0);

    // e2e 14: deactivate; the open session is gone and logging in again fails.
    await page.getByRole("button", { name: "Nonaktifkan" }).click();
    const confirmDeactivate = page.getByRole("dialog", { name: "Nonaktifkan akun?" });
    await expect(confirmDeactivate).toContainText("tidak bisa masuk lagi");
    await confirmDeactivate.getByRole("button", { name: "Nonaktifkan" }).click();
    await expect(page.getByTestId("staff-status")).toHaveText("Nonaktif");
    await expect(page.getByRole("button", { name: "Aktifkan kembali" })).toBeVisible();

    await invitee.goto("/packing");
    await expect(invitee).toHaveURL(/\/login/);
    // The sign-in backdoor runs the real OTP send: a deactivated address gets no code, exactly
    // like an unknown one (the login form shows the same generic step either way).
    await expect(loginAs(invitee, email)).rejects.toThrow(/otp_not_captured/);
    await invitee.context().close();

    await page.goto("/roles-staff?status=nonaktif");
    await expect(staffRow(page, email).getByTestId("staff-status")).toHaveText("Nonaktif");
  });

  test(`the owner manages staff within her own permissions and reads roles without editing (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await loginAs(page, E2E_ROLES_STAFF_OWNER_EMAIL);

    await page.goto("/roles-staff");
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toHaveCount(0);
    // Her own row is marked, and she can't act on herself.
    await expect(staffRow(page, E2E_ROLES_STAFF_OWNER_EMAIL)).toContainText("(Anda)");

    // The invite form never offers Super Admin.
    await page.getByRole("button", { name: "Undang staf" }).click();
    const roleOptions = await page.locator("#invite-role option").allTextContents();
    expect(roleOptions).toEqual(expect.arrayContaining(["Owner", "Packing/Gudang", "Admin Konten", "CS/Pesanan", "Keuangan"]));
    expect(roleOptions).not.toContain("Super Admin");
    await page.getByRole("dialog", { name: "Undang staf" }).getByRole("button", { name: "Batal" }).click();

    // A super_admin's page shows no actions at all, only why.
    await openStaff(page, E2E_SUPER_ADMIN_EMAIL);
    await expect(page.getByTestId("staff-manage-refused")).toHaveText("Hanya Super Admin yang bisa mengubah akun Super Admin.");
    await expect(page.getByRole("button", { name: "Nonaktifkan" })).toHaveCount(0);
    await expect(page.locator("#staff-role")).toHaveCount(0);

    // e2e 15: the Peran tab, read-only, in both layouts.
    await page.goto("/roles-staff?tab=peran");
    const financeRow = page.locator('[data-testid="role-row"]:visible').filter({ hasText: "Keuangan" });
    await expect(financeRow).toHaveCount(1);
    await expect(financeRow).toContainText("Bisa lihat laba");
    await expect(page.getByRole("link", { name: "Buat peran" })).toHaveCount(0);

    await financeRow.getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/roles-staff/roles/${UUID}$`));
    await expect(page.getByTestId("role-read-only")).toHaveText("Hanya Super Admin yang bisa mengubah peran dan izinnya.");
    const matrix = page.getByTestId("permission-matrix");
    for (const area of ["Pesanan", "Stok", "Keuangan", "Konten", "Pengaturan", "Staf & Akses"]) {
      await expect(matrix.getByRole("heading", { name: area, exact: true })).toBeVisible();
    }
    await expect(matrix.locator('[data-permission="finance.view_profit"]')).toContainText("Sensitif");
    await expect(matrix.locator('[data-permission="finance.view_profit"]')).toContainText("Diizinkan");
    await expect(matrix.locator('[data-permission="roles.manage"]')).toContainText("Sensitif");
    await expect(matrix.locator('[data-permission="roles.manage"]')).toContainText("Tidak");
    await expect(matrix.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Simpan perubahan" })).toHaveCount(0);
  });
}

test("super_admin creates a role, adds a sensitive permission after a confirmation summary, and can't edit Super Admin", async ({ page }) => {
  await loginAs(page, E2E_ROLES_STAFF_ADMIN_EMAIL);
  const roleName = `E2E Peran ${Date.now()}`;

  await page.goto("/roles-staff?tab=peran");
  await page.getByRole("link", { name: "Buat peran" }).click();
  await page.locator("#role-name").fill(roleName);
  await page.getByRole("checkbox", { name: "Lihat stok produk" }).check();
  // Never grantable outside super_admin (§11a).
  await expect(page.getByRole("checkbox", { name: "Kelola peran dan izin" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Lihat log aktivitas" })).toBeDisabled();
  await page.getByRole("button", { name: "Buat peran" }).click();

  const createDialog = page.getByRole("dialog", { name: "Buat peran ini?" });
  await expect(createDialog.getByTestId("role-change-summary")).toContainText("Lihat stok produk");
  await createDialog.getByRole("button", { name: "Buat peran" }).click();
  await expect(page).toHaveURL(new RegExp(`/roles-staff/roles/${UUID}$`), { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: roleName })).toBeVisible();

  const profit = page.getByRole("checkbox", { name: "Lihat HPP, laba, biaya, dan pencairan" });
  await profit.check();
  await page.getByRole("checkbox", { name: "Lihat stok produk" }).uncheck();
  await page.getByRole("button", { name: "Simpan perubahan" }).click();
  const saveDialog = page.getByRole("dialog", { name: "Simpan perubahan peran?" });
  const summary = saveDialog.getByTestId("role-change-summary");
  await expect(summary).toContainText("Izin ditambah");
  await expect(summary).toContainText("Lihat HPP, laba, biaya, dan pencairan (Sensitif)");
  await expect(summary).toContainText("Izin dihapus");
  await expect(summary).toContainText("Lihat stok produk");
  await saveDialog.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

  await page.reload();
  await expect(profit).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Lihat stok produk" })).not.toBeChecked();

  // The role is listed with its count, and Super Admin stays read-only even for a super_admin.
  await page.goto("/roles-staff?tab=peran");
  await expect(page.locator('[data-testid="role-row"]:visible').filter({ hasText: roleName })).toContainText("Bisa lihat laba");
  await page.locator('[data-testid="role-row"]:visible').filter({ hasText: "Super Admin" }).getByRole("link").first().click();
  await expect(page.getByTestId("role-read-only")).toHaveText("Super Admin selalu punya semua izin.");
  await expect(page.getByTestId("permission-matrix").getByRole("checkbox")).toHaveCount(0);
});

// e2e 16. A direct server-action call is covered in roles-staff/actions.test.ts (it needs Next's
// action id); here every page of the feature refuses.
test("a staffer without staff.manage or roles.manage gets 403 on every Peran & Staf page", async ({ page }) => {
  await loginAs(page, E2E_ROLES_STAFF_PACKING_EMAIL);
  const someId = "00000000-0000-4000-8000-000000000001";
  for (const path of ["/roles-staff", "/roles-staff?tab=peran", `/roles-staff/staff/${someId}`, `/roles-staff/roles/${someId}`, "/roles-staff/roles/new"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Akses ditolak" }), path).toBeVisible();
  }
});

// Owner answer 5 (S4): Admin Konten opens the product list (both layouts) but can't add products.
for (const viewport of VIEWPORTS) {
  test(`Admin Konten opens the product list without "Tambah produk" (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await loginAs(page, E2E_CONTENT_ADMIN_EMAIL);
    await page.goto("/products");
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Produk", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Tambah produk" })).toHaveCount(0);
    await expect(page.locator('main a[href^="/products/"]:visible').first()).toBeVisible();

    await page.locator('main a[href^="/products/"]:visible').first().click();
    await expect(page).toHaveURL(new RegExp(`/products/${UUID}`));
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toHaveCount(0);
  });
}
