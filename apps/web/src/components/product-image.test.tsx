// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { buildImageSrcSet, buildImageUrl } from "@/lib/storage/public-url";
import { ProductImage } from "./product-image";

const BASE = "https://cdn.example.test";

/** The image's underlying URL: next/image wraps it in its optimizer URL under Vitest, which
 * doesn't load next.config.ts's `images.unoptimized` (the real app serves the URL as-is). */
function sourceOf(image: HTMLElement): string {
  const src = image.getAttribute("src") ?? "";
  const url = new URL(src, "http://localhost");
  return url.pathname === "/_next/image" ? (url.searchParams.get("url") ?? "") : src;
}

describe("buildImageSrcSet", () => {
  test("lists each pre-generated size with its width descriptor", () => {
    expect(buildImageSrcSet(BASE, "products/p1/abc", [800, 1600])).toBe(
      "https://cdn.example.test/products/p1/abc/800.webp 800w, https://cdn.example.test/products/p1/abc/1600.webp 1600w",
    );
  });
});

describe("ProductImage responsive mode", () => {
  const src = buildImageUrl(BASE, "products/p1/abc", 1600);
  const srcSet = buildImageSrcSet(BASE, "products/p1/abc", [800, 1600]);

  test("renders a plain <img> with the srcset and sizes, lazy by default", () => {
    const { container } = render(<ProductImage src={src} srcSet={srcSet} alt="Beige depan" placeholderSize={1600} sizes="100vw" />);
    const image = container.querySelector("img")!;
    expect(image).toHaveAttribute("src", src);
    expect(image).toHaveAttribute("srcset", srcSet);
    expect(image).toHaveAttribute("sizes", "100vw");
    expect(image).toHaveAttribute("alt", "Beige depan");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).not.toHaveAttribute("fetchpriority");
  });

  test("fetchPriority high also loads eagerly (the one LCP photo)", () => {
    const { container } = render(<ProductImage src={src} srcSet={srcSet} alt="" placeholderSize={1600} sizes="100vw" fetchPriority="high" />);
    const image = container.querySelector("img")!;
    expect(image).toHaveAttribute("loading", "eager");
    expect(image).toHaveAttribute("fetchpriority", "high");
  });

  test("loading overrides the mode fetchPriority implies, without claiming the priority (the viewer)", () => {
    const { container } = render(<ProductImage src={src} srcSet={srcSet} alt="" placeholderSize={1600} sizes="100vw" loading="eager" />);
    const image = container.querySelector("img")!;
    expect(image).toHaveAttribute("loading", "eager");
    expect(image).not.toHaveAttribute("fetchpriority");
    const { container: plain } = render(<ProductImage src={src} alt="" placeholderSize={1600} sizes="100vw" loading="eager" />);
    expect(plain.querySelector("img")).toHaveAttribute("loading", "eager");
  });

  test("a failed load swaps to the placeholder, with no srcset left behind", () => {
    const { container } = render(
      <ProductImage src={src} srcSet={srcSet} alt="Beige depan" placeholderAlt="Foto belum tersedia" placeholderSize={1600} sizes="100vw" />,
    );
    fireEvent.error(container.querySelector("img")!);
    const image = container.querySelector("img")!;
    expect(sourceOf(image)).toBe("/images/product-placeholder-1600.webp");
    expect(image).toHaveAttribute("alt", "Foto belum tersedia");
    expect(image).toHaveAttribute("data-placeholder", "true");
    expect(image.getAttribute("srcset") ?? "").not.toContain("cdn.example.test");
  });

  test("no photo at all renders the placeholder even with a srcSet", () => {
    const { container } = render(<ProductImage src={null} srcSet={srcSet} alt="" placeholderSize={1600} sizes="100vw" />);
    expect(sourceOf(container.querySelector("img")!)).toBe("/images/product-placeholder-1600.webp");
  });
});
