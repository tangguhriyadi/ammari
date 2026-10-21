// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CartLine } from "@ammari/commerce/cart";
import { CART_COUNT_EVENT, CART_STATUS_EVENT } from "@/lib/cart/count-event";
import { CartLineItem } from "./cart-line-item";
import { CartPieceCount, CartSubtotal, OptimisticCartProvider } from "./optimistic-cart";
const updateCartItemQtyAction = vi.fn();
const removeCartItemAction = vi.fn();
vi.mock("@/lib/cart/actions", () => ({
  updateCartItemQtyAction: (input: unknown) => updateCartItemQtyAction(input),
  removeCartItemAction: (input: unknown) => removeCartItemAction(input),
}));

function cartLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    sku: "SAGE-M",
    productName: "Haura",
    productSlug: "haura",
    colorName: "Sage",
    sizeLabel: "M",
    qty: 2,
    unitPrice: 269_000,
    lineTotal: 538_000,
    status: "ok",
    image: null,
    ...overrides,
  };
}

function renderLine(line: CartLine, canAddPieces = true) {
  return render(
    <ul>
      <CartLineItem line={line} imageUrl={null} canAddPieces={canAddPieces} />
    </ul>,
  );
}

function listen(eventName: string) {
  const received: unknown[] = [];
  const listener = (event: Event) => received.push((event as CustomEvent).detail);
  window.addEventListener(eventName, listener);
  return { received, stop: () => window.removeEventListener(eventName, listener) };
}

function renderCart(lines: CartLine[]) {
  return render(
    <OptimisticCartProvider lines={lines}>
      <ul>
        {lines.map((line) => (
          <CartLineItem key={line.sku} line={line} imageUrl={null} canAddPieces />
        ))}
      </ul>
      <p data-testid="subtotal">
        <CartSubtotal fallback={0} />
      </p>
      <p data-testid="pieces">
        <CartPieceCount fallback={0} />
      </p>
    </OptimisticCartProvider>,
  );
}

beforeEach(() => {
  updateCartItemQtyAction.mockReset();
  removeCartItemAction.mockReset();
});

