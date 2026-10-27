// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoadingRegion, Skeleton } from "../src/components/Skeleton";

const announcement = (container: HTMLElement) => {
  const node = container.querySelector('[data-slot="loading-announcement"]');
  if (!node) throw new Error("no loading announcement rendered");
  return node;
};

describe("Skeleton", () => {
  it("is hidden from assistive tech", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("pulses, and stops pulsing under prefers-reduced-motion", () => {
    const { container } = render(<Skeleton />);
    const block = container.firstElementChild;
    expect(block).toHaveClass("animate-pulse");
    expect(block).toHaveClass("motion-reduce:animate-none");
  });

  it("uses the admin neutral token and lets the caller size it", () => {
    const { container } = render(<Skeleton className="h-28 rounded-lg" />);
    const block = container.firstElementChild;
    expect(block).toHaveClass("bg-neutral-200", "h-28", "rounded-lg");
    // tailwind-merge keeps the caller's radius instead of stacking both.
    expect(block).not.toHaveClass("rounded-md");
  });

  it("passes other attributes through", () => {
    render(<Skeleton data-testid="row" style={{ width: "40%" }} />);
    expect(screen.getByTestId("row")).toHaveStyle({ width: "40%" });
  });
});

describe("LoadingRegion", () => {
  it("marks the skeleton busy, but not the status that announces it", () => {
    const { container } = render(
      <LoadingRegion>
        <Skeleton />
      </LoadingRegion>,
    );
    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy!.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(announcement(container).closest('[aria-busy="true"]')).toBeNull();
  });

  it("writes the status text after mount, so the live region announces it", () => {
    // The server-rendered markup has an empty status node: text present at insertion is often
    // not announced.
    const html = renderToStaticMarkup(
      <LoadingRegion>
        <Skeleton />
      </LoadingRegion>,
    );
    expect(html).toContain('<span aria-live="polite" data-slot="loading-announcement" class="sr-only"></span>');
    const { container } = render(
      <LoadingRegion>
        <Skeleton />
      </LoadingRegion>,
    );
    expect(announcement(container)).toHaveTextContent("Memuat...");
  });

  it("does not take the status role, which belongs to the app's toasts", () => {
    render(
      <LoadingRegion>
        <Skeleton />
      </LoadingRegion>,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("announces a visually hidden Indonesian loading message in a polite live region", () => {
    const { container } = render(
      <LoadingRegion>
        <Skeleton />
      </LoadingRegion>,
    );
    const live = announcement(container);
    expect(live).toHaveTextContent("Memuat...");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveClass("sr-only");
  });

  it("accepts a custom label", () => {
    const { container } = render(
      <LoadingRegion label="Memuat pesanan...">
        <Skeleton />
      </LoadingRegion>,
    );
    expect(announcement(container)).toHaveTextContent("Memuat pesanan...");
  });

  it("exposes only the loading text, not the decorative blocks", () => {
    const { container } = render(
      <LoadingRegion>
        <Skeleton />
        <Skeleton />
      </LoadingRegion>,
    );
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
    const blocks = container.querySelectorAll('[data-slot="skeleton"]');
    expect(blocks).toHaveLength(2);
    blocks.forEach((block) => expect(block).toHaveAttribute("aria-hidden", "true"));
  });
});
