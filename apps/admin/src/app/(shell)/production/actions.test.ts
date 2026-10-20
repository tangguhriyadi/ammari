import { describe, expect, test, vi } from "vitest";

// Same mocking strategy as products/actions.test.ts — exercises the actual permission
// ENFORCEMENT (requirePermission/requireAllPermissions -> forbidden()) without needing a real
// request/cookie/DB session.
const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

// Mocked (not a real DB call) so the "what did the action pass through" tests below can assert
// on the exact extraCosts argument the action layer forwards, without needing a real
// batch/fabric fixture.
const { createDraftMock, updateDraftMock } = vi.hoisted(() => ({
  createDraftMock: vi.fn().mockResolvedValue({ id: "batch-1" }),
  updateDraftMock: vi.fn().mockResolvedValue({ id: "batch-1" }),
}));
vi.mock("@/lib/production/queries", () => ({
  createDraft: createDraftMock,
  updateDraft: updateDraftMock,
}));

const { postGoodsReceiptForBatchMock, closeBatchShortMock } = vi.hoisted(() => ({
  postGoodsReceiptForBatchMock: vi.fn().mockResolvedValue({ receipt: { receiptNo: "GR-202610-001" }, status: "partially_received" }),
  closeBatchShortMock: vi.fn().mockResolvedValue({ id: "batch-1" }),
}));
vi.mock("@/lib/receipts/production", () => ({
  postGoodsReceiptForBatch: postGoodsReceiptForBatchMock,
  closeBatchShort: closeBatchShortMock,
}));

// Receiving also refreshes the storefront (covered in ../storefront-revalidation.test.ts); mocked
// here so these tests never touch the database or the network for it.
vi.mock("@/lib/storefront-stock", () => ({
  revalidateStorefrontForSkus: vi.fn().mockResolvedValue({ ok: true }),
  skusForBatchLines: vi.fn().mockResolvedValue([]),
}));

const { createDraftAction, updateDraftAction, deleteDraftAction, postBatchAction, receiveBatchAction, closeBatchAction } = await import("./actions");

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

describe("extraCosts fallback is undefined-means-\"don't touch\", never []", () => {
  // Regression test for a bug caught by typescript-reviewer during Phase C: the action layer
  // previously coerced an omitted `extraCosts` key to `[]`, which syncExtraCostLines (queries.ts)
  // treats as "the submitted set is empty" and deletes every existing line — an omitted key must
  // stay `undefined` instead, leaving existing cost data untouched.
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
      extraCosts: [{ costComponentId: NIL_ID, unitPrice: "1000" }],
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

describe("extra cost line supplierId validation", () => {
  test("a non-uuid supplierId is rejected before reaching the query layer", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage", "finance.view_profit"]));
    updateDraftMock.mockClear();
    const result = await updateDraftAction(NIL_ID, {
      producedAt: "2026-10-01",
      fabricYards: "10",
      lines: [],
      extraCosts: [{ costComponentId: NIL_ID, unitPrice: "1000", supplierId: "bukan-uuid" }],
    });
    expect(result).toEqual({ ok: false, error: "Supplier tidak valid." });
    expect(updateDraftMock).not.toHaveBeenCalled();
  });

  test("null and omitted supplierId are both forwarded as-is", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage", "finance.view_profit"]));
    updateDraftMock.mockClear();
    await updateDraftAction(NIL_ID, {
      producedAt: "2026-10-01",
      fabricYards: "10",
      lines: [],
      extraCosts: [
        { costComponentId: NIL_ID, unitPrice: "1000", supplierId: null },
        { costComponentId: NIL_ID, unitPrice: "1000" },
      ],
    });
    const [, input] = updateDraftMock.mock.calls[0]!;
    expect(input.extraCosts[0].supplierId).toBeNull();
    expect(input.extraCosts[1].supplierId).toBeUndefined();
  });
});

describe("output receipt actions (S4): inventory.receive receives, inventory.manage short-closes", () => {
  const receiveInput = {
    batchId: NIL_ID,
    receivedAt: "2026-10-05",
    lines: [{ productionBatchItemId: NIL_ID, qtyAccepted: "2" }],
  };

  test("receiveBatchAction rejects a session without inventory.receive, even with production.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["production.manage", "inventory.manage"]));
    await expect(receiveBatchAction(receiveInput)).rejects.toThrow();
    expect(postGoodsReceiptForBatchMock).not.toHaveBeenCalled();
  });

  test("receiveBatchAction parses whole pcs, drops blank and zero lines' quantities to 0, and refuses fractions", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.receive"]));
    const result = await receiveBatchAction({
      ...receiveInput,
      lines: [
        { productionBatchItemId: NIL_ID, qtyAccepted: " 2 " },
        { productionBatchItemId: "11111111-1111-4111-8111-111111111111", qtyAccepted: "" },
      ],
    });
    expect(result).toEqual({ ok: true, data: { receiptNo: "GR-202610-001", storefrontOk: true } });
    expect(postGoodsReceiptForBatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ lines: [{ productionBatchItemId: NIL_ID, qtyAccepted: 2 }, { productionBatchItemId: "11111111-1111-4111-8111-111111111111", qtyAccepted: 0 }] }),
      "staff-1",
    );

    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.receive"]));
    const fractional = await receiveBatchAction({ ...receiveInput, lines: [{ productionBatchItemId: NIL_ID, qtyAccepted: "1.5" }] });
    expect(fractional).toEqual({ ok: false, error: "Jumlah diterima harus bilangan bulat." });
  });

  test("receiveBatchAction passes rejected pcs through (S5) and refuses fractional rejects", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.receive"]));
    await receiveBatchAction({ ...receiveInput, lines: [{ productionBatchItemId: NIL_ID, qtyAccepted: "0", qtyRejected: " 2 " }] });
    expect(postGoodsReceiptForBatchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ lines: [{ productionBatchItemId: NIL_ID, qtyAccepted: 0, qtyRejected: 2 }] }),
      "staff-1",
    );

    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.receive"]));
    const fractional = await receiveBatchAction({ ...receiveInput, lines: [{ productionBatchItemId: NIL_ID, qtyAccepted: "1", qtyRejected: "0.5" }] });
    expect(fractional).toEqual({ ok: false, error: "Jumlah ditolak harus bilangan bulat." });
  });

  test("closeBatchAction needs inventory.manage and a reason", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.receive", "production.manage"]));
    await expect(closeBatchAction({ batchId: NIL_ID, reason: "Tidak dilanjutkan" })).rejects.toThrow();
    expect(closeBatchShortMock).not.toHaveBeenCalled();

    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    expect(await closeBatchAction({ batchId: NIL_ID, reason: "   " })).toEqual({ ok: false, error: "Alasan wajib diisi." });

    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["inventory.manage"]));
    expect(await closeBatchAction({ batchId: NIL_ID, reason: "Tidak dilanjutkan" })).toEqual({ ok: true, data: undefined });
    expect(closeBatchShortMock).toHaveBeenCalledWith(NIL_ID, "Tidak dilanjutkan", "staff-1");
  });
});
