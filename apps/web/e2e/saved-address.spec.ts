import { randomInt } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { CART_E2E } from "./helpers/cart-flag";
import { clearCheckoutRateLimits, seedCheckoutProduct } from "./helpers/checkout-db";
import { issueLoginLink, seedLinkCustomer, type LinkCustomer } from "./helpers/login-link-db";
import { orderAddressesOf, savedAddressCount, seedSavedAddress } from "./helpers/saved-address-db";

// "Alamat tersimpan" on /account: a logged-in buyer sees the address their last order saved and
// deletes it themselves (the privacy policy promises it). The order keeps its own address, and the
// next checkout starts with the empty address form. With the cart flag off the section shows only
// while an address exists. Fake shipping and payment providers only (playwright.config.ts).

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

async function ownIp(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}` });
}

async function login(page: Page, customer: LinkCustomer): Promise<void> {
  const token = await issueLoginLink(customer);
  await page.goto(`/login/link?token=${token}`);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);
}

async function openCheckout(page: Page, slug: string): Promise<void> {
  await page.goto(`/products/${slug}`);
  await page.getByRole("button", { name: "M", exact: true }).click();
  await page.getByRole("button", { name: "Beli sekarang" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.locator("form[data-hydrated]")).toHaveCount(1);
}

test.describe("saved address on /account, flag on", () => {
  test.skip(!CART_E2E, "run with pnpm test:e2e:cart");

  test.beforeEach(async ({ context }) => {
    await clearCheckoutRateLimits();
    await ownIp(context);
  });

  for (const viewport of VIEWPORTS) {
    test(`an order saves the address; Hapus alamat deletes it; the next checkout has the empty form (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const customer = await seedLinkCustomer(`hapus-${viewport.name.replace("px", "")}`);
      const product = await seedCheckoutProduct({ label: `Hapus ${viewport.name}` });
      await login(page, customer);

      // No address yet: the section explains how one is saved, no form.
      await page.goto("/account");
      const section = page.getByTestId("account-saved-address");
      await expect(section.getByRole("heading", { name: "Alamat tersimpan" })).toBeVisible();
      await expect(section).toContainText("Alamat pengiriman tersimpan otomatis saat kamu memesan sambil masuk ke akun.");
      await expect(section.getByRole("button", { name: "Hapus alamat" })).toHaveCount(0);
      await expect(section.getByRole("textbox")).toHaveCount(0);

      // A logged-in order saves its address.
      await openCheckout(page, product.slug);
      await page.getByLabel("Nomor WhatsApp").fill("0812 7777 8888");
      await page.getByLabel("Nama penerima").fill("Rina Wati");
      await page.getByLabel("Nomor HP penerima").fill("0812 3456 7890");
      await page.getByLabel("Alamat lengkap").fill("Jl. Melati No. 5, RT 02/RW 03, Kel. Sukamaju");
      await page.getByRole("combobox", { name: "Kecamatan atau kode pos" }).fill("e2e jauh");
      await page.getByRole("option", { name: /Kecamatan E2E Jauh/ }).click();
      await expect(page.getByTestId("summary-total")).toHaveText("Rp325.000");
      await page.getByLabel(/Saya setuju dengan/).check();
      await page.getByRole("button", { name: "Bayar sekarang" }).click();
      await expect(page).toHaveURL(/\/api\/test\/payments\//);
      await page.getByTestId("fake-payment-pay").click();
      await expect(page.getByTestId("finish-heading")).toHaveText("Pembayaran berhasil");
      expect(await savedAddressCount(customer.id)).toBe(1);

      // /account shows it.
      await page.goto("/account");
      const card = page.getByTestId("account-saved-address-card");
      await expect(card).toContainText("Rina Wati");
      await expect(card).toContainText("+6281234567890");
      await expect(card).toContainText("Jl. Melati No. 5, RT 02/RW 03, Kel. Sukamaju");
      await expect(card).toContainText(/Kecamatan E2E Jauh/);

      // "Batal" keeps it.
      await section.getByRole("button", { name: "Hapus alamat" }).click();
      const dialog = page.getByRole("dialog", { name: "Hapus alamat tersimpan?" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Batal" }).click();
      await expect(dialog).toBeHidden();
      await expect(section.getByRole("button", { name: "Hapus alamat" })).toBeFocused();
      expect(await savedAddressCount(customer.id)).toBe(1);

      // "Hapus" deletes it.
      await section.getByRole("button", { name: "Hapus alamat" }).click();
      await dialog.getByRole("button", { name: "Hapus", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(section.getByRole("status")).toHaveText("Alamat tersimpan sudah dihapus.");
      await expect(section.getByRole("status")).toBeFocused();
      await expect(card).toHaveCount(0);
      await expect(section).toContainText("Belum ada alamat tersimpan.");
      expect(await savedAddressCount(customer.id)).toBe(0);

      // The order keeps its own address.
      expect(await orderAddressesOf(customer.email)).toEqual([{ recipientName: "Rina Wati", addressLine: "Jl. Melati No. 5, RT 02/RW 03, Kel. Sukamaju" }]);

      // Still gone after a reload.
      await page.reload();
      await expect(page.getByTestId("account-saved-address")).toContainText("Belum ada alamat tersimpan.");
      await expect(page.getByTestId("account-saved-address-card")).toHaveCount(0);

      // The next checkout: no saved-address card, the empty address form.
      await openCheckout(page, product.slug);
      await expect(page.getByTestId("saved-address")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Pakai alamat tersimpan" })).toHaveCount(0);
      await expect(page.getByLabel("Alamat lengkap")).toHaveValue("");
      await expect(page.getByRole("combobox", { name: "Kecamatan atau kode pos" })).toHaveValue("");
      await expect(page.getByTestId("picked-area")).toHaveCount(0);
      await expect(page.getByLabel("Nama penerima")).not.toHaveValue("Rina Wati");
    });
  }
});

test.describe("saved address on /account, flag off (the shipped default)", () => {
  test.skip(CART_E2E, "flag-off behaviour");

  test.beforeEach(async ({ context }) => {
    await ownIp(context);
  });

  for (const viewport of VIEWPORTS) {
    test(`no section without an address; a saved one still shows and deletes (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const customer = await seedLinkCustomer(`alamat-off-${viewport.name.replace("px", "")}`);
      await login(page, customer);

      await page.goto("/account");
      await expect(page.getByRole("heading", { name: "Akun Saya" })).toBeVisible();
      await expect(page.getByTestId("account-saved-address")).toHaveCount(0);

      await seedSavedAddress(customer.id, "Dewi Lestari");
      await page.reload();
      const section = page.getByTestId("account-saved-address");
      await expect(page.getByTestId("account-saved-address-card")).toContainText("Dewi Lestari");
      await expect(page.getByTestId("account-saved-address-card")).toContainText("Kecamatan E2E Alamat, Kota E2E, Jawa Barat 40111");

      await section.getByRole("button", { name: "Hapus alamat" }).click();
      await page.getByRole("dialog", { name: "Hapus alamat tersimpan?" }).getByRole("button", { name: "Hapus", exact: true }).click();
      await expect(section.getByRole("status")).toHaveText("Alamat tersimpan sudah dihapus.");
      expect(await savedAddressCount(customer.id)).toBe(0);

      await page.reload();
      await expect(page.getByRole("heading", { name: "Akun Saya" })).toBeVisible();
      await expect(page.getByTestId("account-saved-address")).toHaveCount(0);
    });
  }
});
