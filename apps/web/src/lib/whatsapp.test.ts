import { describe, expect, test } from "vitest";
import { formatWhatsappNumber } from "./whatsapp";

describe("formatWhatsappNumber", () => {
  test("formats a 13-digit number as 3-4-4 groups", () => {
    expect(formatWhatsappNumber("6288808541442")).toBe("+62 888 0854 1442");
  });

  test("formats a 10-digit number, folding the short trailing group", () => {
    expect(formatWhatsappNumber("6281234567")).toBe("+62 812 34567");
  });

  test("formats an 11-digit number, folding the short trailing group", () => {
    expect(formatWhatsappNumber("62123456789")).toBe("+62 123 456789");
  });

  test("formats a 12-digit number with an even 3-4-3 split", () => {
    expect(formatWhatsappNumber("621234567890")).toBe("+62 123 4567 890");
  });

  test("strips non-digit characters before grouping", () => {
    expect(formatWhatsappNumber("+62 888-0854-1442")).toBe("+62 888 0854 1442");
  });
});
