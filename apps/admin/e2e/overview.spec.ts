import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_OVERVIEW_EMAIL, E2E_OVERVIEW_NO_FINANCE_EMAIL, E2E_OVERVIEW_SETTINGS_EMAIL } from "./global-setup";

// docs/plans/dashboard-overview.md sessions 2 and 3: Ringkasan (target card, period tabs, KPI
// tiles, D9 permissions) and "Target penjualan" on /settings. Every test runs at 390px AND 1280px
// (CLAUDE.md). "Kemarin" reads the backdated orders global-setup.ts seeds (see E2E_OVERVIEW_SKU
// there); every other spec's orders are dated today, so those numbers are fixed. The settings tests
// change the one sales_goal row, so they run last in this file (workers: 1, file order).

const LAYOUTS = [
  { label: "390px", viewport: { width: 390, height: 844 } },
  { label: "1280px", viewport: { width: 1280, height: 800 } },
] as const;

const JAKARTA_OFFSET_MS = 7 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** A Jakarta calendar date `days` from today, "YYYY-MM-DD". */
function jakartaDay(days: number): string {
  return new Date(Date.now() + JAKARTA_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
}

/** Same format as @ammari/ui's formatDate: "1 Nov 2026". */
function dateLabel(date: string): string {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function periodTabs(page: Page) {
  return page.getByRole("navigation", { name: "Pilih periode" });
}

for (const layout of LAYOUTS) {
  test.describe(`Ringkasan at ${layout.label}`, () => {
    test.use({ viewport: layout.viewport });

    test("owner: target card, Kemarin tiles against the day before, period tabs and a custom range", async ({ page }) => {
      await loginAs(page, E2E_OVERVIEW_EMAIL);
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Ringkasan" })).toBeVisible();

      // The seeded goal (migration 0039 / seed.ts): Rp 1 M from 1 Nov 2026.
      const card = page.getByTestId("overview-target-card");
      await expect(card).toBeVisible();
      if (jakartaDay(0) < "2026-11-01") {
        await expect(card.getByTestId("overview-target-start")).toHaveText("Tahun pertama dimulai 1 Nov 2026");
        await expect(card).toContainText("Target Rp 1.000.000.000");
      } else {
        await expect(card.getByTestId("overview-target-amounts")).toContainText("dari Rp 1.000.000.000");
      }

      // Kemarin is the default: the bare URL, its tab marked current.
      await expect(page.getByRole("heading", { name: "Penjualan kemarin" })).toBeVisible();
      await expect(page.getByTestId("overview-period-range")).toHaveText(dateLabel(jakartaDay(-1)));
      await expect(periodTabs(page).getByRole("link", { name: "Kemarin" })).toHaveAttribute("aria-current", "true");

      const dayBefore = dateLabel(jakartaDay(-2));
      const omzet = page.getByTestId("kpi-omzet");
      await expect(omzet.getByTestId("kpi-omzet-value")).toContainText("Rp 500 rb");
      await expect(omzet.getByTestId("kpi-omzet-value")).toContainText("Rp 500.000");
      await expect(omzet).toContainText(`▲ Naik 100% dibanding ${dayBefore}`);

      const ordersTile = page.getByTestId("kpi-orders");
      await expect(ordersTile.getByTestId("kpi-orders-value")).toHaveText("2");
      await expect(ordersTile).toContainText("2 pcs terjual");
      await expect(ordersTile).toContainText("▲ Naik 100% dibanding");

      await expect(page.getByTestId("kpi-average-value")).toContainText("Rp 250 rb");
      await expect(page.getByTestId("kpi-average")).toContainText(`Sama dengan ${dayBefore}`);

      const profit = page.getByTestId("kpi-gross-profit");
      await expect(profit.getByTestId("kpi-gross-profit-value")).toContainText("Rp 380 rb");
      await expect(profit).toContainText("Margin 76%");
      await expect(profit).toContainText("▲ Naik 153% dibanding");
      await expect(profit.getByRole("link", { name: "HPP belum lengkap untuk 1 item" })).toHaveAttribute("href", "/stock");

      await expect(page.getByTestId("kpi-undone")).toHaveText("Batal: 1, Retur: 0");

      // Hari ini: the URL carries the period, the heading and the comparison follow.
      await periodTabs(page).getByRole("link", { name: "Hari ini" }).click();
      await expect(page).toHaveURL(/\?period=today$/);
      await expect(page.getByRole("heading", { name: "Penjualan hari ini" })).toBeVisible();
      await expect(page.getByTestId("kpi-omzet")).toBeVisible();
      await expect(page.getByTestId("kpi-orders")).toContainText(/dibanding kemarin di jam yang sama|Belum ada data pembanding/);

      await periodTabs(page).getByRole("link", { name: "7 hari" }).click();
      await expect(page).toHaveURL(/\?period=7d$/);
      await expect(page.getByRole("heading", { name: "Penjualan 7 hari terakhir" })).toBeVisible();

      // Pilih tanggal: a GET form; the two backdated days hold exactly the 3 seeded counted orders.
      await periodTabs(page).getByRole("link", { name: "Pilih tanggal" }).click();
      await expect(page).toHaveURL(/\?period=custom$/);
      await page.getByLabel("Dari", { exact: true }).fill(jakartaDay(-2));
      await page.getByLabel("Sampai", { exact: true }).fill(jakartaDay(-1));
      await page.getByRole("button", { name: "Tampilkan" }).click();
      await expect(page).toHaveURL(new RegExp(`period=custom&from=${jakartaDay(-2)}&to=${jakartaDay(-1)}`));
      await expect(page.getByRole("heading", { name: "Penjualan", exact: true })).toBeVisible();
      await expect(page.getByTestId("kpi-orders-value")).toHaveText("3");
      await expect(page.getByTestId("kpi-omzet-value")).toContainText("Rp 750 rb");
      await expect(page.getByTestId("kpi-omzet")).toContainText(/2 hari sebelumnya|Belum ada data pembanding/);

      // An invalid range falls back to Kemarin and says so; a repeated key takes its first value.
      await page.goto(`/?period=custom&from=${jakartaDay(-1)}&to=${jakartaDay(-5)}`);
      await expect(page.getByRole("alert")).toContainText("Sekarang menampilkan Kemarin");
      await expect(page.getByRole("heading", { name: "Penjualan kemarin" })).toBeVisible();
      await page.goto("/?period=7d&period=today");
      await expect(page.getByRole("heading", { name: "Penjualan 7 hari terakhir" })).toBeVisible();
    });

    test("staff without finance.view_profit: counts only, no rupiah anywhere, no target card", async ({ page }) => {
      await loginAs(page, E2E_OVERVIEW_NO_FINANCE_EMAIL);
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Ringkasan" })).toBeVisible();
      await expect(page.getByTestId("kpi-orders-value")).toHaveText("2");
      await expect(page.getByTestId("kpi-pcs-value")).toHaveText("2");
      await expect(page.getByTestId("kpi-pcs")).toContainText("▲ Naik 100% dibanding");
      await expect(page.getByTestId("kpi-undone")).toHaveText("Batal: 1, Retur: 0");

      await expect(page.getByTestId("overview-target-card")).toHaveCount(0);
      for (const testId of ["kpi-omzet", "kpi-average", "kpi-gross-profit"]) {
        await expect(page.getByTestId(testId)).toHaveCount(0);
      }
      await expect(page.locator("body")).not.toContainText("Rp");

      // Not just hidden: the server response (HTML + RSC payload) carries no amount at all.
      for (const path of ["/", "/?period=custom&from=" + jakartaDay(-2) + "&to=" + jakartaDay(-1)]) {
        const html = await (await page.request.get(path)).text();
        expect(html).not.toMatch(/Rp\s?\d/);
        expect(html).not.toMatch(/500\.000|250\.000|380\.000|Margin|HPP|Target penjualan/);
      }

      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
    });
  });
}

// The settings tests change the one sales_goal row; put the seeded goal (migration 0039) back so a
// retry or --repeat-each starts the Ringkasan tests from the same state.
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await loginAs(page, E2E_OVERVIEW_SETTINGS_EMAIL);
  await page.goto("/settings");
  await page.getByLabel("Target omzet per tahun").fill("1000000000");
  await page.getByLabel("Tanggal mulai").fill("2026-11-01");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page.getByRole("status")).toContainText("Target penjualan disimpan");
  await page.close();
});

