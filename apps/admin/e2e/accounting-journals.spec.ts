import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { loginAs } from "./helpers/login";
import { E2E_ACCOUNTING_CS_EMAIL, E2E_ACCOUNTING_JOURNALS_EMAIL, E2E_ACCOUNTING_VIEW_ONLY_EMAIL } from "./global-setup";

// docs/plans/accounting.md Session 4: a manual journal is created from the "Top-up Saldo Biteship"
// template and then reversed, once at 390px and once at 1280px; Neraca saldo for the December 2026
// trial month is read at both widths (CardList on phones, table on tablet/desktop: every assertion
// goes through THIS viewport's rows and checks the other layout's are hidden, not missing); Tutup
// buku shows the trial month as never closable; Saldo awal cannot be posted before 1 Jan 2027.
// Dated in December 2026, which can be practised before it starts (it is never official, D-22).

interface Layout {
  label: string;
  journalRow: string;
  hiddenJournalRow: string;
  balanceRow: string;
  hiddenBalanceRow: string;
  periodRow: string;
  viewport: { width: number; height: number };
  amount: string;
  tag: string;
}

const MOBILE: Layout = {
  label: "mobile",
  journalRow: '[data-testid="journal-entry-card"]',
  hiddenJournalRow: '[data-testid="journal-entry-row"]',
  balanceRow: '[data-testid="trial-balance-card"]',
  hiddenBalanceRow: '[data-testid="trial-balance-row"]',
  periodRow: '[data-testid="period-card"]',
  viewport: { width: 390, height: 844 },
  amount: "777.000",
  tag: "E2E ponsel",
};
const DESKTOP: Layout = {
  label: "desktop",
  journalRow: '[data-testid="journal-entry-row"]',
  hiddenJournalRow: '[data-testid="journal-entry-card"]',
  balanceRow: '[data-testid="trial-balance-row"]',
  hiddenBalanceRow: '[data-testid="trial-balance-card"]',
  periodRow: '[data-testid="period-row"]',
  viewport: { width: 1280, height: 800 },
  amount: "333.000",
  tag: "E2E desktop",
};

const DECEMBER_MANUAL = "/accounting/journal?from=2026-12-01&to=2026-12-31&kind=manual";

function entryFor(page: Page, layout: Layout, tag: string): Locator {
  return page.locator(layout.journalRow).filter({ hasText: `Top-up Saldo Biteship ${tag}` });
}

async function createAndReverse(page: Page, layout: Layout): Promise<void> {
  await page.goto("/accounting/journal/new");
  await expect(page.getByRole("heading", { name: "Catat Jurnal Manual" })).toBeVisible();
  const form = page.getByRole("form", { name: "Jurnal manual" });
  await form.getByRole("button", { name: "Top-up Saldo Biteship" }).click();
  await expect(form.getByText("Satu jurnal per top-up, dari mutasi bank (Keputusan 10).")).toBeVisible();
  await expect(form.getByLabel("Akun baris 1")).toHaveValue("1-1603");
  await expect(form.getByLabel("Akun baris 2")).toHaveValue("1-1201");
  await form.getByLabel("Tanggal").fill("2026-12-14");
  await form.getByLabel("Keterangan").fill(`Top-up Saldo Biteship ${layout.tag}`);
  await form.getByLabel("Debit baris 1").fill(layout.amount);
  await expect(form.getByTestId("journal-totals")).toContainText("Belum seimbang");
  await form.getByLabel("Kredit baris 2").fill(layout.amount);
  await expect(form.getByTestId("journal-totals")).toContainText("Seimbang");
  await form.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(page).toHaveURL(/\/accounting\/journal$/);

  await page.goto(DECEMBER_MANUAL);
  const entry = entryFor(page, layout, layout.tag);
  await expect(entry).toHaveCount(1);
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("Manual");
  await expect(entry).toContainText("Uji coba");
  await expect(entry).toContainText("1-1603 Saldo Biteship (uang muka ongkir)");
  await expect(entry).toContainText("1-1201 Bank utama");
  await expect(entry).toContainText(`Rp ${layout.amount}`);
  await expect(entry).toContainText("14 Des 2026");
  const hidden = page.locator(layout.hiddenJournalRow).filter({ hasText: `Top-up Saldo Biteship ${layout.tag}` });
  await expect(hidden).toHaveCount(1);
  await expect(hidden).toBeHidden();

  await entry.getByRole("button", { name: "Balik" }).click();
  const dialog = page.getByRole("dialog", { name: /Balik jurnal JU-202612-/ });
  await dialog.getByRole("button", { name: "Balik jurnal" }).click();
  await expect(dialog.getByText("Alasan pembalikan wajib diisi.")).toBeVisible();
  await dialog.getByLabel("Alasan").fill("Salah nominal");
  await dialog.getByRole("button", { name: "Balik jurnal" }).click();
  await expect(page.getByRole("status").getByText(/dibalik dengan JU-202612-/).last()).toBeVisible();

  await expect(entry).toContainText(/Dibalik oleh JU-202612-\d{4}/);
  await expect(entry.getByRole("button", { name: "Balik" })).toHaveCount(0);
  // The reversal itself: the same lines with sides swapped, linked back.
  await page.goto("/accounting/journal?from=2026-12-01&to=2026-12-31&kind=reversal");
  const reversal = page.locator(layout.journalRow).filter({ hasText: `Salah nominal` }).filter({ hasText: `Rp ${layout.amount}` });
  await expect(reversal).toHaveCount(1);
  await expect(reversal).toContainText(/Membalik JU-202612-\d{4}/);
  await expect(reversal).toContainText("Pembalik");
}

