import type { AccountType, TaxpayerType } from "@ammari/db/schema";
import { monthEndOf, monthStartOf } from "./dates";
import type { JournalLineDraft } from "./journal";

// What a month close posts (docs/plans/accounting.md §5.6, §5.7, §7; Session 11). Pure, so every rule
// is unit-tested; apps/admin lib/accounting/periods.ts reads the ledger and writes the journals under
// the month's exclusive lock.
//
// PPh final accrual (D-20), key (tax, pph_final, YYYY-MM), dated the month's last day:
//   base(m)     = the month's net sales on the ledger: Σ credit − debit over the revenue and
//                 contra-revenue accounts (Penjualan − Potongan penjualan − Retur penjualan): after
//                 vouchers, no ongkir (never revenue, D-6), marketplace sales gross of fees (fees are
//                 expenses, D-5), net of returns;
//   taxable(m)  = max(0, YTD(m) − exemption) − max(0, YTD(m−1) − exemption), the tax year Jan..Dec;
//   accrual(m)  = max(0, taxable(m) × rate_bps / 10000), rounded down to whole rupiah, per month (it
//                 matches the monthly setoran). PPh final is NEVER negative (owner, 27 Nov 2026): a month
//                 whose net sales are negative books 0 and never reverses an earlier month's accrual;
//   the tax_settings row in force for m (latest effective_from on or before m) gives the rate, the
//   exemption and the end date. No row, a rate that ends before the month's last day, or a company
//   taxpayer (the Rp500 juta exemption is for individuals; PT is D-24, out of scope) → no accrual, a
//   warning, never a guess.
// The exemption is measured on the net YTD base, returns included: a negative month lowers YTD, so the
// exemption headroom it frees is used again by the next months' sales before they are taxed (e.g.
// exemption 500, YTD 600 after January (100 taxed), February −200 (YTD 400, accrual 0), March +150
// (YTD 550: taxable = 50 − 0 = 50)). Nothing already booked is reversed or refunded.
//
// Year-end closing (§5.7), key (year_close, YYYY, closing), kind `closing`, dated 31 December, posted
// when December of an official year is closed: every revenue/expense account's balance for the year →
// 3-2001 Saldo laba; Prive (3-1002) → Modal pemilik (3-1001).

export const PPH_FINAL_SOURCE_TYPE = "tax";
export const PPH_FINAL_SOURCE_ID = "pph_final";
export const PPH_FINAL_RULE_VERSION = 1;
export const YEAR_CLOSE_SOURCE_TYPE = "year_close";
export const YEAR_CLOSE_SOURCE_EVENT = "closing";

/** Source types the close writes (not a posting rule): the runner never re-derives them and
 * Rekonsiliasi check 5 does not list them as orphans. */
export const PERIOD_CLOSE_SOURCE_TYPES: readonly string[] = [PPH_FINAL_SOURCE_TYPE, YEAR_CLOSE_SOURCE_TYPE];

export const pphFinalSourceEvent = (month: string) => monthStartOf(month).slice(0, 7);

export interface PphTaxSetting {
  effectiveFrom: string;
  taxpayerType: TaxpayerType;
  rateBps: number;
  annualExemptionAmount: number;
  rateValidUntil: string | null;
}

/** The row in force for `month`: the latest effective_from on or before it. */
export function taxSettingFor<T extends Pick<PphTaxSetting, "effectiveFrom">>(settings: readonly T[], month: string): T | null {
  let found: T | null = null;
  for (const setting of settings) if (setting.effectiveFrom <= month && (!found || setting.effectiveFrom > found.effectiveFrom)) found = setting;
  return found;
}

export type PphFinalProposal =
  | {
      kind: "accrual";
      month: string;
      effectiveFrom: string;
      monthBase: number;
      ytdBefore: number;
      ytdAfter: number;
      exemption: number;
      taxable: number;
      rateBps: number;
      amount: number;
    }
  | { kind: "no_setting"; month: string }
  | { kind: "rate_ended"; month: string; rateValidUntil: string }
  | { kind: "not_individual"; month: string };

/** Rounds down (the input is never negative here); exact for any safe-integer input (BigInt). */
function applyRate(taxable: number, rateBps: number): number {
  return Number((BigInt(taxable) * BigInt(rateBps)) / 10000n);
}

