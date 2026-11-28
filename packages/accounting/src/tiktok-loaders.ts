import "server-only";
import { asc, eq } from "drizzle-orm";
import { marketplaceRefunds, orders, tiktokPayouts, tiktokStatements, tiktokStatementTransactions } from "@ammari/db/schema";
import type { Database } from "./ledger-write";
import type { MarketplaceRefundSnapshot } from "./rules/marketplace-refunds";
import type { TikTokAdjustmentSnapshot, TikTokPayoutSnapshot } from "./rules/tiktok-finance";

// Snapshot loaders for S7 (marketplace_refunds, T6) and M3/M5 (tiktok_payouts and the adjustment
// rows of tiktok_statement_transactions, T7). Read-only: the ledger never writes these tables.

export async function loadMarketplaceRefundSnapshots(db: Database): Promise<MarketplaceRefundSnapshot[]> {
  const rows = await db
    .select({
      id: marketplaceRefunds.id,
      channelRefundId: marketplaceRefunds.channelRefundId,
      amount: marketplaceRefunds.amount,
      refundedAt: marketplaceRefunds.refundedAt,
      kind: marketplaceRefunds.kind,
      orderId: orders.id,
      orderNo: orders.orderNo,
      channelId: orders.channelId,
      status: orders.status,
      shippedAt: orders.shippedAt,
      marketplaceShippedAt: orders.marketplaceShippedAt,
    })
    .from(marketplaceRefunds)
    .innerJoin(orders, eq(orders.id, marketplaceRefunds.orderId))
    .orderBy(asc(marketplaceRefunds.refundedAt), asc(marketplaceRefunds.id));
  // Only `refund_only` exists (CHECK); a later kind must get its own rule, never this one.
  return rows
    .filter((row) => row.kind === "refund_only")
    .map(({ orderId, orderNo, channelId, status, shippedAt, marketplaceShippedAt, kind: _kind, ...refund }) => ({
      ...refund,
      order: { id: orderId, orderNo, channelId, status, shippedAt, marketplaceShippedAt },
    }));
}

export async function loadTikTokPayoutSnapshots(db: Database): Promise<TikTokPayoutSnapshot[]> {
  return db
    .select({
      paymentId: tiktokPayouts.paymentId,
      amount: tiktokPayouts.amount,
      status: tiktokPayouts.status,
      paidTime: tiktokPayouts.paidTime,
      createTime: tiktokPayouts.createTime,
      heldReason: tiktokPayouts.heldReason,
      bankAccountLast4: tiktokPayouts.bankAccountLast4,
    })
    .from(tiktokPayouts)
    .orderBy(asc(tiktokPayouts.paidTime), asc(tiktokPayouts.paymentId));
}

/** Statement transactions that are not the order's own money (kind `adjustment`, T7). */
export async function loadTikTokAdjustmentSnapshots(db: Database): Promise<TikTokAdjustmentSnapshot[]> {
  return db
    .select({
      transactionId: tiktokStatementTransactions.transactionId,
      statementId: tiktokStatementTransactions.statementId,
      type: tiktokStatementTransactions.type,
      settlementAmount: tiktokStatementTransactions.settlementAmount,
      heldReason: tiktokStatementTransactions.heldReason,
      statementTime: tiktokStatements.statementTime,
      statementHeldReason: tiktokStatements.heldReason,
    })
    .from(tiktokStatementTransactions)
    .innerJoin(tiktokStatements, eq(tiktokStatements.statementId, tiktokStatementTransactions.statementId))
    .where(eq(tiktokStatementTransactions.kind, "adjustment"))
    .orderBy(asc(tiktokStatements.statementTime), asc(tiktokStatementTransactions.transactionId));
}