describe("CartLineItem", () => {
  test("shows name, 'Warna · Ukuran', line total and quantity, never a stock number", () => {
    renderLine(cartLine());
    expect(screen.getByRole("link", { name: "Haura" })).toHaveAttribute("href", "/products/haura");
    expect(screen.getByText("Sage · M")).toBeInTheDocument();
    expect(screen.getByText("Rp538.000")).toBeInTheDocument();
    expect(screen.getByTestId("cart-line-qty")).toHaveTextContent("Jumlah 2");
  });

  test("'+' sets qty + 1, then announces the count and status", async () => {
    updateCartItemQtyAction.mockResolvedValue({ ok: true, pieceCount: 3, mergeTrimmed: false });
    const counts = listen(CART_COUNT_EVENT);
    const statuses = listen(CART_STATUS_EVENT);
    renderLine(cartLine());

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tambah jumlah Haura, Sage, M" })));

    expect(updateCartItemQtyAction).toHaveBeenCalledWith({ sku: "SAGE-M", qty: 3 });
    await waitFor(() => expect(counts.received).toEqual([{ pieceCount: 3 }]));
    expect(statuses.received).toEqual(["Jumlah Haura, Sage, M menjadi 3."]);
    counts.stop();
    statuses.stop();
  });

  test("optimistic: '+' changes quantity, line total, subtotal, piece count and the header at once", async () => {
    let resolveCall: (value: unknown) => void = () => {};
    updateCartItemQtyAction.mockReturnValueOnce(new Promise((resolve) => (resolveCall = resolve)));
    const counts = listen(CART_COUNT_EVENT);
    renderCart([cartLine(), cartLine({ sku: "SAGE-L", sizeLabel: "L", qty: 1, lineTotal: 269_000 })]);
    expect(screen.getByTestId("subtotal")).toHaveTextContent("Rp807.000");

    act(() => fireEvent.click(screen.getByRole("button", { name: "Tambah jumlah Haura, Sage, M" })));

    // Before the server has answered.
    expect(screen.getAllByTestId("cart-line-qty")[0]).toHaveTextContent("Jumlah 3");
    expect(screen.getByText("Rp807.000", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByTestId("subtotal")).toHaveTextContent("Rp1.076.000");
    expect(screen.getByTestId("pieces")).toHaveTextContent("4 barang");
    expect(counts.received).toEqual([{ pieceCount: 4 }]);
    await act(async () => resolveCall({ ok: true, pieceCount: 4, mergeTrimmed: false }));
    expect(counts.received).toEqual([{ pieceCount: 4 }, { pieceCount: 4 }]);
    counts.stop();
  });

  test("optimistic: a second tap while the first is in flight sends the next quantity", async () => {
    const resolvers: ((value: unknown) => void)[] = [];
    updateCartItemQtyAction.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    renderCart([cartLine()]);
    const plus = screen.getByRole("button", { name: "Tambah jumlah Haura, Sage, M" });

    act(() => fireEvent.click(plus));
    act(() => fireEvent.click(plus));
    expect(updateCartItemQtyAction.mock.calls.map(([input]) => input)).toEqual([
      { sku: "SAGE-M", qty: 3 },
      { sku: "SAGE-M", qty: 4 },
    ]);
    expect(screen.getByTestId("cart-line-qty")).toHaveTextContent("Jumlah 4");
    await act(async () => resolvers.forEach((resolve) => resolve({ ok: true, pieceCount: 4, mergeTrimmed: false })));
  });

  test("optimistic: a refusal rolls everything back and shows the server's message", async () => {
    let resolveCall: (value: unknown) => void = () => {};
    updateCartItemQtyAction.mockReturnValueOnce(new Promise((resolve) => (resolveCall = resolve)));
    const counts = listen(CART_COUNT_EVENT);
    renderCart([cartLine()]);

    act(() => fireEvent.click(screen.getByRole("button", { name: "Tambah jumlah Haura, Sage, M" })));
    expect(screen.getByTestId("cart-line-qty")).toHaveTextContent("Jumlah 3");

    await act(async () => resolveCall({ ok: false, message: "Stok tidak cukup untuk jumlah ini" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stok tidak cukup untuk jumlah ini");
    expect(screen.getByTestId("cart-line-qty")).toHaveTextContent("Jumlah 2");
    expect(screen.getByTestId("subtotal")).toHaveTextContent("Rp538.000");
    expect(screen.getByTestId("pieces")).toHaveTextContent("2 barang");
    expect(counts.received).toEqual([{ pieceCount: 3 }, { pieceCount: 2 }]);
    counts.stop();
  });

  test("optimistic: × hides the line at once; a refused removal brings it back with the message", async () => {
    let resolveCall: (value: unknown) => void = () => {};
    removeCartItemAction.mockReturnValueOnce(new Promise((resolve) => (resolveCall = resolve)));
    renderCart([cartLine()]);

    act(() => fireEvent.click(screen.getByRole("button", { name: "Hapus Haura, Sage, M" })));
    expect(screen.queryByTestId("cart-line")).toBeNull();
    expect(screen.getByTestId("subtotal")).toHaveTextContent("Rp0");

    await act(async () => resolveCall({ ok: false, message: "Terjadi kesalahan. Coba lagi." }));
    expect(screen.getByTestId("cart-line")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Terjadi kesalahan. Coba lagi.");
    expect(screen.getByTestId("subtotal")).toHaveTextContent("Rp538.000");
  });

  test("a refusal shows the server's message", async () => {
    updateCartItemQtyAction.mockResolvedValue({ ok: false, message: "Stok tidak cukup untuk jumlah ini" });
    renderLine(cartLine());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tambah jumlah Haura, Sage, M" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stok tidak cukup untuk jumlah ini");
  });

  test("a call that rejects shows a retry message instead of crashing the page", async () => {
    removeCartItemAction.mockRejectedValue(new TypeError("Failed to fetch"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderLine(cartLine());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Hapus Haura, Sage, M" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Terjadi kesalahan. Coba lagi.");
    consoleError.mockRestore();
  });

  test("bounds: '-' is inert at 1, '+' at 10 and when the cart is full", () => {
    const { unmount } = renderLine(cartLine({ qty: 1 }));
    const minus = screen.getByRole("button", { name: /^Kurangi jumlah/ });
    expect(minus).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(minus);
    expect(updateCartItemQtyAction).not.toHaveBeenCalled();
    unmount();

    renderLine(cartLine({ qty: 10 }));
    expect(screen.getByRole("button", { name: /^Tambah jumlah/ })).toHaveAttribute("aria-disabled", "true");
  });

  test("the cart at 20 pieces blocks '+' on every line", () => {
    renderLine(cartLine(), false);
    const plus = screen.getByRole("button", { name: /^Tambah jumlah/ });
    expect(plus).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(plus);
    expect(updateCartItemQtyAction).not.toHaveBeenCalled();
  });

  test("insufficient: the message shows and only lowering is possible", () => {
    renderLine(cartLine({ qty: 5, status: "insufficient" }));
    expect(screen.getByText("Stok tidak cukup untuk jumlah ini")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Tambah jumlah/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /^Kurangi jumlah/ })).not.toHaveAttribute("aria-disabled");
  });

  test.each([
    ["sold_out", "Habis"],
    ["unavailable", "Tidak tersedia lagi"],
  ] as const)("%s: shows '%s' with only 'Hapus', no price or stepper", (status, label) => {
    renderLine(cartLine({ status }));
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /jumlah/ })).toBeNull();
    expect(screen.queryByText("Rp538.000")).toBeNull();
    expect(screen.getByRole("button", { name: "Hapus Haura, Sage, M" })).toHaveTextContent("Hapus");
  });

  test("removing moves focus to the page heading", async () => {
    removeCartItemAction.mockResolvedValue({ ok: true, pieceCount: 0, mergeTrimmed: false });
    const heading = document.createElement("h1");
    heading.id = "cart-heading";
    heading.tabIndex = -1;
    document.body.appendChild(heading);
    renderLine(cartLine());

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Hapus Haura, Sage, M" })));

    await waitFor(() => expect(document.activeElement).toBe(heading));
    heading.remove();
  });
});
