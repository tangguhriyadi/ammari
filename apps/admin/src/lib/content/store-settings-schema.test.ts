import { describe, expect, test } from "vitest";
import { normalizeWhatsappNumber, saveStoreSettingsSchema } from "./store-settings-schema";

describe("normalizeWhatsappNumber", () => {
  test("a leading-0 local number becomes 62...", () => {
    expect(normalizeWhatsappNumber("081234567890")).toBe("6281234567890");
  });

  test("a +62-prefixed number is normalized (+ and spaces stripped)", () => {
    expect(normalizeWhatsappNumber("+62 812-3456-7890")).toBe("6281234567890");
  });

  test("an already-62-prefixed number passes through unchanged", () => {
    expect(normalizeWhatsappNumber("6281234567890")).toBe("6281234567890");
  });

  test("a common mistake shape — +62 pasted onto a leading-0 number — is fixed", () => {
    expect(normalizeWhatsappNumber("620812-3456-7890")).toBe("6281234567890");
  });

  test("a bare number with no leading 0/62 (just the 8xx part) is prefixed", () => {
    expect(normalizeWhatsappNumber("81234567890")).toBe("6281234567890");
  });

  test("a landline-shaped or otherwise implausible number is rejected", () => {
    expect(normalizeWhatsappNumber("0211234567")).toBeNull(); // starts 021, not 0 + 8xx
    expect(normalizeWhatsappNumber("123")).toBeNull();
    expect(normalizeWhatsappNumber("")).toBeNull();
    expect(normalizeWhatsappNumber("abc")).toBeNull();
  });
});

describe("saveStoreSettingsSchema", () => {
  const VALID = { whatsappNumber: "081234567890", supportEmail: "halo@ammari.id", businessAddress: "Jl. Contoh No. 1", returnPolicySummary: "Tukar ukuran dalam 3 hari" };

  test("accepts a fully-filled form and normalizes the WhatsApp number", () => {
    const parsed = saveStoreSettingsSchema.parse(VALID);
    expect(parsed).toEqual({
      whatsappNumber: "6281234567890",
      supportEmail: "halo@ammari.id",
      businessAddress: "Jl. Contoh No. 1",
      returnPolicySummary: "Tukar ukuran dalam 3 hari",
    });
  });

  test("every field left blank parses to null, not an empty string", () => {
    const parsed = saveStoreSettingsSchema.parse({ whatsappNumber: "", supportEmail: "", businessAddress: "", returnPolicySummary: "" });
    expect(parsed).toEqual({ whatsappNumber: null, supportEmail: null, businessAddress: null, returnPolicySummary: null });
  });

  test("rejects an invalid WhatsApp number", () => {
    expect(saveStoreSettingsSchema.safeParse({ ...VALID, whatsappNumber: "12345" }).success).toBe(false);
  });

  test("rejects an invalid email", () => {
    expect(saveStoreSettingsSchema.safeParse({ ...VALID, supportEmail: "not-an-email" }).success).toBe(false);
  });

  test("rejects an address over the length cap", () => {
    expect(saveStoreSettingsSchema.safeParse({ ...VALID, businessAddress: "a".repeat(501) }).success).toBe(false);
  });
});
