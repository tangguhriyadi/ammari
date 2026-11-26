import { accountCodeMatchesType, accountTypesForCode, isAccountCode, isCashBankAccountCode } from "@ammari/accounting";
import { ACCOUNT_NORMAL_BALANCES, ACCOUNT_TYPES, CASH_FLOW_GROUPS, type AccountNormalBalance, type AccountType, type CashFlowGroup } from "@ammari/db/schema";
import { FieldError } from "@/lib/errors";
import { ACCOUNT_TYPE_LABELS } from "./labels";

// The account editor's input rules (Data Master Akun, docs/plans/accounting.md Session 3, §8.1).
// Pure, so they are unit-tested without a database; lib/accounting/accounts.ts applies them inside
// the write transaction, and migration 0049/0051's CHECKs and triggers refuse the same rows.

export const ACCOUNT_MESSAGES = {
  codeFormat: "Kode akun harus berformat 1-2345.",
  codeTaken: "Kode akun ini sudah dipakai.",
  codeClass: (code: string, type: AccountType) =>
    `Kode ${code} tidak cocok untuk jenis ${ACCOUNT_TYPE_LABELS[type]}. Digit pertama kode menentukan jenis akun (1 aset, 2 kewajiban, 3 ekuitas, 4 pendapatan, 5 HPP, 6 beban, 7 pendapatan lain-lain, 8 beban lain-lain, 9 pajak).`,
  nameRequired: "Nama akun wajib diisi.",
  nameTooLong: "Nama akun maksimal 80 karakter.",
  nameTaken: "Nama akun ini sudah dipakai.",
  type: "Pilih jenis akun.",
  normalBalance: "Pilih saldo normal.",
  cashFlowGroup: "Pilih kelompok arus kas.",
  parentNotFound: "Akun induk tidak ditemukan.",
  parentNotHeader: "Akun induk harus akun kelompok, bukan akun yang bisa dijurnal.",
  parentType: "Jenis akun harus sama dengan jenis akun induknya.",
  parentCycle: "Akun induk ini membuat susunan akun berputar.",
  bankFieldsNotAllowed: "Nama bank dan 4 digit rekening hanya untuk akun Kas & Bank (1-11xx, 1-12xx).",
  bankNameTooLong: "Nama bank maksimal 60 karakter.",
  last4: "Isi tepat 4 angka terakhir nomor rekening.",
  notFound: "Akun tidak ditemukan.",
  systemCannotDeactivate: "Akun sistem dipakai jurnal otomatis dan tidak bisa dinonaktifkan.",
  mappedCannotDeactivate: "Akun ini masih dipakai di Pemetaan Akun. Pindahkan pemetaannya ke akun lain dulu.",
  parentInactive: "Akun induk sudah nonaktif. Aktifkan dulu akun induknya.",
  headerWithActiveChildren: "Nonaktifkan dulu semua sub-akunnya.",
  systemCannotDelete: "Akun sistem tidak bisa dihapus.",
  usedCannotDelete: "Akun yang sudah dipakai jurnal tidak bisa dihapus. Nonaktifkan saja.",
  mappedCannotDelete: "Akun yang dipakai pemetaan tidak bisa dihapus.",
  childrenCannotDelete: "Akun yang punya sub-akun tidak bisa dihapus.",
} as const;

const MAX_NAME = 80;
const MAX_BANK_NAME = 60;

/** Debit-normal types (the same split as the initial Chart of Accounts); the form preselects it. */
const DEBIT_NORMAL_TYPES: readonly AccountType[] = ["asset", "contra_revenue", "cogs", "expense", "other_expense", "tax"];

export function defaultNormalBalance(type: AccountType): AccountNormalBalance {
  return DEBIT_NORMAL_TYPES.includes(type) ? "debit" : "credit";
}

export function normalizeAccountName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "") throw new FieldError("name", ACCOUNT_MESSAGES.nameRequired);
  if (name.length > MAX_NAME) throw new FieldError("name", ACCOUNT_MESSAGES.nameTooLong);
  return name;
}

export interface ParentInfo {
  code: string;
  type: AccountType;
  isHeader: boolean;
}

/** A parent must be a header of the same type (plan §8.1). The cycle check needs the tree and is
 * the database's (accounts_guard_tree). */
export function assertValidParent(parent: ParentInfo | null, type: AccountType): void {
  if (!parent) return;
  if (!parent.isHeader) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentNotHeader);
  if (parent.type !== type) throw new FieldError("parentCode", ACCOUNT_MESSAGES.parentType);
}

export interface BankFields {
  bankName: string | null;
  accountNoLast4: string | null;
}

/** Bank name and the last 4 digits, only on a postable Kas & Bank account (D-17). Empty text is
 * "none". */
