import { describe, expect, test, vi } from "vitest";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
// The real module builds the Better Auth instance at import; these tests never reach a send.
vi.mock("@/lib/auth/staff", () => ({ staffEmailSender: { send: vi.fn() }, adminBaseUrl: "http://localhost:3001" }));
// Every mutation is a spy, so each test can prove the request stopped before reaching one (a
// bare `rejects.toThrow()` would also pass on a DB error from a call that got through).
const { mutationSpies } = vi.hoisted(() => ({
  mutationSpies: {
    inviteStaff: vi.fn(),
    renewStaffInvite: vi.fn(),
    updateStaffProfile: vi.fn(),
    changeStaffRole: vi.fn(),
    deactivateStaff: vi.fn(),
    reactivateStaff: vi.fn(),
    revokeStaffSessions: vi.fn(),
  },
}));
vi.mock("@/lib/staff/mutations", () => mutationSpies);

const {
  inviteStaffAction,
  renewStaffInviteAction,
  updateStaffProfileAction,
  changeStaffRoleAction,
  deactivateStaffAction,
  reactivateStaffAction,
  revokeStaffSessionsAction,
} = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const SOME_ID = "00000000-0000-4000-8000-000000000001";

// Every assertion is a REJECTION (403, redirect, or a validation result): none reaches a query,
// so the real defaultDb is never touched. Happy paths and guard rails are in
// lib/staff/mutations.test.ts. Same split as product-types/actions.test.ts.
describe("staff actions require staff.manage", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["inviteStaffAction", () => inviteStaffAction({ name: "Rina", email: "rina@example.test", roleId: SOME_ID })],
    ["renewStaffInviteAction", () => renewStaffInviteAction(SOME_ID)],
    ["updateStaffProfileAction", () => updateStaffProfileAction({ staffUserId: SOME_ID, name: "Rina", email: "rina@example.test" })],
    ["changeStaffRoleAction", () => changeStaffRoleAction({ staffUserId: SOME_ID, roleId: SOME_ID })],
    ["deactivateStaffAction", () => deactivateStaffAction(SOME_ID)],
    ["reactivateStaffAction", () => reactivateStaffAction(SOME_ID)],
    ["revokeStaffSessionsAction", () => revokeStaffSessionsAction(SOME_ID)],
  ];

  test.each(calls)("%s rejects a session without staff.manage (roles.manage alone is not enough)", async (_name, call) => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["roles.manage", "audit_log.view", "orders.manage"]));
    // Outside a Next server, forbidden() throws its "experimental, needs authInterrupts" error
    // rather than the 403 digest: still proof that requirePermission's forbidden() is what stopped it.
    await expect(call()).rejects.toThrow(/forbidden\(\)/);
    for (const spy of Object.values(mutationSpies)) expect(spy).not.toHaveBeenCalled();
  });

  test.each(calls)("%s redirects an unauthenticated caller", async (_name, call) => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(call()).rejects.toThrow(/NEXT_REDIRECT/);
    for (const spy of Object.values(mutationSpies)) expect(spy).not.toHaveBeenCalled();
  });
});

describe("staff action input validation", () => {
  test("invite: bad email, empty or control-character name, and a non-uuid role are field errors", async () => {
    const cases: [Parameters<typeof inviteStaffAction>[0], string][] = [
      [{ name: "Rina", email: "rina @example.test", roleId: SOME_ID }, "email"],
      [{ name: "Rina", email: "bukan-email", roleId: SOME_ID }, "email"],
      [{ name: "  ", email: "rina@example.test", roleId: SOME_ID }, "name"],
      [{ name: "Rina\nSubject: x", email: "rina@example.test", roleId: SOME_ID }, "name"],
      [{ name: "Rina\u202Eabc", email: "rina@example.test", roleId: SOME_ID }, "name"],
      [{ name: "Rina\u2028x", email: "rina@example.test", roleId: SOME_ID }, "name"],
      [{ name: "Rina", email: "rina@example.test", roleId: "role-1" }, "roleId"],
    ];
    for (const [input, field] of cases) {
      getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["staff.manage"]));
      const result = await inviteStaffAction(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fieldErrors).toHaveProperty(field);
    }
  });

  test("a non-uuid staff id is refused before any query", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["staff.manage"]));
    const result = await deactivateStaffAction("'; drop table staff_users; --");
    expect(result).toEqual({ ok: false, error: "Staf tidak ditemukan." });
    expect(mutationSpies.deactivateStaff).not.toHaveBeenCalled();
  });
});
