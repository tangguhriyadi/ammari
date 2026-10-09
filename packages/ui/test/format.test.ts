import { describe, expect, test } from "vitest";
import { formatDate, formatDateTime, formatNumber, formatRupiah, formatShortDate } from "../src/lib/format";

describe("formatRupiah", () => {
  test("formats whole rupiah with a thousands separator and no decimals", () => {
    expect(formatRupiah(249_000)).toBe("Rp 249.000");
  });

  test("formats zero", () => {
    expect(formatRupiah(0)).toBe("Rp 0");
  });

  test("rounds a fractional amount rather than showing decimals", () => {
    expect(formatRupiah(249_000.6)).toBe("Rp 249.001");
  });
});

describe("formatNumber", () => {
  test("groups thousands with a dot", () => {
    expect(formatNumber(1234)).toBe("1.234");
  });

  test("formats small numbers without a separator", () => {
    expect(formatNumber(7)).toBe("7");
  });
});

describe("formatDate", () => {
  test("formats in Asia/Jakarta as '1 Okt 2026'", () => {
    // 2026-10-01T18:00:00Z is already 2026-10-02 early morning in WIB (UTC+7) — chosen instead
    // to prove the function uses Jakarta's calendar day, not the host's local/UTC day.
    expect(formatDate(new Date("2026-09-30T18:00:00Z"))).toBe("1 Okt 2026");
  });
});

describe("formatDateTime", () => {
  test("formats as '1 Okt 2026, 20.14' with a dot time separator", () => {
    expect(formatDateTime(new Date("2026-10-01T13:14:00Z"))).toBe("1 Okt 2026, 20.14");
  });
});

describe("formatShortDate", () => {
  test("formats in Asia/Jakarta as '1 Okt', with no year", () => {
    expect(formatShortDate(new Date("2026-09-30T18:00:00Z"))).toBe("1 Okt");
  });
});
