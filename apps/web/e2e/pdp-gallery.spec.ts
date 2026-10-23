import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_GALLERY_COLORS, E2E_GALLERY_NAME, E2E_GALLERY_PHOTOS, E2E_GALLERY_SLUG } from "./gallery-fixtures";

// The PDP page gallery (docs/plans/pdp-gallery.md §10, session 2 list: 1 to 5, 9, 10, 11). Every
// test runs at a phone and a desktop width, in both projects (Chromium and WebKit).

const VIEWPORTS = [
  { name: "390px", width: 390, height: 844, desktop: false },
  { name: "1280px", width: 1280, height: 900, desktop: true },
] as const;

const PDP = `/products/${E2E_GALLERY_SLUG}`;
const COUNT = E2E_GALLERY_PHOTOS.length;

function mainPhoto(page: Page): Locator {
  return page.getByTestId("gallery-current").locator("img");
}

function thumbnails(page: Page): Locator {
  return page.getByRole("group", { name: "Foto produk" }).getByRole("button");
}

async function expectPhoto(page: Page, index: number) {
  await expect(mainPhoto(page)).toHaveAttribute("alt", E2E_GALLERY_PHOTOS[index]!.alt);
  await expect(page.getByTestId("gallery-counter")).toHaveText(`${index + 1} / ${COUNT}`);
  await expect(thumbnails(page).nth(index)).toHaveAttribute("aria-current", "true");
}

/** The thumbnail lies fully inside the strip's visible area (after its smooth scroll). */
async function expectThumbInView(page: Page, index: number) {
  const strip = page.getByRole("group", { name: "Foto produk" });
  await expect
    .poll(async () => {
      const [stripBox, thumbBox] = await Promise.all([strip.boundingBox(), thumbnails(page).nth(index).boundingBox()]);
      return stripBox !== null && thumbBox !== null && thumbBox.x >= stripBox.x - 1 && thumbBox.x + thumbBox.width <= stripBox.x + stripBox.width + 1;
    })
    .toBe(true);
}

/** A horizontal drag across the main photo (Pointer Events, the same path a finger takes). */
async function swipe(page: Page, direction: "left" | "right") {
  const main = page.getByTestId("gallery-main");
  // A tap elsewhere (a size button) may have scrolled the photo partly out of the viewport.
  await main.evaluate((element) => element.scrollIntoView({ block: "center" }));
  const box = (await main.boundingBox())!;
  const y = box.y + box.height / 2;
  const [from, to] = direction === "left" ? [box.x + box.width * 0.8, box.x + box.width * 0.2] : [box.x + box.width * 0.2, box.x + box.width * 0.8];
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move(to, y, { steps: 8 });
  await page.mouse.up();
}

/** "next"/"previous" the way each width offers it: arrows on desktop, a swipe on phones. */
async function step(page: Page, desktop: boolean, direction: "next" | "previous") {
  if (desktop) {
    await page.getByTestId("gallery-main").hover();
    await page.getByRole("button", { name: direction === "next" ? "Foto berikutnya" : "Foto sebelumnya" }).click();
  } else {
    await swipe(page, direction === "next" ? "left" : "right");
  }
}

/** The colour id behind a swatch, read from the `?color=` its click writes. */
async function colorIdOf(page: Page, colorName: string): Promise<string> {
  await page.getByRole("button", { name: colorName }).click();
  await expect(page).toHaveURL(/\?color=/);
  return new URL(page.url()).searchParams.get("color")!;
}


/** Records every slide the main photo starts (owner feedback 2026-10-23): its direction
 * (`data-slide`), whether a real animation runs, and how many photos the track holds meanwhile
 * (the leaving one beside the incoming one). Read back with `slideLog`. */
async function recordSlides(page: Page) {
  await page.getByTestId("gallery-track").evaluate((track) => {
    const log: { slide: string; animations: number; photos: number }[] = [];
    (window as unknown as { __slides: typeof log }).__slides = log;
    new MutationObserver(() => {
      const slide = track.getAttribute("data-slide");
      if (slide) log.push({ slide, animations: track.getAnimations().length, photos: track.querySelectorAll("img").length });
    }).observe(track, { attributes: true, attributeFilter: ["data-slide"] });
  });
}

async function slideLog(page: Page) {
  return page.evaluate(() => (window as unknown as { __slides: { slide: string; animations: number; photos: number }[] }).__slides);
}

/** Left/Right on the page itself: focus out of the thumbnail strip first (a thumbnail tap leaves
 * focus there, and in the strip the keys move focus instead, by design). */
