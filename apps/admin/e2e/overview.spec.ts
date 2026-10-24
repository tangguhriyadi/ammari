import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_OVERVIEW_EMAIL,
  E2E_OVERVIEW_LATE_ORDER_NO,
  E2E_OVERVIEW_NO_FINANCE_EMAIL,
  E2E_OVERVIEW_SETTINGS_EMAIL,
  E2E_SETTINGS_NO_FINANCE_EMAIL,
} from "./global-setup";

// docs/plans/dashboard-overview.md sessions 2 to 5: Ringkasan (target card, period tabs, KPI tiles,
// charts, "Perlu tindakan", D9 permissions) and "Target penjualan" on /settings. Every test runs at
// 390px AND 1280px (CLAUDE.md). "Kemarin" reads the backdated orders global-setup.ts seeds (see
// E2E_OVERVIEW_SKU there); every other spec's orders are dated today, so those numbers are fixed.
// "Perlu tindakan" is not tied to a period and other specs add to it, so only the seeded late order
// is asserted exactly; the other blocks are checked for their link or "Tidak ada". The settings
// tests change the one sales_goal row, so they run last in this file (workers: 1, file order).

const LAYOUTS = [
  { label: "390px", viewport: { width: 390, height: 844 } },
  { label: "1280px", viewport: { width: 1280, height: 800 } },
] as const;

/** A rupiah amount in a response. Not preceded by a letter or digit: Next's random ids can hold
 * "Rp8" ("...uRp8t..."). */
const NO_RUPIAH = /(?<![A-Za-z0-9])Rp\s?\d/;

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

/** A row of a chart's visually hidden data table, by its exact row header. */
function chartRow(chart: Locator, rowHeader: string) {
  return chart.locator("table tr").filter({ has: chart.page().getByRole("rowheader", { name: rowHeader, exact: true }) });
}

/** The page never scrolls sideways (390px: every chart label fits). The period tabs scroll inside
 * their own row, which is fine; on failure, the elements sticking out of the page are named. */
async function expectNoHorizontalScroll(page: Page) {
  const overflowing = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      if (root.scrollWidth <= root.clientWidth) return [];
      return [...document.querySelectorAll("body *")]
        .filter((element) => element.getBoundingClientRect().right > root.clientWidth + 1)
        .slice(0, 5)
        .map((element) => `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}`);
    });
  await expect.poll(overflowing).toEqual([]);
}

/** A "Perlu tindakan" block: either collapsed to "Tidak ada", or its "Lihat semua" link points at
 * the filtered page. */
