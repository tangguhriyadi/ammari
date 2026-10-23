import { describe, expect, test } from "vitest";
import { canSwipe, clampPan, clampScale, containedSize, DOUBLE_TAP_SCALE, isDoubleTap, NO_ZOOM, panZoom, pinchZoom, toggleZoom, ZOOM_MAX, ZOOM_MIN, zoomAt } from "./zoom";

// A 390 x 600 stage showing a 2:3 photo: contained at 390 x 585.
const STAGE = { width: 390, height: 600 };
const PHOTO = containedSize(STAGE, 800, 1200);

/** Where the photo point under `point` (stage-centre coordinates) sits after `zoom`. */
function screenPoint(zoom: { scale: number; x: number; y: number }, contentPoint: { x: number; y: number }) {
  return { x: contentPoint.x * zoom.scale + zoom.x, y: contentPoint.y * zoom.scale + zoom.y };
}

describe("containedSize", () => {
  test("fits the photo inside the stage at its own ratio", () => {
    expect(PHOTO).toEqual({ width: 390, height: 585 });
    expect(containedSize({ width: 1000, height: 600 }, 800, 1200)).toEqual({ width: 400, height: 600 });
  });

  test("a photo without a usable size fills the stage", () => {
    expect(containedSize(STAGE, 0, 0)).toEqual(STAGE);
  });
});

describe("clampScale", () => {
  test("keeps the scale between 1 and 4", () => {
    expect(ZOOM_MIN).toBe(1);
    expect(ZOOM_MAX).toBe(4);
    expect(clampScale(0.5)).toBe(1);
    expect(clampScale(2.2)).toBe(2.2);
    expect(clampScale(9)).toBe(4);
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe("clampPan", () => {
  test("at scale 1 the photo cannot move at all", () => {
    expect(clampPan({ scale: 1, x: 50, y: -20 }, STAGE, PHOTO)).toEqual(NO_ZOOM);
  });

  test("zoomed, the photo's edges never come inside the stage", () => {
    // 2x: 780 x 1170, so up to 195 px sideways and 285 px up or down.
    expect(clampPan({ scale: 2, x: 500, y: -500 }, STAGE, PHOTO)).toEqual({ scale: 2, x: 195, y: -285 });
    expect(clampPan({ scale: 2, x: -100, y: 100 }, STAGE, PHOTO)).toEqual({ scale: 2, x: -100, y: 100 });
  });

  test("an axis where the zoomed photo is still smaller than the stage stays centred", () => {
    // A wide photo in a tall stage: 390 x 260, at 2x still only 520 px tall.
    const wide = containedSize(STAGE, 1200, 800);
    expect(clampPan({ scale: 2, x: 0, y: 80 }, STAGE, wide).y).toBe(0);
  });
});

describe("zoomAt", () => {
  test("keeps the photo point under the given point where it is", () => {
    const point = { x: 60, y: -90 };
    const zoomed = zoomAt(NO_ZOOM, point, 2.5);
    expect(zoomed.scale).toBe(2.5);
    // At scale 1 the content point under `point` is `point` itself.
    expect(screenPoint(zoomed, point)).toEqual(point);
  });

  test("clamps the scale", () => {
    expect(zoomAt(NO_ZOOM, { x: 0, y: 0 }, 10).scale).toBe(4);
  });
});

describe("pinchZoom", () => {
  test("spreading the fingers scales by the distance ratio around the pinch centre", () => {
    const start = { zoom: NO_ZOOM, centre: { x: 40, y: 20 }, distance: 100 };
    const zoomed = pinchZoom(start, { x: 40, y: 20 }, 200, STAGE, PHOTO);
    expect(zoomed.scale).toBe(2);
    // The photo point that was under the fingers is still under them.
    expect(screenPoint(zoomed, { x: 40, y: 20 })).toEqual({ x: 40, y: 20 });
  });

  test("moving both fingers pans along with them", () => {
    const start = { zoom: { scale: 2, x: 0, y: 0 }, centre: { x: 0, y: 0 }, distance: 100 };
    expect(pinchZoom(start, { x: 30, y: -40 }, 100, STAGE, PHOTO)).toEqual({ scale: 2, x: 30, y: -40 });
  });

  test("never below 1x or above 4x, and pinching back to 1x recentres the photo", () => {
    const start = { zoom: { scale: 2, x: 100, y: 100 }, centre: { x: 0, y: 0 }, distance: 200 };
    expect(pinchZoom(start, { x: 0, y: 0 }, 50, STAGE, PHOTO)).toEqual(NO_ZOOM);
    expect(pinchZoom(start, { x: 0, y: 0 }, 2000, STAGE, PHOTO).scale).toBe(4);
  });

  test("a zero start distance (both fingers on one point) changes nothing", () => {
    const start = { zoom: { scale: 2, x: 10, y: 10 }, centre: { x: 0, y: 0 }, distance: 0 };
    expect(pinchZoom(start, { x: 0, y: 0 }, 100, STAGE, PHOTO)).toEqual({ scale: 2, x: 10, y: 10 });
  });
});

describe("panZoom", () => {
  test("one finger moves the zoomed photo by its own travel, clamped to the edges", () => {
    const start = { scale: 2, x: 0, y: 0 };
    expect(panZoom(start, { x: 50, y: -30 }, STAGE, PHOTO)).toEqual({ scale: 2, x: 50, y: -30 });
    expect(panZoom(start, { x: 900, y: 900 }, STAGE, PHOTO)).toEqual({ scale: 2, x: 195, y: 285 });
  });
});

describe("toggleZoom (double-tap)", () => {
  test("at 1x zooms to 2.5x around the tap", () => {
    const zoomed = toggleZoom(NO_ZOOM, { x: 20, y: 30 }, STAGE, PHOTO);
    expect(zoomed.scale).toBe(DOUBLE_TAP_SCALE);
    expect(screenPoint(zoomed, { x: 20, y: 30 })).toEqual({ x: 20, y: 30 });
  });

  test("a tap near the photo's edge zooms in without showing past the edge", () => {
    // On the white band below the photo (585 px tall in a 600 px stage).
    const zoomed = toggleZoom(NO_ZOOM, { x: 0, y: 299 }, STAGE, PHOTO);
    // 2.5x: 1462.5 px tall, at most (1462.5 - 600) / 2 = 431.25 px up, not 299 * 1.5 = 448.5.
    expect(zoomed.y).toBe(-431.25);
  });

  test("zoomed in, it goes back to 1x", () => {
    expect(toggleZoom({ scale: 3, x: 40, y: 40 }, { x: 0, y: 0 }, STAGE, PHOTO)).toEqual(NO_ZOOM);
  });
});

describe("isDoubleTap", () => {
  test("a second tap soon after, near the first, is a double tap", () => {
    expect(isDoubleTap({ time: 1000, x: 100, y: 100 }, { time: 1200, x: 110, y: 95 })).toBe(true);
  });

  test("too slow, too far apart, or no first tap: not a double tap", () => {
    expect(isDoubleTap({ time: 1000, x: 100, y: 100 }, { time: 1400, x: 100, y: 100 })).toBe(false);
    expect(isDoubleTap({ time: 1000, x: 100, y: 100 }, { time: 1100, x: 180, y: 100 })).toBe(false);
    expect(isDoubleTap(null, { time: 1100, x: 100, y: 100 })).toBe(false);
  });
});

describe("canSwipe", () => {
  test("swiping to another photo only at 1x", () => {
    expect(canSwipe(NO_ZOOM)).toBe(true);
    expect(canSwipe({ scale: 1.2, x: 0, y: 0 })).toBe(false);
  });
});
