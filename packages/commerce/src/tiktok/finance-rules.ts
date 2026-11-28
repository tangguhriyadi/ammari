// Pure rules for TikTok fees (docs/plans/tiktok-shop-integration.md §5.3, T7; decided Q8, Q9). No
// database, no clock. finance.ts stores the raw lines and runs these decisions under the order's lock.
//
//   - The fee-type table maps TikTok's own fee type names to the order_channel_fees components M2
//     already books: every component goes to 6-1201 Biaya platform marketplace except
//     `seller_shipping_subsidy`, which stays 6-1202 (D-5, D-6). The transaction fee is NOT
//     `payment_gateway_fee` (that is Midtrans W2 only), and nothing maps to `other` by default.
//   - A type that is not in the table holds the order's fees (`fee_type_unmapped`), naming the types,
//     never summed into `other`. The accountant reviews the table once (§12.2); its rows are TikTok's
//     documented names and are checked against the first real statements in T0.
//   - Estimate, then actual (Q9): the actual (statement transactions, SKU-level) replaces the estimate
//     (unsettled transactions) once every settled order transaction of the order has its lines. An
//     order with neither has no fees written: it is never booked as zero fees.
//   - A cost is TikTok's NEGATIVE amount (a deduction from the seller's settlement). A component whose
//     net is a credit is held (`fee_negative`): order_channel_fees.amount is never negative.
//     T0 confirms the sign on real statements; if TikTok reports costs as positive, every order is held
//     `fee_negative` (loud), never booked the wrong way round.

import type { ChannelFeeComponent, TikTokFeeSource, TikTokOrderFeeHeldReason } from "@ammari/db/schema";
import { TIKTOK_ORDER_TRANSACTION_TYPES, type TikTokFeeGroup, type TikTokFeeLine } from "@ammari/tiktok-shop";

/** TikTok reports a cost as a negative amount: component cost = −Σ amounts. */
export const TIKTOK_FEE_COST_SIGN = -1;

/** `<group>.<TikTok fee type>` → component. Reviewed once by the accountant (plan §5.3, §12.2). */
export const TIKTOK_FEE_TYPE_COMPONENTS: Readonly<Record<string, ChannelFeeComponent>> = Object.freeze({
  // fee_tax_breakdown.fee
  "fee.platform_commission_amount": "platform_commission",
  "fee.referral_fee_amount": "platform_commission",
  "fee.dynamic_commission_amount": "platform_commission",
  "fee.transaction_fee_amount": "admin_fee",
  "fee.affiliate_commission_amount": "affiliate_commission",
  "fee.affiliate_partner_commission_amount": "affiliate_commission",
  "fee.affiliate_ads_commission_amount": "affiliate_commission",
  "fee.sfp_service_fee_amount": "service_fee",
  "fee.voucher_xtra_service_fee_amount": "service_fee",
  "fee.flash_sales_service_fee_amount": "service_fee",
  "fee.live_specials_fee_amount": "service_fee",
  "fee.mall_service_fee_amount": "service_fee",
  // shipping_cost_breakdown: their net is the seller's own shipping cost (6-1202, D-6). Return and
  // replacement shipping are not here on purpose: D-7 books refunded ongkir elsewhere, so the
  // accountant decides them.
  "shipping.actual_shipping_fee_amount": "seller_shipping_subsidy",
  "shipping.shipping_fee_discount_amount": "seller_shipping_subsidy",
  "shipping.platform_shipping_fee_discount_amount": "seller_shipping_subsidy",
  "shipping.customer_paid_shipping_fee_amount": "seller_shipping_subsidy",
});

export function tiktokFeeKey(group: TikTokFeeGroup, type: string): string {
  return `${group}.${type}`;
}

export function tiktokFeeComponent(group: TikTokFeeGroup, type: string): ChannelFeeComponent | null {
  const key = tiktokFeeKey(group, type);
  return Object.hasOwn(TIKTOK_FEE_TYPE_COMPONENTS, key) ? TIKTOK_FEE_TYPE_COMPONENTS[key]! : null;
}

type FeeLine = Pick<TikTokFeeLine, "group" | "type" | "amount"> & { skuId?: string };

