import { describe, expect, test } from "vitest";
import { NAV_ITEMS } from "../nav/config";
import { filterNavByPermissions } from "../nav/filter";
import { visibleIntegrationTabs } from "./tabs";

describe("visibleIntegrationTabs", () => {
  test("each permission shows only its own tab, TikTok Shop first", () => {
    expect(visibleIntegrationTabs(["orders.import", "integrations.manage"]).map((tab) => tab.label)).toEqual(["TikTok Shop", "Shopee"]);
    expect(visibleIntegrationTabs(["integrations.manage"]).map((tab) => tab.label)).toEqual(["TikTok Shop"]);
    expect(visibleIntegrationTabs(["orders.import"]).map((tab) => tab.label)).toEqual(["Shopee"]);
    expect(visibleIntegrationTabs(["settings.manage"])).toEqual([]);
  });

  test("the Integrasi menu item shows exactly when at least one tab is visible", () => {
    for (const key of ["integrations.manage", "orders.import"] as const) {
      expect(filterNavByPermissions(NAV_ITEMS, [key]).map((item) => item.label)).toContain("Integrasi");
    }
    expect(filterNavByPermissions(NAV_ITEMS, ["settings.manage"]).map((item) => item.label)).not.toContain("Integrasi");
  });
});
