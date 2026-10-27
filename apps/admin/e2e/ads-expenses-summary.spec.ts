import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_EXPENSE_SUMMARY_FINANCE_EMAIL,
  E2E_EXPENSE_SUMMARY_MONTH,
  E2E_EXPENSE_SUMMARY_NO_FINANCE_EMAIL,
  E2E_EXPENSE_SUMMARY_OWNER_EMAIL,
  E2E_MONTHLY_BILLS_EXPENSE_NO,
} from "./global-setup";

// docs/plans/growth.md session S3: Iklan & Biaya "Ringkasan" (Laba bersih, biaya per kategori,
// iklan vs omzet), the Laba bersih tile on Ringkasan ("Bulan ini" only) and "Gaji/Sewa belum
// dicatat" in Perlu tindakan. Every test runs at 390px AND 1280px (CLAUDE.md): the two tables
// render a CardList on phones and a TableContainer from md up, so each pass asserts its own
// layout's rows and that the other layout's are hidden. The exact figures come from the month
// global-setup.ts seeds (E2E_EXPENSE_SUMMARY_MONTH); "Bulan ini" moves with other specs, so only
// its presence and gating are asserted.

interface Layout {
  label: string;
  viewport: { width: number; height: number };
  /** The visible layout's row test ids, and the hidden one's. */
  category: string;
  hiddenCategory: string;
  roas: string;
  hiddenRoas: string;
}

const LAYOUTS: readonly Layout[] = [
  {
    label: "390px",
    viewport: { width: 390, height: 844 },
    category: "summary-category-card",
    hiddenCategory: "summary-category-row",
    roas: "summary-roas-card",
    hiddenRoas: "summary-roas-row",
  },
  {
    label: "1280px",
    viewport: { width: 1280, height: 800 },
    category: "summary-category-row",
    hiddenCategory: "summary-category-card",
    roas: "summary-roas-row",
    hiddenRoas: "summary-roas-card",
  },
];

/** A rupiah amount in a response; not preceded by a letter or digit (Next's random ids). */
const NO_RUPIAH = /(?<![A-Za-z0-9])Rp\s?\d/;

const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

/** Today's Jakarta date, "YYYY-MM-DD". */
function jakartaToday(): string {
  return new Date(Date.now() + 7 * 60 * 60_000).toISOString().slice(0, 10);
}

/** "September 2026" for the month before today's (Jakarta). */
function lastMonthLabel(): string {
  const [year, month] = jakartaToday().split("-").map(Number) as [number, number];
  const index = year * 12 + month - 2;
  return `${MONTH_NAMES[index % 12]} ${Math.floor(index / 12)}`;
}

const SEEDED_MONTH_URL = `/ads-expenses?tab=ringkasan&period=month&month=${E2E_EXPENSE_SUMMARY_MONTH}`;

async function expectNoHorizontalScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

