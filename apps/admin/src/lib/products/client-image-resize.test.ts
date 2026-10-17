import { describe, expect, it } from "vitest";
import { computeResizeTarget } from "./client-image-resize";

const MB = 1024 * 1024;

describe("computeResizeTarget (pure, no browser APIs)", () => {
  it("skips a small image that is already under both the dimension cap and the size cap", () => {
    expect(computeResizeTarget(1200, 900, 1 * MB)).toEqual({ shouldProcess: false, width: 1200, height: 900 });
  });

  it("does not skip a large file even when its dimensions are already under the cap — it still needs recompressing", () => {
    const result = computeResizeTarget(2000, 1500, 3 * MB);
    expect(result.shouldProcess).toBe(true);
    // Dimensions stay the SAME — nothing to scale down, only re-encode to shrink bytes.
    expect(result.width).toBe(2000);
    expect(result.height).toBe(1500);
  });

  it("scales a landscape image down so its long edge is capped at 2400px, preserving aspect ratio", () => {
    const result = computeResizeTarget(6000, 4000, 10 * MB);
    expect(result.shouldProcess).toBe(true);
    expect(result.width).toBe(2400);
    expect(result.height).toBe(1600);
  });

  it("scales a portrait image down by its long edge (height), not width", () => {
    const result = computeResizeTarget(3000, 4800, 8 * MB);
    expect(result.shouldProcess).toBe(true);
    expect(result.height).toBe(2400);
    expect(result.width).toBe(1500);
  });

  it("never upscales a small-dimension file that is only over the size cap", () => {
    // A hypothetical dense/uncompressed small image: well under 2400px but heavier than 1.5MB.
    const result = computeResizeTarget(800, 600, 2 * MB);
    expect(result.shouldProcess).toBe(true);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });

  it("treats a long edge exactly at the 2400px cap, under the size cap, as already small enough", () => {
    expect(computeResizeTarget(2400, 1600, 1 * MB)).toEqual({ shouldProcess: false, width: 2400, height: 1600 });
  });

  it("treats a file exactly at the 1.5MB size cap, under the dimension cap, as already small enough", () => {
    expect(computeResizeTarget(1000, 800, 1.5 * MB)).toEqual({ shouldProcess: false, width: 1000, height: 800 });
  });
});
