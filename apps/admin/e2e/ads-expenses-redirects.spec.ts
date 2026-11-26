import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_EXPENSE_REDIRECTS_EMAIL, E2E_EXPENSE_SUMMARY_MONTH } from "./global-setup";

// docs/plans/expense-master-data.md session S5, §3.8: every old "Iklan & Biaya" URL lands on the
// right menu, and the nav shows "Iklan" and "Biaya" instead of "Iklan & Biaya". Seeded numbers
// (global-setup.ts): BYA-202602-902 is an Iklan Shopee, BYA-202602-906 the Endorse/KOL,
// BYA-202602-907 the Gaji of E2E_EXPENSE_SUMMARY_MONTH. Runs at 390px and 1280px.

const MONTH = E2E_EXPENSE_SUMMARY_MONTH;

/** Old URL -> the new path + query it must land on (exactly). */
const REDIRECTS: readonly [string, string][] = [
  ["/ads-expenses", "/expenses"],
  [`/ads-expenses?tab=ringkasan&period=month&month=${MONTH}`, `/expenses?tab=pnl&period=month&month=${MONTH}`],
  ["/ads-expenses?tab=ringkasan", "/expenses?tab=pnl"],
  ["/ads-expenses?group=marketing", "/ads"],
  [`/ads-expenses?month=${MONTH}&group=operational`, `/expenses?month=${MONTH}`],
  [`/ads-expenses?month=${MONTH}&category=endorsement`, `/ads?month=${MONTH}&category=endorsement`],
  [`/ads-expenses?month=${MONTH}&category=salary`, `/expenses?month=${MONTH}&category=salary`],
  [`/ads-expenses?q=BYA-202602-902`, `/ads?month=${MONTH}&q=BYA-202602-902`],
  [`/ads-expenses?q=BYA-202602-906`, `/ads?month=${MONTH}&q=BYA-202602-906`],
  [`/ads-expenses?q=BYA-202602-907`, `/expenses?month=${MONTH}&q=BYA-202602-907`],
  ["/ads-expenses?q=BYA-209901-999", "/expenses?q=BYA-209901-999"],
  ["/iklan-biaya", "/expenses"],
];

function pathAndQuery(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test.describe(`old Iklan & Biaya URLs at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("every old URL lands on Iklan or Biaya, the old report URL keeps working, and the nav has both menus", async ({ page }) => {
      test.setTimeout(120_000);
      await loginAs(page, E2E_EXPENSE_REDIRECTS_EMAIL);

      for (const [from, to] of REDIRECTS) {
        await page.goto(from);
        await expect.poll(() => pathAndQuery(page.url()), { message: from }).toBe(to);
        const title = to.startsWith("/ads") ? "Iklan" : "Biaya";
        await expect(page.getByRole("heading", { level: 1, name: title }), from).toBeVisible();
      }

      // The redirected Laba rugi shows the old Ringkasan's figure for the seeded month, and the
      // category filter survives on the right menu.
      await page.goto(`/ads-expenses?tab=ringkasan&period=month&month=${MONTH}`);
      await expect(page.getByTestId("summary-net-value")).toHaveText("Rp 120.000");
      await page.goto(`/ads-expenses?month=${MONTH}&category=endorsement`);
      await expect(page.getByTestId("expense-total")).toContainText("Rp 150.000");
      // An activity-log link to an expense of an earlier month opens that month, so the row shows.
      await page.goto("/ads-expenses?q=BYA-202602-907");
      const row = page.getByTestId(viewport.width < 768 ? "expense-card" : "expense-row").filter({ hasText: "BYA-202602-907" });
      await expect(row).toBeVisible();
      await expect(row).toContainText("Gaji");

      // The old report URL: a 308 to /expenses/report with the query unchanged, which serves the file.
      const query = `?format=xlsx&period=month&month=${MONTH}`;
      const redirect = await page.request.get(`/ads-expenses/report${query}`, { maxRedirects: 0 });
      expect(redirect.status()).toBe(308);
      expect(redirect.headers()["location"]).toBe(`/expenses/report${query}`);
      const file = await page.request.get(`/ads-expenses/report${query}`);
      expect(file.status()).toBe(200);
      expect(file.headers()["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      expect(file.headers()["content-disposition"]).toBe(`attachment; filename="laporan-keuangan-${MONTH}.xlsx"`);

      // The nav: "Iklan" and "Biaya" under Pertumbuhan, no "Iklan & Biaya". On a phone they sit in
      // the "Lainnya" sheet.
      await page.goto("/expense-categories");
      if (viewport.width < 768) await page.getByRole("navigation", { name: "Navigasi utama" }).getByRole("button", { name: "Lainnya" }).click();
      await expect(page.getByRole("link", { name: "Iklan", exact: true }).first()).toBeVisible();
      await expect(page.getByRole("link", { name: "Iklan", exact: true }).first()).toHaveAttribute("href", "/ads");
      await expect(page.getByRole("link", { name: "Biaya", exact: true }).first()).toHaveAttribute("href", "/expenses");
      await expect(page.getByRole("link", { name: "Iklan & Biaya" })).toHaveCount(0);
    });
  });
}
