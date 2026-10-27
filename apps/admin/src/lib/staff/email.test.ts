import { describe, expect, test } from "vitest";
import { normalizeStaffEmail, staffEmailSchema } from "./email";

describe("normalizeStaffEmail", () => {
  test("trims, lowercases and NFC-normalises", () => {
    expect(normalizeStaffEmail("  Rina@Ammari.ID ")).toBe("rina@ammari.id");
    expect(normalizeStaffEmail("josé@example.test")).toBe("josé@example.test");
  });

  test("keeps Gmail dots and +tags: they are different mailboxes on other domains", () => {
    expect(normalizeStaffEmail("Rina.Putri+admin@gmail.com")).toBe("rina.putri+admin@gmail.com");
  });
});

describe("staffEmailSchema", () => {
  test("accepts a normal address and returns it normalised", () => {
    expect(staffEmailSchema.parse(" Staf@Example.Test ")).toBe("staf@example.test");
  });

  test("refuses empty, inner whitespace, malformed and over-long input", () => {
    for (const bad of ["", "   ", "ri na@example.test", "rina@", "rina", `${"a".repeat(250)}@x.id`]) {
      expect(staffEmailSchema.safeParse(bad).success).toBe(false);
    }
  });
});
