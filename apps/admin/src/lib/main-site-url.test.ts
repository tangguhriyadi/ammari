import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getMainSiteUrl, getMainSiteHost, __resetMainSiteUrlForTests } from "./main-site-url";

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.MAIN_SITE_URL;
  __resetMainSiteUrlForTests();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MAIN_SITE_URL;
  else process.env.MAIN_SITE_URL = savedEnv;
  __resetMainSiteUrlForTests();
  vi.unstubAllEnvs();
});

describe("getMainSiteUrl / getMainSiteHost", () => {
  test("throws when unset", () => {
    delete process.env.MAIN_SITE_URL;
    expect(() => getMainSiteUrl()).toThrow(/MAIN_SITE_URL is not set/);
  });

  test("throws on a non-URL value", () => {
    process.env.MAIN_SITE_URL = "not a url";
    expect(() => getMainSiteUrl()).toThrow(/is not a valid absolute URL/);
  });

  test("throws on a trailing slash", () => {
    process.env.MAIN_SITE_URL = "https://ammari.id/";
    expect(() => getMainSiteUrl()).toThrow(/must not have a trailing slash/);
  });

  test("throws on http in production", () => {
    process.env.MAIN_SITE_URL = "http://ammari.id";
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getMainSiteUrl()).toThrow(/must use https when NODE_ENV=production/);
  });

  test("accepts https in production", () => {
    process.env.MAIN_SITE_URL = "https://ammari.id";
    vi.stubEnv("NODE_ENV", "production");
    expect(getMainSiteUrl()).toBe("https://ammari.id");
  });

  test("accepts http outside production (local dev)", () => {
    process.env.MAIN_SITE_URL = "http://localhost:3000";
    vi.stubEnv("NODE_ENV", "test");
    expect(getMainSiteUrl()).toBe("http://localhost:3000");
    expect(getMainSiteHost()).toBe("localhost:3000");
  });

  test("getMainSiteHost strips the protocol but keeps the port", () => {
    process.env.MAIN_SITE_URL = "https://ammari.my.id";
    expect(getMainSiteHost()).toBe("ammari.my.id");
  });

  test("caches across calls instead of re-validating every time", () => {
    process.env.MAIN_SITE_URL = "https://ammari.id";
    expect(getMainSiteUrl()).toBe(getMainSiteUrl());
    process.env.MAIN_SITE_URL = "https://changed.example"; // ignored — already cached
    expect(getMainSiteUrl()).toBe("https://ammari.id");
  });
});