for (const layout of LAYOUTS) {
  test.describe(`Iklan & Biaya Ringkasan at ${layout.label}`, () => {
    test.use({ viewport: layout.viewport });

    test("Keuangan: seeded month figures, period picker, Laba bersih tile on Bulan ini, Gaji/Sewa item", async ({ page }) => {
      await loginAs(page, E2E_EXPENSE_SUMMARY_FINANCE_EMAIL);

      // The tab bar: Pengeluaran is the default, Ringkasan opens this month.
      await page.goto("/ads-expenses");
      const sections = page.getByRole("navigation", { name: "Bagian Iklan & Biaya" });
      await expect(sections.getByRole("link", { name: "Pengeluaran" })).toHaveAttribute("aria-current", "true");
      await sections.getByRole("link", { name: "Ringkasan" }).click();
      await expect(page).toHaveURL(/\/ads-expenses\?tab=ringkasan$/);
      await expect(page.getByRole("navigation", { name: "Pilih periode" }).getByRole("link", { name: "Bulan ini" })).toHaveAttribute("aria-current", "true");
      await expect(page.getByTestId("summary-period")).toContainText("(s.d. ");

      // Pilih bulan: a future month is refused, the seeded month shows its fixed figures.
      await page.getByRole("navigation", { name: "Pilih periode" }).getByRole("link", { name: "Pilih bulan" }).click();
      await expect(page).toHaveURL(/period=month$/);
      await page.goto("/ads-expenses?tab=ringkasan&period=month&month=2999-01");
      await expect(page.getByRole("alert")).toContainText("Sekarang menampilkan bulan ini.");
      await page.getByLabel("Bulan", { exact: true }).fill(E2E_EXPENSE_SUMMARY_MONTH);
      await page.getByRole("button", { name: "Tampilkan" }).click();
      await expect(page).toHaveURL(new RegExp(`period=month&month=${E2E_EXPENSE_SUMMARY_MONTH}`));
      await expect(page.getByTestId("summary-period")).toHaveText("Februari 2026");

      await expect(page.getByTestId("summary-omzet-value")).toHaveText("Rp 2.000.000");
      await expect(page.getByTestId("summary-omzet")).toContainText("4 pesanan");
      await expect(page.getByTestId("summary-after-fees-value")).toHaveText("Rp 1.170.000");
      await expect(page.getByTestId("summary-expenses-value")).toHaveText("Rp 1.030.000");
      await expect(page.getByTestId("summary-net-value")).toHaveText("Rp 120.000");
      await expect(page.getByTestId("summary-net-value")).toHaveClass(/text-success-700/);
      await expect(page.getByTestId("summary-subsidy")).toHaveText("Subsidi ongkir situs Rp 20.000");
      await expect(page.getByTestId("summary-fee-incomplete")).toHaveText("Biaya platform belum lengkap untuk 1 pesanan");
      await expect(page.getByTestId("summary-hpp-incomplete")).toHaveCount(0);
      await expect(page.getByTestId("summary-net-incomplete")).toBeVisible();

      // Biaya per kategori: biggest first, the voided Sewa left out; ties in the fixed order.
      const categories = page.getByTestId(layout.category);
      await expect(categories).toHaveCount(6);
      const expectedCategories = [
        ["Gaji", "Rp 400.000", "20%"],
        ["Sewa", "Rp 200.000", "10%"],
        ["Endorse/KOL", "Rp 150.000", "7,5%"],
        ["Iklan TikTok", "Rp 100.000", "5%"],
        ["Iklan Shopee", "Rp 100.000", "5%"],
        ["Iklan Meta", "Rp 80.000", "4%"],
      ];
      for (const [index, texts] of expectedCategories.entries()) {
        for (const text of texts) await expect(categories.nth(index)).toContainText(text);
      }
      await expect(page.getByTestId(layout.hiddenCategory).first()).toBeHidden();

      // Iklan vs omzet against 8,3; Endorse/KOL apart.
      const roas = (key: string) => page.locator(`[data-testid="${layout.roas}"][data-channel="${key}"]`);
      await expect(page.getByTestId(layout.roas)).toHaveCount(7);
      await expect(roas("shopee")).toContainText("Rp 100.000");
      await expect(roas("shopee")).toContainText("Rp 1.000.000");
      await expect(roas("shopee")).toContainText("10,0");
      await expect(roas("shopee")).toContainText("Di atas titik impas");
      await expect(roas("tiktok")).toContainText("5,0");
      await expect(roas("tiktok")).toContainText("Di bawah titik impas");
      await expect(roas("web")).toContainText("Situs");
      await expect(roas("web")).toContainText("6,0 (perkiraan)");
      await expect(roas("instagram")).toContainText("Belum ada iklan");
      await expect(roas("whatsapp")).toContainText("Rp 200.000");
      await expect(roas("whatsapp")).toContainText("Belum ada iklan");
      await expect(roas("untagged")).toContainText("Tanpa kanal");
      await expect(roas("untagged")).toContainText("Rp 30.000");
      await expect(roas("total")).toContainText("Rp 280.000");
      await expect(roas("total")).toContainText("Rp 2.000.000");
      await expect(roas("total")).toContainText("7,1 (perkiraan)");
      await expect(roas("total")).toContainText("Di bawah titik impas");
      await expect(page.getByTestId(layout.hiddenRoas).first()).toBeHidden();
      await expect(page.getByTestId("summary-endorsement")).toContainText("Biaya endorse Rp 150.000");
      await expect(page.getByTestId("summary-marketing-total")).toContainText("Biaya pemasaran Rp 430.000");
      await expectNoHorizontalScroll(page);

      // Rentang bulan: more than 12 months is refused; a one-month range equals Pilih bulan.
      await page.goto("/ads-expenses?tab=ringkasan&period=range&from=2025-01&to=2026-02");
      await expect(page.getByRole("alert")).toContainText("paling lama 12 bulan");
      await page.getByLabel("Dari bulan").fill("2026-02");
      await page.getByLabel("Sampai bulan").fill("2026-02");
      await page.getByRole("button", { name: "Tampilkan" }).click();
      await expect(page.getByTestId("summary-net-value")).toHaveText("Rp 120.000");

      // Ringkasan: "Bulan ini" has the Laba bersih tile linking here; "Kemarin" does not.
      await page.goto("/?period=month");
      const tile = page.getByTestId("kpi-laba-bersih");
      await expect(tile).toBeVisible();
      await expect(tile.getByTestId("kpi-laba-bersih-value")).toContainText("Rp");
      await expect(tile.getByTestId("kpi-laba-bersih-costs")).toContainText("Dikurangi subsidi ongkir situs Rp");
      await expect(tile.getByTestId("kpi-laba-bersih-link")).toHaveAttribute("href", "/ads-expenses?tab=ringkasan");
      await expect(page.getByTestId("kpi-laba-bersih-help")).toContainText("Biaya dihitung pada tanggal dibayar.");
      await page.goto("/");
      await expect(page.getByTestId("kpi-net-profit")).toBeVisible();
      await expect(page.getByTestId("kpi-laba-bersih")).toHaveCount(0);

      // Perlu tindakan: global-setup records only a Gaji in the window (the 5th of this month), so
      // from the 6th the item names last month and Sewa, and opens the 6th-to-5th window.
      const bills = page.getByTestId("action-monthly-bills");
      await expect(bills).toBeVisible();
      const today = jakartaToday();
      if (Number(today.slice(8, 10)) >= 6) {
        const [year, month] = today.split("-").map(Number) as [number, number];
        const last = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
        const window = { from: `${last}-06`, to: `${today.slice(0, 7)}-05` };
        await expect(bills.getByTestId("action-monthly-bills-count")).toHaveText(lastMonthLabel());
        await expect(bills).toContainText(`Belum ada biaya Sewa untuk ${lastMonthLabel()} yang dibayar`);
        await expect(bills).not.toContainText("Gaji dan Sewa");
        const link = bills.getByTestId("action-monthly-bills-all");
        await expect(link).toHaveAttribute("href", `/ads-expenses?from=${window.from}&to=${window.to}&group=operational`);
        await link.click();
        await expect(page).toHaveURL(new RegExp(`from=${window.from}&to=${window.to}&group=operational`));
        await expect(page.getByTestId("expense-range")).toBeVisible();
        const seeded = page.locator(`[data-testid="${layout.label === "390px" ? "expense-card" : "expense-row"}"]`).filter({ hasText: E2E_MONTHLY_BILLS_EXPENSE_NO });
        await expect(seeded).toBeVisible();
        await expect(seeded).toContainText("Gaji");
        await expect(page.getByTestId("expense-total")).toContainText("Rp");
        await page.goto("/");
      } else {
        await expect(bills.getByTestId("action-monthly-bills-count")).toHaveText("Tidak ada");
      }
      await expectNoHorizontalScroll(page);
    });

    test("owner: Laba bersih tile only on Bulan ini, and the seeded month on the Ringkasan tab", async ({ page }) => {
      await loginAs(page, E2E_EXPENSE_SUMMARY_OWNER_EMAIL);
      await page.goto("/");
      await page.getByRole("navigation", { name: "Pilih periode" }).getByRole("link", { name: "Bulan ini" }).click();
      await expect(page).toHaveURL(/\?period=month$/);
      await expect(page.getByTestId("kpi-laba-bersih")).toHaveCount(1);
      await expect(page.getByTestId("kpi-laba-bersih")).toContainText(/dibanding periode yang sama bulan lalu|Belum ada data pembanding|Sama dengan/);
      // Hidden, not shown as 0, on every shorter or custom period.
      for (const path of ["/?period=today", "/?period=7d", `/?period=custom&from=${E2E_EXPENSE_SUMMARY_MONTH}-01&to=${E2E_EXPENSE_SUMMARY_MONTH}-28`]) {
        await page.goto(path);
        await expect(page.getByTestId("kpi-net-profit")).toBeVisible();
        await expect(page.getByTestId("kpi-laba-bersih")).toHaveCount(0);
        await expect(page.getByTestId("kpi-laba-bersih-help")).toHaveCount(0);
      }
      await page.goto(SEEDED_MONTH_URL);
      await expect(page.getByTestId("summary-net-value")).toHaveText("Rp 120.000");
      await expect(page.getByTestId(layout.roas)).toHaveCount(7);
      await expectNoHorizontalScroll(page);
    });

    test("staff without finance.view_profit: no Laba bersih, no item, no expense figure sent; Iklan & Biaya refused", async ({ page }) => {
      await loginAs(page, E2E_EXPENSE_SUMMARY_NO_FINANCE_EMAIL);
      await page.goto("/?period=month");
      await expect(page.getByRole("heading", { level: 1, name: "Ringkasan" })).toBeVisible();
      await expect(page.getByTestId("kpi-orders")).toBeVisible();
      await expect(page.getByTestId("kpi-laba-bersih")).toHaveCount(0);
      await expect(page.getByTestId("action-monthly-bills")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("Laba bersih");

      // Not just hidden: the server response carries no amount and no expense wording at all.
      const html = await (await page.request.get("/?period=month")).text();
      expect(html).toContain("kpi-orders-value");
      expect(html).not.toMatch(NO_RUPIAH);
      expect(html).not.toMatch(/Laba bersih|Gaji\/Sewa|Subsidi ongkir|webShippingSubsidy|kpi-laba-bersih|action-monthly-bills/);

      for (const path of ["/ads-expenses", SEEDED_MONTH_URL]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
        await expect(page.getByTestId("summary-net-value")).toHaveCount(0);
      }
      const refused = await (await page.request.get(SEEDED_MONTH_URL)).text();
      expect(refused).not.toMatch(/120\.000|1\.030\.000|Laba bersih/);
    });
  });
}
