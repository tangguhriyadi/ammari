import { describe, expect, test } from "vitest";
import { voucherExpiresAt } from "./dates";

describe("voucherExpiresAt", () => {
  test("adds 3 calendar months, end of day Jakarta, when the target month has that day", () => {
    const claimedAt = new Date("2026-01-15T12:00:00+07:00");
    expect(voucherExpiresAt(claimedAt).toISOString()).toBe("2026-04-15T16:59:59.000Z");
  });

  test("clamps to the last day of the target month when the source day doesn't exist there", () => {
    // 31 Jan + 3 months -> April has only 30 days.
    const claimedAt = new Date("2026-01-31T12:00:00+07:00");
    expect(voucherExpiresAt(claimedAt).toISOString()).toBe("2026-04-30T16:59:59.000Z");
  });

  test("wraps across a year boundary", () => {
    // 30 Nov 2026 + 3 months -> 28 Feb 2027 (not a leap year), clamped from 30.
    const claimedAt = new Date("2026-11-30T12:00:00+07:00");
    expect(voucherExpiresAt(claimedAt).toISOString()).toBe("2027-02-28T16:59:59.000Z");
  });

  test("31 Dec + 3 months lands on 31 Mar without needing to clamp", () => {
    const claimedAt = new Date("2026-12-31T12:00:00+07:00");
    expect(voucherExpiresAt(claimedAt).toISOString()).toBe("2027-03-31T16:59:59.000Z");
  });
});
