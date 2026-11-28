import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { auditLog, orderChannelFees, tiktokFinanceSnapshots, tiktokOrderFeeLines, tiktokOrderFees, tiktokOrders, tiktokStatements, tiktokStatementTransactions, tiktokUnsettledTransactions } from "@ammari/db/schema";
import { insertOrder } from "@ammari/db/test-fixtures";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import {
  projectTikTokOrder,
  projectTikTokOrderTransactions,
  projectTikTokPayment,
  projectTikTokStatement,
  projectTikTokStatementTransaction,
  projectTikTokUnsettledTransaction,
  type TikTokPaymentProjection,
  type TikTokStatementProjection,
  type TikTokStatementTransactionProjection,
  type TikTokUnsettledProjection,
} from "@ammari/tiktok-shop";
import {
  getTikTokPayoutStatementLinks,
  listTikTokOrderFeesToRebuild,
  listTikTokOrdersWithPendingFees,
  rebuildTikTokOrderFees,
  storeTikTokOrderTransactions,
  storeTikTokPayout,
  storeTikTokStatement,
  storeTikTokStatementTransactions,
  storeTikTokUnsettledTransaction,
} from "./finance";
import { ingestTikTokOrder } from "./order-store";

// docs/plans/tiktok-shop-integration.md T7 against a real database (each test rolls back): estimate
// then actual into order_channel_fees with one upsert per component (Q9), no fee data → no rows
// (never zero), an unknown fee type held (never `other`), statement re-fetch idempotent, Σ
// transactions = settlement, payout ↔ statements, and every change to an order's fees audited.

const NOW = new Date("2026-12-05T03:00:00.000Z");
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
let counter = 0;
const newOrderId = () => `5766536881${String(Date.now()).slice(-5)}${String((counter += 1)).padStart(3, "0")}`;

async function tiktokOrder(db: TestDatabase, options: { applied?: boolean; channelId?: "tiktok" | "shopee" } = {}): Promise<{ tiktokOrderId: string; orderId: string | null }> {
  const tiktokOrderId = newOrderId();
  const projected = projectTikTokOrder({ id: tiktokOrderId, status: "IN_TRANSIT", update_time: seconds(NOW) - 3600, paid_time: seconds(NOW) - 7200, payment: { currency: "IDR", sub_total: "249000", total_amount: "249000" }, line_items: [] });
  if (!projected.ok) throw new Error("projection failed");
  await ingestTikTokOrder(db, projected.order, "poll", NOW);
  if (options.applied === false) return { tiktokOrderId, orderId: null };
  const order = await insertOrder(db, { channelId: options.channelId ?? "tiktok", channelOrderNo: tiktokOrderId, status: "shipped", subtotalAmount: 249_000, shippingAmount: 0 });
  await db.update(tiktokOrders).set({ orderId: order.id }).where(eq(tiktokOrders.tiktokOrderId, tiktokOrderId));
  return { tiktokOrderId, orderId: order.id };
}

function unsettled(tiktokOrderId: string, fees: Record<string, string>, overrides: Record<string, unknown> = {}): TikTokUnsettledProjection {
  // The estimated total is the lines' own sum, so the estimate adds up unless a test says otherwise.
  const total = Object.values(fees).reduce((sum, value) => sum + (/^-?[0-9]+$/.test(value) ? Number(value) : 0), 0);
  const result = projectTikTokUnsettledTransaction({ id: `u-${tiktokOrderId}`, type: "ORDER", order_id: tiktokOrderId, est_settlement_amount: "225000", est_fee_tax_amount: String(total), est_shipping_cost_amount: "0", fee_tax_breakdown: { fee: fees }, ...overrides });
  if (!result.ok) throw new Error("projection failed");
  return result.value;
}

