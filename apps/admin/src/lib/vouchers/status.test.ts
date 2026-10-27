import { describe, expect, test } from "vitest";
import { EXPIRING_SOON_DAYS, VOUCHER_STATUS_LABELS, effectiveVoucherStatus } from "./status";

// docs/plans/growth.md §9.1 (session S1). The stored status alone is never trusted: an ordinary
// voucher that ran out still says `active` (only a cancelled order's restore writes `expired`).

const NOW = new Date("2026-10-27T05:00:00Z"); // 12:00 WIB
const DAY = 86_400_000;

describe("effectiveVoucherStatus", () => {
  test("used and void win whatever the date", () => {
    expect(effectiveVoucherStatus({ status: "used", expiresAt: new Date(NOW.getTime() - DAY) }, NOW)).toEqual({ status: "used", expiringSoon: false });
    expect(effectiveVoucherStatus({ status: "void", expiresAt: new Date(NOW.getTime() + 60 * DAY) }, NOW)).toEqual({ status: "void", expiringSoon: false });
  });

  test("stored expired, or active past its expiry, is expired", () => {
    expect(effectiveVoucherStatus({ status: "expired", expiresAt: new Date(NOW.getTime() - DAY) }, NOW).status).toBe("expired");
    expect(effectiveVoucherStatus({ status: "active", expiresAt: new Date(NOW.getTime() - 1) }, NOW).status).toBe("expired");
    // Exactly at the expiry instant it is no longer usable (checkout requires expires_at > now()).
    expect(effectiveVoucherStatus({ status: "active", expiresAt: NOW }, NOW).status).toBe("expired");
  });

  test("active before its expiry is active, and 'segera berakhir' within 14 days", () => {
    expect(EXPIRING_SOON_DAYS).toBe(14);
    expect(effectiveVoucherStatus({ status: "active", expiresAt: new Date(NOW.getTime() + 30 * DAY) }, NOW)).toEqual({ status: "active", expiringSoon: false });
    expect(effectiveVoucherStatus({ status: "active", expiresAt: new Date(NOW.getTime() + 14 * DAY) }, NOW)).toEqual({ status: "active", expiringSoon: true });
    expect(effectiveVoucherStatus({ status: "active", expiresAt: new Date(NOW.getTime() + 14 * DAY + 1) }, NOW)).toEqual({ status: "active", expiringSoon: false });
    expect(effectiveVoucherStatus({ status: "active", expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toEqual({ status: "active", expiringSoon: true });
  });

  test("every effective status has an Indonesian label", () => {
    expect(VOUCHER_STATUS_LABELS).toEqual({ active: "Aktif", used: "Terpakai", expired: "Kedaluwarsa", void: "Dibatalkan" });
  });
});
