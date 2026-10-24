import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_SUPPLIERS_EMAIL } from "./global-setup";

// docs/plans/suppliers-goods-receipt.md session 1: the supplier master. Runs the whole flow at
// 390px AND at the project's default 1280px (CLAUDE.md's rule) — /suppliers renders two
// independent layouts (CardList for phones, TableContainer for tablet/desktop), so a test
// pinned to one viewport can pass while the other is silently broken. The row locator differs
// per layout on purpose: `li` is the card, `tr` is the table row, and each pass asserts the
// OTHER layout is hidden rather than just absent.
interface Layout {
  /** The row element for this layout. */
  rowTag: "li" | "tr";
  /** The row element the OTHER layout uses, which must be present-but-hidden here. */
  hiddenRowTag: "li" | "tr";
  label: string;
}

const MOBILE: Layout = { rowTag: "li", hiddenRowTag: "tr", label: "mobile" };
const DESKTOP: Layout = { rowTag: "tr", hiddenRowTag: "li", label: "desktop" };

function rowFor(page: Page, layout: Layout, name: string) {
  return page.locator(layout.rowTag).filter({ hasText: name });
}

/** The same supplier's row in the layout that is NOT active at this viewport — it is still in
 * the DOM (both layouts always render; Tailwind's `md:hidden`/`hidden md:block` decides which
 * one shows), so this asserts hidden, not absent. */
function hiddenRowFor(page: Page, layout: Layout, name: string) {
  return page.locator(layout.hiddenRowTag).filter({ hasText: name });
}

/** The search box scopes every list assertion to this run's own supplier — the `ammari_e2e`
 * database is shared across runs and both viewport passes, so an unscoped list would also hold
 * rows from earlier ones. */
async function searchSuppliers(page: Page, marker: string): Promise<void> {
  await page.getByLabel("Cari supplier").fill(marker);
  await page.getByLabel("Cari supplier").press("Enter");
  await page.waitForLoadState("networkidle");
}

