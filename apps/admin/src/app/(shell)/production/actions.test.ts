import { describe, expect, test, vi } from "vitest";

// Same mocking strategy as products/actions.test.ts — exercises the actual permission
// ENFORCEMENT (requirePermission/requireAllPermissions -> forbidden()) without needing a real
// request/cookie/DB session.
const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

// Mocked (not a real DB call) so the "what did the action pass through" tests below can assert
// on the exact costs/extraCosts arguments the action layer forwards, without needing a real
// batch/fabric fixture.
const { createDraftMock, updateDraftMock } = vi.hoisted(() => ({
  createDraftMock: vi.fn().mockResolvedValue({ id: "batch-1" }),
  updateDraftMock: vi.fn().mockResolvedValue({ id: "batch-1" }),
}));
vi.mock("@/lib/production/queries", () => ({
  createDraft: createDraftMock,
  updateDraft: updateDraftMock,
}));

const { createDraftAction, updateDraftAction, deleteDraftAction, postBatchAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const NIL_ID = "00000000-0000-0000-0000-000000000000";

describe("production batch actions require production.manage", () => {
  test("createDraftAction rejects a session without production.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["orders.view"]));
    await expect(
      createDraftAction({ fabricId: NIL_ID, producedAt: "2026-10-01", fabricYards: "1", lines: [] }),
    ).rejects.toThrow();
  });

  test("updateDraftAction rejects a session without production.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(updateDraftAction(NIL_ID, { producedAt: "2026-10-01", fabricYards: "1", lines: [] })).rejects.toThrow();
  });

  test("deleteDraftAction rejects a session without production.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(deleteDraftAction({ id: NIL_ID })).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(
      createDraftAction({ fabricId: NIL_ID, producedAt: "2026-10-01", fabricYards: "1", lines: [] }),
    ).rejects.toThrow();
  });
});

describe("extraCosts fallback matches costs' own undefined-means-\"don't touch\" contract", () => {
  // Regression test for a bug caught by typescript-reviewer during Phase C: the action layer
  // previously coerced an omitted `extraCosts` key to `[]`, which syncExtraCostLines (queries.ts)
  // treats as "the submitted set is empty" and deletes every existing line — unlike `costs`,
  // where an omitted key correctly stays `undefined` and leaves existing cost data untouched.
  test("updateDraftAction forwards extraCosts as undefined (not []) when the payload omits it, even with finance.view_profit", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage", "finance.view_profit"]));
    await updateDraftAction(NIL_ID, { producedAt: "2026-10-01", fabricYards: "1", lines: [] });
    expect(updateDraftMock).toHaveBeenCalledWith(
      NIL_ID,
      expect.objectContaining({ extraCosts: undefined }),
      "staff-1",
    );
  });

  test("createDraftAction forwards extraCosts as undefined (not []) when the payload omits it, even with finance.view_profit", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage", "finance.view_profit"]));
    await createDraftAction({ fabricId: NIL_ID, producedAt: "2026-10-01", fabricYards: "1", lines: [] });
    expect(createDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({ extraCosts: undefined }),
      "staff-1",
    );
  });

  test("updateDraftAction strips a submitted extraCosts array to undefined without finance.view_profit", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage"]));
    await updateDraftAction(NIL_ID, {
      producedAt: "2026-10-01",
      fabricYards: "1",
      lines: [],
      extraCosts: [{ costComponentId: NIL_ID, quantity: "1", unitPrice: "1000" }],
    });
    expect(updateDraftMock).toHaveBeenCalledWith(
      NIL_ID,
      expect.objectContaining({ extraCosts: undefined }),
      "staff-1",
    );
  });
});

describe("postBatchAction requires BOTH production.manage AND finance.view_profit", () => {
  test("rejects a session with production.manage but WITHOUT finance.view_profit", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage"]));
    await expect(postBatchAction({ id: NIL_ID })).rejects.toThrow();
  });

  test("rejects a session with finance.view_profit but WITHOUT production.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["finance.view_profit"]));
    await expect(postBatchAction({ id: NIL_ID })).rejects.toThrow();
  });

  test("rejects a session with neither permission", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(postBatchAction({ id: NIL_ID })).rejects.toThrow();
  });
});
