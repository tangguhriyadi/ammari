import { describe, expect, test } from "vitest";
import { isIndexableDeployment, isPrivatePath, publicPageRobots, xRobotsTagFor } from "./indexing";

describe("isIndexableDeployment", () => {
  test("only the literal 'production' is indexable; anything else fails safe", () => {
    expect(isIndexableDeployment("production")).toBe(true);
    for (const value of [undefined, "", "dev", "development", "test", "Production", "prod", " production"]) {
      expect(isIndexableDeployment(value)).toBe(false);
    }
  });
});

describe("isPrivatePath", () => {
  test.each(["/cart", "/checkout", "/checkout/finish", "/account", "/account/complete-profile", "/orders", "/orders/AM-1", "/login", "/login/link", "/claim", "/claim/abc", "/consent", "/preview/home", "/api/health", "/api/test/otp"])(
    "%s is private",
    (path) => expect(isPrivatePath(path)).toBe(true),
  );

  test.each(["/", "/products/gamis-aira", "/shipping", "/privacy-policy", "/accounting", "/carts-guide", "/apiary"])("%s is public", (path) =>
    expect(isPrivatePath(path)).toBe(false),
  );
});

describe("xRobotsTagFor", () => {
  test("off production every path, public ones included, gets noindex", () => {
    for (const env of [undefined, "dev"]) {
      expect(xRobotsTagFor("/", env)).toBe("noindex, nofollow");
      expect(xRobotsTagFor("/products/gamis-aira", env)).toBe("noindex, nofollow");
      expect(xRobotsTagFor("/images/product-placeholder-og.jpg", env)).toBe("noindex, nofollow");
    }
  });

  test("on production only private paths get it", () => {
    expect(xRobotsTagFor("/", "production")).toBeNull();
    expect(xRobotsTagFor("/products/gamis-aira", "production")).toBeNull();
    expect(xRobotsTagFor("/sitemap.xml", "production")).toBeNull();
    expect(xRobotsTagFor("/account", "production")).toBe("noindex, nofollow");
    expect(xRobotsTagFor("/api/health", "production")).toBe("noindex, nofollow");
  });
});

describe("publicPageRobots", () => {
  test("indexable on production, noindex elsewhere", () => {
    expect(publicPageRobots("production")).toEqual({ index: true, follow: true });
    expect(publicPageRobots("dev")).toEqual({ index: false, follow: false });
    expect(publicPageRobots(undefined)).toEqual({ index: false, follow: false });
  });
});
