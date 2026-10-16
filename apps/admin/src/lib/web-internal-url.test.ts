import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getWebInternalUrl, __resetWebInternalUrlForTests } from "./web-internal-url";

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.WEB_INTERNAL_URL;
  __resetWebInternalUrlForTests();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.WEB_INTERNAL_URL;
  else process.env.WEB_INTERNAL_URL = savedEnv;
  __resetWebInternalUrlForTests();
});

describe("getWebInternalUrl", () => {
  test("throws when unset", () => {
    delete process.env.WEB_INTERNAL_URL;
    expect(() => getWebInternalUrl()).toThrow(/WEB_INTERNAL_URL is not set/);
  });

  test("throws on a non-URL value", () => {
    process.env.WEB_INTERNAL_URL = "not a url";
    expect(() => getWebInternalUrl()).toThrow(/is not a valid absolute URL/);
  });

  test("throws on a trailing slash", () => {
    process.env.WEB_INTERNAL_URL = "http://web:3000/";
    expect(() => getWebInternalUrl()).toThrow(/must not have a trailing slash/);
  });

  test("accepts a plain http internal URL (never required to be https)", () => {
    process.env.WEB_INTERNAL_URL = "http://web:3000";
    expect(getWebInternalUrl()).toBe("http://web:3000");
  });

  test("caches across calls instead of re-validating every time", () => {
    process.env.WEB_INTERNAL_URL = "http://web:3000";
    expect(getWebInternalUrl()).toBe(getWebInternalUrl());
    process.env.WEB_INTERNAL_URL = "http://changed:3000"; // ignored — already cached
    expect(getWebInternalUrl()).toBe("http://web:3000");
  });
});
