import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_LANDING_PACKING_EMAIL, E2E_OWNER_EMAIL, E2E_SUPER_ADMIN_EMAIL } from "./global-setup";

test("super_admin sees every nav item, including Peran & Staf and Log Aktivitas", async ({ page }) => {
  await loginAs(page, E2E_SUPER_ADMIN_EMAIL);
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(nav.getByRole("link", { name: "Peran & Staf" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Log Aktivitas" })).toBeVisible();
});

// Owner answer 2 (docs/plans/roles-staff.md): the owner holds staff.manage since migration 0041,
// but still not audit_log.view.
test("owner sees Peran & Staf but not Log Aktivitas, and /activity-log is forbidden", async ({ page }) => {
  await loginAs(page, E2E_OWNER_EMAIL);
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(nav.getByRole("link", { name: "Peran & Staf" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Log Aktivitas" })).toHaveCount(0);

  await page.goto("/roles-staff");
  await expect(page.getByRole("heading", { name: "Akses ditolak" })).toHaveCount(0);

  await page.goto("/activity-log");
  await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
});

// Owner answer 6: a role without overview.view lands on its work queue after login (both login
// methods send people to "/"), instead of "Akses ditolak". Both layouts.
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test(`Packing/Gudang lands on /packing from / and has no Ringkasan (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await loginAs(page, E2E_LANDING_PACKING_EMAIL);
    await page.goto("/");

    await expect(page).toHaveURL(/\/packing$/);
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toHaveCount(0);
    const nav = page.getByRole("navigation", { name: "Navigasi utama" });
    await expect(nav.getByRole("link", { name: "Packing" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Ringkasan" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Peran & Staf" })).toHaveCount(0);
  });
}
