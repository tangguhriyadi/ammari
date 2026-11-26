import { describe, expect, test } from "vitest";
import { GET } from "./route";

// docs/plans/expense-master-data.md §3.8: the old report URL is a 308 to /expenses/report with the
// query string unchanged; the target does the permission check.

describe("GET /ads-expenses/report", () => {
  test("308 to /expenses/report, query unchanged, relative Location", () => {
    const response = GET(new Request("http://internal:3001/ads-expenses/report?format=xlsx&period=month&month=2026-02"));
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("/expenses/report?format=xlsx&period=month&month=2026-02");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("without a query", () => {
    expect(GET(new Request("http://internal:3001/ads-expenses/report")).headers.get("Location")).toBe("/expenses/report");
  });
});
