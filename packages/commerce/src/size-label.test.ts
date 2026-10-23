import { describe, expect, test } from "vitest";
import { SIZES } from "@ammari/db/schema";
import { sizeLabel } from "./size-label";

describe("sizeLabel", () => {
  test('the stored "ALLSIZE" code reads "All Size"', () => {
    expect(sizeLabel("ALLSIZE")).toBe("All Size");
  });

  test("every other size is shown as stored", () => {
    for (const size of SIZES.filter((candidate) => candidate !== "ALLSIZE")) expect(sizeLabel(size)).toBe(size);
  });

  test("no size in SIZES ever renders as the raw ALLSIZE code", () => {
    expect(SIZES.map(sizeLabel)).not.toContain("ALLSIZE");
  });
});