function statement(id: string, settlement: string, overrides: Record<string, unknown> = {}): TikTokStatementProjection {
  const result = projectTikTokStatement({ id, statement_time: seconds(NOW) - 86_400, currency: "IDR", settlement_amount: settlement, payment_status: "PROCESSING", ...overrides });
  if (!result.ok) throw new Error("projection failed");
  return result.value;
}

function transaction(statementId: string, id: string, raw: Record<string, unknown>): TikTokStatementTransactionProjection {
  const result = projectTikTokStatementTransaction(statementId, { id, ...raw });
  if (!result.ok) throw new Error("projection failed");
  return result.value;
}

function payout(id: string, amount: string): TikTokPaymentProjection {
  const result = projectTikTokPayment({ id, create_time: seconds(NOW), paid_time: seconds(NOW), status: "PAID", amount: { value: amount, currency: "IDR" }, bank_account: "****9876" });
  if (!result.ok) throw new Error("projection failed");
  return result.value;
}

async function fees(db: TestDatabase, orderId: string) {
  const rows = await db.select({ component: orderChannelFees.component, amount: orderChannelFees.amount, source: orderChannelFees.source }).from(orderChannelFees).where(eq(orderChannelFees.orderId, orderId));
  return rows.sort((a, b) => a.component.localeCompare(b.component));
}

async function feeState(db: TestDatabase, tiktokOrderId: string) {
  const [row] = await db.select().from(tiktokOrderFees).where(eq(tiktokOrderFees.tiktokOrderId, tiktokOrderId));
  return row;
}

/** One statement with one ORDER transaction for the order, stored and with its SKU lines. */
async function settle(db: TestDatabase, tiktokOrderId: string, skuFees: Record<string, Record<string, string>>, feeTax: string, statementId = `s-${tiktokOrderId}`) {
  const settlement = String(249000 + Number(feeTax));
  const stmt = statement(statementId, settlement);
  await storeTikTokStatement(db, stmt, NOW);
  const stored = await storeTikTokStatementTransactions(db, stmt, [transaction(statementId, `t-${tiktokOrderId}`, { type: "ORDER", order_id: tiktokOrderId, settlement_amount: settlement, revenue_amount: "249000", fee_tax_amount: feeTax, shipping_cost_amount: "0" })], NOW);
  const byOrder = projectTikTokOrderTransactions(tiktokOrderId, {
    statement_transactions: [{ id: `t-${tiktokOrderId}`, statement_id: statementId, sku_statement_transactions: Object.entries(skuFees).map(([sku, fee]) => ({ sku_id: sku, fee_tax_breakdown: { fee } })) }],
  });
  const lines = await storeTikTokOrderTransactions(db, byOrder, NOW);
  return { stmt, stored, lines };
}

