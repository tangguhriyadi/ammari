import { describe, expect, test } from "vitest";
import { parseLoginEmailParam } from "./login-email-param";

describe("parseLoginEmailParam", () => {
  test("trims and lowercases a valid address", () => {
    expect(parseLoginEmailParam("  Rina@Example.Test ")).toBe("rina@example.test");
    expect(parseLoginEmailParam("a+b@example.test")).toBe("a+b@example.test");
  });

  test("ignores missing, repeated, malformed, spaced and over-long values", () => {
    for (const bad of [undefined, ["a@example.test", "b@example.test"], "", "rina", "ri na@example.test", `${"a".repeat(250)}@x.id`]) {
      expect(parseLoginEmailParam(bad)).toBeNull();
    }
  });
});
