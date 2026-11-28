import { jakartaDateOf } from "../dates";
import { mappedAccount, resolveOrIssue, systemAccount, type PostingContext, type PostingEvent, type PostingOutcome, type PostingRule } from "./types";

// TikTok Shop money that is not an order (docs/plans/tiktok-shop-integration.md §5.4, T8; D-11, Q8, Q17).
// The ledger only reads what T7 stored (tiktok_payouts, tiktok_statement_transactions); nothing here
// calls TikTok or writes a source table.
//
//   M3 (tiktok_payout, payment_id, paid_out), the Jakarta date of paid_time, only once TikTok reports
//      the payout PAID: Dr cash.tiktok_payout (default 1-1201 Bank utama, Q17) / Cr 1-1303 Saldo
//      Penjual TikTok, the payout amount. Replaces the manual withdrawal journal for TikTok (the
//      template stays for Shopee). A payout before the posting start is in the opening balance.
//      PAID without a readable amount or time → `tiktok_payout_unreadable`; any other status
//      (PROCESSING, FAILED, ...) → nothing yet.
//   M5 (tiktok_statement_transaction, id, adjustment), the Jakarta date of the statement's
//      statement_time: a statement transaction that is not an order or a refund (compensation,
//      deductions, ads paid from the balance, ...). Its signed settlement amount moves 1-1303; the
//      other side is the account the accountant mapped for its type in Pemetaan Akun,
//      `tiktok.adjustment.<type in lower case>` (Q8). No mapping → `tiktok_adjustment_unmapped`,
//      never guessed (ads included: the editor only suggests 6-1101 Iklan). Money that did not
//      parse, or a statement held as not adding up → `tiktok_statement_held`.

export const TIKTOK_PAYOUT_SOURCE_TYPE = "tiktok_payout";
export const TIKTOK_PAYOUT_RULE_VERSION = 1;
export const TIKTOK_STATEMENT_TRANSACTION_SOURCE_TYPE = "tiktok_statement_transaction";
export const TIKTOK_ADJUSTMENT_RULE_VERSION = 1;

export const TIKTOK_PAYOUT_MAPPING_KEY = "cash.tiktok_payout";
export const TIKTOK_ADJUSTMENT_MAPPING_PREFIX = "tiktok.adjustment.";

export const UNMAPPED_TIKTOK_PAYOUT_ISSUE = "unmapped_tiktok_payout";
export const TIKTOK_PAYOUT_UNREADABLE_ISSUE = "tiktok_payout_unreadable";
export const TIKTOK_ADJUSTMENT_UNMAPPED_ISSUE = "tiktok_adjustment_unmapped";
export const TIKTOK_STATEMENT_HELD_ISSUE = "tiktok_statement_held";
export const TIKTOK_SOURCE_ID_TOO_LONG_ISSUE = "tiktok_source_id_too_long";

/** The payout status TikTok uses for money that reached the bank (T7 assumption, checked in T0). */
export const TIKTOK_PAYOUT_PAID_STATUS = "PAID";

/** journal_entries.source_id is at most 100 characters (journal_entries_source_check). */
const MAX_SOURCE_ID_LENGTH = 100;

const TIKTOK_SELLER_BALANCE = "seller_balance.tiktok";

/** TikTok's types are `[A-Z0-9_]` codes (T7's parser refuses anything else), so lower case is a valid
 * mapping-key segment and two types never share a key. */
export function tiktokAdjustmentMappingKey(type: string): string {
  return `${TIKTOK_ADJUSTMENT_MAPPING_PREFIX}${type.toLowerCase()}`;
}

/** The type back from its mapping key (upper case, as TikTok sends it), or null. */
export function tiktokAdjustmentTypeOfKey(mappingKey: string): string | null {
  if (!mappingKey.startsWith(TIKTOK_ADJUSTMENT_MAPPING_PREFIX)) return null;
  const type = mappingKey.slice(TIKTOK_ADJUSTMENT_MAPPING_PREFIX.length).toUpperCase();
  return /^[A-Z0-9_]{1,64}$/.test(type) ? type : null;
}

/** A type whose name marks it as ads paid from the balance: Pemetaan Akun SUGGESTS 6-1101 Iklan for
 * it (owner, §3.6). Only a suggestion: the type is unmapped until the accountant saves a mapping. */
export function isTikTokAdsAdjustmentType(type: string): boolean {
  return /(^|_)(ADS?|ADVERTIS[A-Z]*|PROMOTE)(_|$)/.test(type.toUpperCase());
}

export interface TikTokPayoutSnapshot {
  paymentId: string;
  amount: number | null;
  status: string | null;
  paidTime: Date | null;
  createTime: Date | null;
  heldReason: string | null;
  bankAccountLast4: string | null;
}

