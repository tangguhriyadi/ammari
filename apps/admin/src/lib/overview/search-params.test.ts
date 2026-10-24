import { describe, expect, test } from "vitest";
import { chartParamsFromSearch, overviewHref } from "./search-params";

describe("chartParamsFromSearch", () => {
  test("defaults to omzet and pieces; unknown or repeated values fall back", () => {
    expect(chartParamsFromSearch({}, true)).toEqual({ metric: "omzet", top: "pcs" });
    expect(chartParamsFromSearch({ metric: "orders", top: "omzet" }, true)).toEqual({ metric: "orders", top: "omzet" });
    expect(chartParamsFromSearch({ metric: "laba", top: ["omzet", "pcs"] }, true)).toEqual({ metric: "omzet", top: "omzet" });
  });

  test("without finance.view_profit it is always orders and pieces, whatever the URL asks", () => {
    expect(chartParamsFromSearch({ metric: "omzet", top: "omzet" }, false)).toEqual({ metric: "orders", top: "pcs" });
  });
});

describe("overviewHref", () => {
  test("keeps the period and the other switch, leaves defaults out", () => {
    expect(overviewHref({}, { metric: "omzet", top: "pcs" })).toBe("/");
    expect(overviewHref({ period: "7d" }, { metric: "orders", top: "pcs" }, "overview-sales-chart")).toBe("/?period=7d&metric=orders#overview-sales-chart");
    expect(overviewHref({ period: "custom", from: "2026-10-01", to: "2026-10-05" }, { metric: "omzet", top: "omzet" })).toBe(
      "/?period=custom&from=2026-10-01&to=2026-10-05&top=omzet",
    );
  });

  test("from and to only travel with a custom period", () => {
    expect(overviewHref({ period: "today", from: "2026-10-01", to: "2026-10-05" }, { metric: "omzet", top: "pcs" })).toBe("/?period=today");
  });
});