async function expectActionBlock(page: Page, testId: string, href: string) {
  const block = page.getByTestId(testId);
  await expect(block).toBeVisible();
  const count = (await block.getByTestId(`${testId}-count`).textContent())?.trim();
  if (count === "Tidak ada") return;
  await expect(block.getByTestId(`${testId}-all`)).toHaveAttribute("href", href);
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

      // Charts (session 4). Omzet per hari: the 14 days ending yesterday, the earlier days muted;
      // every number in the hidden table.
      const salesChart = page.getByTestId("overview-sales-chart");
      await expect(salesChart.getByRole("heading", { name: "Omzet per hari" })).toBeVisible();
      await expect(salesChart.getByTestId("overview-sales-chart-bar")).toHaveCount(14);
      await expect(salesChart.getByTestId("overview-sales-chart-summary")).toContainText("Kemarin: Rp 500.000. Rata-rata 13 hari sebelumnya:");
      await expect(chartRow(salesChart, dateLabel(jakartaDay(-1))).locator("td")).toHaveText("Rp 500.000");
      await expect(chartRow(salesChart, `${dateLabel(jakartaDay(-2))} (sebelum periode)`).locator("td")).toHaveText("Rp 250.000");
      await expect(chartRow(salesChart, `${dateLabel(jakartaDay(-5))} (sebelum periode)`).locator("td")).toHaveText("Rp 300.000");
      await expect(salesChart.getByText("Periode dipilih")).toBeVisible();

      const channels = page.getByTestId("overview-channels");
      await expect(channels.getByTestId("overview-channels-summary")).toHaveText("Semua dari WhatsApp.");
      await expect(channels.getByTestId("overview-channels-row")).toHaveCount(1);
      await expect(channels.getByTestId("overview-channels-row")).toContainText("Rp 500 rb");
      await expect(channels.getByTestId("overview-channels-row")).toContainText("100% dari omzet, 2 pesanan");

      const types = page.getByTestId("overview-product-types");
      await expect(types.getByTestId("overview-product-types-row")).toHaveCount(1);
      await expect(types.getByTestId("overview-product-types-row")).toContainText("Rp 500 rb");
      await expect(types.getByTestId("overview-product-types-row")).toContainText("2 pcs");

      const top = page.getByTestId("overview-top-products");
      const topProduct = top.getByTestId("overview-top-product").first();
      await expect(topProduct).toContainText("E2E Gamis Ringkasan");
      await expect(topProduct).toContainText("2 pcs, Rp 500 rb");
      await expect(topProduct.getByText("Navy, M")).toBeHidden();
      await topProduct.getByText("Lihat 1 varian").click();
      await expect(topProduct.getByText("Navy, M")).toBeVisible();
      await expectNoHorizontalScroll(page);

      // The Omzet / Pesanan switch and the top products rank keep each other and the period.
      await page.getByRole("navigation", { name: "Tampilkan grafik" }).getByRole("link", { name: "Pesanan" }).click();
      await expect(page).toHaveURL(/\/\?metric=orders#overview-sales-chart$/);
      await expect(salesChart.getByRole("heading", { name: "Pesanan per hari" })).toBeVisible();
      await expect(chartRow(salesChart, dateLabel(jakartaDay(-1))).locator("td")).toHaveText("2 pesanan");
      await page.getByRole("navigation", { name: "Urutkan produk terlaris" }).getByRole("link", { name: "Omzet" }).click();
      await expect(page).toHaveURL(/\/\?metric=orders&top=omzet#overview-top-products$/);
      await expect(page.getByRole("navigation", { name: "Urutkan produk terlaris" }).getByRole("link", { name: "Omzet" })).toHaveAttribute("aria-current", "true");
      await page.goto("/");

      // Perlu tindakan (session 5): the seeded late order leads Siap Kirim; the owner packs, so the
      // block opens Packing.
      const actions = page.getByTestId("overview-needs-action");
      await expect(actions.getByRole("heading", { name: "Perlu tindakan" })).toBeVisible();
      const toShip = page.getByTestId("action-to-ship");
      await expect(toShip.getByTestId("action-to-ship-late")).toContainText("lebih dari 2 hari");
      const lateRow = toShip.getByRole("link", { name: new RegExp(E2E_OVERVIEW_LATE_ORDER_NO) });
      await expect(lateRow).toContainText("Terlambat");
      await expect(toShip.getByTestId("action-to-ship-all")).toHaveAttribute("href", "/packing");
      await expectActionBlock(page, "action-attention", "/orders?status=perlu-dicek");
      await expectActionBlock(page, "action-awaiting-payment", "/orders?status=awaiting_payment");
      await expectActionBlock(page, "action-low-stock", "/stock?low=1");
      await expectActionBlock(page, "action-supplier-debt", "/suppliers?balance=owed");
      await expect(page.getByTestId("action-production")).toBeVisible();
      await lateRow.click();
      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
      await expect(page.getByText(E2E_OVERVIEW_LATE_ORDER_NO).first()).toBeVisible();
      await page.goto("/");

      // Hari ini: the URL carries the period, the heading and the comparison follow.
      await periodTabs(page).getByRole("link", { name: "Hari ini" }).click();
      await expect(page).toHaveURL(/\?period=today$/);
      await expect(page.getByRole("heading", { name: "Penjualan hari ini" })).toBeVisible();
      // Exactly one: while the new period streams in, the previous tiles can still be on screen.
      await expect(page.getByTestId("kpi-omzet")).toHaveCount(1);
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

      // Charts: the orders version only, no switch to omzet, no product types (§6).
      const salesChart = page.getByTestId("overview-sales-chart");
      await expect(salesChart.getByRole("heading", { name: "Pesanan per hari" })).toBeVisible();
      await expect(chartRow(salesChart, dateLabel(jakartaDay(-1))).locator("td")).toHaveText("2 pesanan");
      await expect(page.getByRole("navigation", { name: "Tampilkan grafik" })).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Urutkan produk terlaris" })).toHaveCount(0);
      await expect(page.getByTestId("overview-channels-row")).toContainText("2 pesanan");
      await expect(page.getByTestId("overview-channels-row")).toContainText("100% dari pesanan, 2 pcs");
      await expect(page.getByTestId("overview-product-types")).toHaveCount(0);
      await expect(page.getByTestId("overview-top-product").first()).toContainText("2 pcs");
      // ?metric=omzet in the URL changes nothing.
      await page.goto("/?metric=omzet&top=omzet");
      await expect(page.getByTestId("overview-sales-chart").getByRole("heading", { name: "Pesanan per hari" })).toBeVisible();

      // Perlu tindakan, per module permission and without amounts: no Utang pemasok (needs
      // finance.view_profit), Siap Kirim opens the order list (no packing.print_cards).
      await expect(page.getByTestId("overview-needs-action")).toBeVisible();
      await expect(page.getByTestId("action-supplier-debt")).toHaveCount(0);
      const toShip = page.getByTestId("action-to-ship");
      await expect(toShip.getByRole("link", { name: new RegExp(E2E_OVERVIEW_LATE_ORDER_NO) })).toContainText("Terlambat");
      await expect(toShip.getByTestId("action-to-ship-all")).toHaveAttribute("href", "/orders?status=to_ship");
      await expectActionBlock(page, "action-low-stock", "/stock?low=1");
      await expect(page.getByTestId("action-production")).toBeVisible();
      await expectNoHorizontalScroll(page);

      await expect(page.locator("body")).not.toContainText("Rp");

      // Not just hidden: the server response (HTML + RSC payload) carries no amount at all.
      for (const path of ["/", "/?period=custom&from=" + jakartaDay(-2) + "&to=" + jakartaDay(-1)]) {
        const html = await (await page.request.get(path)).text();
        expect(html).not.toMatch(NO_RUPIAH);
        expect(html).not.toMatch(/500\.000|250\.000|380\.000|Margin|HPP|Target penjualan|Total utang|Sisa tagihan/);
      }

      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
    });

    test("settings.manage without finance.view_profit: no Target penjualan section, no amount sent", async ({ page }) => {
      await loginAs(page, E2E_SETTINGS_NO_FINANCE_EMAIL);
      await page.goto("/settings");
      await expect(page.getByRole("heading", { level: 1, name: "Pengaturan" })).toBeVisible();
      await expect(page.getByText("Belum ada pengaturan untuk peran Anda")).toBeVisible();
      await expect(page.getByLabel("Target omzet per tahun")).toHaveCount(0);
      const html = await (await page.request.get("/settings")).text();
      expect(html).not.toMatch(NO_RUPIAH);
      expect(html).not.toMatch(/Target penjualan|1\.000\.000\.000|1000000000/);

      // Ringkasan: no target card, so no "Atur target" link either.
      await page.goto("/");
      await expect(page.getByTestId("overview-target-card")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("Rp");
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
      // The cumulative chart (session 4): one row per month of the goal year.
      const cumulative = card.getByTestId("overview-target-cumulative");
      await expect(cumulative.getByRole("heading", { name: "Omzet kumulatif per bulan" })).toBeVisible();
      // 12 months, or 13 when the start is not the 1st (a part month at each end).
      expect(await cumulative.locator("table tbody tr").count()).toBeGreaterThanOrEqual(12);
      await expect(cumulative).toContainText("Target garis lurus");
    });
  });
}
