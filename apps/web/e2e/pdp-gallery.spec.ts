import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_GALLERY_COLORS, E2E_GALLERY_NAME, E2E_GALLERY_PHOTOS, E2E_GALLERY_SLUG } from "./gallery-fixtures";
import { E2E_OTHER_COLOR_PHOTO_PRODUCT_SLUG } from "./storefront-fixtures";

// The PDP page gallery and its full-screen viewer (docs/plans/pdp-gallery.md §10: session 2 list 1
// to 5, 9, 10, 11; session 3 list 6 to 8). Every test runs at a phone and a desktop width, in both
// projects (Chromium and WebKit).

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


interface SlideEntry {
  slide: string;
  animations: number;
  photos: number;
  duration: number | null;
  easing: string | null;
}

/** Records every slide a track starts (owner feedback 2026-10-23): its direction (`data-slide`),
 * whether a real animation runs (and its timing), and how many photos the track holds meanwhile
 * (the leaving one beside the incoming one). `gallery-track` = the page gallery, `viewer-track` =
 * the full-screen viewer. Read back with `slideLog`. */
async function recordSlides(page: Page, trackId: "gallery-track" | "viewer-track" = "gallery-track") {
  await page.getByTestId(trackId).evaluate((track) => {
    const log: SlideEntry[] = [];
    (window as unknown as { __slides: typeof log }).__slides = log;
    new MutationObserver(() => {
      const slide = track.getAttribute("data-slide");
      if (!slide) return;
      const timing = track.getAnimations()[0]?.effect?.getTiming();
      log.push({
        slide,
        animations: track.getAnimations().length,
        photos: track.querySelectorAll("img").length,
        duration: typeof timing?.duration === "number" ? timing.duration : null,
        easing: timing?.easing ?? null,
      });
    }).observe(track, { attributes: true, attributeFilter: ["data-slide"] });
  });
}

async function slideLog(page: Page): Promise<SlideEntry[]> {
  return page.evaluate(() => (window as unknown as { __slides: SlideEntry[] }).__slides);
}

function viewer(page: Page, productName = E2E_GALLERY_NAME): Locator {
  return page.getByRole("dialog", { name: `Galeri foto ${productName}` });
}

function viewerPhoto(page: Page): Locator {
  return page.getByTestId("viewer-current").locator("img");
}

async function expectViewerPhoto(page: Page, index: number) {
  await expect(viewerPhoto(page)).toHaveAttribute("alt", E2E_GALLERY_PHOTOS[index]!.alt);
  await expect(page.getByTestId("viewer-counter")).toHaveText(`${index + 1} / ${COUNT}`);
}

/** Opens the viewer from the main photo and waits for its open transition to end (it takes no
 * input before). The first open in a dev server compiles its chunk. */
async function openViewer(page: Page, productName = E2E_GALLERY_NAME) {
  await page.getByTestId("gallery-main").click();
  await expect(viewer(page, productName)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("gallery-viewer")).toHaveAttribute("data-state", "open");
}

interface TransitionEntry {
  state: string;
  dialogOpen: boolean;
  photo: string[];
  backdrop: number[];
  dialogFade: number[];
  duration: number | null;
  easing: string | null;
  /** Where the photo's first (open) or last (close) frame puts it, against the main photo's box. */
  expected: { dx: number; dy: number; scale: number };
}

/** Records each open/close transition of the viewer as it starts: the photo's transform frames,
 * the backdrop's and the whole dialog's opacity frames, the timing, and the transform that would
 * put the 2:3 photo exactly over the main photo. Read back with `transitionLog`. */