export function proposePphFinal(input: { month: string; setting: PphTaxSetting | null; ytdBefore: number; monthBase: number }): PphFinalProposal {
  const month = monthStartOf(input.month);
  const { setting } = input;
  if (!setting) return { kind: "no_setting", month };
  if (setting.rateValidUntil !== null && setting.rateValidUntil < monthEndOf(month)) return { kind: "rate_ended", month, rateValidUntil: setting.rateValidUntil };
  if (setting.taxpayerType !== "individual") return { kind: "not_individual", month };
  const exemption = setting.annualExemptionAmount;
  const ytdAfter = input.ytdBefore + input.monthBase;
  const taxable = Math.max(0, ytdAfter - exemption) - Math.max(0, input.ytdBefore - exemption);
  return {
    kind: "accrual",
    month,
    effectiveFrom: setting.effectiveFrom,
    monthBase: input.monthBase,
    ytdBefore: input.ytdBefore,
    ytdAfter,
    exemption,
    taxable,
    rateBps: setting.rateBps,
    amount: Math.max(0, applyRate(Math.max(0, taxable), setting.rateBps)),
  };
}

/** The accrual journal's lines (Dr Beban PPh final / Cr Utang PPh final), or [] when nothing is booked.
 * Never the other way round: PPh final is never negative. */
export function pphFinalLines(proposal: PphFinalProposal, accounts: { expense: string; liability: string }): JournalLineDraft[] {
  if (proposal.kind !== "accrual" || proposal.amount <= 0) return [];
  return [
    { accountCode: accounts.expense, debit: proposal.amount, credit: 0 },
    { accountCode: accounts.liability, debit: 0, credit: proposal.amount },
  ];
}

/** The close page's warning for a proposal that books nothing because of the settings. */
export function pphFinalWarning(proposal: PphFinalProposal): string | null {
  switch (proposal.kind) {
    case "accrual":
      return null;
    case "no_setting":
      return "Belum ada pengaturan pajak untuk bulan ini. Periksa Pengaturan Pajak.";
    case "rate_ended":
      return "Tarif PPh final berakhir, periksa pengaturan pajak.";
    case "not_individual":
      return "Usulan PPh final bulanan hanya untuk wajib pajak orang pribadi. Periksa Pengaturan Pajak.";
  }
}

/** Account types closed into Saldo laba at year end: every Laba rugi account. */
export const PROFIT_AND_LOSS_ACCOUNT_TYPES: readonly AccountType[] = ["revenue", "contra_revenue", "cogs", "expense", "other_income", "other_expense", "tax"];

export interface ClosingBalance {
  code: string;
  type: AccountType;
  /** Σ debit − Σ credit for the year. */
  net: number;
}

/** The year-end closing journal (§5.7): each P&L account's year balance zeroed against Saldo laba,
 * and Prive zeroed against Modal pemilik. [] when everything is already zero. Lines in account order. */
export function yearEndClosingLines(
  balances: readonly ClosingBalance[],
  accounts: { retainedEarnings: string; drawings: string; ownerCapital: string },
): JournalLineDraft[] {
  const lines: JournalLineDraft[] = [];
  let result = 0;
  for (const balance of [...balances].sort((a, b) => a.code.localeCompare(b.code))) {
    if (balance.net === 0 || !PROFIT_AND_LOSS_ACCOUNT_TYPES.includes(balance.type)) continue;
    lines.push({ accountCode: balance.code, debit: Math.max(-balance.net, 0), credit: Math.max(balance.net, 0) });
    // A debit balance (expense) reduces the result; a credit balance (revenue) adds to it.
    result -= balance.net;
  }
  if (result !== 0) lines.push({ accountCode: accounts.retainedEarnings, debit: Math.max(-result, 0), credit: Math.max(result, 0), memo: result > 0 ? "Laba tahun berjalan" : "Rugi tahun berjalan" });
  const drawings = balances.find((balance) => balance.code === accounts.drawings)?.net ?? 0;
  if (drawings !== 0) {
    lines.push({ accountCode: accounts.drawings, debit: Math.max(-drawings, 0), credit: Math.max(drawings, 0) });
    lines.push({ accountCode: accounts.ownerCapital, debit: Math.max(drawings, 0), credit: Math.max(-drawings, 0), memo: "Prive ditutup ke modal" });
  }
  return lines;
}
