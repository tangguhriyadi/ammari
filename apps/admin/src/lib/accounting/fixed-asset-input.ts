import { isCalendarDate } from "@ammari/accounting";
import type { AccountNormalBalance, AccountType } from "@ammari/db/schema";
import { FieldError } from "@/lib/errors";
import { parseRupiahAllowZero } from "./tax-settings-input";

// Aset tetap input rules (docs/plans/accounting.md §5.3, D-19, Session 11). Pure: the forms send text
// and this turns it into the row's values or a FieldError. The fixed_assets CHECKs (migration 0055)
// refuse the same shapes in the database; the account rules (active, postable, of the right kind) are
// checked here against the accounts as they are when the form is saved.

export const FIXED_ASSET_MESSAGES = {
  nameRequired: "Nama aset wajib diisi.",
  nameTooLong: "Nama aset maksimal 120 karakter.",
  group: "Pilih kelompok aset.",
  acquisitionDate: "Tanggal perolehan tidak valid.",
  acquisitionFuture: "Tanggal perolehan tidak boleh setelah hari ini.",
  cost: "Harga perolehan harus bilangan bulat rupiah lebih dari 0.",
  belowThreshold: (threshold: string) => `Harga perolehan di bawah batas kapitalisasi ${threshold}. Catat sebagai biaya biasa, bukan aset tetap.`,
  assetAccount: "Pilih akun aset tetap yang aktif (1-2xxx, saldo normal debit).",
  accumulatedAccount: "Pilih akun akumulasi penyusutan yang aktif (1-2xxx, saldo normal kredit), berbeda dari akun aset.",
  fundingAccount: "Pilih akun Kas & Bank atau akun utang yang aktif, atau pilih \"Sudah tercatat\".",
  noteTooLong: "Catatan maksimal 500 karakter.",
  disposedOn: "Tanggal pelepasan tidak valid.",
  disposedBeforeAcquisition: "Tanggal pelepasan tidak boleh sebelum tanggal perolehan.",
  disposedFuture: "Tanggal pelepasan tidak boleh setelah hari ini.",
  proceeds: "Hasil penjualan harus bilangan bulat rupiah, 0 atau lebih.",
  proceedsAccount: "Pilih akun Kas & Bank yang aktif untuk uang hasil penjualan.",
  voidReasonRequired: "Alasan pembatalan wajib diisi.",
  voidReasonTooLong: "Alasan maksimal 500 karakter.",
  notFound: "Aset tetap tidak ditemukan.",
  voided: "Aset ini sudah dibatalkan.",
  disposed: "Aset ini sudah dilepas. Batalkan aset bila datanya salah, lalu catat ulang.",
  groupLife: "Umur manfaat harus bilangan bulat 1 sampai 600 bulan.",
  groupLabelRequired: "Nama kelompok wajib diisi.",
  groupLabelTooLong: "Nama kelompok maksimal 60 karakter.",
  threshold: "Batas kapitalisasi harus bilangan bulat rupiah, 0 atau lebih.",
} as const;

export interface FixedAssetAccountInfo {
  type: AccountType;
  normalBalance: AccountNormalBalance;
  isActive: boolean;
  isHeader: boolean;
}

export interface FixedAssetValidationContext {
  today: string;
  /** fixed_asset_groups: code → useful life in months. */
  groups: ReadonlyMap<string, number>;
  capitalizationThreshold: number;
  accounts: ReadonlyMap<string, FixedAssetAccountInfo>;
}

export interface FixedAssetFormInput {
  name: string;
  groupCode: string;
  acquisitionDate: string;
  cost: string;
  assetAccountCode: string;
  accumulatedAccountCode: string;
  /** "" = already in the books (no acquisition journal). */
  fundingAccountCode: string;
  note?: string | null;
}

export interface FixedAssetValues {
  name: string;
  groupCode: string;
  usefulLifeMonths: number;
  acquisitionDate: string;
  cost: number;
  assetAccountCode: string;
  accumulatedAccountCode: string;
  fundingAccountCode: string | null;
  note: string | null;
}

const CASH_BANK = /^1-1[12][0-9]{2}$/;
const FIXED_ASSET_CODE = /^1-2[0-9]{3}$/;

function postable(account: FixedAssetAccountInfo | undefined): account is FixedAssetAccountInfo {
  return !!account && account.isActive && !account.isHeader;
}

export function isFixedAssetAccount(code: string, account: FixedAssetAccountInfo | undefined): boolean {
  return FIXED_ASSET_CODE.test(code) && postable(account) && account.type === "asset" && account.normalBalance === "debit";
}

export function isAccumulatedDepreciationAccount(code: string, account: FixedAssetAccountInfo | undefined): boolean {
  return FIXED_ASSET_CODE.test(code) && postable(account) && account.type === "asset" && account.normalBalance === "credit";
}

export function isFundingAccount(code: string, account: FixedAssetAccountInfo | undefined): boolean {
  return postable(account) && ((CASH_BANK.test(code) && account.type === "asset") || (/^2-[0-9]{4}$/.test(code) && account.type === "liability"));
}

export function isCashBankAccount(code: string, account: FixedAssetAccountInfo | undefined): boolean {
  return CASH_BANK.test(code) && postable(account) && account.type === "asset";
}

function rupiahText(amount: number): string {
  return `Rp${amount.toLocaleString("id-ID")}`;
}

