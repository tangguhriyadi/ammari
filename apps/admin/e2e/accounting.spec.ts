import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { loginAs } from "./helpers/login";
import {
  E2E_ACCOUNTING_CS_EMAIL,
  E2E_ACCOUNTING_EMAIL,
  E2E_ACCOUNTING_EXPENSE_NO,
  E2E_ACCOUNTING_PAYMENT_NO,
  E2E_ACCOUNTING_PURCHASE_NO,
  E2E_ACCOUNTING_SUPPLIER,
  E2E_ACCOUNTING_VIEW_ONLY_EMAIL,
} from "./global-setup";

// docs/plans/accounting.md Session 2: Jurnal umum and Buku besar. The owner runs "Posting sekarang"
// over the seeded December 2026 Gaji expense and supplier payment (global-setup.ts), then reads
// both pages at 390px AND 1280px (CLAUDE.md's rule): each page renders a CardList on phones and a
// table on tablet/desktop, so every assertion goes through THIS viewport's rows and also checks the
// other layout's rows are hidden, not missing. The second "Posting sekarang" proves the run is
// idempotent from the UI: nothing new, nothing reversed.

interface Layout {
  label: string;
  journalRow: string;
  hiddenJournalRow: string;
  ledgerRow: string;
  hiddenLedgerRow: string;
  viewport: { width: number; height: number };
}

const MOBILE: Layout = {
  label: "mobile",
  journalRow: '[data-testid="journal-entry-card"]',
  hiddenJournalRow: '[data-testid="journal-entry-row"]',
  ledgerRow: '[data-testid="ledger-line-card"]',
  hiddenLedgerRow: '[data-testid="ledger-line-row"]',
  viewport: { width: 390, height: 844 },
};
const DESKTOP: Layout = {
  label: "desktop",
  journalRow: '[data-testid="journal-entry-row"]',
  hiddenJournalRow: '[data-testid="journal-entry-card"]',
  ledgerRow: '[data-testid="ledger-line-row"]',
  hiddenLedgerRow: '[data-testid="ledger-line-card"]',
  viewport: { width: 1280, height: 800 },
};

const DECEMBER = "from=2026-12-01&to=2026-12-31";

/** Clicks "Posting sekarang" and waits for its toast. The toast region (role="status") can still
 * hold an earlier toast, so callers match the text they expect inside it. */
async function runPosting(page: Page): Promise<void> {
  const toasts = page.getByRole("status").filter({ hasText: "Posting selesai" });
  const before = await page.getByRole("status").getByText("Posting selesai").count();
  await page.getByRole("button", { name: "Posting sekarang" }).click();
  await expect(toasts.getByText("Posting selesai")).toHaveCount(before + 1, { timeout: 15_000 });
}

