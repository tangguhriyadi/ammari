import { describe, expect, test } from "vitest";
import { resolvePagination } from "../src/lib/pagination";

describe("resolvePagination", () => {
  test("defaults to page 1 when rawPage is missing", () => {
    const result = resolvePagination({ rawPage: undefined, totalCount: 45, pageSize: 20 });
    expect(result).toMatchObject({ page: 1, totalPages: 3, offset: 0, limit: 20 });
  });

  test("computes offset for a middle page", () => {
    const result = resolvePagination({ rawPage: "2", totalCount: 45, pageSize: 20 });
    expect(result).toMatchObject({ page: 2, totalPages: 3, offset: 20, limit: 20 });
  });

  test("clamps a page beyond the last page to the last page", () => {
    const result = resolvePagination({ rawPage: "999", totalCount: 45, pageSize: 20 });
    expect(result.page).toBe(3);
  });

  test("clamps zero to page 1", () => {
    expect(resolvePagination({ rawPage: "0", totalCount: 45, pageSize: 20 }).page).toBe(1);
  });

  test("clamps a negative page to page 1", () => {
    expect(resolvePagination({ rawPage: "-5", totalCount: 45, pageSize: 20 }).page).toBe(1);
  });

  test("clamps non-numeric input to page 1", () => {
    expect(resolvePagination({ rawPage: "abc", totalCount: 45, pageSize: 20 }).page).toBe(1);
  });

  test("totalCount of 0 is 'page 1 of 1', not 'of 0'", () => {
    const result = resolvePagination({ rawPage: "1", totalCount: 0, pageSize: 20 });
    expect(result).toMatchObject({ page: 1, totalPages: 1, offset: 0 });
  });

  test("accepts a numeric rawPage directly", () => {
    expect(resolvePagination({ rawPage: 2, totalCount: 45, pageSize: 20 }).page).toBe(2);
  });

  test("a page that exactly fills the last page still computes correctly", () => {
    const result = resolvePagination({ rawPage: "2", totalCount: 40, pageSize: 20 });
    expect(result).toMatchObject({ page: 2, totalPages: 2, offset: 20 });
  });

  test("defaults pageSize to 20 when rawPerPage is missing", () => {
    expect(resolvePagination({ rawPage: undefined, totalCount: 45 }).pageSize).toBe(20);
  });

  test("accepts a whitelisted rawPerPage", () => {
    const result = resolvePagination({ rawPage: undefined, rawPerPage: "50", totalCount: 120 });
    expect(result).toMatchObject({ pageSize: 50, limit: 50, totalPages: 3 });
  });

  test("falls back to 20 when rawPerPage is outside the whitelist", () => {
    expect(resolvePagination({ rawPage: undefined, rawPerPage: "37", totalCount: 45 }).pageSize).toBe(20);
  });

  test("falls back to 20 when rawPerPage is non-numeric", () => {
    expect(resolvePagination({ rawPage: undefined, rawPerPage: "abc", totalCount: 45 }).pageSize).toBe(20);
  });

  test("recomputes totalPages and clamps page for the new pageSize", () => {
    const result = resolvePagination({ rawPage: "5", rawPerPage: "100", totalCount: 45 });
    expect(result).toMatchObject({ page: 1, totalPages: 1, pageSize: 100, offset: 0 });
  });
});
