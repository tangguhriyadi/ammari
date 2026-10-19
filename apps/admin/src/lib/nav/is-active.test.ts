import { describe, expect, test } from "vitest";
import { isNavItemActive } from "./is-active";

describe("isNavItemActive", () => {
  test("/ matches only the exact home path", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/products", "/")).toBe(false);
    expect(isNavItemActive("/orders", "/")).toBe(false);
  });

  test("an item matches its own exact path", () => {
    expect(isNavItemActive("/products", "/products")).toBe(true);
  });

  test("an item matches its own sub-routes", () => {
    expect(isNavItemActive("/products/new", "/products")).toBe(true);
    expect(isNavItemActive("/products/123e4567-e89b-12d3-a456-426614174000", "/products")).toBe(true);
  });

  test("an item does not match an unrelated route, even with a shared prefix", () => {
    expect(isNavItemActive("/fabrics", "/products")).toBe(false);
    expect(isNavItemActive("/fabrics/new", "/products")).toBe(false);
  });

  test("an item does not match a different item that merely starts with the same string", () => {
    // Synthetic prefix pair ("/foobar" vs "/foo") — none of the current real nav paths literally
    // prefix another one, but the matcher's string-boundary check (requires the next character to
    // be "/", not just any shared prefix) still needs covering.
    expect(isNavItemActive("/foobar", "/foo")).toBe(false);
  });

  test("Fabrics matches its own sub-routes but not Products'", () => {
    expect(isNavItemActive("/fabrics", "/fabrics")).toBe(true);
    expect(isNavItemActive("/fabrics/new", "/fabrics")).toBe(true);
    expect(isNavItemActive("/products", "/fabrics")).toBe(false);
  });

  describe("longest match wins among sibling items (real NAV_ITEMS)", () => {
    // Regression for the Konten group: "/content" (Beranda) is a prefix of every other
    // /content/* item, so a plain prefix check kept Beranda highlighted everywhere in the
    // group. Only the most specific (longest) matching item should ever be active.
    test("a /content sub-page activates only its own item, not Beranda", () => {
      expect(isNavItemActive("/content/size-charts", "/content/size-charts")).toBe(true);
      expect(isNavItemActive("/content/size-charts", "/content")).toBe(false);

      expect(isNavItemActive("/content/pages", "/content/pages")).toBe(true);
      expect(isNavItemActive("/content/pages", "/content")).toBe(false);

      expect(isNavItemActive("/content/settings", "/content/settings")).toBe(true);
      expect(isNavItemActive("/content/settings", "/content")).toBe(false);
    });

    test("Beranda is active only on the exact /content page", () => {
      expect(isNavItemActive("/content", "/content")).toBe(true);
    });

    test("a nested create page keeps its section active, not Beranda", () => {
      expect(isNavItemActive("/content/size-charts/new", "/content/size-charts")).toBe(true);
      expect(isNavItemActive("/content/size-charts/new", "/content")).toBe(false);
    });

    test("a nested dynamic detail page keeps its section's parent active, not Beranda", () => {
      // /content/pages/[slug] — the dynamic info-page editor route.
      expect(isNavItemActive("/content/pages/pengembalian", "/content/pages")).toBe(true);
      expect(isNavItemActive("/content/pages/pengembalian", "/content")).toBe(false);
    });

    test("other groups' nested pages still activate their own top-level item", () => {
      expect(isNavItemActive("/products/new", "/products")).toBe(true);
      expect(isNavItemActive("/products/123e4567-e89b-12d3-a456-426614174000", "/products")).toBe(true);
    });
  });

  describe("longest match wins among sibling items (custom item sets)", () => {
    // A synthetic set isolates the "longest wins" rule itself from whatever NAV_ITEMS happens
    // to contain, so this keeps covering the rule even if the real nav config changes shape.
    const items = [{ href: "/a" }, { href: "/a/b" }, { href: "/a/b/c" }];

    test("the deepest matching item wins, and shallower siblings lose", () => {
      expect(isNavItemActive("/a/b/c/d", "/a/b/c", items)).toBe(true);
      expect(isNavItemActive("/a/b/c/d", "/a/b", items)).toBe(false);
      expect(isNavItemActive("/a/b/c/d", "/a", items)).toBe(false);
    });

    test("exactly one item is active at each nesting depth", () => {
      expect(isNavItemActive("/a/b", "/a/b", items)).toBe(true);
      expect(isNavItemActive("/a/b", "/a", items)).toBe(false);

      expect(isNavItemActive("/a", "/a", items)).toBe(true);
    });
  });
});
