import { describe, expect, test } from "vitest";
import {
  ANNOUNCEMENT_BAR_DEFAULT_TEXT,
  ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH,
  HOMEPAGE_META_DESCRIPTION_DEFAULT,
  HOMEPAGE_META_DESCRIPTION_RECOMMENDED_LENGTH,
  HOMEPAGE_META_TITLE_DEFAULT,
  HOMEPAGE_META_TITLE_RECOMMENDED_LENGTH,
} from "@ammari/db/storefront-settings";
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
  const VALID = {
    whatsappNumber: "081234567890",
    supportEmail: "halo@ammari.id",
    businessAddress: "Jl. Contoh No. 1",
    returnPolicySummary: "Tukar ukuran dalam 3 hari",
    announcementBarEnabled: true,
    announcementBarText: "Gratis Ongkir Ke Seluruh Indonesia",
    homepageMetaTitle: "Ammari | Gamis syar'i",
    homepageMetaDescription: "Gamis syar'i yang nyaman dipakai seharian.",
  };

  test("accepts a fully-filled form and normalizes the WhatsApp number", () => {
    const parsed = saveStoreSettingsSchema.parse(VALID);
    expect(parsed).toEqual({
      whatsappNumber: "6281234567890",
      supportEmail: "halo@ammari.id",
      businessAddress: "Jl. Contoh No. 1",
      returnPolicySummary: "Tukar ukuran dalam 3 hari",
      announcementBarEnabled: true,
      announcementBarText: "Gratis Ongkir Ke Seluruh Indonesia",
      homepageMetaTitle: "Ammari | Gamis syar'i",
      homepageMetaDescription: "Gamis syar'i yang nyaman dipakai seharian.",
    });
  });

  test("every field left blank parses to null, not an empty string", () => {
    const parsed = saveStoreSettingsSchema.parse({
      whatsappNumber: "",
      supportEmail: "",
      businessAddress: "",
      returnPolicySummary: "",
      announcementBarEnabled: false,
      announcementBarText: "",
      homepageMetaTitle: "",
      homepageMetaDescription: "",
    });
    expect(parsed).toEqual({
      whatsappNumber: null,
      supportEmail: null,
      businessAddress: null,
      returnPolicySummary: null,
      announcementBarEnabled: false,
      announcementBarText: null,
      homepageMetaTitle: null,
      homepageMetaDescription: null,
    });
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

  test("announcement text: 40 characters is accepted, 41 is rejected with an Indonesian message", () => {
    expect(saveStoreSettingsSchema.safeParse({ ...VALID, announcementBarText: "a".repeat(40) }).success).toBe(true);
    const result = saveStoreSettingsSchema.safeParse({ ...VALID, announcementBarText: "a".repeat(41) });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Teks pengumuman maksimal 40 karakter agar muat satu baris di HP.");
  });

  test("announcement text: line breaks and repeated spaces collapse to one line before counting", () => {
    const parsed = saveStoreSettingsSchema.parse({ ...VALID, announcementBarText: "  Gratis\nOngkir   Seluruh Indonesia  " });
    expect(parsed.announcementBarText).toBe("Gratis Ongkir Seluruh Indonesia");
  });

  test("announcement text may be empty while enabled (the storefront just shows no bar)", () => {
    const parsed = saveStoreSettingsSchema.parse({ ...VALID, announcementBarEnabled: true, announcementBarText: "   " });
    expect(parsed).toMatchObject({ announcementBarEnabled: true, announcementBarText: null });
  });

  test("homepage meta: over the hard caps is rejected, the recommended length is only guidance", () => {
    expect(saveStoreSettingsSchema.safeParse({ ...VALID, homepageMetaTitle: "a".repeat(70) }).success).toBe(true);
    expect(saveStoreSettingsSchema.safeParse({ ...VALID, homepageMetaTitle: "a".repeat(81) }).success).toBe(false);
    expect(saveStoreSettingsSchema.safeParse({ ...VALID, homepageMetaDescription: "a".repeat(200) }).success).toBe(true);
    expect(saveStoreSettingsSchema.safeParse({ ...VALID, homepageMetaDescription: "a".repeat(201) }).success).toBe(false);
  });

  test("rejects a missing announcementBarEnabled (never silently defaults)", () => {
    expect(saveStoreSettingsSchema.safeParse({ ...VALID, announcementBarEnabled: undefined }).success).toBe(false);
  });
});

describe("shipped storefront defaults (@ammari/db/storefront-settings)", () => {
  const DEFAULTS = [ANNOUNCEMENT_BAR_DEFAULT_TEXT, HOMEPAGE_META_TITLE_DEFAULT, HOMEPAGE_META_DESCRIPTION_DEFAULT];

  test("never name a city or shipping origin, and never use an em dash (docs/design/storefront.md §2)", () => {
    for (const text of DEFAULTS) {
      expect(text).not.toMatch(/bandung|cilame|ngamprah|padalarang|cimahi|jawa barat|dikirim dari/i);
      expect(text).not.toContain("\u2014");
    }
  });

  test("fit their own limits and guidance, and pass the admin schema unchanged", () => {
    expect(ANNOUNCEMENT_BAR_DEFAULT_TEXT.length).toBeLessThanOrEqual(ANNOUNCEMENT_BAR_TEXT_MAX_LENGTH);
    expect(HOMEPAGE_META_TITLE_DEFAULT.length).toBeLessThanOrEqual(HOMEPAGE_META_TITLE_RECOMMENDED_LENGTH);
    expect(HOMEPAGE_META_DESCRIPTION_DEFAULT.length).toBeLessThanOrEqual(HOMEPAGE_META_DESCRIPTION_RECOMMENDED_LENGTH);
    const parsed = saveStoreSettingsSchema.parse({
      whatsappNumber: "",
      supportEmail: "",
      businessAddress: "",
      returnPolicySummary: "",
      announcementBarEnabled: true,
      announcementBarText: ANNOUNCEMENT_BAR_DEFAULT_TEXT,
      homepageMetaTitle: HOMEPAGE_META_TITLE_DEFAULT,
      homepageMetaDescription: HOMEPAGE_META_DESCRIPTION_DEFAULT,
    });
    expect(parsed.homepageMetaDescription).toBe(HOMEPAGE_META_DESCRIPTION_DEFAULT);
  });
});