/** What is stored for one TikTok order, gathered by finance.ts. */
export interface TikTokFeeEvidence {
  /** Lines of every unsettled transaction of the order; `held` when one of them is not usable. */
  estimate: { lines: readonly FeeLine[]; held: TikTokOrderFeeHeldReason | null; transactions: number };
  /** Lines of every settled order transaction (ORDER/REFUND) whose SKU lines are stored and add up;
   * `pending` = transactions whose lines are not fetched yet; `held` = one of them is not usable. */
  actual: { lines: readonly FeeLine[]; held: TikTokOrderFeeHeldReason | null; pending: number; transactions: number };
}

export type TikTokFeeComponents = Partial<Record<ChannelFeeComponent, number>>;

export type TikTokOrderFeeDecision =
  | { kind: "none" }
  | { kind: "write"; source: TikTokFeeSource; components: TikTokFeeComponents }
  | { kind: "held"; source: TikTokFeeSource; reason: TikTokOrderFeeHeldReason; unmappedTypes: string[] };

function aggregate(source: TikTokFeeSource, lines: readonly FeeLine[]): TikTokOrderFeeDecision {
  const unmapped = new Set<string>();
  const sums = new Map<ChannelFeeComponent, number>();
  for (const item of lines) {
    const component = tiktokFeeComponent(item.group, item.type);
    if (!component) {
      // A zero amount moves no money: it is kept as a line (visible) but never holds the order.
      if (item.amount !== 0) unmapped.add(tiktokFeeKey(item.group, item.type));
      continue;
    }
    sums.set(component, (sums.get(component) ?? 0) + item.amount);
  }
  if (unmapped.size > 0) return { kind: "held", source, reason: "fee_type_unmapped", unmappedTypes: [...unmapped].sort() };
  const components: TikTokFeeComponents = {};
  for (const [component, sum] of sums) {
    const cost = TIKTOK_FEE_COST_SIGN * sum;
    if (cost < 0) return { kind: "held", source, reason: "fee_negative", unmappedTypes: [] };
    if (!Number.isSafeInteger(cost)) return { kind: "held", source, reason: "money_format", unmappedTypes: [] };
    if (cost > 0) components[component] = cost;
  }
  return { kind: "write", source, components };
}

/** The actual when every settled order transaction has its lines; else the estimate; else nothing. */
export function decideTikTokOrderFees(evidence: TikTokFeeEvidence): TikTokOrderFeeDecision {
  const { actual, estimate } = evidence;
  if (actual.transactions > 0) {
    // A settled transaction that cannot be read needs a person; the estimate is no longer the truth.
    if (actual.held) return { kind: "held", source: "actual", reason: actual.held, unmappedTypes: [] };
    if (actual.pending === 0) return aggregate("actual", actual.lines);
    // Some settled transactions have their lines, a later one (a refund) does not yet: wait, so the
    // order never falls back from the actual to an older estimate. What was written stays.
    if (actual.transactions > actual.pending) return { kind: "none" };
  }
  if (estimate.transactions === 0) return { kind: "none" };
  if (estimate.held) return { kind: "held", source: "estimate", reason: estimate.held, unmappedTypes: [] };
  return aggregate("estimate", estimate.lines);
}

/** Σ fee + tax lines = the transaction's fee_tax total, Σ shipping lines = its shipping total. An
 * absent total never passes: a renamed total (or a renamed breakdown with it) must not read as "no
 * fees" (TikTok sends "0" when there is nothing). */
export function checkTikTokTransactionFeeSums(lines: readonly FeeLine[], totals: { feeTax: number | null; shippingCost: number | null }): boolean {
  let feeTax = 0;
  let shipping = 0;
  for (const item of lines) {
    if (item.group === "shipping") shipping += item.amount;
    else feeTax += item.amount;
  }
  if (totals.feeTax === null || totals.shippingCost === null) return false;
  return feeTax === totals.feeTax && shipping === totals.shippingCost;
}

/** Σ transactions' settlement = the statement's settlement (plan §5.4 check (b)). */
export function checkTikTokStatementSum(settlement: number | null, transactionSettlements: readonly (number | null)[]): boolean {
  if (settlement === null || transactionSettlements.some((value) => value === null)) return false;
  return transactionSettlements.reduce<number>((sum, value) => sum + (value ?? 0), 0) === settlement;
}

/** Every other type is an adjustment, stored as received and mapped by the accountant in Pemetaan Akun
 * (T8, Q8). Defined with the parser (an ORDER/REFUND without its order is refused there). */
export { TIKTOK_ORDER_TRANSACTION_TYPES };
