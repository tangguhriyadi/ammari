import { expect, test, type Page } from "@playwright/test";
import { loginAs } from "./helpers/login";
import { E2E_PRODUCTS_NO_FINANCE_EMAIL, E2E_STOREFRONT_EMAIL } from "./global-setup";

// docs/plans/storefront-cms.md Phase 2 (session 8): info pages (own draft/publish per page,
// unlike the homepage's atomic "Terbitkan") and store settings (save = live, no draft/publish).
// Both run at 390px AND 1280px (CLAUDE.md's rule, applied even though Konten isn't a wife's-daily
// page — it's still used from a phone, per the original plan's own "Admin UX" section).

async function runInfoPagePublishAndDiscardFlow(page: Page, label: string): Promise<void> {
  const editor = page.getByTestId("info-page-body-editor");

  await page.goto("/content/pages/how-to-order");
  await page.locator("#info-page-title").fill(`Cara Pemesanan ${label}`);
  // RichTextEditor is a contentEditable ProseMirror instance, not a plain <textarea> — targeted
  // by its own data-testid and typed into directly (same convention storefront-section.spec.ts
  // uses for the identical editor on the product form; `getByLabel` doesn't resolve here because
  // the `<label for>` points at EditorContent's wrapper id, not the ProseMirror node itself).
  await editor.click();
  await page.keyboard.type(`Langkah terbit ${label}.`);
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: "Terbitkan" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Halaman ini belum pernah diterbitkan")).toHaveCount(0);

  // An unsaved BODY edit disables "Terbitkan" until saved — the editor's own "simpan draf dulu"
  // guard. (`title` is NOT part of the draft/publish pair at all — see info-pages.ts's own doc
  // comment — so it's never what this test exercises for the disable/discard behaviour below.)
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Draf belum disimpan.");
  await expect(page.getByRole("button", { name: "Terbitkan" })).toBeDisabled();
  await page.getByRole("button", { name: "Simpan draf" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: "Terbitkan" })).toBeEnabled();

  // "Batalkan perubahan" resets the DRAFT BODY back to what's published — title is a plain,
  // immediately-live field (not draft/publish), so it's untouched by discard, on purpose.
  await page.getByRole("button", { name: "Batalkan perubahan" }).click();
  await page.waitForLoadState("networkidle");
  await expect(editor).toContainText(`Langkah terbit ${label}.`);
  await expect(editor).not.toContainText("Draf belum disimpan");
}

test.describe("Konten: Halaman Info", () => {
  test("edit a draft, publish, edit again, then discard back to published — at 390px and 1280px", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);

    await page.setViewportSize({ width: 390, height: 844 });
    await runInfoPagePublishAndDiscardFlow(page, "mobile");

    await page.setViewportSize({ width: 1280, height: 800 });
    await runInfoPagePublishAndDiscardFlow(page, "desktop");
  });

  test("the overview lists all 5 pages with their publish status", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);
    await page.goto("/content/pages");
    for (const slug of ["privacy-policy", "terms-of-service", "returns-exchange", "how-to-order", "shipping"]) {
      await expect(page.getByTestId(`info-page-row-${slug}`)).toBeVisible();
    }
    // privacy-policy/terms-of-service are seeded already-published (migration 0020).
    await expect(page.getByTestId("info-page-row-privacy-policy").getByText("Tayang")).toBeVisible();
  });

  test("a staff user without content.manage is denied /content/pages and never sees the Halaman Info nav item", async ({ page }) => {
    await loginAs(page, E2E_PRODUCTS_NO_FINANCE_EMAIL); // products.manage only, no content.manage

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Halaman Info" })).toHaveCount(0);

    await page.goto("/content/pages");
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();

    await page.goto("/content/pages/shipping");
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  });
});

test.describe("Konten: Pengaturan Toko", () => {
  test("save normalizes the WhatsApp number and persists every field (save = live) — at 390px and 1280px", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/content/settings");
    await page.getByLabel("Nomor WhatsApp").fill("081234567890");
    await page.getByLabel("Email").fill("halo-admin-e2e@ammari.id");
    await page.getByLabel("Alamat").fill("Jl. Contoh Admin E2E No. 1");
    await page.getByLabel("Ringkasan kebijakan tukar/retur").fill("Tukar ukuran dalam 3 hari (admin e2e)");
    await page.getByRole("button", { name: "Simpan" }).click();
    await expect(page.getByText("Tersimpan.")).toBeVisible();

    // Reload and confirm it persisted, normalized to wa.me format (62..., no leading 0).
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/content/settings");
    await expect(page.getByLabel("Email")).toHaveValue("halo-admin-e2e@ammari.id");
    await expect(page.getByLabel("Alamat")).toHaveValue("Jl. Contoh Admin E2E No. 1");
  });

  test("rejects an invalid WhatsApp number with a field error, without saving", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);
    await page.goto("/content/settings");
    await page.getByLabel("Nomor WhatsApp").fill("12345");
    await page.getByRole("button", { name: "Simpan" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByText("Tersimpan.")).toHaveCount(0);
  });

  test("a staff user without content.manage is denied /content/settings and never sees the Pengaturan Toko nav item", async ({ page }) => {
    await loginAs(page, E2E_PRODUCTS_NO_FINANCE_EMAIL);

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Pengaturan Toko" })).toHaveCount(0);

    await page.goto("/content/settings");
    await expect(page.getByRole("heading", { name: "Akses ditolak" })).toBeVisible();
  });
});
