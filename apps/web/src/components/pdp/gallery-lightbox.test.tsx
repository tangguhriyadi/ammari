// @vitest-environment jsdom
import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProductGalleryItem } from "@/lib/content/product-view";
import { GALLERY_SLIDE_EASING, GALLERY_SLIDE_MS } from "@/lib/gallery/swipe";
import { GalleryLightbox } from "./gallery-lightbox";

const BASE = "https://cdn.example.test";

function item(id: string): ProductGalleryItem {
  return { id, storageKey: `products/p1/${id}`, altText: `Foto ${id}`, width: 800, height: 1200, colorId: null };
}

const IMAGES = ["a", "b", "c", "d", "e"].map(item);

let reduceMotion = false;
/** jsdom has no Web Animations: a stand-in recording every animation and the element it runs on. */
interface FakeAnimation {
  target: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  onfinish: (() => void) | null;
  finished: boolean;
  cancelled: boolean;
  reversed: boolean;
  cancel: () => void;
  finish: () => void;
  reverse: () => void;
}
let animations: FakeAnimation[] = [];

/** The photo slides (the track), apart from the open/close transition. */
function slides(): FakeAnimation[] {
  return animations.filter((animation) => animation.target.getAttribute("data-testid") === "viewer-track");
}

/** Animations on `testId`'s element, or on the dialog itself (the plain fade). */
function transitionOn(testId: string): FakeAnimation[] {
  return animations.filter((animation) => animation.target.getAttribute("data-testid") === testId);
}

/** Ends every running open/close animation, the way the browser reports it. */
function finishTransitions() {
  act(() => {
    for (const animation of animations.filter((entry) => entry.target.getAttribute("data-testid") !== "viewer-track" && !entry.finished && !entry.cancelled)) {
      animation.finished = true;
      animation.onfinish?.();
    }
  });
}

/** The main photo's box on the page: 312 x 468 at (100, 100), on screen. Its centre (256, 334)
 * is 61 px right of and 22 px above the stage's (195, 356); 312 / 390 = 0.8 of the viewer photo. */
const ORIGIN = { left: 100, top: 100, width: 312, height: 468, right: 412, bottom: 568, x: 100, y: 100, toJSON() {} } as DOMRect;
const FLIP = "translate(61px, -22px) scale(0.8)";
let warmed: string[] = [];
const showModal = vi.fn(function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
});
const closeDialog = vi.fn(function (this: HTMLDialogElement) {
  this.removeAttribute("open");
});

beforeEach(() => {
  reduceMotion = false;
  window.matchMedia = ((query: string) => ({ matches: reduceMotion && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  // jsdom has no modal dialogs: just the open attribute, which is all the component reads.
  showModal.mockClear();
  closeDialog.mockClear();
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = closeDialog;
  animations = [];
  Element.prototype.animate = function animate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const animation: FakeAnimation = {
      target: this,
      keyframes,
      options,
      onfinish: null,
      finished: false,
      cancelled: false,
      reversed: false,
      reverse() {
        this.reversed = true;
      },
      cancel() {
        this.cancelled = true;
      },
      finish() {
        this.finished = true;
        this.onfinish?.();
      },
    };
    animations.push(animation);
    return animation as unknown as Animation;
  } as unknown as Element["animate"];
  innerSize(390, 844);
  warmed = [];
  vi.stubGlobal(
    "Image",
    class {
      set src(value: string) {
        warmed.push(value);
      }
    },
  );
  document.documentElement.style.overflow = "";
});

function innerSize(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

const realGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = realGetBoundingClientRect;
  vi.unstubAllGlobals();
});

// A 390 x 600 stage, 56 px from the top: a 2:3 photo shows at 390 x 585. Set on the prototype
// before render, so the open transition (measured on mount) sees it too.
const STAGE_RECT = { left: 0, top: 56, width: 390, height: 600, right: 390, bottom: 656, x: 0, y: 56, toJSON() {} } as DOMRect;

function renderViewer({ images = IMAGES, initialIndex = 0, origin = ORIGIN as DOMRect | null, settle = true } = {}) {
  const onClose = vi.fn();
  const onClosing = vi.fn();
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.getAttribute("data-testid") === "viewer-stage" ? STAGE_RECT : realRect.call(this);
  };
  const view = render(
    <GalleryLightbox productName="Haura" images={images} initialIndex={initialIndex} storageBaseUrl={BASE} getOrigin={() => origin} onClosing={onClosing} onClose={onClose} />,
  );
  const stage = screen.queryByTestId("viewer-stage");
  if (stage) Object.defineProperty(stage, "clientWidth", { configurable: true, value: 390 });
  if (settle) finishTransitions();
  return { ...view, onClose, onClosing, stage: stage! };
}

