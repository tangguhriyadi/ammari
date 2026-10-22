import { expect, test } from "@playwright/test";
import { E2E_PRODUCT_SLUG, E2E_UNPUBLISHED_PRODUCT_SLUG } from "./storefront-fixtures";
import { CART_E2E } from "./helpers/cart-flag";
import { animatedBetween, readCurtainLog, recordCurtain } from "./helpers/curtain";

test.describe("/products/[slug]", () => {
  test("renders gallery/price/colours/sizes/keunggulan/accordions at 390px and 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Gamis Flowy Straight E2E");
    await expect(page.getByText("Rp269.000")).toBeVisible();
    await expect(page.getByText("Beige E2E", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "S", exact: true })).toBeVisible();
    await expect(page.getByText("Breathable")).toBeVisible();
    await expect(page.getByRole("button", { name: "Deskripsi" })).toHaveAttribute("aria-expanded", "true");

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Gamis Flowy Straight E2E");
    await expect(page.getByText("Rp269.000")).toBeVisible();
  });

  test("an unknown or unpublished slug 404s", async ({ page }) => {
    const unknown = await page.goto("/products/does-not-exist-e2e");
    expect(unknown?.status()).toBe(404);

    const unpublished = await page.goto(`/products/${E2E_UNPUBLISHED_PRODUCT_SLUG}`);
    expect(unpublished?.status()).toBe(404);
  });

  test("switching colour updates the gallery and the URL's ?color=, via replace (not push)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Gamis Flowy Straight E2E/ }).first().click();
    await expect(page).toHaveURL(new RegExp(`/products/${E2E_PRODUCT_SLUG}$`));

    const mobileGallery = page.locator(".md\\:hidden img").first();
    await expect(mobileGallery).toHaveAttribute("alt", "Gamis Flowy Straight Beige");

    await page.getByRole("button", { name: "Navy E2E" }).click();
    await expect(page).toHaveURL(/\?color=/);
    await expect(mobileGallery).toHaveAttribute("alt", "Gamis Flowy Straight Navy");

    // "replace", not "push" — going back once must leave the PDP entirely (back to "/"), not land
    // on an earlier ?color= state of the same page.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });

  test("size selection: an in-stock size is selectable, an out-of-stock size is aria-disabled and labelled 'habis'", async ({ page }) => {
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);

    const sizeL = page.getByRole("button", { name: "Ukuran L habis", exact: true });
    await expect(sizeL).toHaveAttribute("aria-disabled", "true");

    const sizeS = page.getByRole("button", { name: "S", exact: true });
    await sizeS.click();
    await expect(page.getByText("Ukuran: S")).toBeVisible();

    // The WhatsApp CTA's prefilled message picks up the chosen size (lib/whatsapp.ts).
    const whatsapp = page.getByRole("link", { name: /Tanya via WhatsApp/ });
    const href = await whatsapp.getAttribute("href");
    expect(decodeURIComponent(href ?? "")).toContain("Ukuran S");
  });

  test("accordions: Deskripsi is open by default, keyboard (Enter) toggles another panel and closes it", async ({ page }) => {
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);

    const deskripsi = page.getByRole("button", { name: "Deskripsi" });
    const perawatan = page.getByRole("button", { name: "Perawatan" });
    await expect(deskripsi).toHaveAttribute("aria-expanded", "true");
    await expect(perawatan).toHaveAttribute("aria-expanded", "false");

    await perawatan.focus();
    await page.keyboard.press("Enter");
    await expect(perawatan).toHaveAttribute("aria-expanded", "true");
    // Only one open at a time.
    await expect(deskripsi).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press("Enter");
    await expect(perawatan).toHaveAttribute("aria-expanded", "false");
  });

  test("the WhatsApp CTA is the primary action while the cart flag is off (the shipped default)", async ({ page }) => {
    test.skip(CART_E2E, "cart flag on: cart.spec.ts covers the cart CTA");
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
    await expect(page.getByRole("button", { name: /Tambah ke keranjang|Pilih ukuran/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Tanya via WhatsApp/ })).toBeVisible();
  });

  // components/curtain.tsx: panels unroll top to bottom and roll back up, animating their real
  // height, with the closing state rendered before the content is removed.
  for (const viewport of [
    { name: "390px", width: 390, height: 844 },
    { name: "1280px", width: 1280, height: 900 },
  ]) {
    test(`accordion panels unroll and roll back up (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
      const perawatan = page.getByRole("button", { name: "Perawatan" });
      const panel = page.locator(`[id="${await perawatan.getAttribute("aria-controls")}"]`);
      await recordCurtain(perawatan);

      await perawatan.click();
      await expect(panel).toHaveAttribute("data-state", "open");
      const opened = await readCurtainLog(perawatan);
      expect(opened.states).toEqual(["removed", "entering", "opening", "open"]);
      const height = (await panel.boundingBox())!.height;
      expect(height).toBeGreaterThan(20);
      expect(animatedBetween(opened.heights, height)).toBe(true);
      // Settled open: no clip left, so focus outlines inside are not cut off.
      expect(await panel.locator(".curtain-clip").evaluate((element) => getComputedStyle(element).overflow)).toBe("visible");

      await perawatan.click();
      await expect(panel).toHaveCount(0);
      const closed = await readCurtainLog(perawatan);
      expect(closed.states.slice(-2)).toEqual(["closing", "removed"]);
      expect(animatedBetween(closed.heights.slice(opened.heights.length), height)).toBe(true);
    });
  }

  // The size chart's table is wider than a phone (min 480px): only its own container scrolls
  // sideways, the page never does (`.curtain-clip`'s min-width: 0 in globals.css).
  for (const viewport of [
    { name: "390px", width: 390, height: 844 },
    { name: "1280px", width: 1280, height: 900 },
  ]) {
    test(`the open Ukuran panel never makes the page scroll sideways (${viewport.name})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
      const ukuran = page.getByRole("button", { name: "Ukuran", exact: true });
      await ukuran.click();
      await expect(page.locator(`[id="${await ukuran.getAttribute("aria-controls")}"]`)).toHaveAttribute("data-state", "open");
      const table = page.getByRole("region", { name: "Tabel panduan ukuran" });
      await expect(table.getByRole("rowheader", { name: "M" })).toBeVisible();

      const pageWidth = await page.evaluate(() => ({ scroll: document.scrollingElement!.scrollWidth, viewport: document.documentElement.clientWidth }));
      expect(pageWidth.scroll).toBe(pageWidth.viewport);

      const box = await table.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth, right: element.getBoundingClientRect().right }));
      expect(box.right).toBeLessThanOrEqual(viewport.width);
      if (viewport.width === 390) {
        // The table itself scrolls, the hint says so, and the Ukuran column stays put.
        expect(box.scroll).toBeGreaterThan(box.client);
        await expect(page.getByText("Geser tabel ke samping untuk melihat semua kolom.")).toBeVisible();
        const sizeCell = table.getByRole("rowheader", { name: "M" });
        const before = (await sizeCell.boundingBox())!.x;
        await table.evaluate((element) => element.scrollTo({ left: element.scrollWidth, behavior: "instant" }));
        expect((await sizeCell.boundingBox())!.x).toBe(before);
        expect(await page.evaluate(() => window.scrollX)).toBe(0);
      } else {
        expect(box.scroll).toBe(box.client);
        await expect(page.getByText("Geser tabel ke samping untuk melihat semua kolom.")).toBeHidden();
      }
    });
  }

  test("prefers-reduced-motion: accordion panels switch instantly", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
    const perawatan = page.getByRole("button", { name: "Perawatan" });
    await recordCurtain(perawatan);
    await perawatan.click();
    await expect(perawatan).toHaveAttribute("aria-expanded", "true");
    await perawatan.click();
    await expect(perawatan).toHaveAttribute("aria-expanded", "false");
    const { states } = await readCurtainLog(perawatan);
    expect(states).toEqual(["removed", "open", "removed"]);
  });
});
