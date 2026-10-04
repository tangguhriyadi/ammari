import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { loginAs } from "./helpers/login";
import { E2E_SUPER_ADMIN_EMAIL } from "./global-setup";

test.use({ viewport: { width: 390, height: 844 } });

async function jpegFixture(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 40, channels: 3, background: color } }).jpeg().toBuffer();
}

test("upload photos, reorder, set thumbnail, and block activation until every active color has a photo", async ({ page }) => {
  // super_admin, not owner — the OTP send throttle is 5 per 5 minutes per email
  // (packages/auth/src/staff/create-staff-auth.ts), and products.spec.ts's own tests already
  // use E2E_OWNER_EMAIL close to that limit; a 6th login in the same run tips it over.
  // super_admin also holds products.manage, so it works equally well here.
  await loginAs(page, E2E_SUPER_ADMIN_EMAIL);
  const unique = Date.now();

  // 1. Create a fabric with TWO colors in one submit — Sage will get photos, Mocca won't.
  const fabricName = `E2E Bahan Foto ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "+ Tambah warna" }).click();
  await page.getByLabel("Nama warna").nth(1).fill("Mocca");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  // 2. Create a product on that fabric, created INACTIVE — so the variants added below come in
  // ACTIVE normally (addVariants only auto-deactivates new variants for a photo-less color on
  // an ALREADY-active product), making the later activation attempt meaningfully test the
  // required-photo check itself rather than a variant that's inactive for an unrelated reason.
  const productName = `Contoh Gamis Foto E2E ${unique}`;
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  // Switch, not a checkbox — role="switch" has no check()/uncheck(), click to toggle it off.
  await page.getByRole("switch", { name: "Aktif" }).click();
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);

  // 3. Add a size-M variant for BOTH colors in one batch.
  await page.getByRole("checkbox", { name: /Sage/ }).check();
  await page.getByRole("checkbox", { name: /Mocca/ }).check();
  await page.getByRole("checkbox", { name: "M", exact: true }).check();
  await page.getByRole("button", { name: "Tambah varian" }).click();
  await expect(page.getByRole("heading", { name: productName })).toBeVisible(); // page re-rendered, variants saved

  // 4. Upload two photos to the Sage group. Scoped by its heading text, not a fixed testid —
  // product-photos-section.tsx's data-testid for a color group is keyed on the color's (unknown
  // ahead of time) UUID, unlike the "general" group's fixed one.
  const sageGroup = page
    .locator('[data-testid^="photo-group-"]')
    .filter({ has: page.getByRole("heading", { name: "Sage", exact: true }) });
  const sagePhotoA = await jpegFixture({ r: 150, g: 180, b: 140 });
  const sagePhotoB = await jpegFixture({ r: 100, g: 130, b: 90 });
  // A single input, no capture attribute — iOS/Android already offer camera-or-library from
  // this alone (owner feedback), so there's no separate gallery-vs-camera input to pick between.
  const sageFileInput = sageGroup.locator('input[type="file"]');
  await sageFileInput.setInputFiles([
    { name: "sage-a.jpg", mimeType: "image/jpeg", buffer: sagePhotoA },
    { name: "sage-b.jpg", mimeType: "image/jpeg", buffer: sagePhotoB },
  ]);

  // 4a. Selecting files stages them as local previews — nothing is uploaded yet (owner
  // feedback: picking files must not save them immediately).
  const sagePendingTiles = sageGroup.getByTestId("pending-photo-tile");
  await expect(sagePendingTiles).toHaveCount(2);
  await expect(sageGroup.getByTestId("photo-tile")).toHaveCount(0);
  await expect(page.getByTestId("unsaved-photos-count")).toHaveText("2 foto belum disimpan");

  // 4b. "Simpan" uploads the staged files sequentially; once saved they become real tiles and
  // leave the pending list.
  await page.getByTestId("save-photos-button").click();
  const sageTiles = sageGroup.getByTestId("photo-tile");
  await expect(sageTiles).toHaveCount(2, { timeout: 15_000 });
  await expect(sagePendingTiles).toHaveCount(0);
  await expect(sageGroup.getByText("Utama", { exact: true })).toBeVisible();

  // 5. Reorder via the overflow menu: "Geser ke kanan" on the first tile swaps it with the
  // second — verify by the actual image src, not just a badge, since both fixture photos are
  // otherwise visually generic.
  const firstTileImgSrcBefore = await sageTiles.nth(0).getByRole("img").getAttribute("src");
  const secondTileImgSrcBefore = await sageTiles.nth(1).getByRole("img").getAttribute("src");
  await sageTiles.nth(0).getByRole("button", { name: "Opsi foto" }).click();
  await page.getByRole("menuitem", { name: "Geser ke kanan" }).click();
  await expect(sageTiles.nth(0).getByRole("img")).toHaveAttribute("src", secondTileImgSrcBefore!);
  await expect(sageTiles.nth(1).getByRole("img")).toHaveAttribute("src", firstTileImgSrcBefore!);
  // "Utama" follows the position, not the original image — still on tile 0 after the swap.
  await expect(sageTiles.nth(0).getByText("Utama", { exact: true })).toBeVisible();

  // 6. Upload one general photo, then explicitly make it the thumbnail via its overflow menu
  // (it won't be one automatically — Sage's first photo already claimed that in step 4).
  const generalGroup = page.getByTestId("photo-group-general");
  const generalPhoto = await jpegFixture({ r: 200, g: 200, b: 200 });
  await generalGroup.locator('input[type="file"]').setInputFiles({ name: "general.jpg", mimeType: "image/jpeg", buffer: generalPhoto });
  await expect(generalGroup.getByTestId("pending-photo-tile")).toHaveCount(1);
  await page.getByTestId("save-photos-button").click();
  const generalTile = generalGroup.getByTestId("photo-tile");
  await expect(generalTile).toHaveCount(1, { timeout: 15_000 });
  await expect(generalGroup.getByTestId("pending-photo-tile")).toHaveCount(0);
  await expect(generalTile.locator('[aria-label="Thumbnail produk"]')).toHaveCount(0);
  await generalTile.getByRole("button", { name: "Opsi foto" }).click();
  await page.getByRole("menuitem", { name: "Jadikan thumbnail" }).click();
  await expect(generalTile.locator('[aria-label="Thumbnail produk"]')).toBeVisible();

  // 7. Mocca still has no photo — activating the product must be refused, naming Mocca.
  // Scoped to <form> — ProductForm's own "Aktif" switch is the only one inside a <form>; each
  // variant row's own "Aktif" switch (same accessible name) sits outside any <form>.
  const productActiveSwitch = page.locator("form").getByRole("switch", { name: "Aktif" });
  await productActiveSwitch.click();
  await page.getByRole("button", { name: "Simpan" }).first().click();
  await expect(page.getByText(/Warna berikut belum punya foto.*Mocca/)).toBeVisible();
  await expect(productActiveSwitch).toHaveAttribute("aria-checked", "false");
});

test("staged photos can be removed individually, and Batal discards the rest after confirmation", async ({ page }) => {
  await loginAs(page, E2E_SUPER_ADMIN_EMAIL);
  const unique = Date.now();

  const fabricName = `E2E Bahan Foto Batal ${unique}`;
  await page.goto("/fabrics/new");
  await page.getByLabel("Nama bahan").fill(fabricName);
  await page.getByLabel("Nama warna").fill("Sage");
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/fabrics\/[0-9a-f-]+$/);

  const productName = `Contoh Gamis Foto E2E Batal ${unique}`;
  await page.goto("/products/new");
  await page.getByLabel("Nama produk").fill(productName);
  await page.locator("#product-fabric").selectOption({ label: fabricName });
  await page.getByLabel("Harga dasar").fill("269.000");
  await page.getByRole("switch", { name: "Aktif" }).click();
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]+$/);

  const generalGroup = page.getByTestId("photo-group-general");
  const photoA = await jpegFixture({ r: 10, g: 20, b: 30 });
  const photoB = await jpegFixture({ r: 40, g: 50, b: 60 });
  await generalGroup
    .locator('input[type="file"]')
    .setInputFiles([
      { name: "a.jpg", mimeType: "image/jpeg", buffer: photoA },
      { name: "b.jpg", mimeType: "image/jpeg", buffer: photoB },
    ]);

  const pendingTiles = generalGroup.getByTestId("pending-photo-tile");
  await expect(pendingTiles).toHaveCount(2);

  // Removing one staged file via its × button drops only that file, and nothing is uploaded.
  await pendingTiles.nth(0).getByRole("button", { name: /^Hapus/ }).click();
  await expect(pendingTiles).toHaveCount(1);
  await expect(page.getByTestId("unsaved-photos-count")).toHaveText("1 foto belum disimpan");

  // "Batal" asks for confirmation before discarding what's left.
  await page.getByTestId("discard-photos-button").click();
  await expect(page.getByRole("heading", { name: "Batalkan foto yang belum disimpan?" })).toBeVisible();
  await page.getByRole("button", { name: "Batalkan" }).click();

  await expect(pendingTiles).toHaveCount(0);
  await expect(page.getByTestId("unsaved-photos-bar")).toHaveCount(0);
  await expect(generalGroup.getByTestId("photo-tile")).toHaveCount(0);
});
