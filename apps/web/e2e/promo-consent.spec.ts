import { randomInt } from "node:crypto";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { issueLoginLink, promoAuditActionsOf, promoConsentOf, seedLinkCustomer, setPromoConsentAt, type LinkCustomer } from "./helpers/login-link-db";

// "Kabar promo" on /account (docs/plans/growth.md owner answer A11, session S6): a logged-in buyer
// stops promo messages themselves and can start them again; each change is audited as the buyer.
// At 390px and 1280px (one column either way, but both are asserted, as for every page). Runs
// with the cart flag off and on.

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844 },
  { name: "1280px", width: 1280, height: 900 },
];

async function ownIp(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.19.${randomInt(0, 255)}.${randomInt(1, 254)}` });
}

async function login(page: Page, customer: LinkCustomer): Promise<void> {
  const token = await issueLoginLink(customer);
  await page.goto(`/login/link?token=${token}`);
  await page.getByRole("button", { name: "Masuk" }).click();
  await expect(page).toHaveURL(/\/orders$/);
}

for (const viewport of VIEWPORTS) {
  test(`Berhenti terima promo, then Terima kabar promo again (${viewport.name})`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await ownIp(context);
    const customer = await seedLinkCustomer(`promo-${viewport.name.replace("px", "")}`);
    await setPromoConsentAt(customer.id, new Date("2026-10-01T03:00:00Z"));
    await login(page, customer);

    await page.goto("/account");
    const section = page.getByTestId("account-promo");
    await expect(section.getByRole("heading", { name: "Kabar promo" })).toBeVisible();
    await expect(section.getByTestId("account-promo-state")).toContainText("sejak 1 Okt 2026");
    await expect(page.locator("body")).not.toContainText("—");

    // Stop: one press, no dialog.
    await section.getByRole("button", { name: "Berhenti terima promo" }).click();
    await expect(section.getByRole("status")).toHaveText("Kamu tidak akan menerima kabar promo lagi.");
    await expect(section.getByTestId("account-promo-state")).toContainText("Kamu tidak menerima kabar promo dari Ammari.");
    await expect(section.getByRole("button", { name: "Berhenti terima promo" })).toHaveCount(0);
    expect(await promoConsentOf(customer.id)).toBeNull();
    await page.reload();
    await expect(page.getByTestId("account-promo-state")).toContainText("Kamu tidak menerima kabar promo dari Ammari.");

    // Opt in again: the button says what it means.
    const again = page.getByTestId("account-promo");
    await expect(again).toContainText("Dengan menekan tombol ini, kamu setuju dikirimi kabar koleksi baru dan promo dari Ammari.");
    await again.getByRole("button", { name: "Terima kabar promo" }).click();
    await expect(again.getByRole("status")).toHaveText("Kamu akan menerima kabar promo dari Ammari.");
    await expect(again.getByTestId("account-promo-state")).toContainText("Kamu menerima kabar koleksi baru dan promo dari Ammari");
    expect(await promoConsentOf(customer.id)).not.toBeNull();

    expect(await promoAuditActionsOf(customer.id)).toEqual(["promo_consent_withdraw_self", "promo_consent_grant_self"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
}
