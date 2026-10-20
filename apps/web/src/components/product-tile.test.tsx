// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import type { StorefrontProductTile } from "@ammari/db/storefront";
import { ProductTile } from "./product-tile";

function tile(overrides: Partial<StorefrontProductTile> = {}): StorefrontProductTile {
  return {
    productId: "p1",
    fabricColorId: null,
    name: "Haura Dress",
    slug: "haura-dress",
    basePrice: 269_000,
    colorName: "Taupe",
    colorCount: 1,
    soldOut: false,
    image: null,
    ...overrides,
  };
}

/** The image's underlying URL: next/image wraps it in its optimizer URL under Vitest, which
 * doesn't load next.config.ts's `images.unoptimized` (the real app serves the URL as-is). */
function sourceOf(image: HTMLElement): string {
  const src = image.getAttribute("src") ?? "";
  const url = new URL(src, "http://localhost");
  return url.pathname === "/_next/image" ? (url.searchParams.get("url") ?? "") : src;
}

beforeEach(() => {
  process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.example.test";
});

describe("ProductTile image fallback", () => {
  test("a product with no photo shows the static placeholder, decorative (the tile link already names the product)", () => {
    const { container } = render(<ProductTile tile={tile()} />);
    const image = container.querySelector("img")!;
    expect(sourceOf(image)).toBe("/images/product-placeholder-800.webp");
    expect(image).toHaveAttribute("alt", "");
    expect(screen.getByRole("link")).toHaveTextContent("Haura Dress");
  });

  test("a real photo renders from storage, and falls back to the placeholder if it fails to load", () => {
    render(
      <ProductTile
        tile={tile({
          image: { id: "i1", storageKey: "products/p1/i1", fabricColorId: null, altText: "Haura Dress warna Taupe", sortOrder: 0, width: 800, height: 1200 },
        })}
      />,
    );
    const image = screen.getByRole("img");
    expect(sourceOf(image)).toBe("https://cdn.example.test/products/p1/i1/800.webp");
    expect(image).toHaveAttribute("alt", "Haura Dress warna Taupe");

    fireEvent.error(image);

    expect(sourceOf(image)).toBe("/images/product-placeholder-800.webp");
    expect(image).toHaveAttribute("alt", "");
  });

  test("shows a small 'Sold out' label only when the product has no stock", () => {
    const { rerender } = render(<ProductTile tile={tile({ soldOut: true })} />);
    expect(screen.getByText("Sold out")).toBeInTheDocument();
    rerender(<ProductTile tile={tile({ soldOut: false })} />);
    expect(screen.queryByText("Sold out")).toBeNull();
  });
});
