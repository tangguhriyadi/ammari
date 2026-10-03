// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ColorSwatch } from "../src/components/ColorSwatch";

describe("ColorSwatch", () => {
  test("renders a swatch with the given hex as its background color", () => {
    const { container } = render(<ColorSwatch hex="#9CAF88" />);
    const swatch = container.querySelector("span");
    expect(swatch).toHaveStyle({ backgroundColor: "rgb(156, 175, 136)" }); // #9CAF88
  });

  test("renders a different hex with the matching background color (not a stale/shared style)", () => {
    const { container } = render(<ColorSwatch hex="#8B6B4E" />);
    const swatch = container.querySelector("span");
    expect(swatch).toHaveStyle({ backgroundColor: "rgb(139, 107, 78)" }); // #8B6B4E
  });

  test("renders no background color for a null hex (the documented neutral placeholder)", () => {
    const { container } = render(<ColorSwatch hex={null} />);
    const swatch = container.querySelector("span");
    expect(swatch?.style.backgroundColor).toBe("");
  });

  test("is aria-hidden — it never carries the color's name, only a visual cue", () => {
    const { container } = render(<ColorSwatch hex="#9CAF88" />);
    expect(container.querySelector("span")).toHaveAttribute("aria-hidden", "true");
  });

  test("accepts a className override (e.g. a different size per call site)", () => {
    const { container } = render(<ColorSwatch hex="#9CAF88" className="size-6" />);
    expect(container.querySelector("span")).toHaveClass("size-6");
  });
});
