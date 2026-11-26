import { describe, expect, test } from "vitest";
import { parseDateRange, parseJournalFilters, parseLedgerFilters, toSearchParams } from "./filters";

describe("accounting filters", () => {
  test("the default range is the current Jakarta month", () => {
    expect(parseDateRange({}, "2027-02-14")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });

  test("malformed dates fall back, a reversed range is swapped", () => {
    expect(parseDateRange({ from: "2027-02-30", to: "kemarin" }, "2027-01-10")).toEqual({ from: "2027-01-01", to: "2027-01-31" });
    expect(parseDateRange({ from: "2027-03-31", to: "2027-03-01" }, "2027-01-10")).toEqual({ from: "2027-03-01", to: "2027-03-31" });
  });

  test("journal filters accept only known sources, kinds and well-formed account codes", () => {
    expect(parseJournalFilters({ source: "business_expense", kind: "reversal", account: "6-2101" }, "2026-12-05")).toMatchObject({
      sourceType: "business_expense",
      kind: "reversal",
      accountCode: "6-2101",
    });
    expect(parseJournalFilters({ source: "order", kind: "edited", account: "6-21011'--" }, "2026-12-05")).toMatchObject({
      sourceType: null,
      kind: null,
      accountCode: null,
    });
  });

  test("ledger filters validate the supplier id and channel", () => {
    const supplier = "5F0C3E5A-1B2C-4D3E-8F9A-0B1C2D3E4F5A";
    expect(parseLedgerFilters({ account: "2-1101", supplier, channel: "shopee" }, "2026-12-05")).toMatchObject({
      accountCode: "2-1101",
      supplierId: supplier.toLowerCase(),
      channelId: "shopee",
    });
    expect(parseLedgerFilters({ supplier: "bukan-uuid", channel: "lazada" }, "2026-12-05")).toMatchObject({ supplierId: null, channelId: null });
    expect(parseLedgerFilters({ account: ["1-1201", "1-1101"] }, "2026-12-05").accountCode).toBe("1-1201");
  });

  test("toSearchParams drops empty values", () => {
    expect(toSearchParams({ from: "2026-12-01", source: null, kind: undefined, account: "" })).toEqual({ from: "2026-12-01" });
  });
});
