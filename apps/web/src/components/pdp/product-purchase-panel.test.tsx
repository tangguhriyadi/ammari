// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { StorefrontProduct } from "@ammari/db/storefront";
import { buildProductView } from "@/lib/content/product-view";
import { ProductPurchasePanel } from "./product-purchase-panel";
import { OPEN_ACCORDION_EVENT, type OpenAccordionDetail } from "./size-guide";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: routerPush }), usePathname: () => "/products/haura" }));
const addToCartAction = vi.fn();
const buyNowAction = vi.fn();
vi.mock("@/lib/cart/actions", () => ({ addToCartAction: (input: unknown) => addToCartAction(input), buyNowAction: (input: unknown) => buyNowAction(input) }));
// The pending-order notice's read (components/pdp/pending-order-notice.tsx): no order unless a test says so.
const pendingOrderBody = vi.fn<() => unknown>(() => ({ order: null }));

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
  addToCartAction.mockReset();
  buyNowAction.mockReset();
  routerPush.mockReset();
  pendingOrderBody.mockImplementation(() => ({ order: null }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(pendingOrderBody()), { status: 200, headers: { "content-type": "application/json" } })));
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

describe("Tambah ke keranjang (cart on)", () => {
  const allsize: StorefrontProduct["variants"] = [{ sku: "A-SAGE", fabricColorId: "sage", size: "ALLSIZE", available: true }];

  test("adds the selected size's SKU, shows the 'Masuk keranjang' box with a link to /cart and announces the count", async () => {
    addToCartAction.mockResolvedValue({ ok: true, pieceCount: 3, mergeTrimmed: false });
    const counts: number[] = [];
    const listener = (event: Event) => counts.push((event as CustomEvent<{ pieceCount: number }>).detail.pieceCount);
    window.addEventListener("ammari:cart-count", listener);
    renderPanel(mixed, { cartEnabled: true });

    fireEvent.click(screen.getByRole("button", { name: "M" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tambah ke keranjang" })));

    expect(addToCartAction).toHaveBeenCalledWith({ sku: "SAGE-M", qty: 1 });
    await waitFor(() => expect(screen.getByRole("link", { name: "Lihat" })).toHaveAttribute("href", "/cart"));
    expect(screen.getByRole("link", { name: "Lihat" }).closest("p")).toHaveTextContent("Masuk keranjang: Sage, M · Lihat");
    // Screen readers hear the confirmation with the new count.
    expect(screen.getByRole("status")).toHaveTextContent("Masuk keranjang: Sage, M. 3 barang di keranjang.");
    expect(counts).toEqual([3]);
    window.removeEventListener("ammari:cart-count", listener);
  });

  test("an all_size product adds its colour's single SKU without a size", async () => {
    addToCartAction.mockResolvedValue({ ok: true, pieceCount: 1, mergeTrimmed: false });
    renderPanel(allsize, { cartEnabled: true, sizeMode: "all_size" });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tambah ke keranjang" })));

    expect(addToCartAction).toHaveBeenCalledWith({ sku: "A-SAGE", qty: 1 });
    await waitFor(() => expect(screen.getByRole("link", { name: "Lihat" }).closest("p")).toHaveTextContent("Masuk keranjang: Sage · Lihat"));
  });

  test("a refusal shows the server's message as an alert and no 'Masuk keranjang' box", async () => {
    addToCartAction.mockResolvedValue({ ok: false, message: "Maksimal 20 barang per pesanan." });
    renderPanel(mixed, { cartEnabled: true });

    fireEvent.click(screen.getByRole("button", { name: "M" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tambah ke keranjang" })));

    expect(await screen.findByRole("alert")).toHaveTextContent("Maksimal 20 barang per pesanan.");
    expect(screen.queryByRole("link", { name: "Lihat" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  test("a login merge that had to trim says so next to the confirmation", async () => {
    addToCartAction.mockResolvedValue({ ok: true, pieceCount: 20, mergeTrimmed: true });
    renderPanel(mixed, { cartEnabled: true });

    fireEvent.click(screen.getByRole("button", { name: "M" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tambah ke keranjang" })));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Maksimal 20 barang per pesanan."));
    expect(screen.getAllByText("Maksimal 20 barang per pesanan.")).toHaveLength(1);
  });

  test("changing the size clears the previous confirmation", async () => {
    addToCartAction.mockResolvedValue({ ok: true, pieceCount: 1, mergeTrimmed: false });
    renderPanel(
      [
        { sku: "SAGE-M", fabricColorId: "sage", size: "M", available: true },
        { sku: "SAGE-L", fabricColorId: "sage", size: "L", available: true },
      ],
      { cartEnabled: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "M" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tambah ke keranjang" })));
    await waitFor(() => expect(screen.getByRole("link", { name: "Lihat" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "L" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Lihat" })).toBeNull());
  });

  test("a call that rejects (offline, a deploy) shows a retry message instead of crashing the page", async () => {
    addToCartAction.mockRejectedValue(new TypeError("Failed to fetch"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPanel(mixed, { cartEnabled: true });

    fireEvent.click(screen.getByRole("button", { name: "M" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tambah ke keranjang" })));

    expect(await screen.findByRole("alert")).toHaveTextContent("Terjadi kesalahan. Coba lagi.");
    expect(screen.getByRole("button", { name: "Tambah ke keranjang" })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  test("an add that finishes after the buyer picked another size does not confirm the old size", async () => {
    let resolveAdd: (value: unknown) => void = () => {};
    addToCartAction.mockReturnValue(new Promise((resolve) => (resolveAdd = resolve)));
    renderPanel(
      [
        { sku: "SAGE-M", fabricColorId: "sage", size: "M", available: true },
        { sku: "SAGE-L", fabricColorId: "sage", size: "L", available: true },
      ],
      { cartEnabled: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "M" }));
    fireEvent.click(screen.getByRole("button", { name: "Tambah ke keranjang" }));
    expect(screen.getByRole("button", { name: "Menambahkan" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "L" }));

    await act(async () => resolveAdd({ ok: true, pieceCount: 1, mergeTrimmed: false }));

    expect(screen.queryByRole("link", { name: "Lihat" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Masuk keranjang: Sage, M. 1 barang di keranjang.");
  });

  test("cart off: the WhatsApp link is the action and no cart write is possible", () => {
    renderPanel(mixed);
    fireEvent.click(screen.getByRole("button", { name: "M" }));
    expect(screen.queryByRole("button", { name: /Tambah ke keranjang/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Beli sekarang|Pilih ukuran/ })).toBeNull();
    // Exactly as before: the solid primary WhatsApp button.
    expect(screen.getByRole("link", { name: "Tanya via WhatsApp" })).toHaveClass("bg-brand", "min-h-[52px]");
    expect(addToCartAction).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Beli sekarang (cart on, owner request 2026-10-21)", () => {
  test("button order: Beli sekarang (primary), Tambah ke keranjang (outlined), then a small WhatsApp text link", () => {
    renderPanel(mixed, { cartEnabled: true });
    expect(screen.getByRole("button", { name: "Pilih ukuran" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "M" }));
    const buy = screen.getByRole("button", { name: "Beli sekarang" });
    const add = screen.getByRole("button", { name: "Tambah ke keranjang" });
    const whatsapp = screen.getByRole("link", { name: "Tanya via WhatsApp" });
    expect(buy).toHaveClass("bg-brand", "text-white");
    expect(add).toHaveClass("border", "border-ink", "bg-bg");
    expect(whatsapp).toHaveClass("underline");
    expect(whatsapp).not.toHaveClass("min-h-[52px]");
    expect(buy.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(add.compareDocumentPosition(whatsapp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("puts the selected size in the cart and goes to /checkout", async () => {
    buyNowAction.mockResolvedValue({ ok: true, pieceCount: 2, mergeTrimmed: false });
    renderPanel(mixed, { cartEnabled: true });
    fireEvent.click(screen.getByRole("button", { name: "M" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Beli sekarang" })));
    expect(buyNowAction).toHaveBeenCalledWith({ sku: "SAGE-M" });
    expect(addToCartAction).not.toHaveBeenCalled();
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/checkout"));
    // On its way: further taps do nothing.
    fireEvent.click(screen.getByRole("button", { name: "Memproses" }));
    expect(buyNowAction).toHaveBeenCalledTimes(1);
  });

  test("a refusal stays on the page with the server's message", async () => {
    buyNowAction.mockResolvedValue({ ok: false, message: "Stok tidak cukup untuk jumlah ini." });
    renderPanel(mixed, { cartEnabled: true });
    fireEvent.click(screen.getByRole("button", { name: "M" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Beli sekarang" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stok tidak cukup untuk jumlah ini.");
    expect(routerPush).not.toHaveBeenCalled();
  });

  test("a page from the previous build says so instead of a blank page", async () => {
    buyNowAction.mockRejectedValue(Object.assign(new Error('Server Action "x" was not found on the server.'), { name: "UnrecognizedActionError" }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPanel(mixed, { cartEnabled: true });
    fireEvent.click(screen.getByRole("button", { name: "M" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Beli sekarang" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Halaman sudah diperbarui. Coba lagi.");
    consoleError.mockRestore();
  });
});

describe("the visitor's own order waiting for payment (cart on)", () => {
  const order = { orderNo: "ORD-202610-0001", payBy: "21 Oktober 2026, 14.30 WIB", paymentUrl: "https://pay.example/snap/abc", productIds: ["p1"] };

  test("shown when this product is in it, with both ways back to the payment", async () => {
    pendingOrderBody.mockImplementation(() => ({ order }));
    renderPanel(mixed, { cartEnabled: true });
    expect(await screen.findByText("Kamu punya pesanan ORD-202610-0001 yang menunggu pembayaran")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lanjutkan pembayaran" })).toHaveAttribute("href", "https://pay.example/snap/abc");
    expect(screen.getByRole("button", { name: "Ganti metode pembayaran" })).toBeInTheDocument();
  });

  test("not shown for an order of other products", async () => {
    pendingOrderBody.mockImplementation(() => ({ order: { ...order, productIds: ["p2"] } }));
    renderPanel(mixed, { cartEnabled: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/checkout/pending-order", expect.anything()));
    await act(async () => {});
    expect(screen.queryByText(/menunggu pembayaran/)).toBeNull();
  });
});
