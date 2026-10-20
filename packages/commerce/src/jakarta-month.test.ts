import { describe, expect, test } from "vitest";
import { jakartaYearMonth } from "./jakarta-month";

describe("jakartaYearMonth", () => {
  test("formats a plain UTC date within the same Jakarta day", () => {
    expect(jakartaYearMonth(new Date("2026-10-15T03:00:00Z"))).toBe("202610");
  });

  test("a UTC timestamp that is still October in UTC but already November WIB rolls over", () => {
    // 2026-10-31T17:30:00Z = 2026-11-01T00:30:00+07:00 (WIB is UTC+7, no DST).
    expect(jakartaYearMonth(new Date("2026-10-31T17:30:00Z"))).toBe("202611");
  });

  test("a UTC timestamp just before the WIB rollover stays in the earlier month", () => {
    // 2026-10-31T16:59:59Z = 2026-10-31T23:59:59+07:00 — still October in WIB.
    expect(jakartaYearMonth(new Date("2026-10-31T16:59:59Z"))).toBe("202610");
  });
});
