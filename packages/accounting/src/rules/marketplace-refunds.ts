import { MARKETPLACE_CHANNEL_IDS, type ChannelId, type OrderStatus } from "@ammari/db/schema";
import { jakartaDateOf } from "../dates";
import { orderKey } from "./sales";
import { resolveOrIssue, systemAccount, type PostingContext, type PostingEvent, type PostingOutcome, type PostingRule } from "./types";

// S7 `marketplace_refund` (docs/plans/tiktok-shop-integration.md §5.2, decided Q10; T8): refund-only
// money, the buyer got money back and kept the goods (marketplace_refunds, written by T6).
//
//   (marketplace_refund, id, refunded), the Jakarta date of refunded_at:
//      Dr 4-1301 Retur penjualan / Cr Saldo Penjual of the order's channel, the refunded amount.
//
// The goods stay with the buyer: no stock return, no HPP reversal (no S2). The order keeps its status.
// Its own rule and source type, so SALES_RULE_VERSION is untouched and no sales journal reposts.
//
// Held behind the order's M1 (order, id, recognised) whenever M1 is due (recognised on or after the
// posting start), across the books like S4: a real event of its own, not a negation. So S7 never books
// against a sale the ledger does not hold yet, whatever blocks M1 (no real ship time yet, an unmapped
// channel, ...). A sale recognised before the posting start is in the opening balance, so its later
// refund posts on its own date.
//
// Never guessed (an issue instead): an order admin never shipped (a refund before handover is a
// cancel, not a return of revenue), an order since cancelled or returned (S4 would claw the whole
// total back, the refund on top would count twice), a channel that is not a marketplace.

export const MARKETPLACE_REFUND_SOURCE_TYPE = "marketplace_refund";
export const MARKETPLACE_REFUND_RULE_VERSION = 1;

export const MARKETPLACE_REFUND_NOT_SHIPPED_ISSUE = "marketplace_refund_not_shipped";
export const MARKETPLACE_REFUND_ORDER_UNDONE_ISSUE = "marketplace_refund_order_undone";
export const MARKETPLACE_REFUND_NOT_MARKETPLACE_ISSUE = "marketplace_refund_not_marketplace";

export interface MarketplaceRefundSnapshot {
  id: string;
  channelRefundId: string;
  amount: number;
  refundedAt: Date;
  order: {
    id: string;
    orderNo: string;
    channelId: ChannelId;
    status: OrderStatus;
    /** The app's own ship stamp (transitionOrderStatus). */
    shippedAt: Date | null;
    /** The real ship time M1 is dated by (null: M1 is still a posting issue). */
    marketplaceShippedAt: Date | null;
  };
}

function refundOutcome(refund: MarketplaceRefundSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const dims = { orderId: refund.order.id, channelId: refund.order.channelId, memo: refund.channelRefundId };
    return {
      kind: "journal",
      description: `Refund tanpa retur barang pesanan ${refund.order.orderNo} (${refund.channelRefundId})`,
      lines: [
        { accountCode: systemAccount(context, "contra_revenue.sales_return"), debit: refund.amount, credit: 0, ...dims },
        { accountCode: systemAccount(context, `seller_balance.${refund.order.channelId}`), debit: 0, credit: refund.amount, ...dims },
      ],
    };
  });
}

export function marketplaceRefundEvents(refund: MarketplaceRefundSnapshot, context: PostingContext): PostingEvent[] {
  const key = { sourceType: MARKETPLACE_REFUND_SOURCE_TYPE, sourceId: refund.id, sourceEvent: "refunded" };
  const sourceDate = jakartaDateOf(refund.refundedAt);
  const start = context.postingStartDate;
  const issue = (issueCode: string): PostingEvent => ({ key, sourceDate, outcome: { kind: "issue", issueCode, details: { orderNo: refund.order.orderNo, channelRefundId: refund.channelRefundId } } });

  if (sourceDate < start) return [{ key, sourceDate, outcome: { kind: "none" } }];
  if (!(MARKETPLACE_CHANNEL_IDS as readonly string[]).includes(refund.order.channelId)) return [issue(MARKETPLACE_REFUND_NOT_MARKETPLACE_ISSUE)];
  if (refund.order.status === "cancelled" || refund.order.status === "returned") return [issue(MARKETPLACE_REFUND_ORDER_UNDONE_ISSUE)];
  if (!refund.order.shippedAt) return [issue(MARKETPLACE_REFUND_NOT_SHIPPED_ISSUE)];

  // M1 is due when its date (the real ship time, else the app's ship stamp, exactly as the sales rule
  // decides it) is on or after the start: then S7 waits for M1's active journal.
  const recognitionDue = jakartaDateOf(refund.order.marketplaceShippedAt ?? refund.order.shippedAt) >= start;
  return [
    {
      key,
      sourceDate,
      outcome: refundOutcome(refund, context),
      ...(recognitionDue ? { requiresActiveJournalFor: orderKey(refund.order.id, "recognised"), requiresActiveJournalAcrossBooks: true } : {}),
    },
  ];
}

export const marketplaceRefundRule: PostingRule<MarketplaceRefundSnapshot> = {
  name: "marketplace_refund",
  ruleVersion: MARKETPLACE_REFUND_RULE_VERSION,
  events: marketplaceRefundEvents,
};
