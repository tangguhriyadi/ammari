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
});
