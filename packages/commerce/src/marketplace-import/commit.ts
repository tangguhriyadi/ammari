import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  CHANNEL_FEE_COMPONENTS,
  importBatches,
  importBatchOrders,
  orderChannelFees,
  orderItems,
  orders,
  productVariants,
  type ChannelFeeComponent,
  type OrderStatus,
} from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database, type Tx } from "../db";
import { ActionError, FieldError, isPostgresErrorCode } from "../errors";
import { withAttentionFlags, withoutAttentionFlag } from "../orders/attention";
import { decrementStockForOrderItems, transitionOrderStatus } from "../orders/lifecycle";
import { generateOrderNumber } from "../orders/order-number";

// The write path of the marketplace order import (docs/plans/marketplace-import.md §6, session 4).
// The planner lives in apps/admin (it needs the spreadsheet parser); this module owns the one
// transaction Simpan runs, next to createOrder / transitionOrderStatus as CLAUDE.md requires for
// order and stock writes:
//
//   1. pg_advisory_xact_lock per channel: two Simpan clicks, tabs or people run one after the other;
//   2. the caller re-plans INSIDE the transaction, after the lock (`replan`), and decides whether to
//      go on (digest, save blockers);
//   3. the batch row, then every new order (INSERT ... ON CONFLICT DO NOTHING), then every existing
//      order (SELECT ... FOR UPDATE, re-checked against the plan, conditional UPDATEs), fees, history
//      and audit rows.
//
// Anything that no longer matches the plan once its row is locked (an order created meanwhile, a
// status or amount moved, stock taken) is drift: the whole transaction rolls back and the caller
// shows a fresh preview. Nothing is ever check-then-written.

export type MarketplaceChannelId = "shopee" | "tiktok";
export type FeeAmounts = Partial<Record<ChannelFeeComponent, number>>;

export interface MarketplaceCommitLine {
  sku: string;
  qty: number;
  unitPrice: number;
}

export interface MarketplaceSkuMatch {
  fileSku: string;
  adminSku: string;
}

