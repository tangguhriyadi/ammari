import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { E2E_STOREFRONT_EMAIL } from "./global-setup";

async function jpegFixture(width: number, height: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

/** Upload -> preview -> required alt text -> save draft -> Terbitkan, for the Hero section's
 * image field — the full loop docs/plans/storefront-cms.md's session 5 adds on top of session
 * 4's text-only editor. Run twice in the same test (390px then 1280px), each with its own unique
 * `label` so the two passes don't collide on the same draft/published content. */
async function runHeroImageUploadFlow(page: Page, label: string): Promise<void> {
  await page.goto("/content/hero");
  await page.getByLabel("Headline").fill(`Headline Gambar ${label}`);
  await page.getByLabel("Label tombol").fill("Belanja Sekarang");

  const photo = await jpegFixture(1600, 900, { r: 150, g: 120, b: 130 });
  await page.getByTestId("content-image-input-desktop").setInputFiles({ name: `hero-${label}.jpg`, mimeType: "image/jpeg", buffer: photo });

  // Upload happens immediately on file pick (no separate "staged" step, unlike product photos —
  // there's no DB row to defer here, see content-image-field.tsx's own doc comment) — wait for
  // the preview + required alt-text field to appear once it resolves.
  const altTextInput = page.getByLabel("Teks alternatif");
  await expect(altTextInput).toBeVisible({ timeout: 15_000 });
  await altTextInput.fill(`Model memakai gamis ${label}`);

  await page.getByRole("button", { name: "Simpan", exact: true }).click();
  await page.waitForLoadState("networkidle");

  // Reload to confirm the image round-tripped through the draft save, not just client state.
  await page.goto(page.url());
  await expect(page.getByLabel("Teks alternatif")).toHaveValue(`Model memakai gamis ${label}`);

  await page.goto("/content");
  await expect(page.getByTestId("unpublished-changes-banner")).toBeVisible();
  await page.getByRole("button", { name: "Terbitkan" }).click();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("unpublished-changes-banner")).toHaveCount(0);
}

/** Replace the currently-staged image with a new upload, then remove it entirely — covers
 * "preview, replace, remove" beyond the upload-and-save path above. */
async function runReplaceAndRemoveFlow(page: Page, label: string): Promise<void> {
  await page.goto("/content/feature-block");
  // Not `{ exact: true }` — both labels render a trailing " *" (required marker) as part of
  // their accessible name, so the exact string "Judul" never matches anything; and not a plain
  // substring match either — "Judul" is itself a substring of "Subjudul". An anchored regex is
  // the one option that distinguishes the two.
  await page.getByLabel(/^Judul\b/).fill(`Judul ${label}`);
  await page.getByLabel("Subjudul").fill(`Subjudul ${label}`);
  await page.getByLabel("Label tombol").fill("Lihat Produk");

  const firstPhoto = await jpegFixture(1600, 900, { r: 10, g: 200, b: 10 });
  await page.getByTestId("content-image-input-desktop").setInputFiles({ name: `fb-a-${label}.jpg`, mimeType: "image/jpeg", buffer: firstPhoto });
  const altTextInput = page.getByLabel("Teks alternatif");
  await expect(altTextInput).toBeVisible({ timeout: 15_000 });
  await altTextInput.fill(`Alt A ${label}`);
  const firstSrc = await page.locator("img[alt^='Alt A']").getAttribute("src");

  // Picking a new file on the SAME (still-present) hidden input re-fires its onChange handler —
  // exactly what "Ganti gambar" does for a real user; setInputFiles targets the input directly
  // rather than clicking that button, which would instead try to open a real native OS file
  // dialog under automation.
  const secondPhoto = await jpegFixture(1600, 900, { r: 200, g: 10, b: 10 });
  await page.getByTestId("content-image-input-desktop").setInputFiles({ name: `fb-b-${label}.jpg`, mimeType: "image/jpeg", buffer: secondPhoto });
  await expect(page.locator("img[alt^='Alt A']")).not.toHaveAttribute("src", firstSrc!, { timeout: 15_000 });

  // "Hapus ..." clears the image entirely, back to the "Unggah gambar" button.
  await page.getByRole("button", { name: /^Hapus gambar/ }).click();
  await expect(page.getByLabel("Teks alternatif")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Unggah gambar" })).toBeVisible();
}

test.describe("Konten: gambar Hero/Feature Block", () => {
  test("upload, preview, save draft, and publish a hero image — at both 390px and 1280px", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);

    await page.setViewportSize({ width: 390, height: 844 });
    await runHeroImageUploadFlow(page, "mobile");

    await page.setViewportSize({ width: 1280, height: 800 });
    await runHeroImageUploadFlow(page, "desktop");
  });

  test("replace and remove a staged feature-block image — at both 390px and 1280px", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);

    await page.setViewportSize({ width: 390, height: 844 });
    await runReplaceAndRemoveFlow(page, "mobile");

    await page.setViewportSize({ width: 1280, height: 800 });
    await runReplaceAndRemoveFlow(page, "desktop");
  });

  test("rejects an image below the minimum full-bleed dimensions with an Indonesian error, and never saves it", async ({ page }) => {
    await loginAs(page, E2E_STOREFRONT_EMAIL);
    // feature-block, not hero — the earlier tests in this file save/publish a real hero image,
    // and this assertion needs to start from "no image yet" (feature-block's own draft is never
    // actually SAVED by the replace/remove test above, which never clicks "Simpan").
    await page.goto("/content/feature-block");

    const tooSmall = await jpegFixture(300, 200, { r: 50, g: 50, b: 50 });
    await page.getByTestId("content-image-input-desktop").setInputFiles({ name: "too-small.jpg", mimeType: "image/jpeg", buffer: tooSmall });

    // Not a bare getByRole("alert") — Next.js's own route-change announcer
    // (#__next-route-announcer__) also carries role="alert", so scope to the paragraph with the
    // actual error text.
    await expect(page.locator('[role="alert"]', { hasText: /terlalu kecil/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel("Teks alternatif")).toHaveCount(0);
  });
});
