import { beforeEach, describe, expect, test, vi } from "vitest";
import { generateCartToken, hashCartToken } from "@ammari/commerce/cart";

// lib/auth/sign-out.ts: every logout expires the guest cart cookie, the checkout's order cookies and
// every "Lihat pesanan" cookie the index names, merges a not-yet-merged guest cart into the account
// first, and deletes nothing in the database. Next's request APIs are an in-memory cookie jar.

interface DeletedCookie {
  name: string;
  path?: string;
  httpOnly?: boolean;
  sameSite?: string;
}

const jar = new Map<string, string>();
const deleted: DeletedCookie[] = [];
const calls: string[] = [];
let sessionCustomerId: string | null = null;
let cartEnabled = true;
let signOutError: Error | null = null;
let resolveCartError: Error | null = null;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    has: (name: string) => jar.has(name),
    delete: (options: DeletedCookie) => {
      calls.push(`delete:${options.name}`);
      deleted.push(options);
    },
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth/customer-session", () => ({
  getCustomerSession: async () => (sessionCustomerId ? { id: sessionCustomerId } : null),
}));
vi.mock("@/lib/auth/customer", () => ({
  customerAuth: {
    api: {
      signOut: async () => {
        calls.push("signOut");
        if (signOutError) throw signOutError;
      },
    },
  },
}));
vi.mock("@/lib/cart-flag", () => ({ isCartEnabled: () => cartEnabled }));
vi.mock("@/lib/db", () => ({ defaultDb: {} }));
const resolveCart = vi.fn(async (_db: unknown, identity: unknown) => {
  calls.push("resolveCart");
  if (resolveCartError) throw resolveCartError;
  return { cartId: null, clearGuestCookie: true, mergeTrimmed: false, identity };
});
vi.mock("@ammari/commerce/cart", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ammari/commerce/cart")>()),
  resolveCart: (db: unknown, identity: unknown) => resolveCart(db, identity),
}));

const { signOutCustomer } = await import("./sign-out");

const ORDER_A = "ORD-261022-0001";
const ORDER_B = "ORD-261022-0002";

function deletedPaths(): Record<string, string | undefined> {
  return Object.fromEntries(deleted.map((cookie) => [cookie.name, cookie.path]));
}

beforeEach(() => {
  jar.clear();
  deleted.length = 0;
  calls.length = 0;
  sessionCustomerId = "00000000-0000-4000-8000-000000000001";
  cartEnabled = true;
  signOutError = null;
  resolveCartError = null;
  resolveCart.mockClear();
});

describe("signOutCustomer", () => {
  test("signs out, then expires the cart cookie, both checkout order cookies, every indexed order view cookie and the index", async () => {
    jar.set("ammari_cart", generateCartToken());
    jar.set("ammari_checkout_order_v2", "token");
    jar.set("ammari_order_views", `${ORDER_A}.${ORDER_B}`);

    await signOutCustomer();

    expect(deletedPaths()).toEqual({
      ammari_cart: "/",
      ammari_checkout_order_v2: "/",
      ammari_checkout_order: "/checkout",
      [`ammari_order_view_${ORDER_A}`]: `/orders/${ORDER_A}`,
      [`ammari_order_view_${ORDER_B}`]: `/orders/${ORDER_B}`,
      ammari_order_views: "/",
    });
    // Same attributes they were set with, so every browser accepts the expiry.
    for (const cookie of deleted) expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax" });
    // The merge needs the session, then sign out, then the cookies.
    expect(calls.slice(0, 2)).toEqual(["resolveCart", "signOut"]);
  });

  test("expires the cookies even when the browser sent none of them", async () => {
    await signOutCustomer();
    expect(Object.keys(deletedPaths()).sort()).toEqual(["ammari_cart", "ammari_checkout_order", "ammari_checkout_order_v2", "ammari_order_views"]);
  });

  test("a tampered index names no other cookie or path", async () => {
    jar.set("ammari_order_views", `${ORDER_A}.ammari_cart.../../admin.ORD-1`);
    await signOutCustomer();
    expect(deleted.filter((cookie) => cookie.name.startsWith("ammari_order_view_"))).toEqual([
      expect.objectContaining({ name: `ammari_order_view_${ORDER_A}`, path: `/orders/${ORDER_A}` }),
    ]);
  });

  test("merges a guest cart still waiting for its first read after login before dropping its cookie", async () => {
    const token = generateCartToken();
    jar.set("ammari_cart", token);
    await signOutCustomer();
    expect(resolveCart).toHaveBeenCalledWith({}, { customerId: sessionCustomerId, guestTokenHash: hashCartToken(token) });
    expect(calls.indexOf("resolveCart")).toBeLessThan(calls.indexOf("signOut"));
  });

  test("no merge without a guest cookie, or with the cart flag off", async () => {
    await signOutCustomer();
    jar.set("ammari_cart", generateCartToken());
    cartEnabled = false;
    await signOutCustomer();
    expect(resolveCart).not.toHaveBeenCalled();
  });

  test("a failed merge is logged and the logout still happens", async () => {
    jar.set("ammari_cart", generateCartToken());
    resolveCartError = new Error("db down");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await signOutCustomer();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("guest cart merge before logout failed"), expect.anything());
    expect(calls).toContain("signOut");
    expect(deletedPaths()).toHaveProperty("ammari_cart", "/");
    error.mockRestore();
  });

  test("the cookies are still expired when signing out itself fails", async () => {
    signOutError = new Error("auth down");
    await expect(signOutCustomer()).rejects.toThrow("auth down");
    expect(deletedPaths()).toHaveProperty("ammari_checkout_order_v2", "/");
  });
});
