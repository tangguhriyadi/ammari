import { describe, expect, test } from "vitest";
import { NAV_ITEMS } from "./config";
import { filterNavByPermissions, getMobilePrimaryItems } from "./filter";

describe("filterNavByPermissions", () => {
  test("super_admin (every permission) sees every item", () => {
    const allKeys = NAV_ITEMS.flatMap((item) => item.permissionKeys);
    const result = filterNavByPermissions(NAV_ITEMS, allKeys);
    expect(result).toHaveLength(NAV_ITEMS.length);
  });

  test("owner (no roles.manage/staff.manage/audit_log.view) does not see Peran & Staf or Log Aktivitas", () => {
    const ownerKeys = [
      "overview.view",
      "orders.view",
      "orders.import",
      "packing.print_cards",
      "stock.view",
      "stock.adjust",
      "production.manage",
      "products.manage",
      "ads_expenses.manage",
      "finance.view_profit",
      "settings.manage",
      "customers.view",
      "vouchers.void",
    ] as const;
    const result = filterNavByPermissions(NAV_ITEMS, ownerKeys);
    const labels = result.map((item) => item.label);
    expect(labels).not.toContain("Peran & Staf");
    expect(labels).not.toContain("Log Aktivitas");
    expect(labels).toContain("Ringkasan");
    expect(labels).toContain("Iklan & Biaya");
  });

  test("an item gated by multiple keys shows up if the session has just one of them", () => {
    const result = filterNavByPermissions(NAV_ITEMS, ["roles.manage"]);
    expect(result.map((item) => item.label)).toEqual(["Peran & Staf"]);
  });

  test("no permissions means no items", () => {
    expect(filterNavByPermissions(NAV_ITEMS, [])).toEqual([]);
  });
});

describe("getMobilePrimaryItems", () => {
  test("returns the four designated primaries when all are permitted", () => {
    const filtered = filterNavByPermissions(NAV_ITEMS, [
      "overview.view",
      "orders.view",
      "packing.print_cards",
      "stock.view",
      "products.manage",
    ]);
    const primaries = getMobilePrimaryItems(filtered);
    expect(primaries.map((item) => item.label)).toEqual(["Ringkasan", "Pesanan", "Packing", "Stok"]);
  });

  test("pads from the rest of the permitted list when a designated primary is missing", () => {
    // Missing stock.view — only 3 of the 4 designated primaries are permitted.
    const filtered = filterNavByPermissions(NAV_ITEMS, [
      "overview.view",
      "orders.view",
      "packing.print_cards",
      "products.manage",
    ]);
    const primaries = getMobilePrimaryItems(filtered);
    expect(primaries).toHaveLength(4);
    expect(primaries.map((item) => item.label)).toEqual(["Ringkasan", "Pesanan", "Packing", "Produk"]);
  });

  test("returns fewer than four when fewer than four items are permitted at all", () => {
    const filtered = filterNavByPermissions(NAV_ITEMS, ["overview.view"]);
    const primaries = getMobilePrimaryItems(filtered);
    expect(primaries.map((item) => item.label)).toEqual(["Ringkasan"]);
  });
});
