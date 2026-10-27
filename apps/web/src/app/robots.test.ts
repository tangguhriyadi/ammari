import { afterEach, describe, expect, test } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  const saved = { deployEnv: process.env.DEPLOY_ENV, origin: process.env.BETTER_AUTH_URL };
  afterEach(() => {
    process.env.DEPLOY_ENV = saved.deployEnv;
    process.env.BETTER_AUTH_URL = saved.origin;
  });

  test("production allows the site, disallows /api/ and points at the sitemap", () => {
    process.env.DEPLOY_ENV = "production";
    process.env.BETTER_AUTH_URL = "https://ammari.id/";
    expect(robots()).toEqual({ rules: { userAgent: "*", allow: "/", disallow: "/api/" }, sitemap: "https://ammari.id/sitemap.xml" });
  });

  test.each([undefined, "dev", "prod"])("DEPLOY_ENV=%s disallows everything and names no sitemap", (value) => {
    if (value === undefined) delete process.env.DEPLOY_ENV;
    else process.env.DEPLOY_ENV = value;
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
  });
});
