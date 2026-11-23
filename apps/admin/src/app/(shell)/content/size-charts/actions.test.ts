import { beforeEach, describe, expect, test, vi } from "vitest";

// Same mocking strategy as products/actions.test.ts — exercises requirePermission's actual
// enforcement without a real session/DB.
const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));

// Storefront revalidation is a network call to apps/web; the DB writes are covered by
// lib/content/size-charts.test.ts. Both are mocked so the wiring test below asserts only the
// action's own behaviour. Other tests keep the real query module (they never reach the DB).
const m = vi.hoisted(() => ({
  revalidateProductSlugs: vi.fn(),
  updateSizeChart: vi.fn(),
  listProductSlugsUsingSizeChart: vi.fn(),
}));
vi.mock("@/lib/revalidate", () => ({ revalidateProductSlugs: m.revalidateProductSlugs }));
vi.mock("@/lib/content/size-charts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/content/size-charts")>()),
  updateSizeChart: m.updateSizeChart,
  listProductSlugsUsingSizeChart: m.listProductSlugsUsingSizeChart,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const { createSizeChartAction, updateSizeChartAction, deleteSizeChartAction } = await import("./actions");

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

const VALID_ROWS = [
  { size: "XS", bustCm: 90, lengthCm: 130, sleeveLengthCm: 55, heightRecommendationMinCm: 150, heightRecommendationMaxCm: 160 },
  { size: "S", bustCm: 92, lengthCm: 131, sleeveLengthCm: 56, heightRecommendationMinCm: 151, heightRecommendationMaxCm: 161 },
  { size: "M", bustCm: 94, lengthCm: 132, sleeveLengthCm: 57, heightRecommendationMinCm: 152, heightRecommendationMaxCm: 162 },
  { size: "L", bustCm: 96, lengthCm: 133, sleeveLengthCm: 58, heightRecommendationMinCm: 153, heightRecommendationMaxCm: 163 },
  { size: "XL", bustCm: 98, lengthCm: 134, sleeveLengthCm: 59, heightRecommendationMinCm: 154, heightRecommendationMaxCm: 164 },
] as const;

describe("size chart actions require content.manage, NOT products.manage", () => {
  test("createSizeChartAction rejects a session with no permissions", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(createSizeChartAction({ name: "Gamis Reguler", rows: [...VALID_ROWS] })).rejects.toThrow();
  });

  // products.manage is a DIFFERENT permission from content.manage on purpose (docs/plans/
  // storefront-cms.md) — someone who can edit products/variants must not automatically be able
  // to manage storefront-facing size charts.
  test("createSizeChartAction rejects a session holding products.manage but NOT content.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["products.manage"]));
    await expect(createSizeChartAction({ name: "Gamis Reguler", rows: [...VALID_ROWS] })).rejects.toThrow();
  });

  test("updateSizeChartAction rejects a session without content.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(
      updateSizeChartAction("00000000-0000-0000-0000-000000000000", { name: "Gamis Reguler", rows: [...VALID_ROWS] }),
    ).rejects.toThrow();
  });

  test("deleteSizeChartAction rejects a session without content.manage", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions([]));
    await expect(deleteSizeChartAction({ id: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow();
  });

  test("an unauthenticated session (null) redirects rather than proceeding", async () => {
    getStaffSessionMock.mockResolvedValueOnce(null);
    await expect(createSizeChartAction({ name: "Gamis Reguler", rows: [...VALID_ROWS] })).rejects.toThrow();
  });
});

describe("size chart action validation (shape only — never reaches the DB)", () => {
  test("rejects a submission with fewer than 5 rows", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await createSizeChartAction({ name: "Gamis Reguler", rows: VALID_ROWS.slice(0, 3) });
    expect(result.ok).toBe(false);
  });

  test("rejects a blank name", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await createSizeChartAction({ name: "  ", rows: [...VALID_ROWS] });
    expect(result.ok).toBe(false);
  });

  test("rejects a non-positive measurement", async () => {
    getStaffSessionMock.mockResolvedValueOnce(sessionWithPermissions(["content.manage"]));
    const result = await createSizeChartAction({
      name: "Gamis Reguler",
      rows: [{ ...VALID_ROWS[0], bustCm: 0 }, ...VALID_ROWS.slice(1)],
    });
    expect(result.ok).toBe(false);
  });
});

describe("updateSizeChartAction revalidates the storefront", () => {
  const CHART_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["content.manage"]));
    m.updateSizeChart.mockResolvedValue({ id: CHART_ID, name: "Gamis Reguler", rows: [...VALID_ROWS] });
    m.listProductSlugsUsingSizeChart.mockResolvedValue(["haura", "zahra", "alesha"]);
  });

  test("requests revalidation of every product page using the saved chart", async () => {
    m.revalidateProductSlugs.mockResolvedValue({ ok: true });
    const result = await updateSizeChartAction(CHART_ID, { name: "Gamis Reguler", rows: [...VALID_ROWS] });

    expect(result).toEqual({ ok: true, data: { id: CHART_ID, revalidationOk: true } });
    expect(m.listProductSlugsUsingSizeChart).toHaveBeenCalledWith(CHART_ID);
    expect(m.revalidateProductSlugs).toHaveBeenCalledTimes(1);
    expect(m.revalidateProductSlugs).toHaveBeenCalledWith(["haura", "zahra", "alesha"]);
    // Only after the write has committed.
    expect(m.updateSizeChart.mock.invocationCallOrder[0]).toBeLessThan(m.revalidateProductSlugs.mock.invocationCallOrder[0]!);
  });

  test("a storefront that cannot be reached still saves, and says so", async () => {
    m.revalidateProductSlugs.mockResolvedValue({ ok: false });
    const result = await updateSizeChartAction(CHART_ID, { name: "Gamis Reguler", rows: [...VALID_ROWS] });
    expect(result).toEqual({ ok: true, data: { id: CHART_ID, revalidationOk: false } });
  });

  test("a failed save requests no revalidation", async () => {
    m.updateSizeChart.mockRejectedValue(new Error("boom"));
    await updateSizeChartAction(CHART_ID, { name: "Gamis Reguler", rows: [...VALID_ROWS] }).catch(() => undefined);
    expect(m.revalidateProductSlugs).not.toHaveBeenCalled();
  });
});
