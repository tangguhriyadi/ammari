// @vitest-environment jsdom
import { createRef } from "react";
import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ProductGallery as Gallery, ProductGalleryItem } from "@/lib/content/product-view";
import { GALLERY_SLIDE_EASING, GALLERY_SLIDE_MS } from "@/lib/gallery/swipe";
import { ProductGallery, type ProductGalleryHandle } from "./product-gallery";

const BASE = "https://cdn.example.test";

function item(id: string, colorId: string | null): ProductGalleryItem {
  return { id, storageKey: `products/p1/${id}`, altText: `Foto ${id}`, width: 800, height: 1200, colorId };
}

// 2 general, then sage (2), then mocca (2); "navy" has no photo.
const GALLERY: Gallery = {
  images: [item("g1", null), item("g2", null), item("s1", "sage"), item("s2", "sage"), item("m1", "mocca"), item("m2", "mocca")],
  colorStartIndex: { sage: 2, mocca: 4 },
};

let reduceMotion = false;
const scrollTo = vi.fn();

/** jsdom has no Web Animations: a stand-in that records each slide, so the tests can read its
 * direction and finish or see it cancelled. */
interface FakeSlide {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  onfinish: (() => void) | null;
  cancelled: boolean;
  cancel: () => void;
}
let slides: FakeSlide[] = [];

function lastSlide(): FakeSlide {
  const slide = slides.at(-1);
  if (!slide) throw new Error("no slide started");
  return slide;
}

function finishSlide() {
  act(() => lastSlide().onfinish?.());
}