export function tiktokPayoutEvents(payout: TikTokPayoutSnapshot, context: PostingContext): PostingEvent[] {
  const key = { sourceType: TIKTOK_PAYOUT_SOURCE_TYPE, sourceId: payout.paymentId, sourceEvent: "paid_out" };
  const when = payout.paidTime ?? payout.createTime;
  const sourceDate = when ? jakartaDateOf(when) : context.postingStartDate;
  const event = (outcome: PostingOutcome): PostingEvent[] => [{ key, sourceDate, outcome }];
  if (payout.status !== TIKTOK_PAYOUT_PAID_STATUS) return event({ kind: "none" });
  if (when && sourceDate < context.postingStartDate) return event({ kind: "none" });
  if (payout.paymentId.length > MAX_SOURCE_ID_LENGTH) return event({ kind: "issue", issueCode: TIKTOK_SOURCE_ID_TOO_LONG_ISSUE, details: { paymentId: payout.paymentId.slice(0, 40) } });
  if (payout.heldReason !== null || payout.amount === null || payout.paidTime === null || payout.amount < 0) {
    return event({ kind: "issue", issueCode: TIKTOK_PAYOUT_UNREADABLE_ISSUE, details: { paymentId: payout.paymentId, heldReason: payout.heldReason, paidTimeMissing: payout.paidTime === null } });
  }
  if (payout.amount === 0) return event({ kind: "none" });
  const amount = payout.amount;
  return event(
    resolveOrIssue(() => {
      const bank = mappedAccount(context, TIKTOK_PAYOUT_MAPPING_KEY, UNMAPPED_TIKTOK_PAYOUT_ISSUE);
      const memo = payout.bankAccountLast4 ? `${payout.paymentId} (rekening ...${payout.bankAccountLast4})` : payout.paymentId;
      return {
        kind: "journal",
        description: `Pencairan Saldo Penjual TikTok ${payout.paymentId}`,
        lines: [
          { accountCode: bank, debit: amount, credit: 0, channelId: "tiktok", cashAccountCode: bank, memo },
          { accountCode: systemAccount(context, TIKTOK_SELLER_BALANCE), debit: 0, credit: amount, channelId: "tiktok", cashAccountCode: bank, memo },
        ],
      };
    }),
  );
}

export const tiktokPayoutRule: PostingRule<TikTokPayoutSnapshot> = {
  name: "tiktok_payout",
  ruleVersion: TIKTOK_PAYOUT_RULE_VERSION,
  events: tiktokPayoutEvents,
};

export interface TikTokAdjustmentSnapshot {
  transactionId: string;
  statementId: string;
  /** TikTok's type as received. */
  type: string;
  /** Signed, as TikTok reports it: positive credits the seller balance. Null when held. */
  settlementAmount: number | null;
  heldReason: string | null;
  statementTime: Date;
  statementHeldReason: string | null;
}

export function tiktokAdjustmentEvents(adjustment: TikTokAdjustmentSnapshot, context: PostingContext): PostingEvent[] {
  const key = { sourceType: TIKTOK_STATEMENT_TRANSACTION_SOURCE_TYPE, sourceId: adjustment.transactionId, sourceEvent: "adjustment" };
  const sourceDate = jakartaDateOf(adjustment.statementTime);
  const event = (outcome: PostingOutcome): PostingEvent[] => [{ key, sourceDate, outcome }];
  if (sourceDate < context.postingStartDate) return event({ kind: "none" });
  if (adjustment.transactionId.length > MAX_SOURCE_ID_LENGTH) {
    return event({ kind: "issue", issueCode: TIKTOK_SOURCE_ID_TOO_LONG_ISSUE, details: { transactionId: adjustment.transactionId.slice(0, 40), statementId: adjustment.statementId } });
  }
  if (adjustment.heldReason !== null || adjustment.statementHeldReason !== null || adjustment.settlementAmount === null) {
    return event({
      kind: "issue",
      issueCode: TIKTOK_STATEMENT_HELD_ISSUE,
      details: { statementId: adjustment.statementId, type: adjustment.type, heldReason: adjustment.heldReason ?? adjustment.statementHeldReason },
    });
  }
  const amount = adjustment.settlementAmount;
  if (amount === 0) return event({ kind: "none" });
  const mappingKey = tiktokAdjustmentMappingKey(adjustment.type);
  return event(
    resolveOrIssue(() => {
      const counter = mappedAccount(context, mappingKey, TIKTOK_ADJUSTMENT_UNMAPPED_ISSUE, { type: adjustment.type, statementId: adjustment.statementId });
      const balance = systemAccount(context, TIKTOK_SELLER_BALANCE);
      const dims = { channelId: "tiktok" as const, memo: `${adjustment.type} ${adjustment.statementId}` };
      const [debit, credit] = amount > 0 ? [balance, counter] : [counter, balance];
      return {
        kind: "journal",
        description: `Penyesuaian TikTok ${adjustment.type} (laporan ${adjustment.statementId})`,
        lines: [
          { accountCode: debit, debit: Math.abs(amount), credit: 0, ...dims },
          { accountCode: credit, debit: 0, credit: Math.abs(amount), ...dims },
        ],
      };
    }),
  );
}

export const tiktokAdjustmentRule: PostingRule<TikTokAdjustmentSnapshot> = {
  name: "tiktok_adjustment",
  ruleVersion: TIKTOK_ADJUSTMENT_RULE_VERSION,
  events: tiktokAdjustmentEvents,
};