async function pressOnPage(page: Page, key: "ArrowLeft" | "ArrowRight") {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(key);
}

/** Waits for the slide in progress to come to rest. */
async function expectAtRest(page: Page) {
  await expect(page.getByTestId("gallery-track")).not.toHaveAttribute("data-slide");
}

for (const viewport of VIEWPORTS) {
  test.describe(`PDP gallery (${viewport.name})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    });

    test("1. the strip shows every photo in order (general, then colour groups); the active one is outlined", async ({ page }) => {
      await page.goto(PDP);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(E2E_GALLERY_NAME);
      await expect(thumbnails(page)).toHaveCount(COUNT);
      for (const [index, photo] of E2E_GALLERY_PHOTOS.entries()) {
        const thumb = thumbnails(page).nth(index);
        await expect(thumb).toHaveAccessibleName(`Lihat foto ${index + 1} dari ${COUNT}`);
        await expect(thumb.locator("img")).toHaveAttribute("src", new RegExp(`/api/test/fixtures/${photo.fixture}/400\\.webp$`));
      }
      await expectPhoto(page, 0);
      const outline = (thumb: Locator) => thumb.evaluate((element) => `${getComputedStyle(element).outlineStyle} ${getComputedStyle(element).outlineWidth}`);
      expect(await outline(thumbnails(page).nth(0))).toBe("solid 1px");
      expect(await outline(thumbnails(page).nth(1))).toMatch(/^none/);
      await expect(page.getByRole("button", { name: `Perbesar foto 1 dari ${COUNT}` })).toBeVisible();
    });

    test("2. selecting a colour jumps to its first photo and scrolls the strip to it; ?color= via replace", async ({ page }) => {
      await page.goto("/");
      await page.goto(PDP);
      await page.getByRole("button", { name: E2E_GALLERY_COLORS.navy }).click();
      await expectPhoto(page, 4);
      await expectThumbInView(page, 4);
      await expect(page).toHaveURL(/\?color=/);

      // Browse away, then re-tap the selected colour: back to its first photo.
      await thumbnails(page).nth(0).click();
      await expectPhoto(page, 0);
      await page.getByRole("button", { name: E2E_GALLERY_COLORS.navy }).click();
      await expectPhoto(page, 4);
      await expectThumbInView(page, 4);

      // replace, not push: one step back leaves the PDP.
      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
    });

    test("3. thumbnails, arrows/swipe change the photo, wrap at both ends, and never change colour, size or URL", async ({ page }) => {
      await page.goto(PDP);
      await page.getByRole("button", { name: "M", exact: true }).click();
      await expect(page.getByText("Ukuran: M")).toBeVisible();
      const url = page.url();

      await thumbnails(page).nth(3).click();
      await expectPhoto(page, 3);
      await thumbnails(page).nth(0).click();
      await expectPhoto(page, 0);

      await step(page, viewport.desktop, "previous");
      await expectPhoto(page, COUNT - 1);
      await expectThumbInView(page, COUNT - 1);
      await step(page, viewport.desktop, "next");
      await expectPhoto(page, 0);
      await expectThumbInView(page, 0);
      await step(page, viewport.desktop, "next");
      await expectPhoto(page, 1);

      await expect(page.getByText(`Warna: ${E2E_GALLERY_COLORS.sage}`)).toBeVisible();
      await expect(page.getByText("Ukuran: M")).toBeVisible();
      expect(page.url()).toBe(url);
    });

    test("3b. the arrows show on hover and keyboard focus only (desktop), and never on phones", async ({ page }) => {
      await page.goto(PDP);
      const next = page.getByRole("button", { name: "Foto berikutnya" });
      if (!viewport.desktop) {
        await expect(next).toBeHidden();
        return;
      }
      const opacity = () => next.evaluate((element) => getComputedStyle(element).opacity);
      await page.mouse.move(viewport.width - 5, viewport.height - 5);
      await expect.poll(opacity).toBe("0");
      await page.getByTestId("gallery-main").hover();
      await expect.poll(opacity).toBe("1");
      await page.mouse.move(viewport.width - 5, viewport.height - 5);
      await expect.poll(opacity).toBe("0");
      // Keyboard modality first, so the focus below is :focus-visible (as after a Tab).
      await page.keyboard.press("Shift");
      await next.focus();
      await expect(next).toBeFocused();
      await expect.poll(opacity).toBe("1");
      await page.keyboard.press("Enter");
      await expectPhoto(page, 1);
    });

    test("3c. keyboard: arrow keys move focus within the strip, Enter shows that photo", async ({ page }) => {
      await page.goto(PDP);
      await thumbnails(page).nth(0).focus();
      await page.keyboard.press("ArrowLeft");
      await expect(thumbnails(page).nth(COUNT - 1)).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(thumbnails(page).nth(1)).toBeFocused();
      await expectPhoto(page, 0);
      await page.keyboard.press("Enter");
      await expectPhoto(page, 1);
    });

    test("4. landing with ?color= starts on that colour's first photo; without it, on the first photo", async ({ page }) => {
      await page.goto(PDP);
      await expectPhoto(page, 0);
      const navyId = await colorIdOf(page, E2E_GALLERY_COLORS.navy);

      await page.goto(`${PDP}?color=${navyId}`);
      await expectPhoto(page, 4);
      await expectThumbInView(page, 4);
      await expect(page.getByText(`Warna: ${E2E_GALLERY_COLORS.navy}`)).toBeVisible();
    });

    test("5. a colour without photos shows the first general photo", async ({ page }) => {
      await page.goto(PDP);
      await page.getByRole("button", { name: E2E_GALLERY_COLORS.navy }).click();
      await expectPhoto(page, 4);
      await page.getByRole("button", { name: E2E_GALLERY_COLORS.noPhoto }).click();
      await expectPhoto(page, 0);
      await expect(page.getByText(`Warna: ${E2E_GALLERY_COLORS.noPhoto}`)).toBeVisible();
    });

    test("9. no layout shift: the main photo's box is the same before and after load, CLS is 0", async ({ page }) => {
      await page.addInitScript(() => {
        const win = window as unknown as { __cls: number };
        win.__cls = 0;
        if (!PerformanceObserver.supportedEntryTypes?.includes("layout-shift")) return;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
            if (!entry.hadRecentInput) win.__cls += entry.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      // First measured once the HTML and CSS are in (before the photo itself has loaded).
      await page.goto(PDP, { waitUntil: "domcontentloaded" });
      const main = page.getByTestId("gallery-main");
      await main.waitFor();
      const before = (await main.boundingBox())!;
      await page.waitForLoadState("load");
      await expect.poll(() => mainPhoto(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      const after = (await main.boundingBox())!;
      expect(after.height).toBeCloseTo(before.height, 0);
      expect(after.width).toBeCloseTo(before.width, 0);
      expect(after.height / after.width).toBeCloseTo(1.5, 1);
      expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBe(0);
    });

    test("10. only the main photo is high priority and preloaded; every thumbnail is lazy", async ({ page }) => {
      await page.goto(PDP);
      await expect(page.locator('img[fetchpriority="high"]')).toHaveCount(1);
      await expect(mainPhoto(page)).toHaveAttribute("fetchpriority", "high");
      await expect(mainPhoto(page)).toHaveAttribute("loading", "eager");
      const srcset = await mainPhoto(page).getAttribute("srcset");
      expect(srcset).toMatch(/800\.webp 800w, .*1600\.webp 1600w$/);
      // React's own server-rendered preload for that same eager, high-priority <img>: one product
      // photo preload, the main one (no second photo competes, unlike the old two `priority`
      // images). The footer's payment logos have their own, unrelated preloads.
      const preloads = page.locator('link[rel="preload"][as="image"][imagesrcset*="/api/test/fixtures/"], link[rel="preload"][as="image"][href*="/api/test/fixtures/"]');
      await expect(preloads).toHaveCount(1);
      await expect(preloads).toHaveAttribute("imagesrcset", srcset!);
      for (let index = 0; index < COUNT; index += 1) {
        await expect(thumbnails(page).nth(index).locator("img")).toHaveAttribute("loading", "lazy");
      }
    });

    test("11. browsing the gallery leaves the discounted price block exactly as it was", async ({ page }) => {
      await page.goto(PDP);
      // The PDP's own price comes first; related tiles below carry the same test ids.
      const price = page.getByTestId("product-price").first();
      await expect(price.getByTestId("product-price-list")).toHaveText("Rp350.000");
      await expect(price.getByTestId("product-price-sale")).toHaveText("Rp279.000");
      const before = await price.innerHTML();

      await thumbnails(page).nth(5).click();
      await step(page, viewport.desktop, "next");
      await expectPhoto(page, 0);
      await page.getByTestId("gallery-main").click();

      expect(await price.innerHTML()).toBe(before);
      await expect(page.getByText(`Warna: ${E2E_GALLERY_COLORS.sage}`)).toBeVisible();
    });

    test("12. every change slides in from its side, straight to the target; wrap-around keeps the direction", async ({ page }) => {
      await page.goto(PDP);
      await recordSlides(page);

      // Thumbnail far ahead: one slide from the right, straight there.
      await thumbnails(page).nth(5).click();
      await expectPhoto(page, 5);
      await expectAtRest(page);
      // Next on the last photo wraps to the first, still from the right.
      if (viewport.desktop) await step(page, true, "next");
      else await pressOnPage(page, "ArrowRight");
      await expectPhoto(page, 0);
      await expectAtRest(page);
      // Previous on the first photo wraps to the last, from the left.
      await pressOnPage(page, "ArrowLeft");
      await expectPhoto(page, 5);
      await expectAtRest(page);
      // Thumbnail behind: from the left.
      await thumbnails(page).nth(1).click();
      await expectPhoto(page, 1);
      await expectAtRest(page);
      // Colour jump ahead: from the right.
      await page.getByRole("button", { name: E2E_GALLERY_COLORS.navy }).click();
      await expectPhoto(page, 4);
      await expectAtRest(page);

      const log = await slideLog(page);
      expect(log.map((entry) => entry.slide)).toEqual(["next", "next", "prev", "prev", "next"]);
      // A real animation each time, with the leaving photo beside the incoming one.
      for (const entry of log) expect(entry).toMatchObject({ animations: 1, photos: 2 });
    });

    test("12b. rapid clicks never queue: the latest target wins and the slide settles once", async ({ page }) => {
      await page.goto(PDP);
      await recordSlides(page);
      for (const index of [2, 5, 3]) await thumbnails(page).nth(index).click();
      await expectPhoto(page, 3);
      await expectAtRest(page);
      await expect(page.getByTestId("gallery-track").locator("img")).toHaveCount(1);
      expect(await page.getByTestId("gallery-track").evaluate((track) => track.getAnimations().length)).toBe(0);
    });

    test("12c. prefers-reduced-motion: arrows, thumbnails, keys and swipes swap instantly", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(PDP);
      await recordSlides(page);
      await thumbnails(page).nth(3).click();
      await expectPhoto(page, 3);
      await pressOnPage(page, "ArrowRight");
      await expectPhoto(page, 4);
      await step(page, viewport.desktop, "next");
      await expectPhoto(page, 5);
      expect(await slideLog(page)).toEqual([]);
      await expect(page.getByTestId("gallery-track").locator("img")).toHaveCount(1);
    });

    test("13. Left/Right anywhere on the page change the photo, wrap, and announce it", async ({ page }) => {
      await page.goto(PDP);
      await page.getByRole("heading", { level: 1 }).click();
      await page.keyboard.press("ArrowRight");
      await expectPhoto(page, 1);
      await expect(page.getByRole("status").filter({ hasText: /^Foto \d/ })).toHaveText(`Foto 2 dari ${COUNT}`);
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await expectPhoto(page, COUNT - 1);
      await expect(page.getByRole("status").filter({ hasText: /^Foto \d/ })).toHaveText(`Foto ${COUNT} dari ${COUNT}`);
      // Never the colour, size or URL.
      await expect(page.getByText(`Warna: ${E2E_GALLERY_COLORS.sage}`)).toBeVisible();
      expect(page.url()).not.toContain("?color=");
    });

    test("13b. the page-wide keys are ignored with a modifier, in a text field, in an open dialog, and in the strip", async ({ page }) => {
      await page.goto(PDP);
      await page.getByRole("heading", { level: 1 }).click();
      await page.keyboard.press("Shift+ArrowRight");
      await expectPhoto(page, 0);

      await page.evaluate(() => {
        const input = document.createElement("input");
        input.setAttribute("aria-label", "Kolom uji");
        document.body.append(input);
      });
      await page.getByRole("textbox", { name: "Kolom uji" }).focus();
      await page.keyboard.press("ArrowRight");
      await expectPhoto(page, 0);

      await page.evaluate(() => {
        const dialog = document.createElement("dialog");
        dialog.innerHTML = "<button>Tutup uji</button>";
        document.body.append(dialog);
        dialog.showModal();
      });
      await page.keyboard.press("ArrowRight");
      await expectPhoto(page, 0);
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[open]")).toHaveCount(0);

      // In the strip the keys move focus only (one move per press, never also the photo).
      await thumbnails(page).nth(0).focus();
      await page.keyboard.press("ArrowRight");
      await expect(thumbnails(page).nth(1)).toBeFocused();
      await expectPhoto(page, 0);
    });
  });
}
