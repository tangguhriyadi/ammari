import { describe, expect, test } from "vitest";
import { ACCOUNT_NAME_MESSAGES, parseAccountName } from "./name";

describe("parseAccountName", () => {
  test("one clean line", () => {
    expect(parseAccountName("  Siti\n  Aminah\u200b ")).toEqual({ ok: true, name: "Siti Aminah" });
    expect(parseAccountName("Nur-Aini O'Neil")).toEqual({ ok: true, name: "Nur-Aini O'Neil" });
  });
  test("refuses empty, letter-free and too long names", () => {
    expect(parseAccountName("   ")).toEqual({ ok: false, message: ACCOUNT_NAME_MESSAGES.required });
    expect(parseAccountName(null)).toEqual({ ok: false, message: ACCOUNT_NAME_MESSAGES.required });
    expect(parseAccountName("12345 !!")).toEqual({ ok: false, message: ACCOUNT_NAME_MESSAGES.invalid });
    expect(parseAccountName("a".repeat(81))).toEqual({ ok: false, message: ACCOUNT_NAME_MESSAGES.tooLong });
  });
});
