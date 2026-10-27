import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import {
  E2E_CUSTOMERS_CS_EMAIL,
  E2E_CUSTOMERS_NO_ACCESS_EMAIL,
  E2E_CUSTOMERS_OWNER_EMAIL,
  E2E_CUSTOMER_EMAIL,
  E2E_CUSTOMER_NAME,
  E2E_CUSTOMER_PHONE,
  E2E_GUEST_NAME,
} from "./global-setup";

// docs/plans/growth.md sessions S4 and S5: Pelanggan & Voucher. The whole flow runs at 390px AND
// 1280px (CLAUDE.md's rule): every list renders a CardList on phones and a TableContainer on
// tablet/desktop, so each pass asserts its own layout's rows and that the other layout's are
// hidden. Each pass works on its own seeded customer (global-setup.ts), so the voids and
// extensions of one pass never touch the other's vouchers. Session S6: the owner downloads
// "Unduh kontak promo" (A9) only after ticking the warning; CS has neither the button nor the route.

interface Layout {
  key: "M" | "D";
  label: string;
  viewport: { width: number; height: number };
  /** Suffix of each list's data-testid for this layout, and the other one's. */
  item: "card" | "row";
  hidden: "card" | "row";
}

const MOBILE: Layout = { key: "M", label: "390px", viewport: { width: 390, height: 844 }, item: "card", hidden: "row" };
const DESKTOP: Layout = { key: "D", label: "1280px", viewport: { width: 1280, height: 800 }, item: "row", hidden: "card" };

function jakartaDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

function maskedPhone(phone: string): string {
  const national = phone.slice(3);
  return `+62 ${national.slice(0, 3)} **** ${national.slice(-4)}`;
}

async function openDetail(page: Page, layout: Layout): Promise<string> {
  const name = E2E_CUSTOMER_NAME(layout.key);
  await page.goto(`/customers?q=${encodeURIComponent(name)}`);
  const link = page.locator(`[data-testid="customer-${layout.item}"]`).filter({ hasText: name }).getByRole("link", { name });
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/customers\/[0-9a-f-]{36}$/);
  await link.click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  return href!;
}

function voucher(page: Page, layout: Layout, index: number) {
  return page.locator(`[data-testid="customer-voucher-${layout.item}"][data-voucher="ORD-E2E-CUST-${layout.key}-${index}"]`);
}

