import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PermissionKey } from "@ammari/db/rbac";

// "Unduh kontak promo" (docs/plans/growth.md §10, session S6): refused without customers.view +
// customers.export or without the dialog's tick, before anything is read or audited.

const getStaffSession = vi.fn();
const listPromoContacts = vi.fn();
const recordPromoContactExport = vi.fn();

vi.mock("@/lib/auth/staff-session", () => ({ getStaffSession: () => getStaffSession() }));
vi.mock("@/lib/customers/promo-export", () => ({
  listPromoContacts: (...args: unknown[]) => listPromoContacts(...args),
  recordPromoContactExport: (...args: unknown[]) => recordPromoContactExport(...args),
}));

const { GET } = await import("./route");

function session(permissionKeys: PermissionKey[]) {
  return { staffUser: { id: "staff-1" }, role: { id: "r", key: "owner", name: "Owner" }, permissionKeys };
}

const get = (query = "?ack=1") => GET(new Request(`http://localhost:3001/customers/promo-export${query}`));

beforeEach(() => {
  getStaffSession.mockReset();
  listPromoContacts.mockReset().mockResolvedValue([
    { name: "=HYPERLINK(\"x\")", email: "a@example.test", phone: "+6281234567890", promoConsentAt: new Date("2026-10-27T03:15:00Z") },
    { name: "Bu Rina, Bandung", email: "b@example.test", phone: null, promoConsentAt: new Date("2026-10-01T00:00:00Z") },
  ]);
  recordPromoContactExport.mockReset().mockResolvedValue(undefined);
});

describe("GET /customers/promo-export", () => {
  test("401 without a session; 403 for CS (customers.view only) and Keuangan; nothing read or audited", async () => {
    getStaffSession.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    getStaffSession.mockResolvedValue(session(["customers.view", "customers.manage"]));
    expect((await get()).status).toBe(403);
    getStaffSession.mockResolvedValue(session(["finance.view_profit", "ads_expenses.manage"]));
    expect((await get()).status).toBe(403);
    getStaffSession.mockResolvedValue(session(["customers.export"]));
    expect((await get()).status).toBe(403);
    expect(listPromoContacts).not.toHaveBeenCalled();
    expect(recordPromoContactExport).not.toHaveBeenCalled();
  });

  test("400 without the tick", async () => {
    getStaffSession.mockResolvedValue(session(["customers.view", "customers.export"]));
    expect((await get("")).status).toBe(400);
    expect((await get("?ack=0")).status).toBe(400);
    expect(listPromoContacts).not.toHaveBeenCalled();
  });

  test("a formula-safe CSV of the four columns, never cached, audited with the count", async () => {
    getStaffSession.mockResolvedValue(session(["customers.view", "customers.export"]));
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="kontak-promo-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(recordPromoContactExport).toHaveBeenCalledWith("staff-1", 2);
    const lines = (await response.text()).replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[0]).toBe("Nama,Email,Nomor HP,Setuju promo sejak (WIB)");
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"")",a@example.test,6281234567890,"27 Okt 2026, 10.15"`);
    expect(lines[2]).toBe(`"Bu Rina, Bandung",b@example.test,,"1 Okt 2026, 07.00"`);
    expect(lines).toHaveLength(3);
  });
});