async function runSupplierFlow(page: Page, layout: Layout): Promise<void> {
  const marker = `${layout.label}-${Date.now()}`;
  const name = `E2E Supplier ${marker}`;

  // 1. "Batal" on the create form goes back to the list without creating anything.
  await page.goto("/suppliers/new");
  await page.getByRole("link", { name: "Batal" }).click();
  await expect(page).toHaveURL(/\/suppliers$/);

  // 2. A NAME ALONE is enough (plan D13) — every other field is left blank on purpose.
  await page.goto("/suppliers/new");
  await page.getByLabel("Nama supplier").fill(name);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  // Create redirects to the LIST and raises a success toast (role=status), exactly once.
  await expect(page).toHaveURL(/\/suppliers$/);
  await expect(page.getByRole("status")).toContainText("Supplier berhasil ditambahkan");
  await page.reload();
  await expect(page.getByRole("status")).toBeEmpty();
  await searchSuppliers(page, marker);
  await rowFor(page, layout, name).getByRole("link", { name }).click();
  await expect(page).toHaveURL(/\/suppliers\/[0-9a-f-]+$/);
  const supplierUrl = page.url();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  // 3. It shows up on the list in THIS layout, and the other layout's row is hidden, not gone.
  await page.goto("/suppliers");
  await searchSuppliers(page, marker);
  await expect(rowFor(page, layout, name)).toBeVisible();
  await expect(rowFor(page, layout, name).getByRole("link", { name })).toBeVisible();
  await expect(hiddenRowFor(page, layout, name).first()).toBeHidden();

  // 4. Edit: add the bank details and a kind, and confirm they survive a reload.
  await page.goto(supplierUrl);
  await page.getByRole("checkbox", { name: "Kain" }).check();
  await page.getByLabel("Telepon/WhatsApp").fill("0812 3456 7890");
  await page.getByLabel("Nama bank").fill("BCA");
  await page.getByLabel("Nomor rekening").fill("1234567890");
  await page.getByLabel("Nama pemilik rekening").fill(`Pemilik ${marker}`);
  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  // Edit also lands on the list, with the generic "saved" toast; the unsaved-changes guard
  // never prompts on the redirect after a successful save (a dialog would hang this test).
  await expect(page).toHaveURL(/\/suppliers$/);
  await expect(page.getByRole("status")).toContainText("Perubahan berhasil disimpan");

  await page.goto(supplierUrl);
  await expect(page.getByLabel("Nama bank")).toHaveValue("BCA");
  await expect(page.getByLabel("Nomor rekening")).toHaveValue("1234567890");
  await expect(page.getByRole("checkbox", { name: "Kain" })).toBeChecked();
  // The phone became a real wa.me link (0812... normalized to 62812...).
  await expect(page.getByRole("link", { name: /Chat WhatsApp/ })).toHaveAttribute("href", "https://wa.me/6281234567890");

  // 5. Deactivate from the list itself (never a delete — plan D13's "no hard delete, ever").
  await page.goto("/suppliers");
  await searchSuppliers(page, marker);
  await rowFor(page, layout, name).getByRole("switch").click();
  await expect(rowFor(page, layout, name).getByText("Nonaktif")).toBeVisible({ timeout: 15_000 });

  // 6. The filter tabs agree: it's under Nonaktif and gone from Aktif. The URL assertion after
  // each tab click is load-bearing, not decoration — `searchSuppliers` submits a plain GET form
  // whose hidden `status` field comes from the CURRENT render, so firing it before the tab's
  // client-side navigation has landed would re-submit the previous tab's filter and the next
  // assertion would pass or fail for the wrong reason. The tabs keep the current search (q).
  await page.getByRole("link", { name: "Nonaktif", exact: true }).click();
  await page.waitForURL(/\/suppliers\?status=inactive(&q=[^&]*)?$/);
  await searchSuppliers(page, marker);
  await expect(page).toHaveURL(/status=inactive/);
  await expect(rowFor(page, layout, name)).toBeVisible();

  await page.getByRole("link", { name: "Aktif", exact: true }).click();
  await page.waitForURL(/\/suppliers\?status=active(&q=[^&]*)?$/);
  await searchSuppliers(page, marker);
  await expect(page).toHaveURL(/status=active/);
  await expect(rowFor(page, layout, name)).toHaveCount(0);

  // 7. And reactivating puts it back under Aktif.
  await page.goto("/suppliers");
  await searchSuppliers(page, marker);
  await rowFor(page, layout, name).getByRole("switch").click();
  await expect(rowFor(page, layout, name).getByText("Nonaktif")).toHaveCount(0, { timeout: 15_000 });
}

test.describe("Data Master: Supplier", () => {
  test("create with only a name, edit to add bank details, deactivate and filter — at 390px and 1280px", async ({ page }) => {
    await loginAs(page, E2E_SUPPLIERS_EMAIL);

    await page.setViewportSize({ width: 390, height: 844 });
    await runSupplierFlow(page, MOBILE);

    await page.setViewportSize({ width: 1280, height: 800 });
    await runSupplierFlow(page, DESKTOP);
  });

  test("a duplicate name is refused, case-insensitively, with the message on the form", async ({ page }) => {
    await loginAs(page, E2E_SUPPLIERS_EMAIL);
    const name = `E2E Supplier Duplikat ${Date.now()}`;

    await page.goto("/suppliers/new");
    await page.getByLabel("Nama supplier").fill(name);
    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page).toHaveURL(/\/suppliers$/);

    // Same name in a different case — `suppliers.name` is citext, so this must collide.
    await page.goto("/suppliers/new");
    await page.getByLabel("Nama supplier").fill(name.toUpperCase());
    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    // Scoped to the form's own alert paragraph — a bare getByRole("alert") also matches Next's
    // always-present route announcer (`#__next-route-announcer__`), which is empty.
    await expect(page.locator("p[role=alert]")).toContainText("sudah terdaftar");
    await expect(page).toHaveURL(/\/suppliers\/new$/);
  });

  test("Supplier sits in the Data Master nav group", async ({ page }) => {
    await loginAs(page, E2E_SUPPLIERS_EMAIL);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/suppliers");

    const nav = page.getByRole("navigation", { name: "Navigasi utama" });
    await expect(nav.getByRole("link", { name: "Supplier" })).toBeVisible();
    await expect(nav.getByText("Data Master")).toBeVisible();
  });
});
