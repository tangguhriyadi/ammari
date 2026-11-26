import { describe, expect, test } from "vitest";
import { bookSegmentOf, crossesCutover, OFFICIAL_BOOKS_START, resolveReportRange, segmentStartOf, TRIAL_BOOKS_START } from "../src/books";

// How the December 2026 trial month and the official books coexist (D-22, Session 4): two separate
// sets of books, so a balance is never summed across the cut-over.

describe("book segments", () => {
  test("before the trial month, the trial month, the official books", () => {
    expect(bookSegmentOf("2026-11-30")).toBe("before");
    expect(bookSegmentOf(TRIAL_BOOKS_START)).toBe("trial");
    expect(bookSegmentOf("2026-12-31")).toBe("trial");
    expect(bookSegmentOf(OFFICIAL_BOOKS_START)).toBe("official");
    expect(bookSegmentOf("2031-06-15")).toBe("official");
  });

  test("balances are summed from the segment's first day", () => {
    expect(segmentStartOf("2026-12-17")).toBe("2026-12-01");
    expect(segmentStartOf("2027-03-17")).toBe("2027-01-01");
  });

  test("a void dated across the cut-over from its original crosses it; within one segment it does not", () => {
    expect(crossesCutover("2026-12-20", "2027-01-02")).toBe(true);
    expect(crossesCutover("2026-12-20", "2026-12-31")).toBe(false);
    expect(crossesCutover("2027-01-01", "2027-02-02")).toBe(false);
  });
});

describe("resolveReportRange", () => {
  test("a 2027 range opens at the cut-over, never at the trial month, so December never reaches a 2027 opening balance", () => {
    expect(resolveReportRange({ from: "2027-02-01", to: "2027-02-28" })).toEqual({ from: "2027-02-01", to: "2027-02-28", segmentStart: "2027-01-01", segment: "official", adjusted: false });
  });

  test("a range crossing the cut-over starts at the cut-over (December is reported on its own)", () => {
    expect(resolveReportRange({ from: "2026-12-15", to: "2027-01-31" })).toEqual({ from: "2027-01-01", to: "2027-01-31", segmentStart: "2027-01-01", segment: "official", adjusted: true });
  });

  test("a trial-month range sums from 1 Dec 2026; a range reaching back before it starts there", () => {
    expect(resolveReportRange({ from: "2026-12-10", to: "2026-12-31" })).toMatchObject({ from: "2026-12-10", segmentStart: "2026-12-01", segment: "trial", adjusted: false });
    expect(resolveReportRange({ from: "2026-11-01", to: "2026-12-31" })).toMatchObject({ from: "2026-12-01", segmentStart: "2026-12-01", segment: "trial", adjusted: true });
  });

  test("a range wholly before the books has no segment start of its own and is left as is", () => {
    expect(resolveReportRange({ from: "2026-10-01", to: "2026-10-31" })).toMatchObject({ from: "2026-10-01", to: "2026-10-31", segment: "before", adjusted: false });
  });
});