describe("estimate then actual (Q9)", () => {
  test("no estimate and no statement yet → no fee rows, never zero", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId, orderId } = await tiktokOrder(db);
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "none" });
      expect(await fees(db, orderId!)).toEqual([]);
      expect(await feeState(db, tiktokOrderId)).toBeUndefined();
    });
  });

  test("the estimate is written as source estimate; the actual replaces it, one upsert per component; the estimate lines stay as history", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId, orderId } = await tiktokOrder(db);
      await storeTikTokUnsettledTransaction(db, unsettled(tiktokOrderId, { platform_commission_amount: "-14940", transaction_fee_amount: "-9060" }), NOW);
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "applied", source: "estimate", changed: true });
      expect(await fees(db, orderId!)).toEqual([
        { component: "admin_fee", amount: 9060, source: "estimate" },
        { component: "platform_commission", amount: 14940, source: "estimate" },
      ]);
      const [estimateRow] = await db.select({ id: orderChannelFees.id }).from(orderChannelFees).where(and(eq(orderChannelFees.orderId, orderId!), eq(orderChannelFees.component, "platform_commission")));

      // Settled: commission per SKU, and the transaction fee disappeared.
      const { lines } = await settle(db, tiktokOrderId, { "sku-a": { platform_commission_amount: "-9000" }, "sku-b": { platform_commission_amount: "-5000" } }, "-14000");
      expect(lines).toEqual({ complete: 1, held: 0, missing: 0 });
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "applied", source: "actual", changed: true });
      expect(await fees(db, orderId!)).toEqual([
        { component: "admin_fee", amount: 0, source: "actual" },
        { component: "platform_commission", amount: 14000, source: "actual" },
      ]);
      // Same row updated in place (one upsert per component), not a second row.
      const [actualRow] = await db.select({ id: orderChannelFees.id }).from(orderChannelFees).where(and(eq(orderChannelFees.orderId, orderId!), eq(orderChannelFees.component, "platform_commission")));
      expect(actualRow!.id).toBe(estimateRow!.id);
      const lineSources = await db.select({ source: tiktokOrderFeeLines.source }).from(tiktokOrderFeeLines).where(eq(tiktokOrderFeeLines.tiktokOrderId, tiktokOrderId));
      expect(lineSources.filter((row) => row.source === "estimate")).toHaveLength(2);
      expect(lineSources.filter((row) => row.source === "actual")).toHaveLength(2);
      expect(await feeState(db, tiktokOrderId)).toMatchObject({ state: "applied", appliedSource: "actual", appliedComponents: { platform_commission: 14000 } });

      const audits = await db.select({ action: auditLog.action, after: auditLog.after }).from(auditLog).where(and(eq(auditLog.entityId, orderId!), eq(auditLog.action, "tiktok_fees_update")));
      expect(audits).toHaveLength(2);
      expect(audits.map((row) => (row.after as { source: string }).source).sort()).toEqual(["actual", "estimate"]);
    });
  });

  test("a rebuild with nothing new writes nothing and audits nothing", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId, orderId } = await tiktokOrder(db);
      await storeTikTokUnsettledTransaction(db, unsettled(tiktokOrderId, { platform_commission_amount: "-100" }), NOW);
      await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW });
      await storeTikTokUnsettledTransaction(db, unsettled(tiktokOrderId, { platform_commission_amount: "-100" }), new Date(NOW.getTime() + 60_000));
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "applied", source: "estimate", changed: false });
      expect(await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, orderId!), eq(auditLog.action, "tiktok_fees_update")))).toHaveLength(1);
      expect(await db.select({ id: tiktokFinanceSnapshots.id }).from(tiktokFinanceSnapshots).where(eq(tiktokFinanceSnapshots.externalId, `u-${tiktokOrderId}`))).toHaveLength(1);
    });
  });

  test("an unknown fee type holds the order's fees (what was written stays), named for the accountant; never `other`", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId, orderId } = await tiktokOrder(db);
      await storeTikTokUnsettledTransaction(db, unsettled(tiktokOrderId, { platform_commission_amount: "-100" }), NOW);
      await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW });
      await settle(db, tiktokOrderId, { "sku-a": { platform_commission_amount: "-90", brand_new_fee_amount: "-10" } }, "-100");
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "held", reason: "fee_type_unmapped" });
      expect(await fees(db, orderId!)).toEqual([{ component: "platform_commission", amount: 100, source: "estimate" }]);
      expect(await feeState(db, tiktokOrderId)).toMatchObject({ state: "held", heldReason: "fee_type_unmapped", unmappedTypes: ["fee.brand_new_fee_amount"], appliedSource: "estimate" });
      expect(await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, orderId!), eq(auditLog.action, "tiktok_fees_hold")))).toHaveLength(1);
      expect(await listTikTokOrderFeesToRebuild(db)).toContain(tiktokOrderId);
    });
  });

  test("SKU lines that do not add up to the transaction's fee total hold the fees (fee_sum_mismatch)", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId, orderId } = await tiktokOrder(db);
      const { lines } = await settle(db, tiktokOrderId, { "sku-a": { platform_commission_amount: "-90" } }, "-100");
      expect(lines).toEqual({ complete: 0, held: 1, missing: 0 });
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "held", reason: "fee_sum_mismatch" });
      expect(await fees(db, orderId!)).toEqual([]);
    });
  });

  test("estimate lines that do not add up to the estimated totals hold the order (never applied as zero or partial fees)", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId, orderId } = await tiktokOrder(db);
      await storeTikTokUnsettledTransaction(db, unsettled(tiktokOrderId, {}, { est_fee_tax_amount: "-24000" }), NOW);
      const [row] = await db.select().from(tiktokUnsettledTransactions).where(eq(tiktokUnsettledTransactions.transactionId, `u-${tiktokOrderId}`));
      expect(row).toMatchObject({ heldReason: "sum_mismatch" });
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "held", reason: "fee_sum_mismatch" });
      expect(await fees(db, orderId!)).toEqual([]);
    });
  });

  test("an estimate that is not whole rupiah is stored as held, never rounded, and holds the order", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId, orderId } = await tiktokOrder(db);
      await storeTikTokUnsettledTransaction(db, unsettled(tiktokOrderId, { platform_commission_amount: "-149.40" }), NOW);
      const [row] = await db.select().from(tiktokUnsettledTransactions).where(eq(tiktokUnsettledTransactions.transactionId, `u-${tiktokOrderId}`));
      expect(row).toMatchObject({ heldReason: "money_format" });
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "held", reason: "money_format" });
      expect(await fees(db, orderId!)).toEqual([]);
    });
  });

  test("fees for an order not in admin yet wait, then apply once the order exists", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId } = await tiktokOrder(db, { applied: false });
      await storeTikTokUnsettledTransaction(db, unsettled(tiktokOrderId, { platform_commission_amount: "-100" }), NOW);
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "waiting_order" });
      expect(await listTikTokOrderFeesToRebuild(db)).not.toContain(tiktokOrderId);
      const order = await insertOrder(db, { channelId: "tiktok", channelOrderNo: tiktokOrderId, status: "shipped" });
      await db.update(tiktokOrders).set({ orderId: order.id }).where(eq(tiktokOrders.tiktokOrderId, tiktokOrderId));
      expect(await listTikTokOrderFeesToRebuild(db)).toContain(tiktokOrderId);
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toMatchObject({ kind: "applied", source: "estimate" });
      expect(await fees(db, order.id)).toEqual([{ component: "platform_commission", amount: 100, source: "estimate" }]);
    });
  });

  test("never writes another channel's fees", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId, orderId } = await tiktokOrder(db, { channelId: "shopee" });
      await storeTikTokUnsettledTransaction(db, unsettled(tiktokOrderId, { platform_commission_amount: "-100" }), NOW);
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "held", reason: "not_tiktok_order" });
      expect(await fees(db, orderId!)).toEqual([]);
    });
  });
});