async function recordTransitions(page: Page) {
  await page.evaluate(() => {
    const log: TransitionEntry[] = [];
    (window as unknown as { __transitions: typeof log }).__transitions = log;
    const read = (dialog: HTMLDialogElement) => {
      const stage = dialog.querySelector<HTMLElement>('[data-testid="viewer-stage"]')!;
      const backdrop = dialog.querySelector<HTMLElement>('[data-testid="viewer-backdrop"]')!;
      const photoAnimation = stage.getAnimations()[0];
      const frames = (animation: Animation | undefined, property: "transform" | "opacity") =>
        ((animation?.effect as KeyframeEffect | null)?.getKeyframes() ?? []).map((frame) => frame[property] as string);
      // The stage's own box, without the running transform.
      const stageBox = { width: stage.offsetWidth, height: stage.offsetHeight, left: 0, top: 0 };
      const parentBox = stage.parentElement!.getBoundingClientRect();
      stageBox.left = parentBox.left;
      stageBox.top = parentBox.top;
      const main = document.querySelector('[data-testid="gallery-main"]')!.getBoundingClientRect();
      const photoWidth = Math.min(stageBox.width, (stageBox.height * 2) / 3);
      const timing = (photoAnimation ?? dialog.getAnimations()[0])?.effect?.getTiming();
      log.push({
        state: dialog.getAttribute("data-state")!,
        dialogOpen: dialog.open,
        photo: frames(photoAnimation, "transform"),
        backdrop: frames(backdrop.getAnimations()[0], "opacity").map(Number),
        dialogFade: frames(dialog.getAnimations()[0], "opacity").map(Number),
        duration: typeof timing?.duration === "number" ? timing.duration : null,
        easing: timing?.easing ?? null,
        expected: {
          dx: main.left + main.width / 2 - (stageBox.left + stageBox.width / 2),
          dy: main.top + main.height / 2 - (stageBox.top + stageBox.height / 2),
          scale: main.width / photoWidth,
        },
      });
    };
    new MutationObserver((records) => {
      for (const record of records) {
        const targets = record.type === "attributes" ? [record.target] : [...record.addedNodes];
        for (const node of targets) {
          const dialog = node instanceof HTMLDialogElement ? node : node instanceof Element ? node.querySelector("dialog") : null;
          const state = dialog?.getAttribute("data-state");
          if (dialog && (state === "opening" || state === "closing")) read(dialog);
        }
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  });
}

async function transitionLog(page: Page): Promise<TransitionEntry[]> {
  return page.evaluate(() => (window as unknown as { __transitions: TransitionEntry[] }).__transitions);
}

/** `translate(dx px, dy px) scale(s)` from a keyframe, as numbers. */
function parseFlip(transform: string | undefined) {
  const match = /translate\((-?[\d.e-]+)px, (-?[\d.e-]+)px\) scale\(([\d.e-]+)\)/.exec(transform ?? "");
  if (!match) throw new Error(`not a flip transform: ${transform}`);
  return { dx: Number(match[1]), dy: Number(match[2]), scale: Number(match[3]) };
}

/** A horizontal mouse drag across the viewer's photo. */
async function swipeViewer(page: Page, direction: "left" | "right") {
  const box = (await page.getByTestId("viewer-stage").boundingBox())!;
  const y = box.y + box.height / 2;
  const [from, to] = direction === "left" ? [box.x + box.width * 0.8, box.x + box.width * 0.2] : [box.x + box.width * 0.2, box.x + box.width * 0.8];
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move(to, y, { steps: 8 });
  await page.mouse.up();
}

async function viewerScale(page: Page): Promise<number> {
  return Number(await page.getByTestId("viewer-zoom").getAttribute("data-scale"));
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
    test("6. the viewer opens at the same photo, wraps both ways, closes with Esc back on the main photo at the last photo viewed", async ({ page }) => {
      await page.goto(PDP);
      await thumbnails(page).nth(5).click();
      await expectPhoto(page, 5);
      await expectAtRest(page);
      const mainBox = (await page.getByTestId("gallery-main").boundingBox())!;
      const scrollY = await page.evaluate(() => window.scrollY);
      const pageWidth = await page.evaluate(() => document.documentElement.clientWidth);

      await openViewer(page);
      await expectViewerPhoto(page, 5);
      await expect(viewerPhoto(page)).toHaveAttribute("src", /\/1600\.webp$/);
      await expect(page.getByRole("button", { name: "Tutup" })).toBeFocused();
      // Background locked: <html> does not scroll, and nothing behind moves sideways.
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe("hidden");
      expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(pageWidth);

      // Right on the last photo wraps to the first; Left on the first wraps back to the last.
      await page.keyboard.press("ArrowRight");
      await expectViewerPhoto(page, 0);
      await page.keyboard.press("ArrowLeft");
      await expectViewerPhoto(page, 5);
      await page.keyboard.press("ArrowLeft");
      await expectViewerPhoto(page, 4);
      // The page gallery behind did not move with the keys.
      await expect(page.getByTestId("gallery-counter")).toHaveText(`6 / ${COUNT}`);
      // Wheel on the viewer: the page behind stays put.
      await page.mouse.wheel(0, 800);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

      await recordSlides(page);
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toBeHidden();
      await expect(page.getByTestId("gallery-main")).toBeFocused();
      // At the photo last viewed, at once (no slide), and nothing moved or scrolled.
      await expectPhoto(page, 4);
      expect(await slideLog(page)).toEqual([]);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
      const after = (await page.getByTestId("gallery-main").boundingBox())!;
      expect(after).toEqual(mainBox);
      // Browsing navy's photos in the viewer never touched the colour or the URL.
      await expect(page.getByText(`Warna: ${E2E_GALLERY_COLORS.sage}`)).toBeVisible();
      expect(page.url()).not.toContain("?color=");
    });

    test("6b. viewer buttons: Tutup, previous, next in tab order; they wrap and slide like the page gallery; Tutup closes", async ({ page, browserName }) => {
      await page.goto(PDP);
      await openViewer(page);
      await expectViewerPhoto(page, 0);
      // Safari's plain Tab skips buttons unless "Press Tab to highlight each item" is on;
      // Option+Tab is its every-control Tab.
      const tab = browserName === "webkit" ? "Alt+Tab" : "Tab";
      await page.keyboard.press(tab);
      await expect(viewer(page).getByRole("button", { name: "Foto sebelumnya" })).toBeFocused();
      await page.keyboard.press(tab);
      await expect(viewer(page).getByRole("button", { name: "Foto berikutnya" })).toBeFocused();

      await recordSlides(page, "viewer-track");
      await viewer(page).getByRole("button", { name: "Foto sebelumnya" }).click();
      await expectViewerPhoto(page, 5);
      await expect(page.getByTestId("viewer-track")).not.toHaveAttribute("data-slide");
      await viewer(page).getByRole("button", { name: "Foto berikutnya" }).click();
      await expectViewerPhoto(page, 0);
      await expect(page.getByTestId("viewer-track")).not.toHaveAttribute("data-slide");
      const log = await slideLog(page);
      expect(log.map((entry) => entry.slide)).toEqual(["prev", "next"]);
      // The page gallery's own slide: same duration and easing (lib/gallery/swipe.ts).
      for (const entry of log) expect(entry).toMatchObject({ animations: 1, photos: 2, duration: 300, easing: "cubic-bezier(0.33, 1, 0.68, 1)" });
      await expect(viewer(page).getByRole("status")).toHaveText("Foto 1 dari 6");

      await page.getByRole("button", { name: "Tutup" }).click();
      await expect(viewer(page)).toBeHidden();
      await expect(page.getByTestId("gallery-main")).toBeFocused();
      await expectPhoto(page, 0);
    });

    test("6c. viewer under prefers-reduced-motion: photos swap instantly", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(PDP);
      await openViewer(page);
      await recordSlides(page, "viewer-track");
      await page.keyboard.press("ArrowRight");
      await expectViewerPhoto(page, 1);
      await swipeViewer(page, "left");
      await expectViewerPhoto(page, 2);
      expect(await slideLog(page)).toEqual([]);
      await expect(page.getByTestId("viewer-track").locator("img")).toHaveCount(1);
    });

    test("6d. open grows the photo out of the main photo and close shrinks it back, with the backdrop fading", async ({ page }) => {
      await page.goto(PDP);
      // Load the viewer's code first, so the recorded open is a warm one.
      await openViewer(page);
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toBeHidden();
      await recordTransitions(page);

      await openViewer(page);
      await page.keyboard.press("ArrowRight");
      await expectViewerPhoto(page, 1);
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toBeHidden();
      await expect(page.getByTestId("gallery-main")).toBeFocused();
      await expectPhoto(page, 1);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");

      const [opening, closing] = await transitionLog(page);
      expect(opening).toMatchObject({ state: "opening", dialogOpen: true, backdrop: [0, 1], dialogFade: [], duration: 300, easing: "cubic-bezier(0.33, 1, 0.68, 1)" });
      expect(opening!.photo[1]).toBe("none");
      // The first frame puts the photo exactly over the main photo.
      const from = parseFlip(opening!.photo[0]);
      expect(from.dx).toBeCloseTo(opening!.expected.dx, 0);
      expect(from.dy).toBeCloseTo(opening!.expected.dy, 0);
      expect(from.scale).toBeCloseTo(opening!.expected.scale, 2);
      // Closing: the reverse, while the dialog is still open, ending on the main photo again.
      expect(closing).toMatchObject({ state: "closing", dialogOpen: true, backdrop: [1, 0], dialogFade: [], duration: 300 });
      expect(closing!.photo[0]).toBe("none");
      const to = parseFlip(closing!.photo[1]);
      expect(to.dx).toBeCloseTo(closing!.expected.dx, 0);
      expect(to.dy).toBeCloseTo(closing!.expected.dy, 0);
      expect(to.scale).toBeCloseTo(closing!.expected.scale, 2);
    });

    test("6e. a main photo that cannot be measured: the viewer closes with a plain fade", async ({ page }) => {
      await page.goto(PDP);
      await openViewer(page);
      await recordTransitions(page);
      await page.getByTestId("gallery-main").evaluate((element) => ((element as HTMLElement).style.display = "none"));
      await page.getByRole("button", { name: "Tutup" }).click();
      await expect(viewer(page)).toBeHidden();
      const [closing] = await transitionLog(page);
      expect(closing).toMatchObject({ state: "closing", photo: [], backdrop: [], dialogFade: [1, 0], duration: 300 });
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
    });

    test("6f. rapid open then close (Esc mid-opening) closes cleanly: page unlocked, focus back, opens again", async ({ page }) => {
      await page.goto(PDP);
      await openViewer(page);
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toBeHidden();

      await page.getByTestId("gallery-main").click();
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toBeHidden();
      await expect(page.getByTestId("gallery-main")).toBeFocused();
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe("hidden");
      await expectPhoto(page, 0);

      await openViewer(page);
      await page.keyboard.press("ArrowRight");
      await expectViewerPhoto(page, 1);
      await page.getByRole("button", { name: "Tutup" }).click();
      await expect(viewer(page)).toBeHidden();
      await expectPhoto(page, 1);
    });

    test("6g. prefers-reduced-motion: the viewer opens and closes at once, no animation", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(PDP);
      await page.getByTestId("gallery-main").click();
      await expect(page.getByTestId("gallery-viewer")).toHaveAttribute("data-state", "open", { timeout: 20_000 });
      expect(await page.getByTestId("gallery-viewer").evaluate((dialog) => dialog.getAnimations({ subtree: true }).length)).toBe(0);
      await recordTransitions(page);
      await page.keyboard.press("Escape");
      await expect(viewer(page)).toBeHidden();
      expect(await transitionLog(page)).toEqual([]);
      await expect(page.getByTestId("gallery-main")).toBeFocused();
    });

    test.describe("with a touchscreen", () => {
      test.use({ hasTouch: true });

      test("7. viewer: swipe changes photo (wrapping); zoom is touch only", async ({ page, browserName }) => {
        await page.goto(PDP);
        await openViewer(page);
        await swipeViewer(page, "right");
        await expectViewerPhoto(page, 5);
        await swipeViewer(page, "left");
        await expectViewerPhoto(page, 0);
        await swipeViewer(page, "left");
        await expectViewerPhoto(page, 1);

        if (viewport.desktop) {
          // No zoom on desktop (owner answer 6): not from a double-click, not from the wheel.
          const stage = page.getByTestId("viewer-stage");
          await stage.dblclick();
          await page.mouse.wheel(0, -400);
          expect(await viewerScale(page)).toBe(1);
          return;
        }

        const box = (await page.getByTestId("viewer-stage").boundingBox())!;
        const centre = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
        if (browserName === "chromium") {
          // Real multi-touch through the browser's own input pipeline (CDP). WebKit cannot
          // synthesize it in Playwright: there the double-tap below stands in, and real pinch is the
          // owner's iPhone check.
          const cdp = await page.context().newCDPSession(page);
          const touch = (type: "touchStart" | "touchMove" | "touchEnd", spread: number) =>
            cdp.send("Input.dispatchTouchEvent", {
              type,
              touchPoints:
                type === "touchEnd"
                  ? []
                  : [
                      { x: centre.x - spread, y: centre.y, id: 1 },
                      { x: centre.x + spread, y: centre.y, id: 2 },
                    ],
            });
          await touch("touchStart", 40);
          for (const spread of [60, 80, 100, 120]) await touch("touchMove", spread);
          await touch("touchEnd", 0);
          await expect.poll(() => viewerScale(page)).toBeGreaterThan(2.5);
          // Zoomed: a one-finger drag pans instead of changing photo.
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: centre.x + 100, y: centre.y, id: 3 }] });
          for (const x of [60, 20, -20, -60]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: centre.x + x, y: centre.y, id: 3 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await expectViewerPhoto(page, 1);
          // Dragged 160 px left: the photo moved left (not left at the pinch's own centred offset).
        const panX = await page.getByTestId("viewer-zoom").evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41);
        expect(panX).toBeLessThan(-100);
          // A new photo starts at 1x.
          await page.keyboard.press("ArrowRight");
          await expectViewerPhoto(page, 2);
          expect(await viewerScale(page)).toBe(1);
        }

        // Double-tap toggles 2.5x and back (touch). Pauses keep the two double-taps (and the
        // drag above) from reading as one quick run of taps.
        const doubleTap = async () => {
          await page.waitForTimeout(400);
          await page.touchscreen.tap(centre.x, centre.y);
          await page.touchscreen.tap(centre.x, centre.y);
        };
        await doubleTap();
        await expect.poll(() => viewerScale(page)).toBe(2.5);
        await doubleTap();
        await expect.poll(() => viewerScale(page)).toBe(1);
      });
    });

    test("8. one-photo product: no strip or arrows; the viewer opens without prev/next or counter", async ({ page }) => {
      await page.goto(`/products/${E2E_OTHER_COLOR_PHOTO_PRODUCT_SLUG}`);
      const productName = (await page.getByRole("heading", { level: 1 }).textContent())!.trim();
      await expect(page.getByRole("group", { name: "Foto produk" })).toHaveCount(0);
      await expect(page.getByTestId("gallery-counter")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Foto berikutnya" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Perbesar foto" })).toBeVisible();

      await openViewer(page, productName);
      await expect(viewer(page, productName).getByRole("button")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Tutup" })).toBeFocused();
      await expect(page.getByTestId("viewer-counter")).toHaveText("");
      await expect(viewerPhoto(page)).toHaveAttribute("alt", "Gamis Foto Warna Lain warna Mocca");
      await page.keyboard.press("ArrowRight");
      await expect(viewerPhoto(page)).toHaveAttribute("alt", "Gamis Foto Warna Lain warna Mocca");
      await page.keyboard.press("Escape");
      await expect(viewer(page, productName)).toBeHidden();
      await expect(page.getByTestId("gallery-main")).toBeFocused();
    });
  });
}
