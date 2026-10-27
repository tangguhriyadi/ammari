import { describe, expect, test } from "vitest";
import { NON_STAFF_ACTOR_FILTER, defaultRange, filterSearchParams, isDefaultFilters, parseActivityLogFilters, toQueryString } from "./filters";

const TODAY = "2026-10-27";
const STAFF_ID = "0b5f6d0e-2c1a-4c38-9d7e-1f2a3b4c5d6e";

describe("parseActivityLogFilters", () => {
  test("defaults to the last 7 Jakarta days, no other filter", () => {
    expect(defaultRange(TODAY)).toEqual({ from: "2026-10-21", to: "2026-10-27" });
    expect(parseActivityLogFilters({}, TODAY)).toEqual({ from: "2026-10-21", to: "2026-10-27" });
  });

  test("valid values are kept, combinable", () => {
    expect(parseActivityLogFilters({ from: "2026-09-01", to: "2026-09-30", actor: STAFF_ID.toUpperCase(), area: "payments", q: "  BYR-0001 " }, TODAY)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      actor: STAFF_ID,
      area: "payments",
      q: "BYR-0001",
    });
    expect(parseActivityLogFilters({ actor: NON_STAFF_ACTOR_FILTER }, TODAY).actor).toBe("system");
  });

  test("a reversed range is swapped, not rejected", () => {
    expect(parseActivityLogFilters({ from: "2026-10-10", to: "2026-10-01" }, TODAY)).toMatchObject({ from: "2026-10-01", to: "2026-10-10" });
  });

  test("invalid values fall back instead of failing", () => {
    expect(parseActivityLogFilters({ from: "2026-02-30", to: "kemarin", actor: "'; drop table", area: "toString", q: "   " }, TODAY)).toEqual({ from: "2026-10-21", to: "2026-10-27" });
  });

  test("a very long search is capped", () => {
    expect(parseActivityLogFilters({ q: "x".repeat(500) }, TODAY).q).toHaveLength(100);
  });
});

describe("URL round trip", () => {
  test("filterSearchParams + toQueryString keep every set filter and drop empty ones", () => {
    const filters = parseActivityLogFilters({ from: "2026-10-01", to: "2026-10-02", area: "orders", q: "ORD 1&2" }, TODAY);
    expect(toQueryString(filterSearchParams(filters))).toBe("?from=2026-10-01&to=2026-10-02&area=orders&q=ORD+1%262");
    expect(toQueryString({ a: undefined })).toBe("");
  });

  test("parsing the serialised filters gives the same filters back", () => {
    const filters = parseActivityLogFilters({ from: "2026-10-01", to: "2026-10-02", actor: STAFF_ID, area: "access", q: "Rina" }, TODAY);
    const params = new URLSearchParams(toQueryString(filterSearchParams(filters)));
    expect(parseActivityLogFilters(Object.fromEntries(params), TODAY)).toEqual(filters);
  });

  test("isDefaultFilters is true only for the untouched default view", () => {
    expect(isDefaultFilters(parseActivityLogFilters({}, TODAY), TODAY)).toBe(true);
    expect(isDefaultFilters(parseActivityLogFilters({ area: "stock" }, TODAY), TODAY)).toBe(false);
    expect(isDefaultFilters(parseActivityLogFilters({ from: "2026-10-01" }, TODAY), TODAY)).toBe(false);
  });
});
