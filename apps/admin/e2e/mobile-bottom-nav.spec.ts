import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_SUPER_ADMIN_EMAIL } from "./global-setup";

test.use({ viewport: { width: 390, height: 844 } });

test("mobile viewport shows the bottom nav, and the Lainnya sheet opens the rest of the items", async ({ page }) => {
  await loginAs(page, E2E_SUPER_ADMIN_EMAIL);
  await page.goto("/");

  const bottomNav = page.getByRole("navigation", { name: "Navigasi utama" });
  await expect(bottomNav).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Ringkasan" })).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Pesanan" })).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Packing" })).toBeVisible();
  await expect(bottomNav.getByRole("link", { name: "Stok" })).toBeVisible();

  await bottomNav.getByRole("button", { name: "Lainnya" }).click();
  const produkLink = page.getByRole("link", { name: "Produk", exact: true });
  await expect(produkLink).toBeVisible();
  await produkLink.click();
  await expect(page).toHaveURL(/\/produk$/);
});