beforeEach(() => {
  reduceMotion = false;
  window.matchMedia = ((query: string) => ({ matches: reduceMotion && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  scrollTo.mockReset();
  Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
  slides = [];
  Element.prototype.animate = function animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const slide: FakeSlide = {
      keyframes,
      options,
      onfinish: null,
      cancelled: false,
      cancel() {
        this.cancelled = true;
      },
    };
    slides.push(slide);
    return slide as unknown as Animation;
  } as unknown as Element["animate"];
});

function renderGallery(gallery: Gallery = GALLERY, { initialIndex = 0, onOpenViewer = vi.fn() } = {}) {
  const ref = createRef<ProductGalleryHandle>();
  const view = render(<ProductGallery ref={ref} productName="Haura" gallery={gallery} initialIndex={initialIndex} storageBaseUrl={BASE} onOpenViewer={onOpenViewer} />);
  return { ...view, ref, onOpenViewer };
}

function mainImage(): HTMLImageElement {
  return within(screen.getByTestId("gallery-current")).getByRole("img") as HTMLImageElement;
}

function thumbnails(): HTMLElement[] {
  return within(screen.getByRole("group", { name: "Foto produk" })).getAllByRole("button");
}

/** A pointer event with a chosen `timeStamp`: jsdom ignores one passed in the init and uses the
 * wall clock, which would make the swipe's release speed depend on how fast the test runs. */
function pointer(type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", element: HTMLElement, clientX: number, timeStamp: number) {
  const event = createEvent[type](element, { pointerId: 1, clientX, button: 0, pointerType: "touch" });
  // Offset: React's synthetic event reads a 0 timeStamp as missing and uses Date.now() instead.
  Object.defineProperty(event, "timeStamp", { value: 1_000 + timeStamp });
  fireEvent(element, event);
}

describe("ProductGallery", () => {
  test("renders every photo as a thumbnail, the active one aria-current, and the counter", () => {
    renderGallery();
    const thumbs = thumbnails();
    expect(thumbs).toHaveLength(6);
    expect(thumbs.map((thumb) => thumb.getAttribute("aria-label"))).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Lihat foto ${n} dari 6`));
    expect(thumbs[0]).toHaveAttribute("aria-current", "true");
    expect(thumbs.filter((thumb) => thumb.hasAttribute("aria-current"))).toHaveLength(1);
    expect(screen.getByTestId("gallery-counter")).toHaveTextContent("1 / 6");
    expect(screen.getByRole("button", { name: "Perbesar foto 1 dari 6" })).toBeInTheDocument();
    expect(mainImage()).toHaveAttribute("alt", "Foto g1");
  });

  test("only the main photo is high priority and eager; thumbnails use the 400 file, lazily, with an empty alt", () => {
    const { container } = renderGallery();
    const main = mainImage();
    expect(main).toHaveAttribute("fetchpriority", "high");
    expect(main).toHaveAttribute("loading", "eager");
    expect(main.getAttribute("srcset")).toBe(`${BASE}/products/p1/g1/800.webp 800w, ${BASE}/products/p1/g1/1600.webp 1600w`);
    expect(container.querySelectorAll('[fetchpriority="high"]')).toHaveLength(1);
    for (const thumb of thumbnails()) {
      const image = thumb.querySelector("img")!;
      expect(image).toHaveAttribute("alt", "");
      expect(image).toHaveAttribute("loading", "lazy");
      expect(decodeURIComponent(image.getAttribute("src") ?? "")).toMatch(/\/400\.webp/);
    }
  });

  test("starts at the server-computed index", () => {
    renderGallery(GALLERY, { initialIndex: 4 });
    expect(mainImage()).toHaveAttribute("alt", "Foto m1");
    expect(thumbnails()[4]).toHaveAttribute("aria-current", "true");
  });

  test("a thumbnail click changes the main photo and announces it", () => {
    renderGallery();
    fireEvent.click(thumbnails()[3]!);
    expect(mainImage()).toHaveAttribute("alt", "Foto s2");
    expect(thumbnails()[3]).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("gallery-counter")).toHaveTextContent("4 / 6");
    expect(screen.getByRole("status")).toHaveTextContent("Foto 4 dari 6");
  });

  test("the arrow buttons wrap at both ends", () => {
    renderGallery();
    fireEvent.click(screen.getByRole("button", { name: "Foto sebelumnya" }));
    expect(mainImage()).toHaveAttribute("alt", "Foto m2");
    fireEvent.click(screen.getByRole("button", { name: "Foto berikutnya" }));
    expect(mainImage()).toHaveAttribute("alt", "Foto g1");
    fireEvent.click(screen.getByRole("button", { name: "Foto berikutnya" }));
    expect(mainImage()).toHaveAttribute("alt", "Foto g2");
  });

  test("arrow keys move focus within the strip (one tab stop, wrapping); Enter selects", () => {
    renderGallery();
    const thumbs = thumbnails();
    expect(thumbs.map((thumb) => thumb.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    thumbs[0]!.focus();
    fireEvent.keyDown(thumbs[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(thumbs[5]);
    expect(thumbs[5]).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(thumbs[5]!, { key: "ArrowRight" });
    fireEvent.keyDown(thumbs[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(thumbs[1]);
    // Moving focus alone does not change the photo.
    expect(mainImage()).toHaveAttribute("alt", "Foto g1");
    fireEvent.click(thumbs[1]!);
    expect(mainImage()).toHaveAttribute("alt", "Foto g2");
  });

  test("modified arrow keys (Alt+Left = browser back) are left to the browser", () => {
    renderGallery();
    const thumbs = thumbnails();
    thumbs[0]!.focus();
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
    thumbs[0]!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(thumbs[0]);
  });

  test("showColor jumps to the colour's first photo, scrolls the strip, and is not announced", () => {
    const { ref } = renderGallery();
    act(() => ref.current!.showColor("mocca"));
    expect(mainImage()).toHaveAttribute("alt", "Foto m1");
    expect(thumbnails()[4]).toHaveAttribute("aria-current", "true");
    expect(scrollTo).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("");

    // Re-showing the same colour after browsing goes back to its first photo.
    fireEvent.click(screen.getByRole("button", { name: "Foto berikutnya" }));
    expect(mainImage()).toHaveAttribute("alt", "Foto m2");
    act(() => ref.current!.showColor("mocca"));
    expect(mainImage()).toHaveAttribute("alt", "Foto m1");
  });

  test("a colour without photos goes to the first general photo", () => {
    const { ref } = renderGallery(GALLERY, { initialIndex: 4 });
    act(() => ref.current!.showColor("navy"));
    expect(mainImage()).toHaveAttribute("alt", "Foto g1");
  });

  test("clicking the main image opens the viewer at the current index", () => {
    const { onOpenViewer } = renderGallery();
    fireEvent.click(thumbnails()[2]!);
    finishSlide();
    fireEvent.click(screen.getByTestId("gallery-main"));
    expect(onOpenViewer).toHaveBeenCalledWith(2);
  });

  describe("swipe", () => {
    function swipe(fromX: number, toX: number, durationMs = 300) {
      const main = screen.getByTestId("gallery-main");
      Object.defineProperty(main, "clientWidth", { configurable: true, value: 390 });
      pointer("pointerDown", main, fromX, 0);
      pointer("pointerMove", main, toX, durationMs);
      pointer("pointerUp", main, toX, durationMs);
      // The click a mouse drag ends with (a touch swipe fires none).
      fireEvent.click(main, { detail: 1 });
      return main;
    }

    test("a swipe left goes to the next photo, sliding on from where the finger let go, and never opens the viewer", () => {
      const { onOpenViewer } = renderGallery();
      swipe(300, 100);
      expect(mainImage()).toHaveAttribute("alt", "Foto g2");
      // Dragged 200 px of 390: the incoming photo is 190 px short of the left edge.
      expect(lastSlide().keyframes).toEqual([{ transform: "translateX(190px)" }, { transform: "translateX(0)" }]);
      expect(screen.getByTestId("gallery-track")).toHaveAttribute("data-slide", "next");
      expect(onOpenViewer).not.toHaveBeenCalled();
    });

    test("a swipe right on the first photo wraps to the last, coming in from the left", () => {
      renderGallery();
      swipe(100, 300);
      expect(mainImage()).toHaveAttribute("alt", "Foto m2");
      expect(lastSlide().keyframes[0]).toEqual({ transform: "translateX(-190px)" });
      expect(screen.getByTestId("gallery-track")).toHaveAttribute("data-slide", "prev");
    });

    test("a short fast flick (> 0.4 px/ms) goes to the next photo", () => {
      renderGallery();
      // 40 px in 50 ms = 0.8 px/ms, well under 20% of the width.
      swipe(200, 160, 50);
      expect(mainImage()).toHaveAttribute("alt", "Foto g2");
    });

    test("a short slow drag snaps back to the same photo with the same slide", () => {
      renderGallery();
      swipe(200, 160, 1000);
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
      expect(lastSlide().keyframes[0]).toEqual({ transform: "translateX(-40px)" });
      expect(lastSlide().options).toEqual({ duration: GALLERY_SLIDE_MS, easing: GALLERY_SLIDE_EASING });
      expect(screen.getByTestId("gallery-track")).toHaveAttribute("data-slide", "back");
      finishSlide();
      expect(screen.getByTestId("gallery-track")).not.toHaveAttribute("data-slide");
      expect(within(screen.getByTestId("gallery-track")).getAllByRole("img")).toHaveLength(1);
    });

    test("reduced motion: no slide at all, the photo swaps at once, the drag's click opens nothing", () => {
      reduceMotion = true;
      const { onOpenViewer } = renderGallery();
      swipe(300, 100);
      expect(slides).toHaveLength(0);
      expect(screen.getByTestId("gallery-track")).not.toHaveAttribute("data-slide");
      expect(mainImage()).toHaveAttribute("alt", "Foto g2");
      expect(onOpenViewer).not.toHaveBeenCalled();
    });

    test("a keyboard activation after a touch swipe still opens the viewer", () => {
      const { onOpenViewer } = renderGallery();
      const main = screen.getByTestId("gallery-main");
      Object.defineProperty(main, "clientWidth", { configurable: true, value: 390 });
      pointer("pointerDown", main, 300, 0);
      pointer("pointerMove", main, 100, 300);
      pointer("pointerUp", main, 100, 300);
      finishSlide();
      // Enter/Space: a click with detail 0.
      fireEvent.click(main, { detail: 0 });
      expect(onOpenViewer).toHaveBeenCalledWith(1);
    });

    test("a thumbnail tap during the slide wins: the swipe's slide is cancelled", () => {
      renderGallery();
      swipe(300, 100);
      const swipeSlide = lastSlide();
      fireEvent.click(thumbnails()[4]!);
      expect(swipeSlide.cancelled).toBe(true);
      expect(mainImage()).toHaveAttribute("alt", "Foto m1");
      finishSlide();
      expect(mainImage()).toHaveAttribute("alt", "Foto m1");
    });

    test("a new drag during a slide takes over at once", () => {
      renderGallery();
      fireEvent.click(thumbnails()[3]!);
      const thumbSlide = lastSlide();
      swipe(300, 100);
      expect(thumbSlide.cancelled).toBe(true);
      expect(mainImage()).toHaveAttribute("alt", "Foto m1");
    });

    test("a cancelled pointer (the page scrolled instead) puts the photo straight back", () => {
      renderGallery();
      const main = screen.getByTestId("gallery-main");
      pointer("pointerDown", main, 300, 0);
      pointer("pointerMove", main, 100, 50);
      expect(screen.getByTestId("gallery-track").style.transform).toBe("translateX(-200px)");
      pointer("pointerCancel", main, 100, 60);
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
      expect(screen.getByTestId("gallery-track").style.transform).toBe("");
    });
  });

  describe("slide on every change (owner feedback 2026-10-23)", () => {
    const fromRight = { transform: "translateX(calc(100% + 0px))" };
    const fromLeft = { transform: "translateX(calc(-100% + 0px))" };
    const next = () => fireEvent.click(screen.getByRole("button", { name: "Foto berikutnya" }));
    const prev = () => fireEvent.click(screen.getByRole("button", { name: "Foto sebelumnya" }));

    test("next comes in from the right, previous from the left, both with the outgoing photo beside it", () => {
      renderGallery(GALLERY, { initialIndex: 2 });
      next();
      expect(lastSlide().keyframes).toEqual([fromRight, { transform: "translateX(0)" }]);
      expect(lastSlide().options).toEqual({ duration: GALLERY_SLIDE_MS, easing: GALLERY_SLIDE_EASING });
      expect(screen.getByTestId("gallery-track")).toHaveAttribute("data-slide", "next");
      // The leaving photo (s1) sits one width to the left of the incoming one.
      expect(within(screen.getByTestId("gallery-track")).getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["Foto s2", "Foto s1"]);
      finishSlide();
      expect(within(screen.getByTestId("gallery-track")).getAllByRole("img")).toHaveLength(1);

      prev();
      expect(lastSlide().keyframes[0]).toEqual(fromLeft);
      expect(mainImage()).toHaveAttribute("alt", "Foto s1");
    });

    test("wrap-around keeps the button's direction: next on the last photo comes in from the right", () => {
      renderGallery(GALLERY, { initialIndex: 5 });
      next();
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
      expect(lastSlide().keyframes[0]).toEqual(fromRight);
      finishSlide();
      prev();
      expect(mainImage()).toHaveAttribute("alt", "Foto m2");
      expect(lastSlide().keyframes[0]).toEqual(fromLeft);
    });

    test("a thumbnail slides toward its side of the list, once, straight to it", () => {
      renderGallery();
      fireEvent.click(thumbnails()[5]!);
      expect(slides).toHaveLength(1);
      expect(lastSlide().keyframes[0]).toEqual(fromRight);
      expect(within(screen.getByTestId("gallery-track")).getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["Foto m2", "Foto g1"]);
      finishSlide();
      fireEvent.click(thumbnails()[1]!);
      expect(lastSlide().keyframes[0]).toEqual(fromLeft);
      // The active thumbnail again: nothing moves.
      finishSlide();
      fireEvent.click(thumbnails()[1]!);
      expect(slides).toHaveLength(2);
    });

    test("a colour jump slides toward the colour's photos", () => {
      const { ref } = renderGallery();
      act(() => ref.current!.showColor("mocca"));
      expect(lastSlide().keyframes[0]).toEqual(fromRight);
      finishSlide();
      act(() => ref.current!.showColor("sage"));
      expect(lastSlide().keyframes[0]).toEqual(fromLeft);
    });

    test("rapid clicks never queue: each cancels the previous slide and the latest target wins", () => {
      renderGallery();
      next();
      next();
      next();
      expect(slides).toHaveLength(3);
      expect(slides.slice(0, 2).every((slide) => slide.cancelled)).toBe(true);
      expect(lastSlide().cancelled).toBe(false);
      expect(mainImage()).toHaveAttribute("alt", "Foto s2");
      expect(screen.getByTestId("gallery-counter")).toHaveTextContent("4 / 6");
      finishSlide();
      expect(screen.getByTestId("gallery-track")).not.toHaveAttribute("data-slide");
    });

    test("an interrupted slide in the same direction keeps the photo still leaving beside the new one (no gap)", () => {
      renderGallery();
      next();
      next();
      // g3 (s1) comes in, g2 leaves next to it, and g1 (still leaving the first slide) beyond it.
      expect(within(screen.getByTestId("gallery-track")).getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["Foto s1", "Foto g2", "Foto g1"]);
      finishSlide();
      expect(within(screen.getByTestId("gallery-track")).getAllByRole("img")).toHaveLength(1);
    });

    test("a reversed interrupt (next, then back) leaves exactly one current photo", () => {
      renderGallery();
      fireEvent.click(thumbnails()[2]!);
      fireEvent.click(thumbnails()[5]!);
      fireEvent.click(thumbnails()[3]!);
      expect(screen.getAllByTestId("gallery-current")).toHaveLength(1);
      expect(mainImage()).toHaveAttribute("alt", "Foto s2");
      // The photo leaving to the right (m2) stays beside it; nothing sits on the incoming side.
      expect(within(screen.getByTestId("gallery-track")).getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["Foto s2", "Foto m2"]);
    });

    test("a plain tap that stops a slide does not open the viewer", () => {
      const { onOpenViewer } = renderGallery();
      next();
      const main = screen.getByTestId("gallery-main");
      pointer("pointerDown", main, 200, 0);
      pointer("pointerUp", main, 200, 20);
      fireEvent.click(main, { detail: 1 });
      expect(onOpenViewer).not.toHaveBeenCalled();
      // The next plain tap does.
      pointer("pointerDown", main, 200, 100);
      pointer("pointerUp", main, 200, 120);
      fireEvent.click(main, { detail: 1 });
      expect(onOpenViewer).toHaveBeenCalledWith(1);
    });

    test("the main image does not open the viewer mid-slide", () => {
      const { onOpenViewer } = renderGallery();
      next();
      fireEvent.click(screen.getByTestId("gallery-main"));
      expect(onOpenViewer).not.toHaveBeenCalled();
      finishSlide();
      fireEvent.click(screen.getByTestId("gallery-main"));
      expect(onOpenViewer).toHaveBeenCalledWith(1);
    });

    test("reduced motion: arrows, thumbnails and colour jumps swap instantly", () => {
      reduceMotion = true;
      const { ref } = renderGallery();
      next();
      fireEvent.click(thumbnails()[5]!);
      act(() => ref.current!.showColor("sage"));
      expect(slides).toHaveLength(0);
      expect(mainImage()).toHaveAttribute("alt", "Foto s1");
      expect(within(screen.getByTestId("gallery-track")).getAllByRole("img")).toHaveLength(1);
    });
  });

  describe("Left/Right anywhere on the page", () => {
    test("moves to the next/previous photo with the slide, wrapping, and announces it", () => {
      renderGallery();
      fireEvent.keyDown(document.body, { key: "ArrowLeft" });
      expect(mainImage()).toHaveAttribute("alt", "Foto m2");
      expect(lastSlide().keyframes[0]).toEqual({ transform: "translateX(calc(-100% + 0px))" });
      expect(screen.getByRole("status")).toHaveTextContent("Foto 6 dari 6");
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
      expect(lastSlide().keyframes[0]).toEqual({ transform: "translateX(calc(100% + 0px))" });
      expect(screen.getByRole("status")).toHaveTextContent("Foto 1 dari 6");
    });

    test("ignored with a modifier key held", () => {
      renderGallery();
      for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
        fireEvent.keyDown(document.body, { key: "ArrowRight", [modifier]: true });
      }
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
    });

    test("ignored in an input, textarea, select or contenteditable", () => {
      renderGallery();
      const fields = document.createElement("div");
      fields.innerHTML = '<input /><textarea></textarea><select><option>a</option></select><div contenteditable="true"><span>teks</span></div>';
      document.body.append(fields);
      for (const target of [fields.querySelector("input")!, fields.querySelector("textarea")!, fields.querySelector("select")!, fields.querySelector("span")!]) {
        fireEvent.keyDown(target, { key: "ArrowRight" });
      }
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
      fields.remove();
    });

    test("ignored inside something that scrolls sideways (the size chart table)", () => {
      renderGallery();
      const region = document.createElement("div");
      region.style.overflowX = "auto";
      Object.defineProperty(region, "scrollWidth", { value: 600 });
      Object.defineProperty(region, "clientWidth", { value: 300 });
      region.tabIndex = 0;
      document.body.append(region);
      fireEvent.keyDown(region, { key: "ArrowRight" });
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
      region.remove();
    });

    test("ignored while a dialog (the viewer) is open", () => {
      renderGallery();
      const dialog = document.createElement("dialog");
      dialog.setAttribute("open", "");
      document.body.append(dialog);
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
      dialog.remove();
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(mainImage()).toHaveAttribute("alt", "Foto g2");
    });

    test("ignored while an aria-modal overlay is open, during IME composition, and mid-drag", () => {
      renderGallery();
      const overlay = document.createElement("div");
      overlay.setAttribute("aria-modal", "true");
      document.body.append(overlay);
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      overlay.remove();
      fireEvent.keyDown(document.body, { key: "ArrowRight", isComposing: true });
      const main = screen.getByTestId("gallery-main");
      pointer("pointerDown", main, 200, 0);
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
    });

    test("in the thumbnail strip the keys move focus only: never a second, photo move", () => {
      renderGallery();
      const thumbs = thumbnails();
      thumbs[0]!.focus();
      fireEvent.keyDown(thumbs[0]!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(thumbs[1]);
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
    });

    test("a one-photo gallery ignores the keys", () => {
      renderGallery({ images: [item("g1", null)], colorStartIndex: {} });
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(slides).toHaveLength(0);
      expect(mainImage()).toHaveAttribute("alt", "Foto g1");
    });
  });

  test("one photo: main image only, no strip, arrows or counter; still opens the viewer", () => {
    const { onOpenViewer } = renderGallery({ images: [item("g1", null)], colorStartIndex: {} });
    expect(screen.queryByRole("group", { name: "Foto produk" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Foto berikutnya" })).toBeNull();
    expect(screen.queryByTestId("gallery-counter")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Perbesar foto" }));
    expect(onOpenViewer).toHaveBeenCalledWith(0);
  });

  test("no photo: the placeholder, high priority, with no button at all", () => {
    renderGallery({ images: [], colorStartIndex: {} });
    expect(screen.queryByRole("button")).toBeNull();
    const placeholder = mainImage();
    expect(placeholder).toHaveAttribute("alt", "Foto Haura belum tersedia");
    expect(placeholder).toHaveAttribute("data-placeholder", "true");
    expect(placeholder).toHaveAttribute("fetchpriority", "high");
  });
});
