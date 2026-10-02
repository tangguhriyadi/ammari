import { describe, expect, test } from "vitest";
import { isNavItemActive } from "./is-active";

describe("isNavItemActive", () => {
  test("/ matches only the exact home path", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/produk", "/")).toBe(false);
    expect(isNavItemActive("/pesanan", "/")).toBe(false);
  });

  test("an item matches its own exact path", () => {
    expect(isNavItemActive("/produk", "/produk")).toBe(true);
  });

  test("an item matches its own sub-routes", () => {
    expect(isNavItemActive("/produk/baru", "/produk")).toBe(true);
    expect(isNavItemActive("/produk/123e4567-e89b-12d3-a456-426614174000", "/produk")).toBe(true);
  });

  test("an item does not match an unrelated route, even with a shared prefix", () => {
    expect(isNavItemActive("/bahan", "/produk")).toBe(false);
    expect(isNavItemActive("/bahan/baru", "/produk")).toBe(false);
  });

  test("an item does not match a different item that merely starts with the same string", () => {
    // "/produk" is not a prefix-match for "/produksi" per this function's string-boundary check
    // (requires the next character to be "/"), so Produk must not light up on /produksi.
    expect(isNavItemActive("/produksi", "/produk")).toBe(false);
  });

  test("Bahan matches its own sub-routes but not Produk's", () => {
    expect(isNavItemActive("/bahan", "/bahan")).toBe(true);
    expect(isNavItemActive("/bahan/baru", "/bahan")).toBe(true);
    expect(isNavItemActive("/produk", "/bahan")).toBe(false);
  });
});