export interface MarketplaceCreate {
  /** Normalized (trimmed, uppercase): the exact value stored in orders.channel_order_no. */
  channelOrderNo: string;
  rawStatus: string;
  orderedAt: Date;
  lines: MarketplaceCommitLine[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  /** Every component whose column was in the file (a known zero included). */
  fees: FeeAmounts;
  /** Run in order after creating at `to_ship`. */
  transitions: OrderStatus[];
  setReturnPending: boolean;
  skuMatches: MarketplaceSkuMatch[];
}

/** What the planner saw on the admin order; re-checked under the row lock before anything is written. */
export interface MarketplaceExpectedOrder {
  status: OrderStatus;
  discountAmount: number;
  totalAmount: number;
  channelStatus: string | null;
  returnPending: boolean;
  lines: MarketplaceCommitLine[];
}

export interface MarketplaceUpdate {
  orderId: string;
  channelOrderNo: string;
  rawStatus: string;
  expected: MarketplaceExpectedOrder;
  transitions: OrderStatus[];
  setReturnPending: boolean;
  clearReturnPending: boolean;
  discount: { before: number; after: number } | null;
  totalAmount: { before: number; after: number } | null;
  /** Only the components that change; `before: null` = no row yet. */
  fees: { component: ChannelFeeComponent; before: number | null; after: number }[];
  channelStatus: { before: string | null; after: string } | null;
  skuMatches: MarketplaceSkuMatch[];
}

export interface MarketplaceCommitPlan {
  creates: MarketplaceCreate[];
  updates: MarketplaceUpdate[];
  /** Every manual match the plan used, with the orders it applied to (one audit row each). */
  skuMatches: (MarketplaceSkuMatch & { channelOrderNos: string[] })[];
  /** Stored on the batch for the history view (counts, totals, matches). Never buyer data. */
  summary: Record<string, unknown>;
}

export type ReplanDecision<T> = { proceed: true; plan: MarketplaceCommitPlan } | { proceed: false; result: T };

export interface CommitMarketplaceImportInput<T> {
  channelId: MarketplaceChannelId;
  actorStaffUserId: string;
  batch: { filename: string; fileSha256: string; rowCount: number };
  /** Runs inside the transaction, after the channel lock: re-plan with `tx` and decide. */
  replan: (tx: Tx) => Promise<ReplanDecision<T>>;
}

export interface CommittedImport {
  batchId: string;
  createdOrderIds: string[];
  updatedOrderIds: string[];
  /** SKUs whose stock moved (sales of new orders, returns of cancelled/returned ones): the
   * storefront availability to refresh after commit. */
  stockSkus: string[];
}

export type CommitMarketplaceImportResult<T> =
  | { status: "committed"; value: CommittedImport }
  | { status: "aborted"; result: T }
  /** Something changed between the in-transaction plan and its row locks; nothing was written. */
  | { status: "drift"; reason: string }
  /** Another write held a row this import needs (lock timeout or deadlock); nothing was written. */
  | { status: "busy" };

/** How long one row lock may be waited for before the import gives up as `busy` (a stock count or a
 * web payment holding a SKU). The channel's own advisory lock is taken before this applies. */
const ROW_LOCK_TIMEOUT = "10s";

/** Rolls the commit back; caught outside the transaction and reported as `drift`. */
export class MarketplaceImportDriftError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "MarketplaceImportDriftError";
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function feesInCanonicalOrder(fees: FeeAmounts): [ChannelFeeComponent, number][] {
  return CHANNEL_FEE_COMPONENTS.flatMap((component): [ChannelFeeComponent, number][] => {
    const amount = fees[component];
    return amount === undefined ? [] : [[component, amount]];
  });
}

/** A step through transitionOrderStatus (the only status path). Its refusals (the status moved, a
 * stock sale refused) mean the plan is stale, not a bug. */
async function runTransitions(tx: Tx, orderId: string, steps: readonly OrderStatus[], actorStaffUserId: string, channelOrderNo: string): Promise<void> {
  for (const step of steps) {
    try {
      await transitionOrderStatus(orderId, step, actorStaffUserId, tx);
    } catch (error) {
      if (error instanceof ActionError || error instanceof FieldError) {
        throw new MarketplaceImportDriftError(`transition of ${channelOrderNo} to ${step} refused: ${error.message}`);
      }
      throw error;
    }
  }
}

function sameLines(stored: readonly MarketplaceCommitLine[], expected: readonly MarketplaceCommitLine[]): boolean {
  if (stored.length !== expected.length) return false;
  const bySku = new Map(stored.map((line) => [line.sku, line]));
  return expected.every((line) => {
    const item = bySku.get(line.sku);
    return item !== undefined && item.qty === line.qty && item.unitPrice === line.unitPrice;
  });
}

async function createOrderFromImport(tx: Tx, entry: MarketplaceCreate, channelId: MarketplaceChannelId, batchId: string, actorStaffUserId: string, now: Date): Promise<string> {
  const orderNo = await generateOrderNumber(tx, now);
  const [inserted] = await tx
    .insert(orders)
    .values({
      channelId,
      orderNo,
      channelOrderNo: entry.channelOrderNo,
      status: "to_ship",
      orderDate: entry.orderedAt,
      subtotalAmount: entry.subtotalAmount,
      shippingAmount: 0,
      discountAmount: entry.discountAmount,
      totalAmount: entry.totalAmount,
      importBatchId: batchId,
      // Imported orders carry no buyer data at all (owner decision 9) and no staff creator: the
      // batch's uploaded_by attributes them.
      customerId: null,
      buyerUsername: null,
      shippingAddress: null,
      notes: null,
      createdByStaffUserId: null,
      channelStatus: entry.rawStatus,
      channelSyncedAt: now,
    })
    .onConflictDoNothing({ target: [orders.channelId, orders.channelOrderNo] })
    .returning({ id: orders.id });
  // Someone created this order since the plan (another import, a manual entry): never a second write.
  if (!inserted) throw new MarketplaceImportDriftError(`order ${entry.channelOrderNo} exists since the plan`);

  const items = await tx
    .insert(orderItems)
    .values(entry.lines.map((line) => ({ orderId: inserted.id, sku: line.sku, qty: line.qty, unitPrice: line.unitPrice, listUnitPrice: null, unitCost: 0 })))
    .returning({ id: orderItems.id, sku: orderItems.sku, qty: orderItems.qty });
  try {
    await decrementStockForOrderItems(tx, items, actorStaffUserId);
  } catch (error) {
    // Stock was taken since the plan (the planner checked it file-wide).
    if (error instanceof FieldError) throw new MarketplaceImportDriftError(`stock for ${entry.channelOrderNo}: ${error.message}`);
    throw error;
  }

  const fees = feesInCanonicalOrder(entry.fees);
  if (fees.length > 0) {
    await tx.insert(orderChannelFees).values(fees.map(([component, amount]) => ({ orderId: inserted.id, component, amount, importBatchId: batchId })));
  }
  await runTransitions(tx, inserted.id, entry.transitions, actorStaffUserId, entry.channelOrderNo);
  if (entry.setReturnPending) {
    await tx.update(orders).set({ needsAttention: withAttentionFlags(["marketplace_return_pending"]) }).where(eq(orders.id, inserted.id));
  }

  const finalStatus = entry.transitions.at(-1) ?? "to_ship";
  const changes = {
    status: finalStatus,
    rawStatus: entry.rawStatus,
    lines: entry.lines.map((line) => ({ sku: line.sku, qty: line.qty, unitPrice: line.unitPrice })),
    subtotalAmount: entry.subtotalAmount,
    discountAmount: entry.discountAmount,
    totalAmount: entry.totalAmount,
    fees: Object.fromEntries(fees),
    returnPending: entry.setReturnPending,
    skuMatches: entry.skuMatches,
  };
  await tx.insert(importBatchOrders).values({ importBatchId: batchId, orderId: inserted.id, action: "created", changes });
  await writeAuditLog(tx, {
    actorStaffUserId,
    action: "import_create",
    entityType: "order",
    entityId: inserted.id,
    after: { orderNo, channelId, channelOrderNo: entry.channelOrderNo, orderDate: entry.orderedAt, ...changes, importBatchId: batchId },
  });
  return inserted.id;
}

async function updateOrderFromImport(tx: Tx, entry: MarketplaceUpdate, batchId: string, actorStaffUserId: string, now: Date): Promise<void> {
  const [locked] = await tx
    .select({
      id: orders.id,
      status: orders.status,
      discountAmount: orders.discountAmount,
      totalAmount: orders.totalAmount,
      channelStatus: orders.channelStatus,
      needsAttention: orders.needsAttention,
    })
    .from(orders)
    .where(eq(orders.id, entry.orderId))
    .for("update")
    .limit(1);
  if (!locked) throw new MarketplaceImportDriftError(`order ${entry.channelOrderNo} is gone`);
  const items = await tx.select({ sku: orderItems.sku, qty: orderItems.qty, unitPrice: orderItems.unitPrice }).from(orderItems).where(eq(orderItems.orderId, entry.orderId));
  const expected = entry.expected;
  const returnPending = locked.needsAttention.includes("marketplace_return_pending");
  if (
    locked.status !== expected.status ||
    locked.discountAmount !== expected.discountAmount ||
    locked.totalAmount !== expected.totalAmount ||
    locked.channelStatus !== expected.channelStatus ||
    returnPending !== expected.returnPending ||
    !sameLines(items, expected.lines)
  ) {
    throw new MarketplaceImportDriftError(`order ${entry.channelOrderNo} changed since the plan`);
  }

  await runTransitions(tx, entry.orderId, entry.transitions, actorStaffUserId, entry.channelOrderNo);

  if ((entry.discount === null) !== (entry.totalAmount === null)) throw new Error(`commitMarketplaceImport: voucher and total of ${entry.channelOrderNo} must change together`);
  if (entry.discount && entry.totalAmount) {
    const [moved] = await tx
      .update(orders)
      .set({ discountAmount: entry.discount.after, totalAmount: entry.totalAmount.after })
      .where(and(eq(orders.id, entry.orderId), eq(orders.discountAmount, entry.discount.before), eq(orders.totalAmount, entry.totalAmount.before)))
      .returning({ id: orders.id });
    if (!moved) throw new MarketplaceImportDriftError(`voucher of ${entry.channelOrderNo} changed since the plan`);
  }

  for (const fee of entry.fees) {
    // Conditional on the amount the plan saw, so a concurrent writer is drift, never overwritten.
    const written =
      fee.before === null
        ? await tx
            .insert(orderChannelFees)
            .values({ orderId: entry.orderId, component: fee.component, amount: fee.after, importBatchId: batchId })
            .onConflictDoNothing({ target: [orderChannelFees.orderId, orderChannelFees.component] })
            .returning({ id: orderChannelFees.id })
        : await tx
            .update(orderChannelFees)
            .set({ amount: fee.after, importBatchId: batchId })
            .where(and(eq(orderChannelFees.orderId, entry.orderId), eq(orderChannelFees.component, fee.component), eq(orderChannelFees.amount, fee.before)))
            .returning({ id: orderChannelFees.id });
    if (written.length === 0) throw new MarketplaceImportDriftError(`fee ${fee.component} of ${entry.channelOrderNo} changed since the plan`);
  }

  // The flag after the transitions: a transition to cancelled/returned already cleared it.
  const flagChange = entry.setReturnPending ? withAttentionFlags(["marketplace_return_pending"]) : entry.clearReturnPending ? withoutAttentionFlag("marketplace_return_pending") : null;
  await tx
    .update(orders)
    .set({ channelStatus: entry.rawStatus, channelSyncedAt: now, ...(flagChange ? { needsAttention: flagChange } : {}) })
    .where(eq(orders.id, entry.orderId));

  const changes = {
    status: entry.transitions.length > 0 ? { before: expected.status, after: entry.transitions.at(-1) } : null,
    discountAmount: entry.discount,
    totalAmount: entry.totalAmount,
    fees: entry.fees,
    channelStatus: entry.channelStatus,
    returnPending: entry.setReturnPending ? "set" : entry.clearReturnPending ? "cleared" : null,
    skuMatches: entry.skuMatches,
  };
  await tx.insert(importBatchOrders).values({ importBatchId: batchId, orderId: entry.orderId, action: "updated", changes });
  await writeAuditLog(tx, {
    actorStaffUserId,
    action: "import_update",
    entityType: "order",
    entityId: entry.orderId,
    before: {
      status: expected.status,
      discountAmount: expected.discountAmount,
      totalAmount: expected.totalAmount,
      channelStatus: expected.channelStatus,
      returnPending: expected.returnPending,
      fees: entry.fees.map((fee) => ({ component: fee.component, amount: fee.before })),
    },
    after: { ...changes, importBatchId: batchId },
  });
}

/** Simpan (plan §6). Returns `aborted` with the caller's own result when `replan` says no (digest
 * mismatch, save blockers), `drift` when a row no longer matched its plan once locked; in both cases
 * nothing was written. Any other error is a bug and propagates (the transaction rolls back). */
export async function commitMarketplaceImport<T>(input: CommitMarketplaceImportInput<T>, db: Database = defaultDb, now: Date = new Date()): Promise<CommitMarketplaceImportResult<T>> {
  try {
    return await db.transaction(async (tx): Promise<CommitMarketplaceImportResult<T>> => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`marketplace-import:${input.channelId}`}))`);
      const decision = await input.replan(tx);
      if (!decision.proceed) return { status: "aborted", result: decision.result };
      const { plan } = decision;
      if (plan.creates.length + plan.updates.length === 0) throw new Error("commitMarketplaceImport: a plan with nothing to write must not proceed");

      // Every row lock up front, in one fixed order (orders by id, then SKUs by name), before any
      // write: the same order the other stock paths use (an order row before its SKUs; SKUs sorted),
      // so the import can never deadlock against a payment, a manual order or a stock count. The
      // per-order code below takes the same locks again (a no-op for a lock already held).
      await tx.execute(sql`select set_config('lock_timeout', ${ROW_LOCK_TIMEOUT}, true)`);
      const updateIds = plan.updates.map((entry) => entry.orderId);
      if (updateIds.length > 0) {
        await tx.select({ id: orders.id }).from(orders).where(inArray(orders.id, updateIds)).orderBy(asc(orders.id)).for("update");
      }
      const lockSkus = new Set<string>();
      for (const entry of plan.creates) for (const line of entry.lines) lockSkus.add(line.sku);
      for (const entry of plan.updates) if (entry.transitions.length > 0) for (const line of entry.expected.lines) lockSkus.add(line.sku);
      if (lockSkus.size > 0) {
        await tx.select({ sku: productVariants.sku }).from(productVariants).where(inArray(productVariants.sku, [...lockSkus])).orderBy(asc(productVariants.sku)).for("update");
      }

      const [batch] = await tx
        .insert(importBatches)
        .values({
          channelId: input.channelId,
          kind: "orders",
          filename: input.batch.filename,
          status: "committed",
          uploadedBy: input.actorStaffUserId,
          rowCount: input.batch.rowCount,
          fileSha256: input.batch.fileSha256,
          summary: plan.summary,
          committedAt: now,
        })
        .returning({ id: importBatches.id });
      if (!batch) throw new Error("failed to insert import batch");

      const stockSkus = new Set<string>();
      // A stable lock order (plan §6): new orders by number, existing ones by number too.
      const createdOrderIds: string[] = [];
      for (const entry of [...plan.creates].sort((a, b) => compareText(a.channelOrderNo, b.channelOrderNo))) {
        createdOrderIds.push(await createOrderFromImport(tx, entry, input.channelId, batch.id, input.actorStaffUserId, now));
        for (const line of entry.lines) stockSkus.add(line.sku);
      }
      const updatedOrderIds: string[] = [];
      for (const entry of [...plan.updates].sort((a, b) => compareText(a.channelOrderNo, b.channelOrderNo))) {
        await updateOrderFromImport(tx, entry, batch.id, input.actorStaffUserId, now);
        updatedOrderIds.push(entry.orderId);
        const last = entry.transitions.at(-1);
        if (last === "cancelled" || last === "returned" || entry.transitions.includes("to_ship")) for (const line of entry.expected.lines) stockSkus.add(line.sku);
      }

      for (const match of plan.skuMatches) {
        await writeAuditLog(tx, {
          actorStaffUserId: input.actorStaffUserId,
          action: "import_sku_match",
          entityType: "import_batch",
          entityId: batch.id,
          after: { fileSku: match.fileSku, adminSku: match.adminSku, orderNos: match.channelOrderNos },
        });
      }
      await writeAuditLog(tx, {
        actorStaffUserId: input.actorStaffUserId,
        action: "import_commit",
        entityType: "import_batch",
        entityId: batch.id,
        after: { channelId: input.channelId, filename: input.batch.filename, fileSha256: input.batch.fileSha256, created: createdOrderIds.length, updated: updatedOrderIds.length, summary: plan.summary },
      });

      return { status: "committed", value: { batchId: batch.id, createdOrderIds, updatedOrderIds, stockSkus: [...stockSkus].sort(compareText) } };
    });
  } catch (error) {
    if (error instanceof MarketplaceImportDriftError) return { status: "drift", reason: error.reason };
    // 55P03 lock_not_available (lock_timeout), 40P01 deadlock_detected: rolled back, try again.
    if (isPostgresErrorCode(error, "55P03") || isPostgresErrorCode(error, "40P01")) return { status: "busy" };
    throw error;
  }
}
