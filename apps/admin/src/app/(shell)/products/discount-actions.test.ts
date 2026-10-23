import { beforeEach, describe, expect, test, vi } from "vitest";

// The discount actions' own behaviour: permission, input parsing (WIB datetimes, Rp text, the
// percent never accepted), and that a save revalidates the storefront page. The DB write and its
// rules are covered against a real test db in lib/products/discount-queries.test.ts.
const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
vi.mock("@/lib/admin-revalidate", () => ({ revalidateAdmin: vi.fn() }));

const m = vi.hoisted(() => ({ updateProductDiscount: vi.fn(), revalidateProductSlug: vi.fn() }));
vi.mock("@/lib/products/discount-queries", () => ({
  updateProductDiscount: m.updateProductDiscount,
  CLEARED_DISCOUNT: { discountPriceAmount: null, discountEnabled: false, discountStartsAt: null, discountEndsAt: null },
}));
vi.mock("@/lib/revalidate", () => ({ revalidateProductSlug: m.revalidateProductSlug }));

const { updateProductDiscountAction, clearProductDiscountAction } = await import("./actions");
const { FieldError } = await import("@/lib/products/errors");

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const VALID = { discountPrice: "279.000", discountEnabled: true, discountStartsAt: "2026-11-01T00:00", discountEndsAt: "" };

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["products.manage"]));
  m.updateProductDiscount.mockResolvedValue({ id: PRODUCT_ID, slug: "contoh-gamis" });
  m.revalidateProductSlug.mockResolvedValue({ ok: true });
});

describe("permission: products.manage, same as editing the base price", () => {
  test("updateProductDiscountAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["content.manage", "orders.manage"]));
    await expect(updateProductDiscountAction(PRODUCT_ID, VALID)).rejects.toThrow();
    expect(m.updateProductDiscount).not.toHaveBeenCalled();
  });

  test("clearProductDiscountAction rejects a session without products.manage", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions([]));
    await expect(clearProductDiscountAction(PRODUCT_ID)).rejects.toThrow();
    expect(m.updateProductDiscount).not.toHaveBeenCalled();
  });

  test("an unauthenticated session is rejected", async () => {
    getStaffSessionMock.mockResolvedValue(null);
    await expect(updateProductDiscountAction(PRODUCT_ID, VALID)).rejects.toThrow();
  });
});

describe("updateProductDiscountAction", () => {
  test("converts WIB datetimes to UTC, parses the Rp price, saves as the staff user, and revalidates the product page", async () => {
    const result = await updateProductDiscountAction(PRODUCT_ID, { ...VALID, discountEndsAt: "2026-12-01T10:30" });
    expect(result).toEqual({ ok: true, data: { revalidationOk: true } });
    expect(m.updateProductDiscount).toHaveBeenCalledWith(
      PRODUCT_ID,
      {
        discountPriceAmount: 279_000,
        discountEnabled: true,
        discountStartsAt: new Date("2026-10-31T17:00:00Z"),
        discountEndsAt: new Date("2026-12-01T03:30:00Z"),
      },
      "staff-1",
    );
    expect(m.revalidateProductSlug).toHaveBeenCalledWith("contoh-gamis");
  });

  test("empty price and dates are saved as null", async () => {
    await updateProductDiscountAction(PRODUCT_ID, { discountPrice: "", discountEnabled: false, discountStartsAt: "", discountEndsAt: "" });
    expect(m.updateProductDiscount).toHaveBeenCalledWith(
      PRODUCT_ID,
      { discountPriceAmount: null, discountEnabled: false, discountStartsAt: null, discountEndsAt: null },
      "staff-1",
    );
  });

  test("a percent in the request is ignored: only the Rp price is saved", async () => {
    await updateProductDiscountAction(PRODUCT_ID, { ...VALID, discountPercent: "50" } as typeof VALID);
    expect(m.updateProductDiscount.mock.calls[0]?.[1]).toMatchObject({ discountPriceAmount: 279_000 });
    expect(m.updateProductDiscount.mock.calls[0]?.[1]).not.toHaveProperty("discountPercent");
  });

  test.each([
    [{ discountPrice: "279,5" }, "discountPriceAmount", "Format harga tidak valid."],
    [{ discountStartsAt: "2026-02-30T10:00" }, "discountStartsAt", "Format tanggal dan jam tidak valid."],
    [{ discountEndsAt: "besok" }, "discountEndsAt", "Format tanggal dan jam tidak valid."],
  ])("rejects malformed input %o on %s before touching the DB", async (patch, field, message) => {
    const result = await updateProductDiscountAction(PRODUCT_ID, { ...VALID, ...patch });
    expect(result).toEqual({ ok: false, error: message, fieldErrors: { [field]: message } });
    expect(m.updateProductDiscount).not.toHaveBeenCalled();
  });

  test("a rule broken on the server comes back as a field error, not a throw", async () => {
    m.updateProductDiscount.mockRejectedValue(new FieldError("discountPriceAmount", "Diskon minimal 1%."));
    const result = await updateProductDiscountAction(PRODUCT_ID, VALID);
    expect(result).toEqual({ ok: false, error: "Diskon minimal 1%.", fieldErrors: { discountPriceAmount: "Diskon minimal 1%." } });
    expect(m.revalidateProductSlug).not.toHaveBeenCalled();
  });

  test("a storefront that cannot be reached still saves, and says so", async () => {
    m.revalidateProductSlug.mockResolvedValue({ ok: false });
    expect(await updateProductDiscountAction(PRODUCT_ID, VALID)).toEqual({ ok: true, data: { revalidationOk: false } });
  });

  test("a product id that is not a UUID is refused", async () => {
    expect(await updateProductDiscountAction("not-a-uuid", VALID)).toMatchObject({ ok: false });
    expect(m.updateProductDiscount).not.toHaveBeenCalled();
  });
});

test("clearProductDiscountAction saves the cleared discount and revalidates", async () => {
  expect(await clearProductDiscountAction(PRODUCT_ID)).toEqual({ ok: true, data: { revalidationOk: true } });
  expect(m.updateProductDiscount).toHaveBeenCalledWith(
    PRODUCT_ID,
    { discountPriceAmount: null, discountEnabled: false, discountStartsAt: null, discountEndsAt: null },
    "staff-1",
  );
  expect(m.revalidateProductSlug).toHaveBeenCalledWith("contoh-gamis");
});