describe("held statements and the re-check queues", () => {
  test("a statement whose transactions do not add up holds the actuals of its orders, even when the SKU lines add up", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId, orderId } = await tiktokOrder(db);
      const stmt = statement(`s-h-${tiktokOrderId}`, "999999");
      await storeTikTokStatement(db, stmt, NOW);
      await storeTikTokStatementTransactions(db, stmt, [transaction(stmt.statementId, `t-h-${tiktokOrderId}`, { type: "ORDER", order_id: tiktokOrderId, settlement_amount: "235000", fee_tax_amount: "-14000", shipping_cost_amount: "0" })], NOW);
      await storeTikTokOrderTransactions(db, projectTikTokOrderTransactions(tiktokOrderId, { statement_transactions: [{ id: `t-h-${tiktokOrderId}`, sku_statement_transactions: [{ sku_id: "a", fee_tax_breakdown: { fee: { platform_commission_amount: "-14000" } } }] }] }), NOW);
      expect(await rebuildTikTokOrderFees(db, tiktokOrderId, { now: NOW })).toEqual({ kind: "held", reason: "fee_sum_mismatch" });
      expect(await fees(db, orderId!)).toEqual([]);
    });
  });

  test("an order TikTok does not return goes to the back of the fee-fetch queue", async () => {
    await withRollback(async (db) => {
      const first = await tiktokOrder(db);
      const second = await tiktokOrder(db);
      for (const order of [first, second]) {
        const stmt = statement(`s-q-${order.tiktokOrderId}`, "235000");
        await storeTikTokStatement(db, stmt, NOW);
        await storeTikTokStatementTransactions(db, stmt, [transaction(stmt.statementId, `t-q-${order.tiktokOrderId}`, { type: "ORDER", order_id: order.tiktokOrderId, settlement_amount: "235000" })], NOW);
      }
      const before = await listTikTokOrdersWithPendingFees(db, 100);
      const head = before.find((id) => id === first.tiktokOrderId || id === second.tiktokOrderId)!;
      await new Promise((resolve) => setTimeout(resolve, 5));
      // now() is the transaction start inside one test transaction; move the touched row explicitly later.
      await storeTikTokOrderTransactions(db, projectTikTokOrderTransactions(head, { statement_transactions: [] }), NOW);
      await db.update(tiktokStatementTransactions).set({ updatedAt: new Date(Date.now() + 60_000) }).where(eq(tiktokStatementTransactions.transactionId, `t-q-${head}`));
      const after = (await listTikTokOrdersWithPendingFees(db, 100)).filter((id) => id === first.tiktokOrderId || id === second.tiktokOrderId);
      expect(after.at(-1)).toBe(head);
    });
  });
});