export function normalizeBankFields(code: string, isHeader: boolean, raw: { bankName?: string | null; accountNoLast4?: string | null }): BankFields {
  const bankName = raw.bankName?.trim().replace(/\s+/g, " ") || null;
  const accountNoLast4 = raw.accountNoLast4?.trim() || null;
  if (bankName === null && accountNoLast4 === null) return { bankName, accountNoLast4 };
  if (isHeader || !isCashBankAccountCode(code)) throw new FieldError(bankName !== null ? "bankName" : "accountNoLast4", ACCOUNT_MESSAGES.bankFieldsNotAllowed);
  if (bankName !== null && bankName.length > MAX_BANK_NAME) throw new FieldError("bankName", ACCOUNT_MESSAGES.bankNameTooLong);
  if (accountNoLast4 !== null && !/^[0-9]{4}$/.test(accountNoLast4)) throw new FieldError("accountNoLast4", ACCOUNT_MESSAGES.last4);
  return { bankName, accountNoLast4 };
}

/** The cash-flow group an account gets: a header is never classified; a postable Kas & Bank
 * account is cash itself; anything else takes the chosen group. */
export function resolveCashFlowGroup(code: string, isHeader: boolean, chosen: CashFlowGroup | undefined): CashFlowGroup {
  if (isHeader) return "none";
  if (isCashBankAccountCode(code)) return "cash";
  if (!chosen || chosen === "none" || !(CASH_FLOW_GROUPS as readonly string[]).includes(chosen)) {
    throw new FieldError("cashFlowGroup", ACCOUNT_MESSAGES.cashFlowGroup);
  }
  return chosen;
}

/** Whether the cash-flow group is the accountant's choice for this account (the form shows the
 * field only then). */
export function cashFlowGroupIsChosen(code: string, isHeader: boolean): boolean {
  return !isHeader && !isCashBankAccountCode(code);
}

export interface NewAccountInput {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: AccountNormalBalance;
  isHeader: boolean;
  cashFlowGroup?: CashFlowGroup;
  bankName?: string | null;
  accountNoLast4?: string | null;
}

export interface NewAccountValues {
  code: string;
  name: string;
  type: AccountType;
  normalBalance: AccountNormalBalance;
  isHeader: boolean;
  cashFlowGroup: CashFlowGroup;
  bankName: string | null;
  accountNoLast4: string | null;
}

/** Everything about a new account that doesn't need the database, in form order. */
export function validateNewAccount(input: NewAccountInput, parent: ParentInfo | null): NewAccountValues {
  const code = input.code.trim();
  if (!isAccountCode(code)) throw new FieldError("code", ACCOUNT_MESSAGES.codeFormat);
  const name = normalizeAccountName(input.name);
  if (!(ACCOUNT_TYPES as readonly string[]).includes(input.type)) throw new FieldError("type", ACCOUNT_MESSAGES.type);
  if (!accountCodeMatchesType(code, input.type)) throw new FieldError("code", ACCOUNT_MESSAGES.codeClass(code, input.type));
  if (!(ACCOUNT_NORMAL_BALANCES as readonly string[]).includes(input.normalBalance)) throw new FieldError("normalBalance", ACCOUNT_MESSAGES.normalBalance);
  assertValidParent(parent, input.type);
  const cashFlowGroup = resolveCashFlowGroup(code, input.isHeader, input.cashFlowGroup);
  const bank = normalizeBankFields(code, input.isHeader, input);
  return { code, name, type: input.type, normalBalance: input.normalBalance, isHeader: input.isHeader, cashFlowGroup, ...bank };
}

/** The first free code under a header, for the "Tambah sub-akun" form: under x-y000 the next
 * x-yN00 group, under x-yz00 the next x-yzNN. Null when the header's block is full or its code
 * has no block (a sub-account's code is then typed by hand). */
export function suggestChildCode(parentCode: string, takenCodes: ReadonlySet<string>): string | null {
  if (!isAccountCode(parentCode)) return null;
  const prefix = parentCode.slice(0, 2);
  const number = Number(parentCode.slice(2));
  const step = number % 1000 === 0 ? 100 : number % 100 === 0 ? 1 : 0;
  if (step === 0) return null;
  const blockEnd = step === 100 ? number + 900 : number + 99;
  for (let candidate = number + step; candidate <= blockEnd; candidate += step) {
    const code = `${prefix}${String(candidate).padStart(4, "0")}`;
    if (!takenCodes.has(code)) return code;
  }
  return null;
}

/** The type a code's class allows, when there is only one (the form preselects it). */
export function onlyTypeForCode(code: string): AccountType | null {
  const types = accountTypesForCode(code);
  return types.length === 1 ? types[0]! : null;
}
