import { jakartaDateOf } from "../dates";
import type { JournalLineDraft } from "../journal";
import { PAYMENT_GATEWAY_FEE_COMPONENT } from "./sales";
import { mappedAccount, resolveOrIssue, systemAccount, type PostingContext, type PostingEvent, type PostingOutcome, type PostingRule } from "./types";

// Midtrans MDR and payouts (docs/plans/accounting.md §4.2 W2, W5; D-8). The rule code ships in
// Session 9 against snapshots shaped like fee work A/B (a post-launch feature, not in the repo yet):
// A writes one order_channel_fees row of component `payment_gateway_fee` with `source` estimate |
// actual per paid checkout order; B overwrites it with the actual fee and fills order_settlements.
// Neither the component nor the `source` column exists yet, so these rules are not in
// defaultPostingSources(); Session 11 adds their loaders once A+B are deployed.
//
//   W2 (order_channel_fee, id, mdr), the order's paid_at: Dr 6-1203 Biaya payment gateway / Cr 1-1301
//      Piutang Midtrans, the row's amount (PPN included: Ammari is not PKP, D-21). B overwriting the
//      estimate changes the row in place: the engine reverses the estimate's journal and posts the
//      actual one, into the first open month when the paid month is closed (D-8, D-23). A refund
//      never reverses it (Midtrans keeps the MDR).
//   W5 (order_settlement, id, settled), settled_at: Dr the payout account (mapping
//      `cash.midtrans_payout`, default 1-1201) / Cr 1-1301, net_amount only. The fee half of D-1's
//      settlement entry is W2 (dated at payment), so order_settlements.fee_amount is never booked
//      again. A negative net (an adjustment row) books the other way round.

export const ORDER_CHANNEL_FEE_SOURCE_TYPE = "order_channel_fee";
export const ORDER_SETTLEMENT_SOURCE_TYPE = "order_settlement";

export type MdrSource = "estimate" | "actual";

export interface MdrFeeSnapshot {
  id: string;
  orderId: string;
  orderNo: string;
  component: string;
  amount: number;
  source: MdrSource;
  /** The order's paid_at; null for an order not (or no longer) paid. */
  paidAt: Date | null;
}

export interface MidtransSettlementSnapshot {
  id: string;
  orderId: string;
  orderNo: string;
  settledAt: Date;
  netAmount: number;
}

function signed(accountCode: string, amount: number, extra: Partial<JournalLineDraft>): JournalLineDraft {
  return { accountCode, debit: Math.max(amount, 0), credit: Math.max(-amount, 0), ...extra };
}

export function mdrOutcome(fee: MdrFeeSnapshot, context: PostingContext): PostingOutcome {
  if (fee.amount === 0) return { kind: "none" };
  return resolveOrIssue(() => {
    const d = { orderId: fee.orderId, channelId: "web" as const };
    const label = fee.source === "actual" ? "sebenarnya" : "perkiraan";
    return {
      kind: "journal",
      description: `Biaya Midtrans (${label}) pesanan ${fee.orderNo}`,
      lines: [signed(systemAccount(context, "expense.payment_gateway"), fee.amount, d), signed(systemAccount(context, "receivable.midtrans"), -fee.amount, d)],
    };
  });
}

export const mdrRule: PostingRule<MdrFeeSnapshot> = {
  name: "midtrans_mdr",
  ruleVersion: 1,
  events(fee, context): PostingEvent[] {
    if (fee.component !== PAYMENT_GATEWAY_FEE_COMPONENT) return [];
    const eventKey = { sourceType: ORDER_CHANNEL_FEE_SOURCE_TYPE, sourceId: fee.id, sourceEvent: "mdr" };
    if (!fee.paidAt) return [{ key: eventKey, sourceDate: context.postingStartDate, outcome: { kind: "none" } }];
    const date = jakartaDateOf(fee.paidAt);
    return [{ key: eventKey, sourceDate: date, outcome: date < context.postingStartDate ? { kind: "none" } : mdrOutcome(fee, context) }];
  },
};

export function settlementOutcome(settlement: MidtransSettlementSnapshot, context: PostingContext): PostingOutcome {
  if (settlement.netAmount === 0) return { kind: "none" };
  return resolveOrIssue(() => {
    const bank = mappedAccount(context, "cash.midtrans_payout", "unmapped_payment_method", { method: "midtrans_payout" });
    const d = { orderId: settlement.orderId, channelId: "web" as const };
    const lines = [signed(bank, settlement.netAmount, { ...d, cashAccountCode: bank }), signed(systemAccount(context, "receivable.midtrans"), -settlement.netAmount, d)];
    return { kind: "journal", description: `Pencairan Midtrans pesanan ${settlement.orderNo}`, lines: [...lines.filter((l) => l.debit > 0), ...lines.filter((l) => l.credit > 0)] };
  });
}

export const midtransSettlementRule: PostingRule<MidtransSettlementSnapshot> = {
  name: "midtrans_settlement",
  ruleVersion: 1,
  events(settlement, context): PostingEvent[] {
    const date = jakartaDateOf(settlement.settledAt);
    return [
      {
        key: { sourceType: ORDER_SETTLEMENT_SOURCE_TYPE, sourceId: settlement.id, sourceEvent: "settled" },
        sourceDate: date,
        outcome: date < context.postingStartDate ? { kind: "none" } : settlementOutcome(settlement, context),
      },
    ];
  },
};
