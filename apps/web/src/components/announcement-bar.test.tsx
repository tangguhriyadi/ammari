// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnnouncementBar } from "./announcement-bar";

describe("AnnouncementBar", () => {
  test("renders the text in a labelled region", () => {
    render(<AnnouncementBar text="Gratis Ongkir Ke Seluruh Indonesia" />);
    const region = screen.getByRole("region", { name: "Pengumuman" });
    expect(region).toHaveTextContent("Gratis Ongkir Ke Seluruh Indonesia");
  });

  test("brand background, white text, fixed 36px/40px height, never sticky", () => {
    render(<AnnouncementBar text="Promo" />);
    const region = screen.getByTestId("announcement-bar");
    expect(region.className).toMatch(/\bbg-brand\b/);
    expect(region.className).toMatch(/\btext-white\b/);
    expect(region.className).toMatch(/\bh-9\b/);
    expect(region.className).toMatch(/\blg:h-10\b/);
    expect(region.className).not.toMatch(/\b(sticky|fixed)\b/);
  });

  test("keeps the text on one line (truncates instead of wrapping)", () => {
    render(<AnnouncementBar text="Promo" />);
    expect(screen.getByText("Promo").className).toMatch(/\btruncate\b/);
  });
});
