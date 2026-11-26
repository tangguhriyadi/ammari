import { describe, expect, test } from "vitest";
import { FieldError } from "@/lib/errors";
import {
  formatBpsAsPercent,
  parseEffectiveMonth,
  parseRatePercentToBps,
  parseRupiahAllowZero,
  validateTaxSetting,
  type TaxSettingFormInput,
} from "./tax-settings-input";

// Pengaturan pajak validation (D-20, docs/plans/accounting.md Session 3): rate in basis points,
// exemption >= 0, end date optional (and never before the start month).

const form: TaxSettingFormInput = {
  effectiveFrom: "2027-01",
  taxpayerType: "individual",
  taxpayerLabel: "Istri pemilik, orang pribadi",
  npwpRegisteredYear: "2020",
  ratePercent: "0,5",
  annualExemptionAmount: "500.000.000",
  rateValidUntil: "2029-12-31",
  note: "Perpanjangan PP 55",
};

function fieldOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof FieldError) return error.field;
    throw error;
  }
}

describe("rate in basis points", () => {
  test("a percentage with up to two decimals becomes whole basis points", () => {
    expect(parseRatePercentToBps("0,5")).toBe(50);
    expect(parseRatePercentToBps("0.5")).toBe(50);
    expect(parseRatePercentToBps("0,25")).toBe(25);
    expect(parseRatePercentToBps("1")).toBe(100);
    expect(parseRatePercentToBps("0")).toBe(0);
    expect(parseRatePercentToBps("100")).toBe(10_000);
  });

  test("more than two decimals, negatives, junk and above 100% are refused", () => {
    for (const raw of ["0,125", "-1", "abc", "", "100,01", "101", "1,2,3"]) expect(parseRatePercentToBps(raw), raw).toBeNull();
  });

  test("basis points show as an Indonesian percentage", () => {
    expect(formatBpsAsPercent(50)).toBe("0,5");
    expect(formatBpsAsPercent(25)).toBe("0,25");
    expect(formatBpsAsPercent(100)).toBe("1");
    expect(formatBpsAsPercent(0)).toBe("0");
  });
});

describe("exemption >= 0", () => {
  test("whole rupiah with or without thousand dots; zero is allowed", () => {
    expect(parseRupiahAllowZero("500.000.000")).toBe(500_000_000);
    expect(parseRupiahAllowZero("Rp 500000000")).toBe(500_000_000);
    expect(parseRupiahAllowZero("0")).toBe(0);
  });

  test("negative, decimal and empty are refused", () => {
    for (const raw of ["-1", "1,5", "", "abc", "1.5", "500.5", "5000.00", ".500"]) expect(parseRupiahAllowZero(raw), raw).toBeNull();
  });
});

describe("validateTaxSetting", () => {
  test("a full form becomes the row's values", () => {
    expect(validateTaxSetting(form)).toEqual({
      effectiveFrom: "2027-01-01",
      taxpayerType: "individual",
      taxpayerLabel: "Istri pemilik, orang pribadi",
      npwpRegisteredYear: 2020,
      rateBps: 50,
      annualExemptionAmount: 500_000_000,
      rateValidUntil: "2029-12-31",
      note: "Perpanjangan PP 55",
    });
  });

  test("the end date is optional: empty means no end", () => {
    expect(validateTaxSetting({ ...form, rateValidUntil: "" }).rateValidUntil).toBeNull();
    expect(validateTaxSetting({ ...form, rateValidUntil: null, npwpRegisteredYear: "", note: " " })).toMatchObject({ rateValidUntil: null, npwpRegisteredYear: null, note: null });
  });

  test("the end date is a real date on or after the start month", () => {
    expect(fieldOf(() => validateTaxSetting({ ...form, rateValidUntil: "2026-12-31" }))).toBe("rateValidUntil");
    expect(fieldOf(() => validateTaxSetting({ ...form, rateValidUntil: "2027-02-30" }))).toBe("rateValidUntil");
    expect(validateTaxSetting({ ...form, rateValidUntil: "2027-01-01" }).rateValidUntil).toBe("2027-01-01");
    expect(fieldOf(() => validateTaxSetting({ ...form, effectiveFrom: "0000-01" }))).toBe("effectiveFrom");
  });

  test("on update the month is the existing row's, whatever the form says", () => {
    expect(validateTaxSetting({ ...form, effectiveFrom: "garbage", rateValidUntil: "2026-12-31" }, "2026-12-01").effectiveFrom).toBe("2026-12-01");
  });

  test("each field's own error", () => {
    expect(fieldOf(() => validateTaxSetting({ ...form, effectiveFrom: "2027-13" }))).toBe("effectiveFrom");
    expect(fieldOf(() => validateTaxSetting({ ...form, taxpayerType: "partnership" }))).toBe("taxpayerType");
    expect(fieldOf(() => validateTaxSetting({ ...form, taxpayerLabel: " " }))).toBe("taxpayerLabel");
    expect(fieldOf(() => validateTaxSetting({ ...form, npwpRegisteredYear: "1970" }))).toBe("npwpRegisteredYear");
    expect(fieldOf(() => validateTaxSetting({ ...form, ratePercent: "0,125" }))).toBe("ratePercent");
    expect(fieldOf(() => validateTaxSetting({ ...form, annualExemptionAmount: "-5" }))).toBe("annualExemptionAmount");
    expect(fieldOf(() => validateTaxSetting({ ...form, note: "x".repeat(501) }))).toBe("note");
  });

  test("months: '2027-01' and '2027-01-01' are the first; any other day is refused", () => {
    expect(parseEffectiveMonth("2027-01")).toBe("2027-01-01");
    expect(parseEffectiveMonth("2027-01-01")).toBe("2027-01-01");
    expect(parseEffectiveMonth("2027-01-15")).toBeNull();
    expect(parseEffectiveMonth(undefined)).toBeNull();
  });
});
