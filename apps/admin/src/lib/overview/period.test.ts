import { describe, expect, test } from "vitest";
import { DEFAULT_OVERVIEW_PERIOD, resolvePeriod } from "./period";

// docs/plans/dashboard-overview.md §3.1 (D5: default Kemarin). Jakarta is UTC+7, so 08:00 WIB on
// 24 Oct 2026 is 01:00Z, and 06:59 WIB on 1 Nov is still 31 Oct 23:59Z.

const iso = (date: Date) => date.toISOString();
const at = (value: string) => new Date(value);

describe("resolvePeriod", () => {
  const morning = at("2026-10-24T01:00:00Z"); // Sat 24 Oct 2026, 08:00 WIB

  test("defaults to Kemarin: the whole previous Jakarta day, compared with the day before", () => {
    expect(DEFAULT_OVERVIEW_PERIOD).toBe("yesterday");
    const resolved = resolvePeriod({}, morning);
    expect(resolved.period).toBe("yesterday");
    expect([resolved.fromDate, resolved.toDate]).toEqual(["2026-10-23", "2026-10-23"]);
    expect(iso(resolved.current.start)).toBe("2026-10-22T17:00:00.000Z");
    expect(iso(resolved.current.end)).toBe("2026-10-23T17:00:00.000Z");
    expect(iso(resolved.previous.start)).toBe("2026-10-21T17:00:00.000Z");
    expect(iso(resolved.previous.end)).toBe("2026-10-22T17:00:00.000Z");
    expect([resolved.previousFromDate, resolved.previousToDate]).toEqual(["2026-10-22", "2026-10-22"]);
  });

  test("Hari ini runs to now and compares with yesterday up to the same time", () => {
    const resolved = resolvePeriod({ period: "today" }, morning);
    expect([resolved.fromDate, resolved.toDate]).toEqual(["2026-10-24", "2026-10-24"]);
    expect(iso(resolved.current.start)).toBe("2026-10-23T17:00:00.000Z");
    expect(iso(resolved.current.end)).toBe("2026-10-24T01:00:00.000Z");
    expect(iso(resolved.previous.start)).toBe("2026-10-22T17:00:00.000Z");
    expect(iso(resolved.previous.end)).toBe("2026-10-23T01:00:00.000Z");
  });

  test("the Jakarta day, not the UTC day, decides 'today' just after midnight WIB", () => {
    const resolved = resolvePeriod({ period: "today" }, at("2026-10-31T17:30:00Z")); // 00:30 WIB 1 Nov
    expect(resolved.fromDate).toBe("2026-11-01");
    expect(iso(resolved.current.start)).toBe("2026-10-31T17:00:00.000Z");
  });

  test("7 hari is today and the 6 days before, compared with the 7 days before that", () => {
    const resolved = resolvePeriod({ period: "7d" }, morning);
    expect([resolved.fromDate, resolved.toDate]).toEqual(["2026-10-18", "2026-10-24"]);
    expect(iso(resolved.current.start)).toBe("2026-10-17T17:00:00.000Z");
    expect(iso(resolved.current.end)).toBe("2026-10-24T01:00:00.000Z");
    expect(iso(resolved.previous.start)).toBe("2026-10-10T17:00:00.000Z");
    expect(iso(resolved.previous.end)).toBe("2026-10-17T01:00:00.000Z");
  });

  test("Bulan ini compares with the same stretch of last month", () => {
    const resolved = resolvePeriod({ period: "month" }, morning);
    expect([resolved.fromDate, resolved.toDate]).toEqual(["2026-10-01", "2026-10-24"]);
    expect(iso(resolved.current.start)).toBe("2026-09-30T17:00:00.000Z");
    expect(iso(resolved.previous.start)).toBe("2026-08-31T17:00:00.000Z");
    expect(iso(resolved.previous.end)).toBe("2026-09-24T01:00:00.000Z"); // 24 Sep 08:00 WIB
    expect([resolved.previousFromDate, resolved.previousToDate]).toEqual(["2026-09-01", "2026-09-24"]);
  });

  test("Bulan ini on 31 March stops the comparison at the end of February", () => {
    const resolved = resolvePeriod({ period: "month" }, at("2027-03-31T05:00:00Z"));
    expect(iso(resolved.previous.start)).toBe("2027-01-31T17:00:00.000Z"); // 1 Feb 00:00 WIB
    expect(iso(resolved.previous.end)).toBe("2027-02-28T17:00:00.000Z"); // 1 Mar 00:00 WIB
  });

  test("Pilih tanggal covers whole Jakarta days and compares with as many days right before", () => {
    const resolved = resolvePeriod({ period: "custom", from: "2026-10-01", to: "2026-10-10" }, morning);
    expect(resolved.period).toBe("custom");
    expect(iso(resolved.current.start)).toBe("2026-09-30T17:00:00.000Z");
    expect(iso(resolved.current.end)).toBe("2026-10-10T17:00:00.000Z");
    expect(iso(resolved.previous.start)).toBe("2026-09-20T17:00:00.000Z");
    expect(iso(resolved.previous.end)).toBe("2026-09-30T17:00:00.000Z");
  });

  test("a custom range ending today stops at now, and its comparison at the same time", () => {
    const resolved = resolvePeriod({ period: "custom", from: "2026-10-23", to: "2026-10-24" }, morning);
    expect(iso(resolved.current.end)).toBe("2026-10-24T01:00:00.000Z");
    expect(iso(resolved.previous.start)).toBe("2026-10-20T17:00:00.000Z");
    expect(iso(resolved.previous.end)).toBe("2026-10-22T01:00:00.000Z");
  });

  test("an invalid period or custom range falls back to the default instead of throwing", () => {
    for (const params of [
      { period: "kemarin" },
      { period: "custom" },
      { period: "custom", from: "2026-10-10", to: "2026-10-01" }, // from after to
      { period: "custom", from: "2026-10-01", to: "2026-10-25" }, // to after today
      { period: "custom", from: "2025-10-01", to: "2026-10-02" }, // more than 366 days
      { period: "custom", from: "2026-02-30", to: "2026-03-02" }, // not a date
    ]) {
      expect(resolvePeriod(params, morning).period).toBe("yesterday");
    }
    // 367 days is one too many; exactly 366 days is allowed.
    expect(resolvePeriod({ period: "custom", from: "2025-10-23", to: "2026-10-24" }, morning).period).toBe("yesterday");
    expect(resolvePeriod({ period: "custom", from: "2025-10-24", to: "2026-10-24" }, morning).period).toBe("custom");
  });
});