/** The register row's values from the form (create and edit; `existingCost` on edit). */
export function validateFixedAsset(input: FixedAssetFormInput, context: FixedAssetValidationContext, existingCost?: number): FixedAssetValues {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name === "") throw new FieldError("name", FIXED_ASSET_MESSAGES.nameRequired);
  if (name.length > 120) throw new FieldError("name", FIXED_ASSET_MESSAGES.nameTooLong);
  const usefulLifeMonths = context.groups.get(input.groupCode);
  if (usefulLifeMonths === undefined) throw new FieldError("groupCode", FIXED_ASSET_MESSAGES.group);
  const acquisitionDate = input.acquisitionDate.trim();
  if (!isCalendarDate(acquisitionDate) || acquisitionDate < "1900-01-01") throw new FieldError("acquisitionDate", FIXED_ASSET_MESSAGES.acquisitionDate);
  if (acquisitionDate > context.today) throw new FieldError("acquisitionDate", FIXED_ASSET_MESSAGES.acquisitionFuture);
  const cost = parseRupiahAllowZero(input.cost);
  if (cost === null || cost <= 0) throw new FieldError("cost", FIXED_ASSET_MESSAGES.cost);
  // Checked on create and whenever the cost changes: a later rise of the threshold never locks an
  // existing asset out of a correction of its other fields.
  if (cost !== existingCost && cost < context.capitalizationThreshold) throw new FieldError("cost", FIXED_ASSET_MESSAGES.belowThreshold(rupiahText(context.capitalizationThreshold)));
  if (!isFixedAssetAccount(input.assetAccountCode, context.accounts.get(input.assetAccountCode))) throw new FieldError("assetAccountCode", FIXED_ASSET_MESSAGES.assetAccount);
  if (input.accumulatedAccountCode === input.assetAccountCode || !isAccumulatedDepreciationAccount(input.accumulatedAccountCode, context.accounts.get(input.accumulatedAccountCode))) {
    throw new FieldError("accumulatedAccountCode", FIXED_ASSET_MESSAGES.accumulatedAccount);
  }
  const funding = input.fundingAccountCode.trim();
  if (funding !== "" && !isFundingAccount(funding, context.accounts.get(funding))) throw new FieldError("fundingAccountCode", FIXED_ASSET_MESSAGES.fundingAccount);
  const note = input.note?.trim() || null;
  if (note !== null && note.length > 500) throw new FieldError("note", FIXED_ASSET_MESSAGES.noteTooLong);
  return {
    name,
    groupCode: input.groupCode,
    usefulLifeMonths,
    acquisitionDate,
    cost,
    assetAccountCode: input.assetAccountCode,
    accumulatedAccountCode: input.accumulatedAccountCode,
    fundingAccountCode: funding === "" ? null : funding,
    note,
  };
}

export interface FixedAssetDisposalInput {
  disposedOn: string;
  proceeds: string;
  /** Required when proceeds > 0. */
  cashAccountCode: string;
}

export interface FixedAssetDisposalValues {
  disposedOn: string;
  disposalProceeds: number;
  disposalCashAccountCode: string | null;
}

export function validateFixedAssetDisposal(
  input: FixedAssetDisposalInput,
  context: { today: string; acquisitionDate: string; accounts: ReadonlyMap<string, FixedAssetAccountInfo> },
): FixedAssetDisposalValues {
  const disposedOn = input.disposedOn.trim();
  if (!isCalendarDate(disposedOn)) throw new FieldError("disposedOn", FIXED_ASSET_MESSAGES.disposedOn);
  if (disposedOn < context.acquisitionDate) throw new FieldError("disposedOn", FIXED_ASSET_MESSAGES.disposedBeforeAcquisition);
  if (disposedOn > context.today) throw new FieldError("disposedOn", FIXED_ASSET_MESSAGES.disposedFuture);
  const proceeds = input.proceeds.trim() === "" ? 0 : parseRupiahAllowZero(input.proceeds);
  if (proceeds === null) throw new FieldError("proceeds", FIXED_ASSET_MESSAGES.proceeds);
  if (proceeds === 0) return { disposedOn, disposalProceeds: 0, disposalCashAccountCode: null };
  const cash = input.cashAccountCode.trim();
  if (!isCashBankAccount(cash, context.accounts.get(cash))) throw new FieldError("cashAccountCode", FIXED_ASSET_MESSAGES.proceedsAccount);
  return { disposedOn, disposalProceeds: proceeds, disposalCashAccountCode: cash };
}

export function normalizeVoidReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "") throw new FieldError("reason", FIXED_ASSET_MESSAGES.voidReasonRequired);
  if (trimmed.length > 500) throw new FieldError("reason", FIXED_ASSET_MESSAGES.voidReasonTooLong);
  return trimmed;
}

export function validateGroupInput(input: { label: string; usefulLifeMonths: string }): { label: string; usefulLifeMonths: number } {
  const label = input.label.trim().replace(/\s+/g, " ");
  if (label === "") throw new FieldError("label", FIXED_ASSET_MESSAGES.groupLabelRequired);
  if (label.length > 60) throw new FieldError("label", FIXED_ASSET_MESSAGES.groupLabelTooLong);
  const text = input.usefulLifeMonths.trim();
  const months = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
  if (!(months >= 1 && months <= 600)) throw new FieldError("usefulLifeMonths", FIXED_ASSET_MESSAGES.groupLife);
  return { label, usefulLifeMonths: months };
}

export function validateThresholdInput(raw: string): number {
  const amount = parseRupiahAllowZero(raw);
  if (amount === null) throw new FieldError("capitalizationThreshold", FIXED_ASSET_MESSAGES.threshold);
  return amount;
}
