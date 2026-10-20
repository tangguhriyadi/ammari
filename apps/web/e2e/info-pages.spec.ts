import { expect, test } from "@playwright/test";
import { E2E_BUSINESS_ADDRESS, E2E_SHIPPING_BODY_TEXT, E2E_SUPPORT_EMAIL, E2E_WHATSAPP_FORMATTED, E2E_WHATSAPP_NUMBER } from "./storefront-fixtures";

// docs/plans/storefront-cms.md Phase 2 (session 8): the 5 info pages read from `info_pages`
// instead of hard-coded JSX, an unpublished page shows "sedang disiapkan" (never a 500), and the
// footer's contact block reads from `store_settings` — all at both 390px (CLAUDE.md's mobile
// rule) and the Playwright project default desktop viewport, Chromium + WebKit (this app's
// existing convention).

test.describe("info pages — published vs unpublished", () => {
  test("a published page (shipping, seeded by storefront-fixtures.ts) renders its body, at 390px and 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/shipping");
    await expect(page.getByRole("heading", { level: 1, name: "Pengiriman" })).toBeVisible();
    await expect(page.getByText(E2E_SHIPPING_BODY_TEXT)).toBeVisible();
    await expect(page.getByText("sedang disiapkan")).not.toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/shipping");
    await expect(page.getByRole("heading", { level: 1, name: "Pengiriman" })).toBeVisible();
    await expect(page.getByText(E2E_SHIPPING_BODY_TEXT)).toBeVisible();
  });

  test("an unpublished page (how-to-order, left at migration 0020's seeded state) shows 'sedang disiapkan', never a 500, at 390px and 1280px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto("/how-to-order");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Cara Pemesanan" })).toBeVisible();
    await expect(page.getByText(/sedang disiapkan/)).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    const desktopResponse = await page.goto("/how-to-order");
    expect(desktopResponse?.status()).toBe(200);
    await expect(page.getByText(/sedang disiapkan/)).toBeVisible();
  });

  test("returns-exchange (also left unpublished) shows 'sedang disiapkan' too — not just how-to-order", async ({ page }) => {
    await page.goto("/returns-exchange");
    await expect(page.getByRole("heading", { level: 1, name: "Pengembalian & Penukaran" })).toBeVisible();
    await expect(page.getByText(/sedang disiapkan/)).toBeVisible();
  });

  test("privacy-policy and terms-of-service keep their exact URLs and render migrated (already-published) content, not a blank page", async ({
    page,
  }) => {
    const privacy = await page.goto("/privacy-policy");
    expect(privacy?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Kebijakan Privasi" })).toBeVisible();
    await expect(page.getByText(/Undang-Undang Pelindungan Data Pribadi/)).toBeVisible();

    const terms = await page.goto("/terms-of-service");
    expect(terms?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Syarat & Ketentuan" })).toBeVisible();
    await expect(page.getByText(/aturan voucher dan belanja/)).toBeVisible();
  });
});

test.describe("footer contact block (store_settings)", () => {
  test("renders the formatted WhatsApp number (not the bare word)/email/address once store_settings is filled in, at 390px and 1280px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByText("Hubungi kami")).toBeVisible();
    await expect(page.getByRole("link", { name: E2E_WHATSAPP_FORMATTED })).toHaveAttribute("href", new RegExp(`^https://wa\\.me/${E2E_WHATSAPP_NUMBER}`));
    await expect(page.getByRole("link", { name: E2E_SUPPORT_EMAIL })).toHaveAttribute("href", `mailto:${E2E_SUPPORT_EMAIL}`);
    await expect(page.getByText(E2E_BUSINESS_ADDRESS)).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await expect(page.getByText("Hubungi kami")).toBeVisible();
    await expect(page.getByRole("link", { name: E2E_WHATSAPP_FORMATTED })).toHaveAttribute("href", new RegExp(`^https://wa\\.me/${E2E_WHATSAPP_NUMBER}`));
    await expect(page.getByText(E2E_BUSINESS_ADDRESS)).toBeVisible();
  });

  test("the return-policy summary is no longer in the PDP trust row (it moved into the accordion)", async ({ page }) => {
    await page.goto("/products/gamis-flowy-straight-e2e");
    await expect(page.getByRole("list").filter({ hasText: "Proses Cepat" }).getByText("Tukar ukuran gratis dalam 3 hari E2E")).toHaveCount(0);
  });

  test("the PDP 'Pengiriman & pengembalian' accordion links out to /shipping and /returns-exchange instead of hard-coding either policy", async ({
    page,
  }) => {
    await page.goto("/products/gamis-flowy-straight-e2e");
    await page.getByRole("button", { name: "Pengiriman & Pengembalian" }).click();
    await expect(page.getByRole("link", { name: "Lihat kebijakan pengiriman" })).toHaveAttribute("href", "/shipping");
    await expect(page.getByRole("link", { name: /kebijakan pengembalian/ })).toHaveAttribute("href", "/returns-exchange");
  });
});