async function checkTrialBalance(page: Page, layout: Layout): Promise<void> {
  await page.goto("/accounting/trial-balance?from=2026-12-01&to=2026-12-31");
  await expect(page.getByRole("heading", { name: "Neraca Saldo" })).toBeVisible();
  await expect(page.getByTestId("trial-balance-notes")).toContainText("Desember 2026 adalah bulan uji coba");
  // Both top-ups and both reversals: 777.000 + 333.000 each way on Saldo Biteship.
  const biteship = page.locator(layout.balanceRow).filter({ hasText: "1-1603" });
  await expect(biteship).toHaveCount(1);
  await expect(biteship).toBeVisible();
  await expect(biteship).toContainText("Saldo Biteship (uang muka ongkir)");
  await expect(biteship).toContainText("Rp 1.110.000");
  const hidden = page.locator(layout.hiddenBalanceRow).filter({ hasText: "1-1603" });
  await expect(hidden).toHaveCount(1);
  await expect(hidden).toBeHidden();
  const total = page.getByTestId(layout === MOBILE ? "trial-balance-total-card" : "trial-balance-total-row");
  await expect(total).toBeVisible();
  await expect(total).toContainText("Seimbang");
}

test("manual journal create and reverse at 390px and 1280px, then Neraca saldo at both widths", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_JOURNALS_EMAIL);
  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(`${layout.label}: create and reverse`, async () => {
      await page.setViewportSize(layout.viewport);
      await createAndReverse(page, layout);
    });
  }
  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(`${layout.label}: Neraca saldo`, async () => {
      await page.setViewportSize(layout.viewport);
      await checkTrialBalance(page, layout);
    });
  }
  await test.step("Excel and PDF downloads", async () => {
    for (const [label, extension] of [
      ["Unduh Excel", "xlsx"],
      ["Unduh PDF", "pdf"],
    ] as const) {
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: label }).click();
      expect((await download).suggestedFilename()).toBe(`neraca-saldo-2026-12-01-2026-12-31.${extension}`);
    }
  });
});

test("an unbalanced manual journal is refused with a message, nothing is saved", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_JOURNALS_EMAIL);
  await page.setViewportSize(DESKTOP.viewport);
  await page.goto("/accounting/journal/new");
  const form = page.getByRole("form", { name: "Jurnal manual" });
  await form.getByLabel("Tanggal").fill("2026-12-15");
  await form.getByLabel("Keterangan").fill("Jurnal tidak seimbang E2E");
  await form.getByLabel("Akun baris 1").selectOption("1-1603");
  await form.getByLabel("Debit baris 1").fill("100.000");
  await form.getByLabel("Akun baris 2").selectOption("1-1201");
  await form.getByLabel("Kredit baris 2").fill("90.000");
  await form.getByRole("button", { name: "Simpan jurnal" }).click();
  await expect(form.getByRole("alert").filter({ hasText: "Total debit dan total kredit harus sama." }).first()).toBeVisible();
  await page.goto(DECEMBER_MANUAL);
  await expect(page.getByText("Jurnal tidak seimbang E2E")).toHaveCount(0);
});

test("Tutup buku: the trial month is never closable, January waits until it has ended; at 390px and 1280px", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_JOURNALS_EMAIL);
  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(layout.label, async () => {
      await page.setViewportSize(layout.viewport);
      await page.goto("/accounting/periods");
      await expect(page.getByRole("heading", { name: "Tutup Buku" })).toBeVisible();
      const trial = page.locator(layout.periodRow).filter({ hasText: "Desember 2026" });
      await expect(trial).toBeVisible();
      await expect(trial).toContainText("Uji coba");
      await expect(trial.getByRole("button", { name: "Tutup bulan" })).toHaveCount(0);
      const january = page.locator(layout.periodRow).filter({ hasText: "Januari 2027" });
      await expect(january).toContainText("10 Feb 2027");
      await expect(january).toContainText("Bulan ini belum berakhir, jadi belum bisa ditutup.");
      await expect(january).toContainText("Tarif PPh final berakhir, periksa pengaturan pajak.");
    });
  }
});

test("Saldo awal cannot be posted before 1 Januari 2027", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_JOURNALS_EMAIL);
  await page.setViewportSize(DESKTOP.viewport);
  await page.goto("/accounting/opening-balance");
  await expect(page.getByRole("heading", { name: "Saldo Awal" })).toBeVisible();
  await expect(page.getByText("Saldo awal baru bisa dibukukan mulai 1 Januari 2027, setelah semua data 2026 lengkap.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Bukukan saldo awal" })).toBeDisabled();
  await expect(page.getByTestId("opening-typed-line").first()).toContainText("1-1101");
});

test("a view-only role sees no manual journal or close buttons; staff without accounting.view are refused", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_VIEW_ONLY_EMAIL);
  await page.goto(DECEMBER_MANUAL);
  await expect(page.getByRole("heading", { name: "Jurnal Umum" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Catat jurnal manual" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Balik" })).toHaveCount(0);
  await page.goto("/accounting/journal/new");
  await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  await page.goto("/accounting/periods");
  await expect(page.getByRole("button", { name: "Tutup bulan" })).toHaveCount(0);

  await loginAs(page, E2E_ACCOUNTING_CS_EMAIL);
  for (const path of ["/accounting/trial-balance", "/accounting/periods", "/accounting/opening-balance"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  }
  const response = await page.request.get("/accounting/trial-balance/export?format=pdf");
  expect(response.status()).toBe(403);
});