function dialog(): HTMLDialogElement {
  return screen.getByTestId("gallery-viewer") as HTMLDialogElement;
}

function currentAlt(): string | null {
  return within(screen.getByTestId("viewer-current")).getByRole("img").getAttribute("alt");
}

function scale(): number {
  return Number(screen.getByTestId("viewer-zoom").getAttribute("data-scale"));
}

/** A pointer event with a chosen `timeStamp` (see product-gallery.test.tsx's own helper). Stage
 * centre: (195, 356). */
function pointer(type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", element: HTMLElement, { id = 1, x, y = 356, t, pointerType = "touch" }: { id?: number; x: number; y?: number; t: number; pointerType?: string }) {
  const event = createEvent[type](element, { pointerId: id, clientX: x, clientY: y, button: 0, pointerType });
  Object.defineProperty(event, "timeStamp", { value: 1_000 + t });
  fireEvent(element, event);
}

function key(name: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(dialog(), { key: name, ...init });
}

/** Two fingers 100 px apart around the stage centre, spread to `distance` px apart. */
function pinch(stage: HTMLElement, distance: number, t = 0) {
  pointer("pointerDown", stage, { id: 1, x: 145, t });
  pointer("pointerDown", stage, { id: 2, x: 245, t: t + 5 });
  pointer("pointerMove", stage, { id: 1, x: 195 - distance / 2, t: t + 50 });
  pointer("pointerMove", stage, { id: 2, x: 195 + distance / 2, t: t + 50 });
  pointer("pointerUp", stage, { id: 1, x: 195 - distance / 2, t: t + 100 });
  pointer("pointerUp", stage, { id: 2, x: 195 + distance / 2, t: t + 100 });
}

function doubleTap(stage: HTMLElement, { x = 195, y = 356, t = 0, pointerType = "touch" } = {}) {
  pointer("pointerDown", stage, { x, y, t, pointerType });
  pointer("pointerUp", stage, { x, y, t: t + 50, pointerType });
  pointer("pointerDown", stage, { x, y, t: t + 150, pointerType });
  pointer("pointerUp", stage, { x, y, t: t + 200, pointerType });
}