async function ownerFlow(page: Page, layout: Layout): Promise<string> {
  const name = E2E_CUSTOMER_NAME(layout.key);
  const email = E2E_CUSTOMER_EMAIL(layout.key);
  const phone = E2E_CUSTOMER_PHONE[layout.key];

  // 1. The list: masked contacts only; the unpaid guest is hidden until asked for.
  await page.goto(`/customers?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("heading", { name: "Pelanggan & Voucher" })).toBeVisible();
  const row = page.locator(`[data-testid="customer-${layout.item}"]`).filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(page.locator(`[data-testid="customer-${layout.hidden}"]`).filter({ hasText: name })).toBeHidden();
  await expect(row).toContainText(maskedPhone(phone));
  await expect(row).toContainText(`pe***@e2e.ammari.test`);
  await expect(row).toContainText("Akun situs");
  await expect(row).toContainText("Rp 1.730.000");
  expect(await page.content()).not.toContain(email);
  expect(await page.content()).not.toContain(phone);

  const guestName = E2E_GUEST_NAME(layout.key);
  await page.goto(`/customers?q=${encodeURIComponent(guestName)}`);
  await expect(page.getByText("Belum ada pelanggan", { exact: true })).toBeVisible();
  await page.getByLabel("Termasuk yang belum pernah belanja").check();
  await page.getByRole("button", { name: "Terapkan" }).click();
  await expect(page).toHaveURL(/all=1/);
  await expect(page.locator(`[data-testid="customer-${layout.item}"]`).filter({ hasText: guestName })).toContainText("Checkout tamu");

  // 2. Filter tab "Setuju promo" keeps the customer.
  await page.goto(`/customers?q=${encodeURIComponent(name)}`);
  await page.getByRole("navigation", { name: "Filter pelanggan" }).getByRole("link", { name: "Setuju promo" }).click();
  await expect(page).toHaveURL(/filter=promo/);
  await expect(page.locator(`[data-testid="customer-${layout.item}"]`).filter({ hasText: name })).toBeVisible();

  // 3. The detail: full contacts, never the order's contact snapshot or address.
  const href = await openDetail(page, layout);
  await expect(page.getByTestId("customer-email")).toContainText(email);
  await expect(page.getByTestId("customer-email")).toContainText("Terverifikasi");
  await expect(page.getByTestId("customer-phone")).toContainText(phone);
  await expect(page.getByTestId("customer-account")).toContainText("Ya, masuk dengan Kode email");
  await expect(page.getByTestId("customer-promo-consent")).toContainText("Setuju sejak");
  expect(await page.content()).not.toContain("Jl. Rahasia");
  expect(await page.content()).not.toContain(`rahasia-${layout.key.toLowerCase()}@`);
  await expect(page.locator(`[data-testid="customer-order-${layout.item}"]`)).toHaveCount(6);
  await expect(page.locator(`[data-testid="customer-order-${layout.hidden}"]`).first()).toBeHidden();
  await expect(page.locator(`[data-testid="customer-claimed-card"]`)).toHaveCount(4);
  await expect(voucher(page, layout, 1)).toContainText("Aktif");
  await expect(voucher(page, layout, 3)).toContainText("Kedaluwarsa");
  await expect(voucher(page, layout, 4)).toContainText("Terpakai");
  await expect(voucher(page, layout, 4)).toContainText(`ORD-E2E-CUST-${layout.key}-U`);
  await expect(voucher(page, layout, 4).getByRole("button")).toHaveCount(0);

  // 4. Void with a required reason.
  const voidLabel = `Batalkan voucher ORD-E2E-CUST-${layout.key}-2`;
  await voucher(page, layout, 2).getByRole("button", { name: voidLabel, exact: true }).click();
  const voidDialog = page.getByRole("dialog", { name: `${voidLabel}?` });
  await voidDialog.getByRole("button", { name: "Batalkan voucher", exact: true }).click();
  await expect(voidDialog.getByText("Alasan wajib diisi.")).toBeVisible();
  await voidDialog.getByLabel("Alasan").fill("Kartu hilang, dilaporkan pelanggan");
  await voidDialog.getByRole("button", { name: "Batalkan voucher", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Voucher dibatalkan", { timeout: 15_000 });
  await expect(voucher(page, layout, 2)).toContainText("Dibatalkan");
  await expect(voucher(page, layout, 2).getByTestId("voucher-history")).toContainText("Dibatalkan oleh E2E Pelanggan (owner)");
  await expect(voucher(page, layout, 2).getByTestId("voucher-history")).toContainText("Kartu hilang, dilaporkan pelanggan");
  await expect(voucher(page, layout, 2).getByRole("button", { name: voidLabel, exact: true })).toHaveCount(0);

  // 5. Extend the lapsed voucher: active again until the chosen day.
  const extendLabel = `Perpanjang voucher ORD-E2E-CUST-${layout.key}-3`;
  await voucher(page, layout, 3).getByRole("button", { name: extendLabel, exact: true }).click();
  const extendDialog = page.getByRole("dialog", { name: `${extendLabel}?` });
  await extendDialog.getByLabel("Berlaku sampai").fill(jakartaDate(30));
  await extendDialog.getByLabel("Alasan").fill("Pelanggan sakit, minta tambahan waktu");
  await extendDialog.getByRole("button", { name: "Perpanjang voucher", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Voucher diperpanjang", { timeout: 15_000 });
  await expect(voucher(page, layout, 3)).toContainText("Aktif");
  await expect(voucher(page, layout, 3).getByTestId("voucher-history")).toContainText("Diperpanjang dari");

  // 6. The Voucher tab: counts, the liability for finance, "Segera berakhir", status filter.
  await page.goto("/customers?tab=voucher");
  await expect(page.getByTestId("voucher-count-active")).toBeVisible();
  await expect(page.getByTestId("voucher-active-value")).toContainText("Nilai voucher aktif");
  await expect(page.locator(`[data-testid="voucher-expiring-${layout.item}"]`).filter({ hasText: name })).toBeVisible();
  await expect(page.locator(`[data-testid="voucher-expiring-${layout.hidden}"]`).filter({ hasText: name })).toBeHidden();
  await page.goto(`/customers?tab=voucher&status=void&q=${encodeURIComponent(name)}`);
  await expect(page.locator(`[data-testid="voucher-${layout.item}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-testid="voucher-${layout.item}"]`)).toContainText("Dibatalkan");
  await page.goto(`/customers?tab=voucher&status=expired&q=${encodeURIComponent(name)}`);
  await expect(page.getByText("Belum ada voucher", { exact: true })).toBeVisible();

  // 7. Unduh kontak promo: the warning must be ticked; the CSV holds this consenting account
  // holder (full contacts, the four columns) and never the unpaid guest.
  await page.goto("/customers");
  await page.getByRole("button", { name: "Unduh kontak promo" }).click();
  const exportDialog = page.getByRole("dialog", { name: "Unduh kontak promo" });
  await expect(exportDialog.getByTestId("promo-export-warning")).toContainText("Jangan unggah ke Meta, TikTok");
  await exportDialog.getByRole("button", { name: "Unduh CSV" }).click();
  await expect(exportDialog.getByText("Centang pernyataan di atas dulu.")).toBeVisible();
  await exportDialog.getByLabel("Saya paham data ini hanya untuk promo Ammari sendiri dan tidak diunggah ke platform iklan.").check();
  const [download] = await Promise.all([page.waitForEvent("download"), exportDialog.getByRole("button", { name: "Unduh CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^kontak-promo-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = (await readFile(await download.path())).toString("utf8").replace(/^\ufeff/, "");
  const lines = csv.trimEnd().split("\r\n");
  expect(lines[0]).toBe("Nama,Email,Nomor HP,Setuju promo sejak (WIB)");
  const mine = lines.find((line) => line.includes(email));
  expect(mine).toBeDefined();
  expect(mine).toContain(`${name},${email},${phone.slice(1)},`);
  expect(csv).not.toContain(E2E_GUEST_NAME(layout.key));
  expect((await page.request.get("/customers/promo-export")).status()).toBe(400);

  // 8. Ringkasan: the voucher card for this month links to the tab.
  await page.goto("/?period=month");
  const card = page.getByTestId("overview-voucher-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: "Lihat voucher" })).toHaveAttribute("href", "/customers?tab=voucher");
  return href;
}

async function csFlow(page: Page, layout: Layout, detailHref: string): Promise<void> {
  await page.context().clearCookies();
  await loginAs(page, E2E_CUSTOMERS_CS_EMAIL);
  await page.goto(detailHref);
  await expect(page.getByRole("heading", { name: E2E_CUSTOMER_NAME(layout.key), level: 1 })).toBeVisible();
  // No promo export for CS (A9): no button, and the route itself refuses.
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "Pelanggan & Voucher" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unduh kontak promo" })).toHaveCount(0);
  expect((await page.request.get("/customers/promo-export?ack=1")).status()).toBe(403);
  await page.goto(detailHref);

  // History visible, no void/extend for CS (roles-staff answer 9, A8).
  await expect(voucher(page, layout, 2).getByTestId("voucher-history")).toContainText("Kartu hilang");
  await expect(page.getByRole("button", { name: /^Batalkan voucher/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Perpanjang voucher/ })).toHaveCount(0);

  // Promo withdrawal (customers.manage): source required.
  await page.getByRole("button", { name: "Catat penarikan persetujuan promo" }).click();
  const dialog = page.getByRole("dialog", { name: "Pelanggan minta berhenti menerima promo" });
  await dialog.getByRole("button", { name: "Catat penarikan" }).click();
  await expect(dialog.getByText("Pilih sumber permintaan.")).toBeVisible();
  await dialog.getByLabel("Sumber permintaan").selectOption("whatsapp");
  await dialog.getByRole("button", { name: "Catat penarikan" }).click();
  await expect(page.getByRole("status")).toContainText("Penarikan persetujuan promo dicatat", { timeout: 15_000 });
  await expect(page.getByTestId("customer-promo-consent")).toContainText("Ditarik pada");
  await expect(page.getByRole("button", { name: "Catat penarikan persetujuan promo" })).toHaveCount(0);

  // No finance.view_profit: no liability figure on the Voucher tab; the Ringkasan card still shows.
  await page.goto("/customers?tab=voucher");
  await expect(page.getByTestId("voucher-count-active")).toBeVisible();
  await expect(page.getByTestId("voucher-active-value")).toHaveCount(0);
  await page.goto("/?period=month");
  await expect(page.getByTestId("overview-voucher-card")).toBeVisible();
}

async function noAccessFlow(page: Page, detailHref: string): Promise<void> {
  await page.context().clearCookies();
  await loginAs(page, E2E_CUSTOMERS_NO_ACCESS_EMAIL);
  for (const path of ["/customers", "/customers?tab=voucher", detailHref]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  }
  await page.goto("/?period=month");
  await expect(page.getByRole("heading", { name: "Ringkasan" })).toBeVisible();
  await expect(page.getByTestId("overview-voucher-card")).toHaveCount(0);
}

test.describe("Pelanggan & Voucher", () => {
  for (const layout of [MOBILE, DESKTOP]) {
    test(`list, masked contacts, detail, void, extend, voucher tab, CS withdrawal, no access at ${layout.label}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize(layout.viewport);
      await loginAs(page, E2E_CUSTOMERS_OWNER_EMAIL);
      const detailHref = await ownerFlow(page, layout);
      await csFlow(page, layout, detailHref);
      await noAccessFlow(page, detailHref);
    });
  }
});
