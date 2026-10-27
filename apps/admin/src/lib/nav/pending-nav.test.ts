import { describe, expect, test } from "vitest";
import { isNavItemActive } from "./is-active";
import { isPlainLeftClick, resolveNavPath, syncNavPending, type NavPendingState } from "./pending-nav";

const plainClick = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };

describe("resolveNavPath", () => {
  test("no pending click: the real pathname", () => {
    expect(resolveNavPath("/orders", null)).toBe("/orders");
  });

  test("a click from the current page highlights its target right away", () => {
    expect(resolveNavPath("/orders", { href: "/stock", from: "/orders" })).toBe("/stock");
  });

  test("once the pathname moves, the pending click no longer applies", () => {
    // Landed on the target.
    expect(resolveNavPath("/stock", { href: "/stock", from: "/orders" })).toBe("/stock");
    // Went somewhere else (e.g. a later click, or a redirect).
    expect(resolveNavPath("/packing", { href: "/stock", from: "/orders" })).toBe("/packing");
  });

  test("exactly one item is active while a click is pending, even from a sub-page", () => {
    const path = resolveNavPath("/orders/123", { href: "/content/size-charts", from: "/orders/123" });
    expect(isNavItemActive(path, "/content/size-charts")).toBe(true);
    expect(isNavItemActive(path, "/content")).toBe(false);
    expect(isNavItemActive(path, "/orders")).toBe(false);
  });
});

describe("syncNavPending", () => {
  test("same pathname: the very same state, so the provider sets nothing", () => {
    const state: NavPendingState = { pathname: "/orders", pending: { href: "/stock", from: "/orders" } };
    expect(syncNavPending(state, "/orders")).toBe(state);
  });

  test("a pathname change ends the pending click", () => {
    const state: NavPendingState = { pathname: "/orders", pending: { href: "/stock", from: "/orders" } };
    expect(syncNavPending(state, "/stock")).toEqual({ pathname: "/stock", pending: null });
  });

  test("landing, then returning to the page the click came from, does not revive it", () => {
    let state: NavPendingState = { pathname: "/orders", pending: { href: "/packing", from: "/orders" } };
    state = syncNavPending(state, "/packing"); // landed
    state = syncNavPending(state, "/orders"); // breadcrumb / browser back
    expect(state.pending).toBeNull();
    expect(resolveNavPath("/orders", state.pending)).toBe("/orders");
    expect(isNavItemActive(resolveNavPath("/orders", state.pending), "/packing")).toBe(false);
  });
});

describe("isPlainLeftClick", () => {
  test("a plain primary click navigates in place", () => {
    expect(isPlainLeftClick(plainClick)).toBe(true);
  });

  test.each([
    ["middle button", { button: 1 }],
    ["cmd", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["already handled", { defaultPrevented: true }],
  ])("%s does not", (_label, override) => {
    expect(isPlainLeftClick({ ...plainClick, ...override })).toBe(false);
  });
});
