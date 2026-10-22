import { randomInt } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { issueLoginLink, seedLinkCustomer, type LinkCustomer } from "./helpers/login-link-db";
import { activeVoucherExpiries, seedClaimableCard } from "./helpers/claim-db";

// The voucher claim flow's landing (lib/claim/claimed-notice.ts): a buyer who consents and then
// claims ends up on the homepage collection with a one-time "Voucher sudah masuk ke akunmu"
// notice and the voucher's dates (usable from 1 Desember 2026 until its own expiry, in WIB). An
// explicit `next` on /consent (the claim page) is kept; none means the collection. Runs with
// the cart flag off and on (the claim flow is the same either way), at 390px and 1280px.

async function ownIp(context: BrowserContext): Promise<void> {
  // The claim page and action count views/submits per IP (lib/claim/throttle.ts).
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.19.${randomInt(0, 255)}.${randomInt(1, 254)}` });
}

async function login(page: Page, customer: LinkCustomer): Promise<void> {
  const token = await issueLoginLink(customer);
  await page.goto(`/login/link?token=${token}`);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/(orders|consent)/);
}

for (const viewport of [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
]) {
  test.describe(`claim landing (${viewport.name})`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await ownIp(context);
    });

    test("consent keeps the claim page as next, then a claim lands on /#koleksi with the notice", async ({ page }) => {
      const customer = await seedLinkCustomer("klaim-koleksi", { consented: false });
      const token = await seedClaimableCard();
      await login(page, customer);

      await page.goto(`/claim/${token}`);
      await expect(page).toHaveURL(new RegExp(`/consent\\?next=${encodeURIComponent(`/claim/${token}`)}`));
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Lanjutkan" }).click();

      // The explicit next (the claim page) wins over the collection.
      await expect(page).toHaveURL(new RegExp(`/claim/${token}$`));
      await page.getByRole("button", { name: "Klaim Sekarang" }).click();

      // Landed first: the claim has committed once the notice is up.
      const notice = page.getByTestId("voucher-claimed-notice");
      await expect(notice).toBeVisible();
      const expiries = await activeVoucherExpiries(customer.id);
      expect(expiries).toHaveLength(1);
      const expiresOn = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" }).format(expiries[0]);
      await expect(notice).toContainText(`Voucher sudah masuk ke akunmu. Bisa dipakai mulai 1 Desember 2026 sampai ${expiresOn}.`);
      await expect(notice.getByRole("link", { name: "Lihat akun" })).toHaveAttribute("href", "/account");
      // The one-time param is dropped from the address, the collection anchor stays.
      await expect(page).toHaveURL(/\/#koleksi$/);
      await expect(page.locator("#koleksi")).toBeInViewport();

      // A refresh does not show it again.
      await page.reload();
      await expect(page.getByRole("heading", { level: 2 }).first()).toBeVisible();
      await expect(page.getByTestId("voucher-claimed-notice")).toHaveCount(0);
    });

    test("consent with no next asked for lands on the collection, without the voucher notice", async ({ page }) => {
      const customer = await seedLinkCustomer("setuju-tanpa-next", { consented: false });
      await login(page, customer);

      await page.goto("/consent");
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Lanjutkan" }).click();

      await expect(page).toHaveURL(/\/#koleksi$/);
      await expect(page.locator("#koleksi")).toBeVisible();
      await expect(page.getByTestId("voucher-claimed-notice")).toHaveCount(0);
    });
  });
}
