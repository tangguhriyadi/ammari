import {
  ACCOUNT_CODE_CLASS_TYPES,
  CASH_BANK_ACCOUNT_CODE_PATTERN,
  INVENTORY_ACCOUNT_CODE_PATTERN,
  type AccountType,
} from "@ammari/db/schema";

// What an account and a mapping may be (docs/plans/accounting.md Session 3 and §8.1). The account
// editor and the mapping editor (apps/admin) check these before writing, to give a clear message;
// migration 0051's CHECKs and triggers refuse the same things in the database, which is the real
// guard. Keep the two in sync: migration-0051.test.ts runs the same cases against the triggers.

const CASH_BANK_CODE = new RegExp(CASH_BANK_ACCOUNT_CODE_PATTERN);
const INVENTORY_CODE = new RegExp(INVENTORY_ACCOUNT_CODE_PATTERN);
const ACCOUNT_CODE = /^[1-9]-[0-9]{4}$/;

export function isAccountCode(code: string): boolean {
  return ACCOUNT_CODE.test(code);
}

/** A Kas & Bank account code, 1-11xx or 1-12xx (D-17). */
export function isCashBankAccountCode(code: string): boolean {
  return CASH_BANK_CODE.test(code);
}

/** An inventory account code, 1-15xx. */
export function isInventoryAccountCode(code: string): boolean {
  return INVENTORY_CODE.test(code);
}

/** The types an account code's leading digit allows (1 asset ... 9 tax). */
export function accountTypesForCode(code: string): readonly AccountType[] {
  const digit = code.charAt(0) as keyof typeof ACCOUNT_CODE_CLASS_TYPES;
  return ACCOUNT_CODE_CLASS_TYPES[digit] ?? [];
}

export function accountCodeMatchesType(code: string, type: AccountType): boolean {
  return isAccountCode(code) && accountTypesForCode(code).includes(type);
}

/** The groups of mapping keys the editor knows, by what their target must be. */
export type MappingFamily =
  | "expense_category"
  | "expense_item"
  | "cash_method"
  | "midtrans_payout"
  | "tiktok_payout"
  | "tiktok_adjustment"
  | "revenue_channel"
  | "supplier_payable";

/** The system key of 1-1303 Saldo Penjual TikTok: an adjustment moves money in or out of it, so it
 * is never the adjustment's own counter-account (the journal would net to nothing). */
export const TIKTOK_SELLER_BALANCE_SYSTEM_KEY = "seller_balance.tiktok";

export function mappingFamily(mappingKey: string): MappingFamily | null {
  if (mappingKey.startsWith("expense.category.")) return "expense_category";
  if (mappingKey.startsWith("expense.item.")) return "expense_item";
  if (mappingKey.startsWith("cash.method.")) return "cash_method";
  if (mappingKey === "cash.midtrans_payout") return "midtrans_payout";
  if (mappingKey === "cash.tiktok_payout") return "tiktok_payout";
  if (mappingKey.startsWith("tiktok.adjustment.")) return "tiktok_adjustment";
  if (mappingKey.startsWith("revenue.channel.")) return "revenue_channel";
  if (mappingKey.startsWith("supplier_payable.")) return "supplier_payable";
  return null;
}

export interface MappingTargetAccount {
  code: string;
  type: AccountType;
  isHeader: boolean;
  isActive: boolean;
  /** accounts.system_key, when the caller has it (needed for tiktok.adjustment.*). */
  systemKey?: string | null;
}

/** Why an account cannot be a mapping's target, or null when it can:
 * - not_found: no such account;
 * - not_postable: a header or an inactive account;
 * - inventory: an expense category/item onto 1-15xx (D-14, the fabric-as-inventory guard);
 * - not_cash_bank: a payment method, the Midtrans or the TikTok payout onto anything but Kas & Bank;
 * - not_revenue: a channel's sales onto anything but a revenue account;
 * - not_liability: a supplier payable onto anything but a liability;
 * - seller_balance: a TikTok adjustment type onto Saldo Penjual TikTok itself (T8). */
export type MappingTargetProblem = "not_found" | "not_postable" | "inventory" | "not_cash_bank" | "not_revenue" | "not_liability" | "seller_balance";

export function mappingTargetProblem(mappingKey: string, account: MappingTargetAccount | null | undefined): MappingTargetProblem | null {
  if (!account) return "not_found";
  if (account.isHeader || !account.isActive) return "not_postable";
  switch (mappingFamily(mappingKey)) {
    case "expense_category":
    case "expense_item":
      return isInventoryAccountCode(account.code) ? "inventory" : null;
    case "tiktok_adjustment":
      if (isInventoryAccountCode(account.code)) return "inventory";
      return account.systemKey === TIKTOK_SELLER_BALANCE_SYSTEM_KEY ? "seller_balance" : null;
    case "cash_method":
    case "midtrans_payout":
    case "tiktok_payout":
      return isCashBankAccountCode(account.code) ? null : "not_cash_bank";
    case "revenue_channel":
      return account.type === "revenue" ? null : "not_revenue";
    case "supplier_payable":
      return account.type === "liability" ? null : "not_liability";
    default:
      return null;
  }
}
