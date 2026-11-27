import { beforeEach, describe, expect, test, vi } from "vitest";

// The route wiring: the staff session comes from the server (never the request), and a request
// without integrations.manage gets 403 before the handler reads anything. The full flow is in
// src/lib/integrations/tiktok.test.ts.

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

const { GET } = await import("./route");

function request(): Request {
  return new Request("https://admin.test/api/integrations/tiktok/callback?code=ROW_code&state=" + "A".repeat(43));
}

beforeEach(() => getStaffSessionMock.mockReset());

describe("GET /api/integrations/tiktok/callback", () => {
  test("no staff session (a customer session cookie is not a staff session) → 403", async () => {
    getStaffSessionMock.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("ROW_code");
  });

  test("staff without integrations.manage → 403", async () => {
    getStaffSessionMock.mockResolvedValue({ staffUser: { id: "00000000-0000-0000-0000-000000000001" }, permissionKeys: ["settings.manage", "orders.view"] });
    expect((await GET(request())).status).toBe(403);
  });
});
