import { describe, expect, test } from "vitest";
import { maskEmail, maskPhone, phoneSearchPrefix } from "./mask";

// docs/plans/growth.md §8.1, owner answer A5: the list masks contacts, search still matches the
// full value.

describe("maskEmail", () => {
  test("keeps two letters and the domain", () => {
    expect(maskEmail("nurul.hidayah@gmail.com")).toBe("nu***@gmail.com");
    expect(maskEmail("ab@ammari.id")).toBe("a***@ammari.id");
    expect(maskEmail("a@ammari.id")).toBe("a***@ammari.id");
  });

  test("something that is not an email is fully hidden", () => {
    expect(maskEmail("bukan-email")).toBe("***");
    expect(maskEmail("@ammari.id")).toBe("***");
  });
});

describe("maskPhone", () => {
  test("keeps the +62, the operator prefix and the last four digits", () => {
    expect(maskPhone("+6281234564567")).toBe("+62 812 **** 4567");
    expect(maskPhone("+6285712345678")).toBe("+62 857 **** 5678");
  });

  test("a too-short number shows nothing", () => {
    expect(maskPhone("+621234")).toBe("+62 ****");
  });
});

describe("phoneSearchPrefix", () => {
  test("normalises 08..., 62..., +62... and 8... to the stored +62 form", () => {
    expect(phoneSearchPrefix("0812-3456")).toBe("+628123456");
    expect(phoneSearchPrefix("0812 3456 4567")).toBe("+6281234564567");
    expect(phoneSearchPrefix("62812")).toBe("+62812");
    expect(phoneSearchPrefix("+62 812")).toBe("+62812");
    expect(phoneSearchPrefix("8123")).toBe("+628123");
  });

  test("names, emails, short or foreign numbers are not phone queries", () => {
    expect(phoneSearchPrefix("Sari")).toBeNull();
    expect(phoneSearchPrefix("sari@gmail.com")).toBeNull();
    expect(phoneSearchPrefix("081")).toBeNull();
    expect(phoneSearchPrefix("4567")).toBeNull();
  });
});