async function checkJournal(page: Page, layout: Layout): Promise<void> {
  await page.goto(`/accounting/journal?${DECEMBER}`);
  await expect(page.getByRole("heading", { name: "Jurnal Umum" })).toBeVisible();

  const expense = page.locator(layout.journalRow).filter({ hasText: E2E_ACCOUNTING_EXPENSE_NO });
  await expect(expense).toHaveCount(1);
  await expect(expense).toBeVisible();
  await expect(expense).toContainText(`Biaya ${E2E_ACCOUNTING_EXPENSE_NO}: Gaji`);
  await expect(expense).toContainText("6-2101 Gaji");
  await expect(expense).toContainText("1-1201 Bank utama");
  await expect(expense).toContainText("Rp 1.234.000");
  await expect(expense).toContainText("3 Des 2026");
  await expect(expense).toContainText("Otomatis");
  // Present in the DOM (the other layout exists) but hidden at this width.
  const hiddenExpense = page.locator(layout.hiddenJournalRow).filter({ hasText: E2E_ACCOUNTING_EXPENSE_NO });
  await expect(hiddenExpense).toHaveCount(1);
  await expect(hiddenExpense).toBeHidden();

  const payment = page.locator(layout.journalRow).filter({ hasText: E2E_ACCOUNTING_PAYMENT_NO });
  await expect(payment).toBeVisible();
  await expect(payment).toContainText(`Pembayaran pembelian ${E2E_ACCOUNTING_PURCHASE_NO} ke ${E2E_ACCOUNTING_SUPPLIER}`);
  await expect(payment).toContainText("2-1101 Utang usaha pemasok bahan");
  await expect(payment).toContainText("1-1101 Kas tunai");
  await expect(payment).toContainText("Rp 500.000");
  // The source document links to its purchase.
  await expect(payment.getByRole("link", { name: E2E_ACCOUNTING_PAYMENT_NO })).toHaveAttribute("href", /^\/purchases\//);

  // Filtering by source keeps only the payment.
  const form = page.getByRole("form", { name: "Filter jurnal" });
  await form.getByLabel("Sumber").selectOption("supplier_payment");
  await form.getByRole("button", { name: "Terapkan" }).click();
  await expect(page).toHaveURL(/source=supplier_payment/);
  await expect(page.locator(layout.journalRow).filter({ hasText: E2E_ACCOUNTING_PAYMENT_NO })).toBeVisible();
  await expect(page.locator(layout.journalRow).filter({ hasText: E2E_ACCOUNTING_EXPENSE_NO })).toHaveCount(0);
}

async function checkLedger(page: Page, layout: Layout): Promise<void> {
  await page.goto("/accounting/ledger");
  await expect(page.getByText("Pilih akun dan periode, lalu tekan Tampilkan.")).toBeVisible();

  const form = page.getByRole("form", { name: "Filter buku besar" });
  await form.getByLabel("Akun").selectOption("2-1101");
  await form.getByLabel("Dari tanggal").fill("2026-12-01");
  await form.getByLabel("Sampai tanggal").fill("2026-12-31");
  await form.getByLabel("Supplier").selectOption({ label: E2E_ACCOUNTING_SUPPLIER });
  await form.getByRole("button", { name: "Tampilkan" }).click();
  await expect(page).toHaveURL(/account=2-1101/);

  await expect(page.getByRole("heading", { name: "Buku Besar 2-1101 Utang usaha pemasok bahan" })).toBeVisible();
  await expect(page.getByText("Saldo normal: Kredit")).toBeVisible();
  await expect(page.getByTestId("ledger-opening")).toHaveText("Rp 0");
  await expect(page.getByTestId("ledger-debit-total")).toHaveText("Rp 500.000");
  await expect(page.getByTestId("ledger-credit-total")).toHaveText("Rp 0");
  // Without chain (Session 2) the payment clears utang before any receipt is booked, so the
  // credit-normal account runs against its normal side until Session 7 posts receipts.
  await expect(page.getByTestId("ledger-closing")).toHaveText("-Rp 500.000");

  const rows = page.locator(layout.ledgerRow);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(E2E_ACCOUNTING_PAYMENT_NO);
  await expect(rows.first()).toContainText("Rp 500.000");
  await expect(rows.first()).toContainText("-Rp 500.000");
  const hiddenRows = page.locator(layout.hiddenLedgerRow);
  await expect(hiddenRows).toHaveCount(1);
  await expect(hiddenRows.first()).toBeHidden();
}

test("Jurnal umum and Buku besar after Posting sekarang, at 390px and 1280px", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_EMAIL);

  await page.setViewportSize(MOBILE.viewport);
  await page.goto(`/accounting/journal?${DECEMBER}`);
  await runPosting(page);
  // Idempotent: a second run posts nothing new and reverses nothing. (The anchor keeps a first
  // toast's "10 jurnal baru, 0 jurnal dibalik" from matching.)
  await runPosting(page);
  await expect(page.getByRole("status").getByText(/^Posting selesai: 0 jurnal baru, 0 jurnal dibalik/).last()).toBeVisible();

  for (const layout of [MOBILE, DESKTOP]) {
    await test.step(layout.label, async () => {
      await page.setViewportSize(layout.viewport);
      await checkJournal(page, layout);
      await checkLedger(page, layout);
    });
  }
});

test("staff without accounting.view get Akses ditolak and no Akuntansi menu", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_CS_EMAIL);
  await page.goto("/accounting/journal");
  await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  await page.goto("/accounting/ledger");
  await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  await page.goto("/orders");
  await expect(page.getByRole("link", { name: "Jurnal Umum" })).toHaveCount(0);
});

test("a view-only role reads the journal but gets no Posting sekarang button", async ({ page }) => {
  await loginAs(page, E2E_ACCOUNTING_VIEW_ONLY_EMAIL);
  await page.goto(`/accounting/journal?${DECEMBER}`);
  await expect(page.getByRole("heading", { name: "Jurnal Umum" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Posting sekarang" })).toHaveCount(0);
});
