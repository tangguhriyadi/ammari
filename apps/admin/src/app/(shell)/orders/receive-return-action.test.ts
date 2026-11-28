import { beforeEach, describe, expect, test, vi } from "vitest";

// Server-side gate for "Retur diterima" (docs/plans/tiktok-shop-integration.md T6): orders.manage on
// every call, whatever the page showed. The write itself (in-transit flag required, stock back
// through transitionOrderStatus) is covered against the database in
// packages/commerce/src/tiktok/after-sale.test.ts.

const { getStaffSessionMock, receiveMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn(), receiveMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
vi.mock("@ammari/commerce/tiktok", () => ({ receiveMarketplaceReturn: receiveMock }));
vi.mock("@/lib/admin-revalidate", () => ({ revalidateAdmin: vi.fn(), revalidateOverview: vi.fn() }));
vi.mock("@/lib/storefront-stock", () => ({ revalidateStorefrontForSkus: vi.fn(async () => ({ ok: true })), skusForOrder: vi.fn(async () => []) }));

const { receiveMarketplaceReturnAction } = await import("./actions");

const ORDER_ID = "00000000-0000-4000-8000-000000000001";

function sessionWith(permissionKeys: string[]) {
  return { staffUser: { id: "staff-1", name: "Staf", email: "staf@example.test", roleId: "role-1" }, role: { id: "role-1", key: "test", name: "Test" }, permissionKeys };
}

beforeEach(() => {
  getStaffSessionMock.mockReset();
  receiveMock.mockReset();
  receiveMock.mockResolvedValue({ orderNo: "ORD-1" });
});

describe("receiveMarketplaceReturnAction", () => {
  test("staff without orders.manage (even orders.view or packing) → forbidden, nothing written", async () => {
    for (const keys of [[], ["orders.view"], ["orders.view", "orders.import", "packing.print_cards"], ["integrations.manage"]]) {
      getStaffSessionMock.mockResolvedValueOnce(sessionWith(keys));
      await expect(receiveMarketplaceReturnAction({ orderId: ORDER_ID })).rejects.toThrow(/forbidden\(\)/);
    }
    expect(receiveMock).not.toHaveBeenCalled();
  });

  test("no staff session → redirect to /login, nothing written", async () => {
    getStaffSessionMock.mockResolvedValue(null);
    await expect(receiveMarketplaceReturnAction({ orderId: ORDER_ID })).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(receiveMock).not.toHaveBeenCalled();
  });

  test("with orders.manage: the return is received for this staff member", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWith(["orders.view", "orders.manage"]));
    const result = await receiveMarketplaceReturnAction({ orderId: ORDER_ID });
    expect(result).toEqual({ ok: true, data: { orderNo: "ORD-1", storefrontOk: true } });
    expect(receiveMock).toHaveBeenCalledWith(expect.anything(), ORDER_ID, "staff-1");
  });

  test("a malformed order id is refused before any write", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWith(["orders.manage"]));
    expect(await receiveMarketplaceReturnAction({ orderId: "nope" })).toMatchObject({ ok: false });
    expect(receiveMock).not.toHaveBeenCalled();
  });
});
