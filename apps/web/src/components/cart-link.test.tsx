// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { announceCartCount } from "@/lib/cart/count-event";
import { CartLink } from "./cart-link";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("CartLink", () => {
  beforeEach(() => {
    pathname = "/";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("links to /cart and shows the fetched count, uncached", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ pieceCount: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CartLink />);

    const link = screen.getByRole("link", { name: "Keranjang" });
    expect(link).toHaveAttribute("href", "/cart");
    await waitFor(() => expect(screen.getByRole("link", { name: "Keranjang, 2 barang" })).toBeInTheDocument());
    expect(screen.getByTestId("cart-count")).toHaveTextContent("2");
    expect(fetchMock).toHaveBeenCalledWith("/api/cart/count", expect.objectContaining({ cache: "no-store" }));
  });

  test("above 9 the badge shows 9+ while the accessible name keeps the exact count; 0 hides it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(() => {})));
    render(<CartLink />);

    act(() => announceCartCount(9));
    expect(screen.getByTestId("cart-count")).toHaveTextContent(/^9$/);
    act(() => announceCartCount(12));
    expect(screen.getByTestId("cart-count")).toHaveTextContent(/^9\+$/);
    expect(screen.getByRole("link", { name: "Keranjang, 12 barang" })).toBeInTheDocument();
    act(() => announceCartCount(0));
    expect(screen.queryByTestId("cart-count")).toBeNull();
    expect(screen.getByRole("link", { name: "Keranjang" })).toBeInTheDocument();
  });

  test("a failed fetch shows the bag without a number and is logged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unavailable" }, 500)));
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<CartLink />);
    await waitFor(() => expect(consoleWarn).toHaveBeenCalled());
    expect(screen.queryByTestId("cart-count")).toBeNull();
    expect(screen.getByRole("link", { name: "Keranjang" })).toBeInTheDocument();
    consoleWarn.mockRestore();
  });

  test("a 404 (flag switched off under a cached page) hides the icon", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    render(<CartLink />);
    await waitFor(() => expect(screen.queryByRole("link", { name: /Keranjang/ })).toBeNull());
  });

  test("a back/forward cache restore re-fetches the count", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ pieceCount: 1 })).mockResolvedValueOnce(jsonResponse({ pieceCount: 4 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CartLink />);
    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("1"));

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("4"));
  });

  test("an announced count replaces the shown one, and a slower fetch started earlier cannot undo it", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((resolve) => (resolveFetch = resolve))));
    render(<CartLink />);

    act(() => announceCartCount(5));
    expect(screen.getByTestId("cart-count")).toHaveTextContent("5");

    await act(async () => resolveFetch(jsonResponse({ pieceCount: 0 })));
    expect(screen.getByTestId("cart-count")).toHaveTextContent("5");
  });

  test("re-fetches after a navigation", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ pieceCount: 1 })).mockResolvedValueOnce(jsonResponse({ pieceCount: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<CartLink />);
    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("1"));

    pathname = "/cart";
    rerender(<CartLink />);
    await waitFor(() => expect(screen.getByTestId("cart-count")).toHaveTextContent("3"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
