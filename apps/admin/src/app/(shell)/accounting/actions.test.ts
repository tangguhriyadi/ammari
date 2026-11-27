import { beforeEach, describe, expect, test, vi } from "vitest";

const { getStaffSessionMock, runPostingMock } = vi.hoisted(() => ({
  getStaffSessionMock: vi.fn(),
  runPostingMock: vi.fn(),
}));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
// The runner itself is covered against a real database (packages/accounting/test/runner.test.ts);
// here only the gate in front of it and the result shape.
vi.mock("@ammari/accounting/runner", () => ({ runPostingExclusive: runPostingMock }));
vi.mock("@/lib/admin-revalidate", () => ({ revalidateAdmin: vi.fn() }));

const { runPostingAction } = await import("./actions");

// docs/plans/accounting.md §7: running posting needs accounting.manage; the button lives on the
// accounting.view pages, so both are required.

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const RESULT = { runId: "run-1", insertedCount: 3, reversedCount: 1, unchangedCount: 5, issueCount: 2, failedCount: 0 };

describe("runPostingAction", () => {
  beforeEach(() => {
    runPostingMock.mockReset();
  });

  test("a view-only role cannot run posting", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["accounting.view"]));
    await expect(runPostingAction()).rejects.toThrow();
    expect(runPostingMock).not.toHaveBeenCalled();
  });

  test("accounting.manage alone, without accounting.view, is not enough", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["accounting.manage"]));
    await expect(runPostingAction()).rejects.toThrow();
    expect(runPostingMock).not.toHaveBeenCalled();
  });

  test("view + manage runs a manual posting run attributed to the staff member", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["accounting.view", "accounting.manage"]));
    runPostingMock.mockResolvedValue({ ran: true, result: RESULT, staleRunsClosed: 0 });
    expect(await runPostingAction()).toEqual({ ok: true, data: { insertedCount: 3, reversedCount: 1, issueCount: 2 } });
    expect(runPostingMock).toHaveBeenCalledWith(expect.anything(), { trigger: "manual", triggeredByStaffUserId: "staff-1" });
  });

  test("while another run holds the posting lock, the button says so and posts nothing", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["accounting.view", "accounting.manage"]));
    runPostingMock.mockResolvedValue({ ran: false });
    const result = await runPostingAction();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^Posting sedang berjalan/);
  });

  test("a failed run returns a plain Indonesian message, never the database error", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["accounting.view", "accounting.manage"]));
    runPostingMock.mockRejectedValue(new Error("relation does not exist"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runPostingAction()).toEqual({ ok: false, error: "Posting gagal. Coba lagi beberapa saat lagi." });
  });
});
