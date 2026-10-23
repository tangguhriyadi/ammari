import { describe, expect, test } from "vitest";
import { swipeDirection } from "./swipe";

const WIDTH = 390;

describe("swipeDirection", () => {
  test("past 20% of the width: left goes to the next photo, right to the previous one", () => {
    expect(swipeDirection(-80, WIDTH, 0)).toBe(1);
    expect(swipeDirection(80, WIDTH, 0)).toBe(-1);
  });

  test("a short slow drag snaps back", () => {
    expect(swipeDirection(-70, WIDTH, -0.1)).toBe(0);
    expect(swipeDirection(70, WIDTH, 0.1)).toBe(0);
  });

  test("a flick (> 0.4 px/ms) in the drag's direction counts over a short distance", () => {
    expect(swipeDirection(-30, WIDTH, -0.5)).toBe(1);
    expect(swipeDirection(30, WIDTH, 0.5)).toBe(-1);
  });

  test("a flick against the drag's direction does not count", () => {
    expect(swipeDirection(-30, WIDTH, 0.9)).toBe(0);
  });

  test("a drag within the click threshold never swipes, however fast", () => {
    expect(swipeDirection(-10, WIDTH, -2)).toBe(0);
    expect(swipeDirection(0, WIDTH, 0)).toBe(0);
  });

  test("no width (not laid out): never swipes", () => {
    expect(swipeDirection(-200, 0, -1)).toBe(0);
  });
});
