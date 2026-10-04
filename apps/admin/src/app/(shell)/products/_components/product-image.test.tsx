// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductImage } from "./product-image";

describe("ProductImage", () => {
  it("renders the real src and alt text when no error has occurred", () => {
    render(<ProductImage src="https://cdn.example.com/photo-400.webp" alt="Gamis Syari Sage" />);
    const img = screen.getByRole("img", { name: "Gamis Syari Sage" });
    expect(img).toHaveAttribute("src", "https://cdn.example.com/photo-400.webp");
  });

  it("renders the fallback immediately when src is null", () => {
    render(<ProductImage src={null} alt="Gamis Syari Sage" />);
    const img = screen.getByRole("img", { name: "Foto belum tersedia" });
    expect(img).toHaveAttribute("src", "/images/fallback-product-400.webp");
  });

  it("switches to the fallback src and alt text after a load error", () => {
    render(<ProductImage src="https://cdn.example.com/missing-400.webp" alt="Gamis Syari Mocca" />);
    const img = screen.getByRole("img", { name: "Gamis Syari Mocca" });

    fireEvent.error(img);

    const fallback = screen.getByRole("img", { name: "Foto belum tersedia" });
    expect(fallback).toHaveAttribute("src", "/images/fallback-product-400.webp");
  });

  it("stops listening for errors once the fallback is showing (loop guard)", () => {
    render(<ProductImage src="https://cdn.example.com/missing-400.webp" alt="Gamis Syari Mocca" />);
    const img = screen.getByRole("img", { name: "Gamis Syari Mocca" });

    fireEvent.error(img);
    const fallback = screen.getByRole("img", { name: "Foto belum tersedia" });
    expect(fallback).not.toHaveAttribute("onerror");

    // A second error (e.g. the fallback asset itself failing to load) must not throw or change
    // the rendered src again — the component's onError handler is removed once showing fallback.
    expect(() => fireEvent.error(fallback)).not.toThrow();
    expect(fallback).toHaveAttribute("src", "/images/fallback-product-400.webp");
  });
});