describe("statements", () => {
  test("re-fetching the same statement and transactions is idempotent; Σ transactions = settlement marks it complete", async () => {
    await withRollback(async (db) => {
      const { tiktokOrderId } = await tiktokOrder(db);
      const stmt = statement("s-idem", "205000");
      expect(await storeTikTokStatement(db, stmt, NOW)).toEqual({ snapshot: "inserted", needsTransactions: true });
      const txns = [
        transaction("s-idem", "t-idem-1", { type: "ORDER", order_id: tiktokOrderId, settlement_amount: "225000", fee_tax_amount: "-24000" }),
        transaction("s-idem", "t-idem-2", { type: "GMV_PAYMENT_FOR_ADS", settlement_amount: "-20000", adjustment_amount: "-20000" }),
      ];
      expect(await storeTikTokStatementTransactions(db, stmt, txns, NOW)).toMatchObject({ inserted: 2, complete: true, heldReason: null, tiktokOrderIds: [tiktokOrderId] });
      expect(await storeTikTokStatement(db, stmt, NOW)).toEqual({ snapshot: "replay", needsTransactions: false });
      expect(await storeTikTokStatementTransactions(db, stmt, txns, NOW)).toMatchObject({ inserted: 0, replays: 2, complete: true });
      const rows = await db.select({ id: tiktokStatementTransactions.transactionId, kind: tiktokStatementTransactions.kind, type: tiktokStatementTransactions.type, feesState: tiktokStatementTransactions.feesState }).from(tiktokStatementTransactions).where(eq(tiktokStatementTransactions.statementId, "s-idem"));
      expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "t-idem-1", kind: "order", type: "ORDER", feesState: "pending" },
        { id: "t-idem-2", kind: "adjustment", type: "GMV_PAYMENT_FOR_ADS", feesState: null },
      ]);
      expect(await listTikTokOrdersWithPendingFees(db)).toContain(tiktokOrderId);
      expect(await db.select({ id: tiktokFinanceSnapshots.id }).from(tiktokFinanceSnapshots).where(eq(tiktokFinanceSnapshots.externalId, "s-idem"))).toHaveLength(1);
    });
  });

  test("transactions that do not add up to the settlement hold the statement (sum_mismatch), kept on the same content", async () => {
    await withRollback(async (db) => {
      const stmt = statement("s-sum", "205000");
      await storeTikTokStatement(db, stmt, NOW);
      expect(await storeTikTokStatementTransactions(db, stmt, [transaction("s-sum", "t-sum", { type: "ORDER", order_id: "576653688135258178", settlement_amount: "200000" })], NOW)).toMatchObject({ complete: false, heldReason: "sum_mismatch" });
      expect(await storeTikTokStatement(db, stmt, NOW)).toEqual({ snapshot: "replay", needsTransactions: true });
      const [row] = await db.select().from(tiktokStatements).where(eq(tiktokStatements.statementId, "s-sum"));
      expect(row).toMatchObject({ heldReason: "sum_mismatch", transactionsCompleteSha256: null });
    });
  });

  test("a changed statement (paid now) is a new version: history kept, its transactions checked again", async () => {
    await withRollback(async (db) => {
      const first = statement("s-ver", "100");
      await storeTikTokStatement(db, first, NOW);
      await storeTikTokStatementTransactions(db, first, [transaction("s-ver", "t-ver", { type: "GMV_PAYMENT_FOR_ADS", settlement_amount: "100" })], NOW);
      const paid = statement("s-ver", "100", { payment_status: "PAID", payment_id: "p-ver" });
      expect(await storeTikTokStatement(db, paid, NOW)).toEqual({ snapshot: "inserted", needsTransactions: true });
      expect(await db.select({ id: tiktokFinanceSnapshots.id }).from(tiktokFinanceSnapshots).where(eq(tiktokFinanceSnapshots.externalId, "s-ver"))).toHaveLength(2);
      const [row] = await db.select().from(tiktokStatements).where(eq(tiktokStatements.statementId, "s-ver"));
      expect(row).toMatchObject({ paymentStatus: "PAID", paymentId: "p-ver" });
    });
  });

  test("a statement in another currency or with a decimal settlement is held, its money never stored as rupiah", async () => {
    await withRollback(async (db) => {
      expect(await storeTikTokStatement(db, statement("s-usd", "100", { currency: "USD" }), NOW)).toMatchObject({ needsTransactions: false });
      await storeTikTokStatement(db, statement("s-dec", "100.5"), NOW);
      const rows = await db.select({ id: tiktokStatements.statementId, held: tiktokStatements.heldReason, settlement: tiktokStatements.settlementAmount }).from(tiktokStatements);
      expect(rows.filter((row) => row.id.startsWith("s-usd") || row.id.startsWith("s-dec")).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "s-dec", held: "money_format", settlement: null },
        { id: "s-usd", held: "currency", settlement: 100 },
      ]);
    });
  });
});

describe("payouts", () => {
  test("a payout links to the statements it paid; the amounts must agree", async () => {
    await withRollback(async (db) => {
      await storeTikTokStatement(db, statement("s-p1", "120000", { payment_status: "PAID", payment_id: "p-1" }), NOW);
      await storeTikTokStatement(db, statement("s-p2", "85000", { payment_status: "PAID", payment_id: "p-1" }), NOW);
      await storeTikTokPayout(db, payout("p-1", "205000"), NOW);
      await storeTikTokPayout(db, payout("p-2", "1"), NOW);
      expect(await storeTikTokPayout(db, payout("p-1", "205000"), NOW)).toEqual({ snapshot: "replay" });
      const links = await getTikTokPayoutStatementLinks(db, ["p-1", "p-2"]);
      expect(links.sort((a, b) => a.paymentId.localeCompare(b.paymentId))).toEqual([
        { paymentId: "p-1", amount: 205000, statementCount: 2, statementsTotal: 205000, matches: true },
        { paymentId: "p-2", amount: 1, statementCount: 0, statementsTotal: null, matches: false },
      ]);
    });
  });
});
