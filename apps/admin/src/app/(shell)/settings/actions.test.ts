import { beforeEach, describe, expect, test, vi } from "vitest";

const { getStaffSessionMock, saveSalesGoalMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn(), saveSalesGoalMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
// The write itself (and its audit row) is covered against the database in sales-goal.test.ts.
vi.mock("@/lib/settings/sales-goal", () => ({ saveSalesGoal: saveSalesGoalMock }));

const { saveSalesGoalAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const VALID = { revenueTarget: "1.000.000.000", startDate: "2026-11-01" };

beforeEach(() => {
  saveSalesGoalMock.mockReset();
  vi.useRealTimers();
});

describe("saveSalesGoalAction requires settings.manage", () => {
  test("refuses finance.view_profit or content.manage without settings.manage", async () => {
    for (const keys of [["finance.view_profit", "overview.view"], ["content.manage"]]) {
      getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(keys));
      // It reached next/navigation's forbidden(), not some other error. Outside a Next build that
      // call throws its own "experimental" error (authInterrupts is set in next.config.ts only).
      await expect(saveSalesGoalAction(VALID)).rejects.toThrow(/forbidden\(\)/);
    }
    expect(saveSalesGoalMock).not.toHaveBeenCalled();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(saveSalesGoalAction(VALID)).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
    expect(saveSalesGoalMock).not.toHaveBeenCalled();
  });
});

describe("saveSalesGoalAction", () => {
  test("saves the parsed amount and date as the signed-in staff member", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-24T01:00:00Z"), toFake: ["Date"] });
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["settings.manage"]));
    const result = await saveSalesGoalAction({ revenueTarget: "Rp 1.250.000.000", startDate: "2026-11-01" });
    expect(result).toEqual({ ok: true, data: undefined });
    expect(saveSalesGoalMock).toHaveBeenCalledWith({ revenueTargetAmount: 1_250_000_000, startDate: "2026-11-01" }, "staff-1");
  });

  test("returns Indonesian field errors and never writes", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-24T01:00:00Z"), toFake: ["Date"] });
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["settings.manage"]));
    const result = await saveSalesGoalAction({ revenueTarget: "0", startDate: "2028-01-01" });
    expect(result).toEqual({
      ok: false,
      error: "Target harus antara Rp 1 dan Rp 100.000.000.000.",
      fieldErrors: {
        revenueTarget: "Target harus antara Rp 1 dan Rp 100.000.000.000.",
        startDate: "Tanggal mulai paling lambat 1 tahun dari hari ini.",
      },
    });
    expect(saveSalesGoalMock).not.toHaveBeenCalled();
  });

  test("today is the Jakarta date: at 00:30 WIB on 25 Oct (still 24 Oct in UTC), 25 Oct next year is allowed", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-24T17:30:00Z"), toFake: ["Date"] });
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["settings.manage"]));
    const result = await saveSalesGoalAction({ revenueTarget: "1000", startDate: "2027-10-25" });
    expect(result.ok).toBe(true);
  });
});
