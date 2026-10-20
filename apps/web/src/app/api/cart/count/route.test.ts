import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/cart/queries", () => ({ loadCartPieceCount: vi.fn() }));

const { loadCartPieceCount } = await import("@/lib/cart/queries");
const { GET } = await import("./route");

describe("GET /api/cart/count", () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env.STOREFRONT_CART_ENABLED;
    vi.mocked(loadCartPieceCount).mockReset();
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.STOREFRONT_CART_ENABLED;
    else process.env.STOREFRONT_CART_ENABLED = savedFlag;
  });

  test("flag off: 404 without reading the cart", async () => {
    process.env.STOREFRONT_CART_ENABLED = "false";
    const response = await GET();
    expect(response.status).toBe(404);
    expect(loadCartPieceCount).not.toHaveBeenCalled();
  });

  test("flag on: the visitor's piece count, never stored by any cache", async () => {
    process.env.STOREFRONT_CART_ENABLED = "true";
    vi.mocked(loadCartPieceCount).mockResolvedValue(4);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ pieceCount: 4 });
  });

  test("a failed read is a logged 500, not a count of 0", async () => {
    process.env.STOREFRONT_CART_ENABLED = "true";
    vi.mocked(loadCartPieceCount).mockRejectedValue(new Error("db down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(consoleError).toHaveBeenCalledWith("[cart] count read failed", expect.any(Error));
    consoleError.mockRestore();
  });
});
