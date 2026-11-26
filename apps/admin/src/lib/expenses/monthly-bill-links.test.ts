import { describe, expect, test } from "vitest";
import { DEFAULT_EXPENSE_CATEGORY_INFOS } from "@/lib/expense-categories/default-catalog";
import { monthlyBillLinks } from "./monthly-bill-links";

// The "Biaya bulanan belum dicatat" reminder links (expense-master-data.md §3.8, S6 follow-up):
// one link per menu holding a missing category.

const window = { month: "2031-02", from: "2031-02-06", to: "2031-03-05" };
const categories = [...DEFAULT_EXPENSE_CATEGORY_INFOS, { code: "langganan", kind: "operating" as const }, { code: "iklan_google", kind: "ad" as const }];

describe("monthlyBillLinks", () => {
  test("nothing missing: the plain Biaya menu", () => {
    expect(monthlyBillLinks(null, categories)).toEqual([{ group: "operational", label: "Catat di Biaya", href: "/expenses" }]);
  });

  test("only operating bills missing: one Biaya link on the 6th-to-5th window", () => {
    expect(monthlyBillLinks({ ...window, missing: ["salary", "langganan"] }, categories)).toEqual([
      { group: "operational", label: "Catat di Biaya", href: "/expenses?from=2031-02-06&to=2031-03-05" },
    ]);
  });

  test("only ad bills missing: one Iklan link", () => {
    expect(monthlyBillLinks({ ...window, missing: ["iklan_google", "endorsement"] }, categories)).toEqual([
      { group: "marketing", label: "Catat di Iklan", href: "/ads?from=2031-02-06&to=2031-03-05" },
    ]);
  });

  test("bills missing in both menus: Biaya first, then Iklan", () => {
    expect(monthlyBillLinks({ ...window, missing: ["iklan_google", "rent"] }, categories)).toEqual([
      { group: "operational", label: "Catat di Biaya", href: "/expenses?from=2031-02-06&to=2031-03-05" },
      { group: "marketing", label: "Catat di Iklan", href: "/ads?from=2031-02-06&to=2031-03-05" },
    ]);
  });

  test("a code the catalog no longer knows counts as Biaya", () => {
    expect(monthlyBillLinks({ ...window, missing: ["gone"] }, categories).map((link) => link.group)).toEqual(["operational"]);
  });
});
