import { TAXPAYER_TYPES, type TaxpayerType } from "@ammari/db/schema";
import { FieldError } from "@/lib/errors";

// Pengaturan pajak input rules (docs/plans/accounting.md §2.1 tax_settings, D-20, Session 3).
// Pure; the form sends text and this turns it into the row's values or a FieldError. The
// tax_settings CHECKs (migration 0049) refuse the same values in the database.
//
// The rate is typed as a percentage the Indonesian way ("0,5") and stored in basis points (50).

export const TAX_SETTING_MESSAGES = {
  effectiveFrom: "Pilih bulan mulai berlaku.",
  effectiveFromTaken: "Sudah ada pengaturan yang mulai berlaku di bulan ini. Ubah pengaturan itu saja.",
  taxpayerType: "Pilih jenis wajib pajak.",
  labelRequired: "Keterangan wajib pajak wajib diisi.",
  labelTooLong: "Keterangan wajib pajak maksimal 120 karakter.",
  npwpYear: "Tahun NPWP harus antara 1980 dan 2100.",
  rate: "Tarif harus angka 0 sampai 100 persen, paling banyak 2 angka di belakang koma (mis. 0,5).",
  exemption: "Batas bebas pajak harus bilangan bulat rupiah, 0 atau lebih.",
  validUntil: "Tanggal akhir tarif tidak valid.",
  validUntilBeforeStart: "Tanggal akhir tarif tidak boleh sebelum bulan mulai berlaku.",
  noteTooLong: "Catatan maksimal 500 karakter.",
  notFound: "Pengaturan pajak tidak ditemukan.",
} as const;

export interface TaxSettingFormInput {
  /** "2027-01" (an <input type="month">) or "2027-01-01". Only read on create. */
  effectiveFrom?: string;
  taxpayerType: string;
  taxpayerLabel: string;
  npwpRegisteredYear?: string | null;
  /** Percent, "0,5" or "0.5". */
  ratePercent: string;
  /** Whole rupiah, "500.000.000" or "500000000". */
  annualExemptionAmount: string;
  /** "2026-12-31" or empty (no end). */
  rateValidUntil?: string | null;
  note?: string | null;
}

export interface TaxSettingValues {
  effectiveFrom: string;
  taxpayerType: TaxpayerType;
  taxpayerLabel: string;
  npwpRegisteredYear: number | null;
  rateBps: number;
  annualExemptionAmount: number;
  rateValidUntil: string | null;
  note: string | null;
}

const MAX_EXEMPTION = 1_000_000_000_000_000;

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Postgres has no year 0, and nothing here is that old.
  if (Number(value.slice(0, 4)) < 1900) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** "2027-01" or "2027-01-01" → "2027-01-01"; anything else (another day, a bad month) is null. */
export function parseEffectiveMonth(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  const month = /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
  return isRealDate(month) && month.endsWith("-01") ? month : null;
}

/** "0,5" → 50 bps; "1" → 100; "0,25" → 25. More than two decimals, a sign, or above 100% → null. */
export function parseRatePercentToBps(raw: string): number | null {
  const value = raw.trim().replace(",", ".");
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bps <= 10_000 ? bps : null;
}

/** 50 → "0,5"; 100 → "1"; 25 → "0,25". */
export function formatBpsAsPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole},${fraction}` : String(whole);
}

/** "500.000.000" / "500000000" / "0" → number; negative, decimal or junk → null. */
export function parseRupiahAllowZero(raw: string): number | null {
  const typed = raw.trim().replace(/^rp\s*/i, "");
  // Dots only as thousands separators ("500.000.000"); "1.5" is a typo, not 15.
  if (!/^\d+$/.test(typed) && !/^\d{1,3}(\.\d{3})+$/.test(typed)) return null;
  const value = typed.replace(/\./g, "");
  if (!/^\d{1,16}$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount <= MAX_EXEMPTION ? amount : null;
}

/** The row's values from the form. `effectiveFrom` is the existing row's key on update. */
export function validateTaxSetting(input: TaxSettingFormInput, existingEffectiveFrom?: string): TaxSettingValues {
  const effectiveFrom = existingEffectiveFrom ?? parseEffectiveMonth(input.effectiveFrom);
  if (!effectiveFrom) throw new FieldError("effectiveFrom", TAX_SETTING_MESSAGES.effectiveFrom);
  if (!(TAXPAYER_TYPES as readonly string[]).includes(input.taxpayerType)) throw new FieldError("taxpayerType", TAX_SETTING_MESSAGES.taxpayerType);
  const taxpayerLabel = input.taxpayerLabel.trim().replace(/\s+/g, " ");
  if (taxpayerLabel === "") throw new FieldError("taxpayerLabel", TAX_SETTING_MESSAGES.labelRequired);
  if (taxpayerLabel.length > 120) throw new FieldError("taxpayerLabel", TAX_SETTING_MESSAGES.labelTooLong);
  const npwpText = input.npwpRegisteredYear?.trim() ?? "";
  let npwpRegisteredYear: number | null = null;
  if (npwpText !== "") {
    npwpRegisteredYear = /^\d{4}$/.test(npwpText) ? Number(npwpText) : NaN;
    if (!(npwpRegisteredYear >= 1980 && npwpRegisteredYear <= 2100)) throw new FieldError("npwpRegisteredYear", TAX_SETTING_MESSAGES.npwpYear);
  }
  const rateBps = parseRatePercentToBps(input.ratePercent);
  if (rateBps === null) throw new FieldError("ratePercent", TAX_SETTING_MESSAGES.rate);
  const annualExemptionAmount = parseRupiahAllowZero(input.annualExemptionAmount);
  if (annualExemptionAmount === null) throw new FieldError("annualExemptionAmount", TAX_SETTING_MESSAGES.exemption);
  const validUntilText = input.rateValidUntil?.trim() ?? "";
  let rateValidUntil: string | null = null;
  if (validUntilText !== "") {
    if (!isRealDate(validUntilText)) throw new FieldError("rateValidUntil", TAX_SETTING_MESSAGES.validUntil);
    if (validUntilText < effectiveFrom) throw new FieldError("rateValidUntil", TAX_SETTING_MESSAGES.validUntilBeforeStart);
    rateValidUntil = validUntilText;
  }
  const note = input.note?.trim() || null;
  if (note !== null && note.length > 500) throw new FieldError("note", TAX_SETTING_MESSAGES.noteTooLong);
  return {
    effectiveFrom,
    taxpayerType: input.taxpayerType as TaxpayerType,
    taxpayerLabel,
    npwpRegisteredYear,
    rateBps,
    annualExemptionAmount,
    rateValidUntil,
    note,
  };
}
