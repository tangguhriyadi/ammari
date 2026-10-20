// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { StorefrontProduct } from "@ammari/db/storefront";
import { buildProductView } from "@/lib/content/product-view";
import { ProductPurchasePanel } from "./product-purchase-panel";
import { OPEN_ACCORDION_EVENT, type OpenAccordionDetail } from "./size-guide";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => "/products/haura" }));

const colors = [
  { id: "sage", name: "Sage", hex: "#9CAF88" },
  { id: "mocca", name: "Mocca", hex: "#8B6F5A" },
];

function product(variants: StorefrontProduct["variants"]): StorefrontProduct {
  return {
    id: "p1",
    name: "Haura",
    slug: "haura",
    basePrice: 269_000,
    storefrontDescription: null,
    highlights: [],
    sizeMode: "sized",
    allsizeFitNote: null,
    careInstructions: null,
    images: [],
    colors,
    variants,
    sizeChart: null,
  };
}

function renderPanel(variants: StorefrontProduct["variants"], { cartEnabled = false, sizeMode = "sized" as StorefrontProduct["sizeMode"], withChart = false } = {}) {
  const sizeChart = withChart ? [{ size: "M" as const, bustCm: 100, lengthCm: 140, sleeveLengthCm: 55, heightRecommendationMinCm: 155, heightRecommendationMaxCm: 165 }] : null;
  const view = buildProductView({ ...product(variants), sizeMode, sizeChart });
  return render(
    <ProductPurchasePanel
      view={view}
      initialColorId="sage"
      cartEnabled={cartEnabled}
      whatsappNumber="6281234567890"
      pageUrl="https://example.test/products/haura"
      storageBaseUrl="https://cdn.example.test"
      afterActions={null}
    />,
  );
}

// Haura only has S, M, L in sage (only M in stock); mocca has only M and it is out of stock.
const mixed: StorefrontProduct["variants"] = [
  { sku: "SAGE-S", fabricColorId: "sage", size: "S", available: false },
  { sku: "SAGE-M", fabricColorId: "sage", size: "M", available: true },
  { sku: "SAGE-L", fabricColorId: "sage", size: "L", available: false },
  { sku: "MOCCA-M", fabricColorId: "mocca", size: "M", available: false },
];

beforeEach(() => {
  // jsdom has no Element.scrollTo (the gallery effect resets its scroll position).
  Element.prototype.scrollTo = vi.fn() as unknown as Element["scrollTo"];
  window.history.replaceState(null, "", "/products/haura");
});

describe("PDP size buttons", () => {
  test("mixed stock: only M is selectable, S and L are aria-disabled 'habis', XS and XL are not shown", () => {
    renderPanel(mixed);
    expect(screen.queryByRole("button", { name: /XS/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /XL/ })).toBeNull();

    const s = screen.getByRole("button", { name: "Ukuran S habis" });
    expect(s).toHaveAttribute("aria-disabled", "true");
    expect(s).toHaveClass("line-through", "bg-surface", "text-ink-muted");
    fireEvent.click(s);
    expect(screen.getByText("Ukuran", { selector: "p" })).toHaveTextContent(/^Ukuran$/);

    const m = screen.getByRole("button", { name: "M" });
    expect(m).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(m);
    expect(screen.getByText("Ukuran: M")).toBeInTheDocument();
  });

  test("switching colour re-evaluates the sizes and the CTA", () => {
    renderPanel(mixed);
    expect(screen.getByRole("link", { name: /Tanya via WhatsApp/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mocca" }));

    // Mocca has only M, and it is out of stock.
    expect(screen.queryByRole("button", { name: /^Ukuran S/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Ukuran M habis" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "SOLD OUT" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sage" }));
    expect(screen.getByRole("link", { name: /Tanya via WhatsApp/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "SOLD OUT" })).toBeNull();
  });
});

describe("PDP main CTA when nothing is in stock", () => {
  const empty = mixed.map((variant) => ({ ...variant, available: false }));

  test("WhatsApp CTA (cart off): replaced by a disabled SOLD OUT button", () => {
    renderPanel(empty);
    const button = screen.getByRole("button", { name: "SOLD OUT" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("link", { name: /Tanya via WhatsApp/ })).toBeNull();
    for (const name of ["Ukuran S habis", "Ukuran M habis", "Ukuran L habis"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");
    }
  });

  test("cart CTA (cart on): 'Tambah ke keranjang' is replaced by SOLD OUT, WhatsApp stays secondary", () => {
    renderPanel(empty, { cartEnabled: true });
    expect(screen.getByRole("button", { name: "SOLD OUT" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Tambah ke keranjang|Pilih ukuran/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Tanya via WhatsApp/ })).toBeInTheDocument();
  });

  test("cart on with stock: the normal cart CTA is shown, no SOLD OUT", () => {
    renderPanel(mixed, { cartEnabled: true });
    expect(screen.getByRole("button", { name: "Pilih ukuran" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "SOLD OUT" })).toBeNull();
  });

  test("all_size product with no stock is sold out too", () => {
    renderPanel([{ sku: "A-SAGE", fabricColorId: "sage", size: "ALLSIZE", available: false }], { sizeMode: "all_size" });
    expect(screen.getByRole("button", { name: "SOLD OUT" })).toBeDisabled();
  });
});

describe("Panduan ukuran link", () => {
  test("is not shown when the product has no size chart to land on", () => {
    renderPanel(mixed);
    expect(screen.queryByRole("link", { name: "Panduan ukuran" })).toBeNull();
  });

  test("a modified click (new tab) is left to the browser", () => {
    renderPanel(mixed, { withChart: true });
    const received: unknown[] = [];
    window.addEventListener(OPEN_ACCORDION_EVENT, (event) => received.push(event));
    expect(fireEvent.click(screen.getByRole("link", { name: "Panduan ukuran" }), { ctrlKey: true })).toBe(true);
    expect(received).toHaveLength(0);
  });

  test("asks the accordions to open the Ukuran panel instead of jumping natively", () => {
    renderPanel(mixed, { withChart: true });
    const received: OpenAccordionDetail[] = [];
    window.addEventListener(OPEN_ACCORDION_EVENT, (event) => received.push((event as CustomEvent<OpenAccordionDetail>).detail));

    const notPrevented = fireEvent.click(screen.getByRole("link", { name: "Panduan ukuran" }));

    expect(notPrevented).toBe(false);
    expect(received).toEqual([{ accordionId: "ukuran", targetId: "panduan-ukuran-heading" }]);
  });
});
