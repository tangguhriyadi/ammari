import { expect, test } from "@playwright/test";

// docs/design/storefront.md §4 "Header": desktop is wordmark left, account right, nothing in the
// center (the old center "Koleksi" nav link is gone); mobile is unchanged (menu left, centered
// wordmark, account right, Koleksi inside the menu).
test.describe("header", () => {
  test("desktop (1280px): no center nav, wordmark at the left gutter, account at the right gutter", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const header = page.locator("header");

    await expect(header.getByRole("navigation")).toHaveCount(0);
    await expect(header.getByRole("link", { name: /koleksi/i })).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Buka menu" })).toBeHidden();

    const logo = header.getByRole("link", { name: "Ammari, beranda" }).locator("visible=true");
    await expect(logo).toHaveCount(1);
    const account = header.getByRole("link", { name: "Akun saya" });
    const logoBox = (await logo.boundingBox())!;
    const accountBox = (await account.boundingBox())!;
    // 40px desktop gutter on both sides (Container), so the two ends mirror each other.
    expect(logoBox.x).toBe(40);
    expect(1280 - (accountBox.x + accountBox.width)).toBe(40);
    // Both vertically centred in the 56px header.
    const headerBox = (await header.boundingBox())!;
    expect(headerBox.height).toBe(56);
    expect(Math.abs(logoBox.y + logoBox.height / 2 - (headerBox.y + 28))).toBeLessThanOrEqual(1);
    expect(Math.abs(accountBox.y + accountBox.height / 2 - (headerBox.y + 28))).toBeLessThanOrEqual(1);
  });

  test("mobile (390px): unchanged, menu button left, centred wordmark, Koleksi in the menu", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const header = page.locator("header");

    const logo = header.getByRole("link", { name: "Ammari, beranda" }).locator("visible=true");
    const logoBox = (await logo.boundingBox())!;
    expect(Math.abs(logoBox.x + logoBox.width / 2 - 195)).toBeLessThanOrEqual(1);

    await header.getByRole("button", { name: "Buka menu" }).click();
    await expect(header.getByRole("navigation", { name: "Navigasi utama" }).getByRole("link", { name: "Koleksi" })).toBeVisible();
  });
});
