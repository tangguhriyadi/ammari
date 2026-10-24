import { describe, expect, test } from "vitest";
import {
  parseSidebarCollapsed,
  serializeSidebarCookie,
  SIDEBAR_COOKIE_NAME,
  writeSidebarPreference,
} from "./sidebar-preference";

describe("sidebar preference", () => {
  test("only the exact collapsed value reads as collapsed", () => {
    expect(parseSidebarCollapsed("collapsed")).toBe(true);
    expect(parseSidebarCollapsed("expanded")).toBe(false);
    expect(parseSidebarCollapsed(undefined)).toBe(false);
    expect(parseSidebarCollapsed(null)).toBe(false);
    expect(parseSidebarCollapsed("")).toBe(false);
    expect(parseSidebarCollapsed("COLLAPSED")).toBe(false);
  });

  test("serializes a long-lived, site-wide, lax cookie", () => {
    const cookie = serializeSidebarCookie(true);
    expect(cookie).toContain(`${SIDEBAR_COOKIE_NAME}=collapsed`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toMatch(/Max-Age=\d{7,}/);
    expect(serializeSidebarCookie(false)).toContain(`${SIDEBAR_COOKIE_NAME}=expanded`);
  });

  test("write then read round-trips through the cookie value", () => {
    const target = { cookie: "" };
    writeSidebarPreference(true, target);
    const stored = target.cookie.split(";")[0]!.split("=")[1];
    expect(parseSidebarCollapsed(stored)).toBe(true);
    writeSidebarPreference(false, target);
    expect(parseSidebarCollapsed(target.cookie.split(";")[0]!.split("=")[1])).toBe(false);
  });
});
