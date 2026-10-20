// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import type { StorefrontProductTile } from "@ammari/db/storefront";
import type { ResolvedFeatureBlock } from "@/lib/content/homepage-resolve";
import { FeatureBlockSection } from "./feature-block-section";

const linkedProduct: StorefrontProductTile = {
  productId: "p1",
  fabricColorId: null,
  name: "Haura Dress",
  slug: "haura-dress",
  basePrice: 269_000,
  colorName: "Taupe",
  colorCount: 1,
  soldOut: false,
  image: null,
};

function block(overrides: Partial<ResolvedFeatureBlock> = {}): ResolvedFeatureBlock {
  return {
    title: "Haura Dress",
    subtitle: "Koleksi terbaru",
    ctaLabel: "LIHAT",
    image: { storageKey: "content/feature", altText: "Haura Dress", mobileStorageKey: null },
    linkedProduct,
    href: "/products/haura-dress?color=c1",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.STORAGE_PUBLIC_BASE_URL = "https://cdn.example.test";
});

describe("FeatureBlockSection image link", () => {
  test("the image links to exactly the button's href", () => {
    const { container } = render(<FeatureBlockSection block={block()} />);
    const button = screen.getByRole("link", { name: "LIHAT" });
    const imageLink = screen.getByTestId("feature-block-image-link");
    expect(button).toHaveAttribute("href", "/products/haura-dress?color=c1");
    expect(imageLink.getAttribute("href")).toBe(button.getAttribute("href"));
    expect(imageLink.getAttribute("target")).toBe(button.getAttribute("target"));
    expect(imageLink.getAttribute("rel")).toBe(button.getAttribute("rel"));
    expect(container.querySelectorAll("a")).toHaveLength(2);
  });

  test("the image link is out of the tab order and hidden from assistive tech, so the button is the only accessible link", () => {
    render(<FeatureBlockSection block={block()} />);
    const imageLink = screen.getByTestId("feature-block-image-link");
    expect(imageLink).toHaveAttribute("tabindex", "-1");
    expect(imageLink).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  test("with no button link, nothing is clickable", () => {
    const { container } = render(<FeatureBlockSection block={block({ href: "" })} />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelector("img")).not.toBeNull();
  });
});
