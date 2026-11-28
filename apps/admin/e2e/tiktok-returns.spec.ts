import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_IMPORT_NO_FINANCE_EMAIL, E2E_TIKTOK_ADMIN_EMAIL, E2E_TIKTOK_REQUEST_ORDER_NO, E2E_TIKTOK_RETURN_1280_ORDER_NO, E2E_TIKTOK_RETURN_390_ORDER_NO } from "./global-setup";

// TikTok cancellations and returns (docs/plans/tiktok-shop-integration.md T6), at 390px (CardList)
// and 1280px (TableContainer), CLAUDE.md. global-setup.ts seeds two parcels on their way back (one
// per viewport: each viewport presses "Retur diterima" on its own order), and one delivered order
// with two requests waiting for the seller (due in 3 h and in 30 h) plus one the rules could not
// classify (a replacement).

const VIEWPORTS = [
  { name: "390", width: 390, height: 844, returnOrderNo: E2E_TIKTOK_RETURN_390_ORDER_NO },
  { name: "1280", width: 1280, height: 800, returnOrderNo: E2E_TIKTOK_RETURN_1280_ORDER_NO },
] as const;

/** The rows of one section in the layout the viewport shows: phone cards below md, the table from md up. */
function rows(section: Locator, desktop: boolean): Locator {
  return desktop ? section.locator("table tbody tr").filter({ visible: true }) : section.locator("ul.md\\:hidden > li").filter({ visible: true });
}

async function open(page: Page) {
  await page.goto("/orders/tiktok-returns");
  await expect(page.getByRole("heading", { level: 1, name: "Retur dan pembatalan TikTok" })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  const desktop = viewport.width >= 768;
  test.describe(`TikTok returns at ${viewport.name}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await loginAs(page, E2E_TIKTOK_ADMIN_EMAIL);
    });

    // Before this viewport's own "Retur diterima", so its parcel is still listed.
    test("staff with orders.view but not orders.manage see the lists but no Retur diterima", async ({ page, context }) => {
      await context.clearCookies();
      await loginAs(page, E2E_IMPORT_NO_FINANCE_EMAIL);
      await open(page);
      const inTransit = page.getByTestId("tiktok-in-transit");
      await expect(rows(inTransit, desktop).filter({ hasText: viewport.returnOrderNo })).toHaveCount(1);
      await expect(page.getByRole("button", { name: /^Retur diterima/ })).toHaveCount(0);
    });

    test("the deadline list shows requests to answer in Seller Center, soonest first, the urgent one marked", async ({ page }) => {
      await open(page);
      const due = rows(page.getByTestId("tiktok-response-due"), desktop);
      await expect(due).toHaveCount(2);
      await expect(due.nth(0)).toContainText(E2E_TIKTOK_REQUEST_ORDER_NO);
      await expect(due.nth(0)).toContainText("Retur barang dan dana");
      await expect(due.nth(0).getByTestId("tiktok-response-deadline")).toContainText(/^Sebelum \S+, \d{1,2} \S+ \d{2}\.\d{2}Segera$/);
      await expect(due.nth(1)).toContainText("Pembatalan");
      await expect(due.nth(1).getByText("Segera")).toHaveCount(0);

      const person = rows(page.getByTestId("tiktok-needs-person"), desktop);
      await expect(person).toHaveCount(1);
      await expect(person.first()).toContainText("Permintaan tukar barang");
    });

    test("Retur diterima puts the parcel's order to Retur and takes it off the list", async ({ page }) => {
      await open(page);
      const inTransit = page.getByTestId("tiktok-in-transit");
      const mine = rows(inTransit, desktop).filter({ hasText: viewport.returnOrderNo });
      await expect(mine).toHaveCount(1);
      await mine.getByRole("button", { name: `Retur diterima untuk ${viewport.returnOrderNo}` }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText(`Paket ${viewport.returnOrderNo} sudah diterima?`);
      await dialog.getByRole("button", { name: "Ya, paket sudah diterima" }).click();
      await expect(page.getByText(`Retur ${viewport.returnOrderNo} dicatat. Stok sudah dikembalikan.`)).toBeVisible();
      await expect(rows(inTransit, desktop).filter({ hasText: viewport.returnOrderNo })).toHaveCount(0);

      // The order is now Retur; the order page no longer offers the button.
      await page.goto(`/orders?q=${encodeURIComponent(viewport.returnOrderNo)}`);
      const listed = desktop ? page.locator("table tbody tr").filter({ visible: true, hasText: viewport.returnOrderNo }) : page.locator("ul.md\\:hidden > li").filter({ visible: true, hasText: viewport.returnOrderNo });
      await expect(listed.getByText("Retur", { exact: true })).toBeVisible();
      await listed.getByRole("link").first().click();
      await expect(page.getByRole("heading", { level: 1, name: viewport.returnOrderNo })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Retur diterima/ })).toHaveCount(0);
    });

    test("the order page lists the TikTok requests with their deadline", async ({ page }) => {
      await page.goto(`/orders?q=${encodeURIComponent(E2E_TIKTOK_REQUEST_ORDER_NO)}`);
      const listed = desktop ? page.locator("table tbody tr").filter({ visible: true, hasText: E2E_TIKTOK_REQUEST_ORDER_NO }) : page.locator("ul.md\\:hidden > li").filter({ visible: true, hasText: E2E_TIKTOK_REQUEST_ORDER_NO });
      await listed.getByRole("link").first().click();
      const requests = page.getByTestId("tiktok-order-requests");
      await expect(requests.locator("li")).toHaveCount(3);
      await expect(requests).toContainText("Jawab di Seller Center sebelum");
      await expect(requests).toContainText("Permintaan tukar barang");
    });

    test("the home page links the requests waiting for an answer", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId("action-tiktok-responses-due")).toHaveText("2 permintaan TikTok perlu dijawab");
    });
  });
}
