import { describe, expect, test, vi } from "vitest";
import { shopeeRows, xlsxBytes } from "../../../../test/marketplace-fixtures";

const { getStaffSessionMock } = vi.hoisted(() => ({ getStaffSessionMock: vi.fn() }));
vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: getStaffSessionMock }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const { commitImportAction, previewImportAction, searchMatchVariantsAction } = await import("./actions");

// docs/plans/marketplace-import.md §12, test 44: every import action checks `orders.import` on the
// server, before reading the upload or touching the database. (The write path itself is covered
// against ammari_test in lib/marketplace-import/commit.test.ts; the money allowlist in
// preview-view.test.ts.) Nothing here reaches a database: refusals and input errors return first.

function sessionWithPermissions(permissionKeys: string[]) {
  return {
    staffUser: { id: "staff-1", name: "Test Staff", email: "staff@example.test", roleId: "role-1" },
    role: { id: "role-1", key: "test_role", name: "Test Role" },
    permissionKeys,
  };
}

function form(values: Record<string, string | File>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

const file = () => new File([xlsxBytes(shopeeRows([{ orderNo: "UJI123456", lines: [{ sku: "SKU-UJI", qty: 1, lineTotal: 1000 }] }])).slice()], "pesanan.xlsx");

describe("permissions (test 44)", () => {
  test("previewing, saving and the variant search need orders.import", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["orders.view", "orders.manage", "finance.view_profit"]));
    await expect(previewImportAction(form({ channel: "shopee", file: file() }))).rejects.toThrow();
    await expect(commitImportAction(form({ channel: "shopee", file: file(), digest: "a".repeat(64) }))).rejects.toThrow();
    await expect(searchMatchVariantsAction("gamis")).rejects.toThrow();
    getStaffSessionMock.mockReset();
  });

  test("without a session every action redirects to the login page", async () => {
    getStaffSessionMock.mockResolvedValue(null);
    await expect(previewImportAction(form({ channel: "shopee", file: file() }))).rejects.toThrow();
    await expect(commitImportAction(form({ channel: "shopee", file: file(), digest: "a".repeat(64) }))).rejects.toThrow();
    getStaffSessionMock.mockReset();
  });
});

describe("input refused before any read", () => {
  test("no channel, no file, an oversized file, broken matches, a bad digest", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["orders.import"]));
    expect(await previewImportAction(form({ file: file() }))).toEqual({ ok: false, error: "Pilih kanal." });
    expect(await previewImportAction(form({ channel: "lazada", file: file() }))).toEqual({ ok: false, error: "Pilih kanal." });
    expect(await previewImportAction(form({ channel: "shopee" }))).toEqual({ ok: false, error: "Pilih file export dulu." });
    const huge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "besar.xlsx");
    expect(await previewImportAction(form({ channel: "shopee", file: huge }))).toMatchObject({ ok: false, error: expect.stringContaining("File terlalu besar") });
    expect(await previewImportAction(form({ channel: "shopee", file: file(), skuOverrides: "{bukan json" }))).toMatchObject({ ok: false });
    expect(await previewImportAction(form({ channel: "shopee", file: file(), skuOverrides: JSON.stringify({ A: 5 }) }))).toMatchObject({ ok: false });
    expect(await commitImportAction(form({ channel: "shopee", file: file(), digest: "bukan-digest" }))).toMatchObject({ ok: false });
    getStaffSessionMock.mockReset();
  });

  test("TikTok Shop is refused with the Indonesian message until its export is mapped", async () => {
    getStaffSessionMock.mockResolvedValue(sessionWithPermissions(["orders.import"]));
    const result = await previewImportAction(form({ channel: "tiktok", file: file() }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Format export TikTok Shop belum dikonfirmasi") });
    const saved = await commitImportAction(form({ channel: "tiktok", file: file(), digest: "a".repeat(64) }));
    expect(saved).toMatchObject({ ok: false, error: expect.stringContaining("Format export TikTok Shop belum dikonfirmasi") });
    getStaffSessionMock.mockReset();
  });
});
