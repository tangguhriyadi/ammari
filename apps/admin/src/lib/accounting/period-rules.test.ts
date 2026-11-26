import { describe, expect, test } from "vitest";
import { closeDeadlineOf, monthLabel, periodCloseRefusal, periodMonthsToShow, periodReopenRefusal, PERIOD_MESSAGES } from "./period-rules";

// Month close rules (docs/plans/accounting.md §7, D-22, D-23, Session 4).

describe("periodCloseRefusal", () => {
  test("the trial month December 2026 is never closable (D-22)", () => {
    expect(periodCloseRefusal("2026-12-01", "2027-06-01", new Set())).toBe(PERIOD_MESSAGES.trialMonth);
  });

  test("a month before the books, a malformed month, an already closed month", () => {
    expect(periodCloseRefusal("2026-11-01", "2027-06-01", new Set())).toBe(PERIOD_MESSAGES.beforeBooks);
    expect(periodCloseRefusal("2027-01-15", "2027-06-01", new Set())).toBe(PERIOD_MESSAGES.invalidMonth);
    expect(periodCloseRefusal("2027-01-01", "2027-06-01", new Set(["2027-01-01"]))).toBe(PERIOD_MESSAGES.alreadyClosed);
  });

  test("only after the month has ended (Jakarta day)", () => {
    expect(periodCloseRefusal("2027-01-01", "2027-01-31", new Set())).toBe(PERIOD_MESSAGES.notEnded);
    expect(periodCloseRefusal("2027-01-01", "2027-02-01", new Set())).toBeNull();
  });

  test("official months close in order: February waits for January", () => {
    expect(periodCloseRefusal("2027-02-01", "2027-03-05", new Set())).toBe(PERIOD_MESSAGES.earlierOpen("Januari 2027"));
    expect(periodCloseRefusal("2027-02-01", "2027-03-05", new Set(["2027-01-01"]))).toBeNull();
    // The trial month never needs closing first.
    expect(periodCloseRefusal("2027-01-01", "2027-03-05", new Set())).toBeNull();
  });
});

describe("deadline and listing", () => {
  test("the close target is the 10th of the next month (D-23), across a year end", () => {
    expect(closeDeadlineOf("2027-01-01")).toBe("2027-02-10");
    expect(closeDeadlineOf("2027-12-01")).toBe("2028-01-10");
  });

  test("months listed from the trial month through the current month, and at least through January 2027", () => {
    expect(periodMonthsToShow("2026-11-26")).toEqual(["2026-12-01", "2027-01-01"]);
    expect(periodMonthsToShow("2027-03-04")).toEqual(["2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01"]);
    expect(monthLabel("2027-02-01")).toBe("Februari 2027");
  });
});

describe("periodReopenRefusal", () => {
  test("only a closed month, and the newest closed month first", () => {
    expect(periodReopenRefusal("2027-01-01", new Set())).toBe(PERIOD_MESSAGES.notClosed);
    expect(periodReopenRefusal("2027-01-01", new Set(["2027-01-01", "2027-02-01", "2027-03-01"]))).toBe(PERIOD_MESSAGES.laterClosed("Maret 2027"));
    expect(periodReopenRefusal("2027-03-01", new Set(["2027-01-01", "2027-02-01", "2027-03-01"]))).toBeNull();
  });
});
