import { describe, expect, test } from "vitest";
import { addCalendarDays, addCalendarYears, calendarDaysBetween, isCalendarDate, jakartaDate, jakartaMidnight } from "./jakarta-day";

describe("jakartaDate", () => {
  test("is the Asia/Jakarta calendar date, which runs 7 hours ahead of UTC", () => {
    expect(jakartaDate(new Date("2026-10-31T16:59:59.999Z"))).toBe("2026-10-31");
    expect(jakartaDate(new Date("2026-10-31T17:00:00Z"))).toBe("2026-11-01");
    expect(jakartaDate(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
});

describe("jakartaMidnight", () => {
  test("is 00:00 WIB of that date as a UTC instant", () => {
    expect(jakartaMidnight("2026-11-01").toISOString()).toBe("2026-10-31T17:00:00.000Z");
    expect(jakartaMidnight("2027-01-01").toISOString()).toBe("2026-12-31T17:00:00.000Z");
    expect(jakartaDate(jakartaMidnight("2028-02-29"))).toBe("2028-02-29");
  });

  test("refuses anything that is not a real calendar date", () => {
    expect(() => jakartaMidnight("2026-02-30")).toThrow();
    expect(() => jakartaMidnight("2026-11-1")).toThrow();
  });
});

describe("calendar arithmetic", () => {
  test("adds days across month, year and leap-day boundaries", () => {
    expect(addCalendarDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addCalendarDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addCalendarDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  test("adds years; a 29 February start lands on 1 March in a non-leap year", () => {
    expect(addCalendarYears("2026-11-01", 1)).toBe("2027-11-01");
    expect(addCalendarYears("2028-02-29", 1)).toBe("2029-03-01");
  });

  test("counts whole days from one date to another", () => {
    expect(calendarDaysBetween("2026-11-01", "2026-11-01")).toBe(0);
    expect(calendarDaysBetween("2026-11-01", "2027-11-01")).toBe(365);
    expect(calendarDaysBetween("2027-11-01", "2028-11-01")).toBe(366);
    expect(calendarDaysBetween("2026-11-02", "2026-11-01")).toBe(-1);
  });

  test("isCalendarDate accepts only real YYYY-MM-DD dates", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-1-01")).toBe(false);
    expect(isCalendarDate("kemarin")).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
  });
});
