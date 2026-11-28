import { beforeEach, describe, expect, test, vi } from "vitest";

// Server-side gate for the Integrasi TikTok Shop actions (docs/plans/tiktok-shop-integration.md T2):
// integrations.manage on every call, whatever the page showed. The writes themselves are covered
// against the database in packages/commerce/src/tiktok/connection.test.ts.

const { getStaffSessionMock, createStateMock, disconnectMock, runtimeMock, stockSyncMock, retryMock, pushMock } = vi.hoisted(() => ({
  stockSyncMock: vi.fn(),
  retryMock: vi.fn(),
  pushMock: vi.fn(),
  getStaffSessionMock: vi.fn(),
  createStateMock: vi.fn(),
  disconnectMock: vi.fn(),
  runtimeMock: vi.fn(),
}));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
vi.mock("@ammari/commerce/tiktok", () => ({ createTikTokOAuthState: createStateMock, disconnectTikTokShop: disconnectMock, setTikTokStockSync: stockSyncMock, retryRefusedTikTokStockPushes: retryMock }));
vi.mock("@/lib/integrations/tiktok-stock-push", () => ({ pushTikTokStockAfterResponse: pushMock }));
vi.mock("@/lib/integrations/tiktok", () => ({ getTikTokRuntime: runtimeMock, TIKTOK_PERMISSION: "integrations.manage" }));
vi.mock("@/lib/admin-revalidate", () => ({ revalidateAdmin: vi.fn(), revalidateOverview: vi.fn() }));

const { Secret } = await import("@ammari/tiktok-shop");
const { disconnectTikTokAction, retryRefusedTikTokStockAction, setTikTokStockSyncAction, startTikTokConnectAction } = await import("./actions");

function sessionWith(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Staf", email: "staf@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test", name: "Test" },
    permissionKeys,
  };
}

const CONFIGURED = { ok: true, runtime: { config: { serviceId: "7000000000000000999", appKey: new Secret("dummyappkey") } } };

beforeEach(() => {
  for (const mock of [getStaffSessionMock, createStateMock, disconnectMock, runtimeMock, stockSyncMock]) mock.mockReset();
  runtimeMock.mockReturnValue(CONFIGURED);
  createStateMock.mockResolvedValue(new Secret("A".repeat(43)));
  disconnectMock.mockResolvedValue({ ok: true, shopId: "7000000000000000001" });
});

describe("both actions require integrations.manage on the server", () => {
  test("staff without it (even settings.manage or roles.manage) → forbidden, nothing written", async () => {
    for (const keys of [[], ["settings.manage"], ["roles.manage", "audit_log.view"], ["orders.manage"]]) {
      getStaffSessionMock.mockResolvedValueOnce(sessionWith(keys));
      await expect(startTikTokConnectAction()).rejects.toThrow(/forbidden\(\)/);
      getStaffSessionMock.mockResolvedValueOnce(sessionWith(keys));
      await expect(disconnectTikTokAction()).rejects.toThrow(/forbidden\(\)/);
    }
    expect(createStateMock).not.toHaveBeenCalled();
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  test("no staff session (a customer session is never one in admin) → redirect to /login, nothing written", async () => {
    getStaffSessionMock.mockResolvedValue(null);
    await expect(startTikTokConnectAction()).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    await expect(disconnectTikTokAction()).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(createStateMock).not.toHaveBeenCalled();
    expect(disconnectMock).not.toHaveBeenCalled();
  });
});

describe("startTikTokConnectAction", () => {
  test("creates a state for this staff user and returns the authorize link with TIKTOK_SERVICE_ID, never the App Key", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWith(["integrations.manage"]));
    const result = await startTikTokConnectAction();
    expect(createStateMock).toHaveBeenCalledWith(expect.anything(), "staff-1");
    expect(runtimeMock).toHaveBeenCalledWith({ requireServiceId: true });
    if (!result.ok) throw new Error(result.error);
    const url = new URL(result.data.url);
    expect(url.origin + url.pathname).toBe("https://services.tiktokshop.com/open/authorize");
    expect(url.searchParams.get("service_id")).toBe("7000000000000000999");
    expect(url.searchParams.get("state")).toBe("A".repeat(43));
    expect(result.data.url).not.toContain("dummyappkey");
  });

  test("not configured → an Indonesian message, no state created", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWith(["integrations.manage"]));
    runtimeMock.mockReturnValue({ ok: false, problems: ["TIKTOK_SERVICE_ID is not set"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await startTikTokConnectAction()).toEqual({ ok: false, error: "Integrasi TikTok Shop belum diatur di server. Hubungi pengelola teknis." });
    expect(createStateMock).not.toHaveBeenCalled();
  });
});