for (const layout of LAYOUTS) {
  test.describe(`Target penjualan settings at ${layout.label}`, () => {
    test.use({ viewport: layout.viewport });

    test("owner edits target and start date; Ringkasan follows", async ({ page }) => {
      await loginAs(page, E2E_OVERVIEW_SETTINGS_EMAIL);
      await page.goto("/settings");
      await expect(page.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeVisible();
      const amount = page.getByLabel("Target omzet per tahun");
      const startDate = page.getByLabel("Tanggal mulai");
      await expect(amount).toHaveValue(/^\d{1,3}(\.\d{3})*$/);

      // Server-side validation, in Indonesian, nothing saved.
      await amount.fill("0");
      await page.getByRole("button", { name: "Simpan" }).click();
      await expect(page.getByText("Target harus antara Rp 1 dan Rp 100.000.000.000.")).toBeVisible();
      await startDate.fill(jakartaDay(400));
      await amount.fill("600000000");
      await expect(amount).toHaveValue("600.000.000");
      await page.getByRole("button", { name: "Simpan" }).click();
      await expect(page.getByText("Tanggal mulai paling lambat 1 tahun dari hari ini.")).toBeVisible();

      // A future start: the card waits for it.
      const futureStart = jakartaDay(30);
      await startDate.fill(futureStart);
      await expect(page.getByText(`Tahun target: ${dateLabel(futureStart)} s.d.`)).toBeVisible();
      await page.getByRole("button", { name: "Simpan" }).click();
      await expect(page.getByRole("status")).toContainText("Target penjualan disimpan");
      await page.goto("/");
      await expect(page.getByTestId("overview-target-start")).toHaveText(`Tahun pertama dimulai ${dateLabel(futureStart)}`);
      await expect(page.getByTestId("overview-target-card")).toContainText("Target Rp 600.000.000, mulai 30 hari lagi.");

      // A start 10 days ago: progress, a pace badge, and the needed pace for the rest of the year.
      const pastStart = jakartaDay(-10);
      await page.goto("/settings");
      await expect(amount).toHaveValue("600.000.000");
      await startDate.fill(pastStart);
      await page.getByRole("button", { name: "Simpan" }).click();
      await expect(page.getByRole("status")).toContainText("Target penjualan disimpan");
      await page.goto("/");
      const card = page.getByTestId("overview-target-card");
      await expect(card.getByTestId("overview-target-amounts")).toContainText("dari Rp 600.000.000");
      await expect(card.getByTestId("overview-target-percent")).toHaveText(/^\d+(,\d)?%$/);
      await expect(card).toContainText("hari ke-11 dari");
      await expect(card.getByText(/^(Sesuai target|Di bawah target|Target tercapai)$/)).toBeVisible();
      await expect(card.getByRole("progressbar", { name: "Progres target" })).toBeVisible();
      await expect(card.getByTestId("overview-target-days-left")).toContainText(/\d+ hari/);
      await expect(card.getByTestId("overview-target-needed-day")).toContainText("Rp");
    });
  });
}