describe("GalleryLightbox", () => {
  test("opens as a modal at the given photo, named, with focus on Tutup and the counter", () => {
    renderViewer({ initialIndex: 2 });
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog()).toHaveAttribute("aria-label", "Galeri foto Haura");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Tutup" }));
    expect(currentAlt()).toBe("Foto c");
    expect(screen.getByTestId("viewer-counter")).toHaveTextContent("3 / 5");
  });

  test("shows the large (1600) file, eagerly", () => {
    renderViewer();
    const image = within(screen.getByTestId("viewer-current")).getByRole("img");
    expect(decodeURIComponent(image.getAttribute("src") ?? "")).toContain("/products/p1/a/1600.webp");
    expect(image).toHaveAttribute("loading", "eager");
    expect(image).not.toHaveAttribute("fetchpriority", "high");
  });

  test("preloads only the neighbours, again after each change", () => {
    renderViewer();
    expect(warmed).toEqual([`${BASE}/products/p1/b/1600.webp`, `${BASE}/products/p1/e/1600.webp`]);
    key("ArrowRight");
    // b's neighbours: c is new, a is the photo already on screen.
    expect(warmed.slice(2)).toEqual([`${BASE}/products/p1/c/1600.webp`, `${BASE}/products/p1/a/1600.webp`]);
  });

  test("tab order: Tutup, previous, next", () => {
    renderViewer();
    expect(within(dialog()).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Tutup", "Foto sebelumnya", "Foto berikutnya"]);
  });

  test("Left/Right wrap at both ends with the page gallery's slide, and are announced", () => {
    renderViewer();
    key("ArrowLeft");
    expect(currentAlt()).toBe("Foto e");
    expect(slides().at(-1)!.keyframes).toEqual([{ transform: "translateX(calc(-100% + 0px))" }, { transform: "translateX(0)" }]);
    expect(slides().at(-1)!.options).toEqual({ duration: GALLERY_SLIDE_MS, easing: GALLERY_SLIDE_EASING });
    expect(screen.getByTestId("viewer-track")).toHaveAttribute("data-slide", "prev");
    expect(screen.getByRole("status")).toHaveTextContent("Foto 5 dari 5");
    key("ArrowRight");
    expect(currentAlt()).toBe("Foto a");
    expect(slides().at(-1)!.keyframes[0]).toEqual({ transform: "translateX(calc(100% + 0px))" });
    expect(screen.getByTestId("viewer-counter")).toHaveTextContent("1 / 5");
  });

  test("the keys are taken from the page (default prevented); modified keys are left alone", () => {
    renderViewer();
    const plain = createEvent.keyDown(dialog(), { key: "ArrowRight" });
    fireEvent(dialog(), plain);
    expect(plain.defaultPrevented).toBe(true);
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) key("ArrowRight", { [modifier]: true });
    expect(currentAlt()).toBe("Foto b");
  });

  test("the buttons wrap too", () => {
    renderViewer({ initialIndex: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Foto berikutnya" }));
    expect(currentAlt()).toBe("Foto a");
    fireEvent.click(screen.getByRole("button", { name: "Foto sebelumnya" }));
    expect(currentAlt()).toBe("Foto e");
  });

  test("reduced motion: instant swaps, no slide", () => {
    reduceMotion = true;
    renderViewer();
    key("ArrowRight");
    fireEvent.click(screen.getByRole("button", { name: "Foto berikutnya" }));
    expect(slides()).toHaveLength(0);
    expect(currentAlt()).toBe("Foto c");
    expect(within(screen.getByTestId("viewer-track")).getAllByRole("img")).toHaveLength(1);
  });

  test("Esc closes through the cancel event: shrinks back first, then closes and reports the photo on screen, once", () => {
    const { onClose, onClosing } = renderViewer({ initialIndex: 1 });
    key("ArrowRight");
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog(), cancel);
    expect(cancel.defaultPrevented).toBe(true);
    // The page gallery shows the photo at once; the dialog stays open while the photo shrinks.
    expect(onClosing).toHaveBeenCalledWith(2);
    expect(dialog()).toHaveAttribute("data-state", "closing");
    expect(closeDialog).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    finishTransitions();
    expect(closeDialog).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(2);
    // Closed: its content is hidden now, but a stray click must still not report twice.
    fireEvent.click(screen.getByRole("button", { name: "Tutup", hidden: true }));
    finishTransitions();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a close it did not start (a repeated Esc it may not cancel, Android back) still reports, once, without animating", () => {
    const { onClose } = renderViewer({ initialIndex: 2 });
    // While still open (StrictMode's effect re-run), a close event changes nothing.
    fireEvent(dialog(), new Event("close"));
    expect(onClose).not.toHaveBeenCalled();
    const before = animations.length;
    dialog().removeAttribute("open");
    fireEvent(dialog(), new Event("close"));
    fireEvent(dialog(), new Event("close"));
    expect(animations).toHaveLength(before);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(2);
  });

  test("Tutup closes and reports the photo on screen", () => {
    const { onClose } = renderViewer({ initialIndex: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
    finishTransitions();
    expect(onClose).toHaveBeenCalledWith(3);
    expect(dialog()).not.toHaveAttribute("open");
  });

  describe("open and close transition", () => {
    const timing = { duration: GALLERY_SLIDE_MS, easing: GALLERY_SLIDE_EASING };

    test("opens by growing the photo out of the main photo while the backdrop and controls fade in", () => {
      renderViewer({ settle: false });
      expect(dialog()).toHaveAttribute("data-state", "opening");
      const [photo] = transitionOn("viewer-stage");
      expect(photo!.keyframes).toEqual([{ transform: FLIP }, { transform: "none" }]);
      expect(photo!.options).toEqual({ ...timing, fill: "backwards" });
      expect(transitionOn("viewer-backdrop")[0]!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      const controls = animations.filter((animation) => animation.target.hasAttribute("data-viewer-control"));
      expect(controls).toHaveLength(3);
      for (const control of controls) expect(control.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      finishTransitions();
      expect(dialog()).toHaveAttribute("data-state", "open");
    });

    test("closes by shrinking back into the main photo while everything else fades out", () => {
      const { onClose } = renderViewer();
      fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
      const [photo] = transitionOn("viewer-stage").slice(-1);
      expect(photo!.keyframes).toEqual([{ transform: "none" }, { transform: FLIP }]);
      expect(photo!.options).toEqual({ ...timing, fill: "forwards" });
      expect(transitionOn("viewer-backdrop").at(-1)!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
      expect(onClose).not.toHaveBeenCalled();
      finishTransitions();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test("a main photo off screen or without size: a plain fade of the whole viewer instead", () => {
      for (const origin of [{ ...ORIGIN, top: -700, bottom: -232 }, { ...ORIGIN, width: 0, height: 0 }, null]) {
        animations = [];
        const { onClose, unmount } = renderViewer({ origin: origin as DOMRect | null, settle: false });
        expect(transitionOn("viewer-stage")).toHaveLength(0);
        expect(transitionOn("gallery-viewer")[0]!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
        finishTransitions();
        fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
        expect(transitionOn("gallery-viewer").at(-1)!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
        finishTransitions();
        expect(onClose).toHaveBeenCalledTimes(1);
        unmount();
      }
    });

    test("no input mid-transition: keys, buttons and touches do nothing while opening", () => {
      const { stage } = renderViewer({ settle: false });
      key("ArrowRight");
      fireEvent.click(screen.getByRole("button", { name: "Foto berikutnya" }));
      pointer("pointerDown", stage, { x: 300, t: 0 });
      pointer("pointerMove", stage, { x: 100, t: 300 });
      pointer("pointerUp", stage, { x: 100, t: 300 });
      expect(currentAlt()).toBe("Foto a");
      expect(slides()).toHaveLength(0);
      finishTransitions();
      key("ArrowRight");
      expect(currentAlt()).toBe("Foto b");
    });

    test("closing during the opening plays the opening backwards from where it is (no jump), then closes cleanly", () => {
      document.documentElement.style.overflow = "";
      const { onClose, unmount } = renderViewer({ settle: false });
      const opening = animations.slice();
      fireEvent(dialog(), new Event("cancel", { cancelable: true }));
      expect(opening.every((animation) => animation.reversed && !animation.finished)).toBe(true);
      // No second, separate close animation.
      expect(animations).toHaveLength(opening.length);
      expect(dialog()).toHaveAttribute("data-state", "closing");
      expect(onClose).not.toHaveBeenCalled();
      finishTransitions();
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
      expect(document.documentElement.style.overflow).toBe("");
    });

    test("no input while closing either", () => {
      renderViewer();
      fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
      key("ArrowRight");
      fireEvent.click(screen.getByRole("button", { name: "Foto berikutnya", hidden: true }));
      expect(currentAlt()).toBe("Foto a");
    });

    test("an opening that never reports its end still becomes usable", () => {
      vi.useFakeTimers();
      try {
        renderViewer({ settle: false });
        act(() => {
          vi.advanceTimersByTime(GALLERY_SLIDE_MS + 250);
        });
        expect(dialog()).toHaveAttribute("data-state", "open");
        key("ArrowRight");
        expect(currentAlt()).toBe("Foto b");
      } finally {
        vi.useRealTimers();
      }
    });

    test("unmounted mid-close (a route change): the safety timer does not call back into the page", () => {
      vi.useFakeTimers();
      try {
        const { onClose, unmount } = renderViewer();
        fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
        unmount();
        act(() => {
          vi.advanceTimersByTime(GALLERY_SLIDE_MS + 250);
        });
        expect(onClose).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    test("an animation that never reports its end still closes the viewer (no stuck scroll lock)", () => {
      vi.useFakeTimers();
      try {
        const { onClose } = renderViewer();
        fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
        act(() => {
          vi.advanceTimersByTime(GALLERY_SLIDE_MS + 250);
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(closeDialog).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    test("reduced motion: opens and closes at once, with no animation at all", () => {
      reduceMotion = true;
      const { onClose } = renderViewer({ settle: false });
      expect(dialog()).toHaveAttribute("data-state", "open");
      fireEvent.click(screen.getByRole("button", { name: "Tutup" }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(animations).toHaveLength(0);
    });
  });

  test("locks the page scroll on <html> while open and restores the previous value", () => {
    document.documentElement.style.overflow = "clip";
    const { unmount } = renderViewer();
    expect(document.documentElement.style.overflow).toBe("hidden");
    unmount();
    expect(document.documentElement.style.overflow).toBe("clip");
  });

  test("one photo: no counter, no prev/next, the keys do nothing", () => {
    renderViewer({ images: [item("a")] });
    expect(screen.getByTestId("viewer-counter")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Foto berikutnya" })).toBeNull();
    key("ArrowRight");
    expect(currentAlt()).toBe("Foto a");
    expect(warmed).toEqual([]);
  });

  describe("touch", () => {
    test("a swipe left at 1x goes to the next photo with the shared slide", () => {
      const { stage } = renderViewer();
      pointer("pointerDown", stage, { x: 300, t: 0 });
      pointer("pointerMove", stage, { x: 100, t: 300 });
      pointer("pointerUp", stage, { x: 100, t: 300 });
      expect(currentAlt()).toBe("Foto b");
      expect(slides().at(-1)!.keyframes[0]).toEqual({ transform: "translateX(190px)" });
    });

    test("a swipe right on the first photo wraps to the last", () => {
      const { stage } = renderViewer();
      pointer("pointerDown", stage, { x: 100, t: 0 });
      pointer("pointerMove", stage, { x: 300, t: 300 });
      pointer("pointerUp", stage, { x: 300, t: 300 });
      expect(currentAlt()).toBe("Foto e");
    });

    test("pinching out zooms in around the fingers, up to 4x", () => {
      const { stage } = renderViewer();
      pinch(stage, 200);
      expect(scale()).toBe(2);
      expect(currentAlt()).toBe("Foto a");
      pinch(stage, 1000, 1000);
      expect(scale()).toBe(4);
    });

    test("pinching back in never goes below 1x", () => {
      const { stage } = renderViewer();
      pinch(stage, 200);
      pinch(stage, 10, 1000);
      expect(scale()).toBe(1);
      expect(screen.getByTestId("viewer-zoom").style.transform).toBe("translate(0px, 0px) scale(1)");
    });

    test("zoomed in, one finger pans (clamped to the photo's edges) instead of changing photo", () => {
      const { stage } = renderViewer();
      pinch(stage, 200);
      pointer("pointerDown", stage, { x: 300, t: 2000 });
      pointer("pointerMove", stage, { x: -500, t: 2100 });
      pointer("pointerUp", stage, { x: -500, t: 2100 });
      expect(currentAlt()).toBe("Foto a");
      // 2x of a 390 px wide photo: at most 195 px either way.
      expect(screen.getByTestId("viewer-zoom").style.transform).toBe("translate(-195px, 0px) scale(2)");
    });

    test("a finger left over from a pinch at 1x does not swipe", () => {
      const { stage } = renderViewer();
      pointer("pointerDown", stage, { id: 1, x: 150, t: 0 });
      pointer("pointerDown", stage, { id: 2, x: 250, t: 5 });
      pointer("pointerUp", stage, { id: 2, x: 250, t: 50 });
      pointer("pointerMove", stage, { id: 1, x: -100, t: 100 });
      pointer("pointerUp", stage, { id: 1, x: -100, t: 110 });
      expect(currentAlt()).toBe("Foto a");
      expect(scale()).toBe(1);
    });

    test("double-tap zooms to 2.5x, eased, and a second double-tap back to 1x", () => {
      const { stage } = renderViewer();
      doubleTap(stage);
      expect(scale()).toBe(2.5);
      expect(screen.getByTestId("viewer-zoom").style.transition).toBe(`transform ${GALLERY_SLIDE_MS}ms ${GALLERY_SLIDE_EASING}`);
      doubleTap(stage, { t: 1000 });
      expect(scale()).toBe(1);
    });

    test("two slow taps are not a double-tap", () => {
      const { stage } = renderViewer();
      pointer("pointerDown", stage, { x: 195, t: 0 });
      pointer("pointerUp", stage, { x: 195, t: 50 });
      pointer("pointerDown", stage, { x: 195, t: 600 });
      pointer("pointerUp", stage, { x: 195, t: 650 });
      expect(scale()).toBe(1);
    });

    test("reduced motion: double-tap zooms without easing", () => {
      reduceMotion = true;
      const { stage } = renderViewer();
      doubleTap(stage);
      expect(scale()).toBe(2.5);
      expect(screen.getByTestId("viewer-zoom").style.transition).toBe("");
    });

    test("changing photo resets the zoom", () => {
      const { stage } = renderViewer();
      doubleTap(stage);
      expect(scale()).toBe(2.5);
      fireEvent.click(screen.getByRole("button", { name: "Foto berikutnya" }));
      expect(currentAlt()).toBe("Foto b");
      expect(scale()).toBe(1);
      // Zoomed, the change swaps at once: no zoomed photo snapping to 1x as it slides out.
      expect(slides()).toHaveLength(0);
    });

    test("rotating the phone while zoomed keeps the photo covering the new stage", () => {
      const { stage } = renderViewer();
      pinch(stage, 400);
      // 4x: a 390 px wide photo pans up to 585 px; push it to the edge.
      pointer("pointerDown", stage, { x: 100, t: 2000 });
      pointer("pointerMove", stage, { x: 900, t: 2100 });
      pointer("pointerUp", stage, { x: 900, t: 2100 });
      expect(screen.getByTestId("viewer-zoom").style.transform).toBe("translate(585px, 0px) scale(4)");
      // Landscape: a 300 px wide stage, the photo drawn 200 px wide, so at most 250 px.
      stage.getBoundingClientRect = () => ({ left: 0, top: 56, width: 300, height: 300, right: 300, bottom: 356, x: 0, y: 56, toJSON() {} }) as DOMRect;
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(screen.getByTestId("viewer-zoom").style.transform).toBe("translate(250px, 0px) scale(4)");
    });

    test("Left/Right still change photo while zoomed, from 1x", () => {
      const { stage } = renderViewer();
      doubleTap(stage);
      key("ArrowRight");
      expect(currentAlt()).toBe("Foto b");
      expect(scale()).toBe(1);
    });
  });

  test("desktop: no zoom from a mouse double-click", () => {
    const { stage } = renderViewer();
    doubleTap(stage, { pointerType: "mouse" });
    act(() => {
      fireEvent.doubleClick(stage);
    });
    expect(scale()).toBe(1);
  });
});