describe("disconnectTikTokAction", () => {
  test("disconnects as this staff user; nothing connected → a message", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWith(["integrations.manage"]));
    expect(await disconnectTikTokAction()).toEqual({ ok: true, data: undefined });
    expect(disconnectMock).toHaveBeenCalledWith(expect.anything(), { staffUserId: "staff-1" });
    disconnectMock.mockResolvedValueOnce({ ok: false, reason: "not_connected" });
    expect(await disconnectTikTokAction()).toEqual({ ok: false, error: "Tidak ada toko TikTok yang terhubung." });
  });
});

describe("setTikTokStockSyncAction (docs/plans/tiktok-stock-sync.md R1)", () => {
  test("integrations.manage on the server; without it nothing is written", async () => {
    for (const keys of [[], ["settings.manage"], ["stock.manage"], ["orders.manage"]]) {
      getStaffSessionMock.mockResolvedValueOnce(sessionWith(keys));
      await expect(setTikTokStockSyncAction({ enabled: true })).rejects.toThrow(/forbidden\(\)/);
    }
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(setTikTokStockSyncAction({ enabled: true })).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(stockSyncMock).not.toHaveBeenCalled();
  });

  test("stores the flag as this staff user; refused while orders apply is off; bad input refused", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWith(["integrations.manage"]));
    stockSyncMock.mockResolvedValueOnce({ ok: true, changed: true });
    expect(await setTikTokStockSyncAction({ enabled: true })).toEqual({ ok: true, data: { changed: true } });
    expect(stockSyncMock).toHaveBeenCalledWith(expect.anything(), { enabled: true, staffUserId: "staff-1" });
    stockSyncMock.mockResolvedValueOnce({ ok: false, reason: "orders_apply_off" });
    expect(await setTikTokStockSyncAction({ enabled: true })).toEqual({ ok: false, error: "Aktifkan Mulai terapkan pesanan dulu." });
    expect(await setTikTokStockSyncAction({ enabled: "yes" } as never)).toEqual({ ok: false, error: "Input tidak valid." });
  });

  test("S2: turning it ON starts the first push after the response; OFF or no change does not", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWith(["integrations.manage"]));
    pushMock.mockClear();
    stockSyncMock.mockResolvedValueOnce({ ok: true, changed: true });
    await setTikTokStockSyncAction({ enabled: true });
    expect(pushMock).toHaveBeenCalledTimes(1);
    stockSyncMock.mockResolvedValueOnce({ ok: true, changed: false });
    await setTikTokStockSyncAction({ enabled: true });
    stockSyncMock.mockResolvedValueOnce({ ok: true, changed: true });
    await setTikTokStockSyncAction({ enabled: false });
    expect(pushMock).toHaveBeenCalledTimes(1);
  });
});

describe("retryRefusedTikTokStockAction (docs/plans/tiktok-stock-sync.md S2)", () => {
  test("integrations.manage on the server; without it nothing is cleared", async () => {
    for (const keys of [[], ["stock.manage"]]) {
      getStaffSessionMock.mockResolvedValueOnce(sessionWith(keys));
      await expect(retryRefusedTikTokStockAction()).rejects.toThrow(/forbidden\(\)/);
    }
    expect(retryMock).not.toHaveBeenCalled();
  });

  test("clears as this staff user and pushes after the response only when something was cleared", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWith(["integrations.manage"]));
    pushMock.mockClear();
    retryMock.mockResolvedValueOnce({ ok: true, cleared: 2 });
    expect(await retryRefusedTikTokStockAction()).toEqual({ ok: true, data: { cleared: 2 } });
    expect(retryMock).toHaveBeenCalledWith(expect.anything(), { staffUserId: "staff-1" });
    expect(pushMock).toHaveBeenCalledTimes(1);
    retryMock.mockResolvedValueOnce({ ok: true, cleared: 0 });
    await retryRefusedTikTokStockAction();
    expect(pushMock).toHaveBeenCalledTimes(1);
    retryMock.mockResolvedValueOnce({ ok: false, reason: "not_connected" });
    expect(await retryRefusedTikTokStockAction()).toEqual({ ok: false, error: "Hubungkan TikTok Shop dulu." });
  });
});
