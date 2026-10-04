import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_OWNER_EMAIL, E2E_SUPER_ADMIN_EMAIL } from "./global-setup";

test("super_admin sees every nav item, including Peran & Staf and Log Aktivitas", async ({ page }) => {
  await loginAs(page, E2E_SUPER_ADMIN_EMAIL);
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(nav.getByRole("link", { name: "Peran & Staf" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Log Aktivitas" })).toBeVisible();
});

test("owner does not see Peran & Staf or Log Aktivitas, and direct navigation is forbidden", async ({ page }) => {
  await loginAs(page, E2E_OWNER_EMAIL);
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(nav.getByRole("link", { name: "Peran & Staf" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Log Aktivitas" })).toHaveCount(0);

  await page.goto("/roles-staff");
  await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
});
