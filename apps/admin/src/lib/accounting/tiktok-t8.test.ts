import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SALES_RULE_VERSION, salesRule } from "@ammari/accounting";
import { defaultPostingSources, loadOrderSnapshots, runPosting, type Database as LedgerDatabase, type PostingSource } from "@ammari/accounting/runner";
import { createOrder, transitionOrderStatus } from "@ammari/commerce/orders";
import {
  businessExpenses,
  fiscalPeriods,
  journalEntries,
  journalLines,
  marketplaceRefunds,
  orderChannelFees,
  orders,
  postingIssues,
  privateFiles,
  stockMovements,
} from "@ammari/db/schema";
import { insertProductVariant, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { getExpenseSummary } from "@/lib/expenses/summary";
import { recordManualOrderPayment } from "@/lib/orders/manual-payment";
import { getChannelBreakdown, getPeriodTotals } from "@/lib/overview/queries";
import { getMappingPage, MAPPING_MESSAGES, setAccountMapping } from "./mappings";
import { tiktokOrdersOnEstimatedFees } from "./periods";
import { getPnlReconciliation } from "./pnl-reconciliation";
import { getTikTokReconciliation } from "./tiktok-reconciliation";

// TikTok T8 against ammari_test (docs/plans/tiktok-shop-integration.md §5): the loader reads
// marketplace_shipped_at without reposting anything already booked; M1/M2 on collection_time; estimated
// fees replaced by actuals (into the first open month once the sale's month is closed); S7 refund-only;
// M3 payouts; M5 adjustments by the accountant's mapping; Rekonsiliasi TikTok Shop (a)-(d); Ringkasan
// minus refund-only money and check 4 without a difference for it (Q19). Every test rolls back.

afterEach(() => {
  vi.useRealTimers();
});

function setNow(iso: string) {
  vi.useFakeTimers({ now: new Date(iso), toFake: ["Date"] });
}

const START = "2020-01-01";
const SHA = "b".repeat(64);

/** Same as session9.test.ts: the real write paths stamp some rows with the database clock, which may be
 * before the books start; the 0056 date floor is lifted inside the rolled-back transaction only. */
async function liftDateFloorBeforeBooksStart(tx: TestTx) {
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  await tx.execute(sql`
    do $$ begin
      if now() < date '2026-12-01' then
        alter table journal_entries drop constraint if exists journal_entries_entry_date_floor_check;
      end if;
    end $$`);
}

async function postAll(tx: TestTx, sources?: PostingSource[]) {
  vi.useRealTimers();
  await liftDateFloorBeforeBooksStart(tx);
  const result = await runPosting(tx as unknown as LedgerDatabase, { trigger: "cron", postingStartDate: START, ...(sources ? { sources } : {}) });
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
  return result;
}

/** 10 pcs on the shelf at 87.917 each. */
async function setup(tx: TestTx) {
  const { variant } = await insertProductVariant(tx);
  const staff = await insertStaffUser(tx);
  await tx.insert(stockMovements).values({ sku: variant.sku, qty: 10, valueAmount: 879_170, type: "production", refType: "manual" });
  return { variant, staff };
}

/** A TikTok order as the sync leaves it (T5): 1 pcs at 270.000, seller discount 20.000 (Q7), total
 * 250.000, shipped, marketplace_shipped_at = collection_time. */
async function tiktokOrder(tx: TestTx, sku: string, staffId: string, { orderDate, collection, complete = false }: { orderDate: string; collection: string | null; complete?: boolean }) {
  const tiktokOrderId = `57${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  setNow(`${orderDate}T02:00:00Z`);
  const order = await createOrder(
    { channelId: "tiktok", channelOrderNo: tiktokOrderId, orderDate, items: [{ sku, qty: 1, unitPrice: 270_000 }], discountAmount: 20_000, shippingAmount: 0, status: "to_ship" },
    staffId,
    tx as never,
  );
  await transitionOrderStatus(order.id, "shipped", null, tx as never);
  if (complete) await transitionOrderStatus(order.id, "completed", null, tx as never);
  vi.useRealTimers();
  if (collection) await tx.update(orders).set({ marketplaceShippedAt: new Date(collection) }).where(eq(orders.id, order.id));
  return { order, tiktokOrderId };
}

async function fees(tx: TestTx, orderId: string, source: "estimate" | "actual", components: Record<string, number>) {
  await tx.delete(orderChannelFees).where(eq(orderChannelFees.orderId, orderId));
  await tx.insert(orderChannelFees).values(Object.entries(components).map(([component, amount]) => ({ orderId, component: component as never, amount, source })));
}

async function snapshot(tx: TestTx, kind: string, externalId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    insert into tiktok_finance_snapshots (kind, external_id, content_sha256, payload) values (${kind}, ${externalId}, ${SHA}, '{}'::jsonb) returning id
  `)) as unknown as { id: string }[];
  return row!.id;
}

async function statement(tx: TestTx, id: string, time: string, settlement: number, paymentId: string | null, transactions: { id: string; type: string; tiktokOrderId?: string; settlement: number }[]) {
  const snap = await snapshot(tx, "statement", id);
  await tx.execute(sql`
    insert into tiktok_statements (statement_id, statement_time, currency, settlement_amount, payment_status, payment_id, latest_snapshot_id, fetched_at)
    values (${id}, ${time}::timestamptz, 'IDR', ${settlement}, ${paymentId ? "PAID" : "PROCESSING"}, ${paymentId}, ${snap}::uuid, now())`);
  for (const t of transactions) {
    const tSnap = await snapshot(tx, "statement_transaction", t.id);
    const kind = t.type === "ORDER" || t.type === "REFUND" ? "order" : "adjustment";
    await tx.execute(sql`
      insert into tiktok_statement_transactions (transaction_id, statement_id, type, kind, tiktok_order_id, settlement_amount, content_sha256, latest_snapshot_id, fetched_at)
      values (${t.id}, ${id}, ${t.type}, ${kind}, ${t.tiktokOrderId ?? null}, ${t.settlement}, ${SHA}, ${tSnap}::uuid, now())`);
  }
}

async function payout(tx: TestTx, id: string, paidTime: string, amount: number, status = "PAID") {
  const snap = await snapshot(tx, "payment", id);
  await tx.execute(sql`
    insert into tiktok_payouts (payment_id, amount, currency, status, create_time, paid_time, bank_account_last4, content_sha256, latest_snapshot_id, fetched_at)
    values (${id}, ${amount}, 'IDR', ${status}, ${paidTime}::timestamptz, ${paidTime}::timestamptz, '9876', ${SHA}, ${snap}::uuid, now())`);
}

async function journalsFor(tx: TestTx, sourceType: string, sourceId: string, sourceEvent: string) {
  const entries = await tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceType, sourceType), eq(journalEntries.sourceId, sourceId), eq(journalEntries.sourceEvent, sourceEvent)))
    .orderBy(asc(journalEntries.createdAt), asc(journalEntries.entryNo));
  return Promise.all(
    entries.map(async (entry) => {
      const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).orderBy(asc(journalLines.lineNo));
      return { ...entry, sides: lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`)) };
    }),
  );
}

async function orderNet(tx: TestTx, orderId: string): Promise<Record<string, number>> {
  const rows = await tx
    .select({ code: journalLines.accountCode, net: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})` })
    .from(journalLines)
    .where(eq(journalLines.orderId, orderId))
    .groupBy(journalLines.accountCode);
  return Object.fromEntries(rows.map((row) => [row.code, Number(row.net)]));
}

/** Σ (debit − credit) on an account over the given journals' source ids. */
async function accountNetFor(tx: TestTx, accountCode: string, sourceIds: string[]): Promise<number> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(l.debit - l.credit), 0)::bigint as net from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.account_code = ${accountCode} and e.source_id in (${sql.join(sourceIds.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as { net: string }[];
  return Number(row?.net ?? 0);
}

async function openIssues(tx: TestTx, sourceId: string) {
  return tx.select({ code: postingIssues.issueCode, event: postingIssues.sourceEvent }).from(postingIssues).where(and(eq(postingIssues.sourceId, sourceId), isNull(postingIssues.resolvedAt)));
}

describe("the loader reads marketplace_shipped_at: nothing already booked reposts (T8, §5.1)", () => {
  test("a run with the old loader, then the new one: zero reversals; only the TikTok order's M1/M2 are new", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      setNow("2026-12-08T03:00:00Z");
      const manual = await createOrder({ channelId: "instagram", orderDate: "2026-12-08", items: [{ sku: variant.sku, qty: 1, unitPrice: 250_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" }, staff.id, tx as never);
      await recordManualOrderPayment(manual.id, { method: "transfer", cashAccountCode: "1-1201", paidOn: "2026-12-08" }, staff.id, tx as never);
      await transitionOrderStatus(manual.id, "shipped", staff.id, tx as never);
      const shopee = await createOrder({ channelId: "shopee", channelOrderNo: `SP-${randomUUID().slice(0, 8)}`, orderDate: "2026-12-07", items: [{ sku: variant.sku, qty: 1, unitPrice: 250_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" }, staff.id, tx as never);
      await transitionOrderStatus(shopee.id, "shipped", staff.id, tx as never);
      const { order: tiktok } = await tiktokOrder(tx, variant.sku, staff.id, { orderDate: "2026-12-04", collection: "2026-12-04T23:30:00Z" });
      await fees(tx, tiktok.id, "actual", { platform_commission: 21_600, admin_fee: 5_000, seller_shipping_subsidy: 3_000 });

      // The release before T8: the loader hard-coded both marketplace times to null.
      const legacySales: PostingSource = {
        name: "sales",
        ruleVersion: SALES_RULE_VERSION,
        async events(db, context) {
          return (await loadOrderSnapshots(db)).flatMap((order) => salesRule.events({ ...order, marketplaceShippedAt: null, marketplaceReturnedAt: null }, context));
        },
      };
      const legacy = defaultPostingSources().filter((source) => !["sales", "marketplace_refund", "tiktok_payout", "tiktok_adjustment"].includes(source.name));
      await postAll(tx, [...legacy, legacySales]);
      expect((await openIssues(tx, tiktok.id)).map((issue) => issue.code)).toEqual(["marketplace_ship_date_missing"]);
      const before = await tx.select({ id: journalEntries.id }).from(journalEntries);

      const result = await postAll(tx);
      expect(result.reversedCount).toBe(0);
      const added = (await tx.select({ id: journalEntries.id, sourceId: journalEntries.sourceId, event: journalEntries.sourceEvent }).from(journalEntries)).filter(
        (entry) => !before.some((old) => old.id === entry.id),
      );
      expect(added.map((entry) => `${entry.sourceId === tiktok.id ? "tiktok" : entry.sourceId}:${entry.event}`).sort()).toEqual(["tiktok:channel_fees", "tiktok:recognised"]);
      expect(await openIssues(tx, tiktok.id)).toEqual([]);
      // Shopee keeps reading NULL until its own Session 5.
      expect((await openIssues(tx, shopee.id)).map((issue) => issue.code)).toEqual(["marketplace_ship_date_missing"]);
      // Idempotent: a third run changes nothing.
      expect(await postAll(tx)).toMatchObject({ insertedCount: 0, reversedCount: 0 });
    });
  });
});

describe("a TikTok order paid → shipped → completed → settled → paid out (T8)", () => {
  test("M1/M2 on collection_time; the statement and the payout leave 1-1303 at 0; Rekonsiliasi (a)-(d) all match", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const { order, tiktokOrderId } = await tiktokOrder(tx, variant.sku, staff.id, { orderDate: "2026-12-04", collection: "2026-12-04T23:30:00Z", complete: true });
      await fees(tx, order.id, "actual", { platform_commission: 21_600, admin_fee: 5_000, seller_shipping_subsidy: 3_000 });
      const settlement = 250_000 - 29_600;
      await statement(tx, `st-${tiktokOrderId}`, "2026-12-12T03:00:00Z", settlement, `pay-${tiktokOrderId}`, [{ id: `tx-${tiktokOrderId}`, type: "ORDER", tiktokOrderId, settlement }]);
      await payout(tx, `pay-${tiktokOrderId}`, "2026-12-14T17:10:00Z", settlement);
      await postAll(tx);

      const m1 = await journalsFor(tx, "order", order.id, "recognised");
      expect(m1.map((entry) => entry.sourceDate)).toEqual(["2026-12-05"]);
      expect(m1[0]?.sides).toEqual(["Dr 1-1303 250000", "Dr 4-1201 20000", "Dr 5-1101 87917", "Cr 4-1103 270000", "Cr 1-1505 87917"]);
      expect((await journalsFor(tx, "order", order.id, "channel_fees"))[0]).toMatchObject({ sourceDate: "2026-12-05", sides: ["Dr 6-1201 26600", "Dr 6-1202 3000", "Cr 1-1303 29600"] });
      const m3 = await journalsFor(tx, "tiktok_payout", `pay-${tiktokOrderId}`, "paid_out");
      expect(m3[0]).toMatchObject({ sourceDate: "2026-12-15", sides: [`Dr 1-1201 ${settlement}`, `Cr 1-1303 ${settlement}`] });

      // The order's own 1-1303 lines = the settlement; the payout clears it.
      expect((await orderNet(tx, order.id))["1-1303"]).toBe(settlement);
      expect((await orderNet(tx, order.id))["1-1505"]).toBe(0);
      expect(await accountNetFor(tx, "1-1303", [order.id, `pay-${tiktokOrderId}`])).toBe(0);

      const check = await getTikTokReconciliation("2026-12-31", tx);
      expect(check.orders.rows.find((row) => row.orderId === order.id)).toMatchObject({ ledger: settlement, settlement, status: "ok" });
      expect(check.statements.rows.find((row) => row.statementId === `st-${tiktokOrderId}`)).toMatchObject({ settlement, transactionsTotal: settlement, status: "ok" });
      expect(check.payouts.rows.find((row) => row.paymentId === `pay-${tiktokOrderId}`)).toMatchObject({ amount: settlement, statementsTotal: settlement, journaled: true, rowStatus: "ok" });
    });
  });

  test("payout matching: a payout that differs from its statements is red, and a PAID payout without M3 is flagged", async () => {
    await withRollback(async (tx) => {
      const id = randomUUID().slice(0, 8);
      await statement(tx, `st-a-${id}`, "2026-12-12T03:00:00Z", 100_000, `pay-${id}`, [{ id: `tx-a-${id}`, type: "ORDER", tiktokOrderId: `999${id}`, settlement: 100_000 }]);
      await statement(tx, `st-b-${id}`, "2026-12-13T03:00:00Z", 50_000, `pay-${id}`, [{ id: `tx-b-${id}`, type: "ORDER", tiktokOrderId: `998${id}`, settlement: 50_000 }]);
      await payout(tx, `pay-${id}`, "2026-12-14T03:00:00Z", 140_000);
      const check = await getTikTokReconciliation("2026-12-31", tx);
      expect(check.payouts.rows.find((row) => row.paymentId === `pay-${id}`)).toMatchObject({ amount: 140_000, statementsTotal: 150_000, statementCount: 2, difference: -10_000, rowStatus: "mismatch" });

      await payout(tx, `pay-ok-${id}`, "2026-12-14T03:00:00Z", 0, "PAID");
      await tx.execute(sql`update tiktok_payouts set amount = 150000 where payment_id = ${`pay-ok-${id}`}`);
      await tx.execute(sql`update tiktok_statements set payment_id = ${`pay-ok-${id}`} where statement_id in (${`st-a-${id}`}, ${`st-b-${id}`})`);
      const unposted = await getTikTokReconciliation("2026-12-31", tx);
      expect(unposted.payouts.rows.find((row) => row.paymentId === `pay-ok-${id}`)).toMatchObject({ difference: 0, journaled: false, rowStatus: "review" });
    });
  });
});

describe("estimated fees replaced by actuals across a closed month (Q9, D-5, D-23)", () => {
  test("the estimate posts on the ship date; the close warns; the actual reverses and reposts into the first open month; a re-run is a no-op", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const { order } = await tiktokOrder(tx, variant.sku, staff.id, { orderDate: "2027-01-09", collection: "2027-01-10T03:00:00Z" });
      await fees(tx, order.id, "estimate", { admin_fee: 30_000 });
      await postAll(tx);
      expect(await journalsFor(tx, "order", order.id, "channel_fees")).toMatchObject([{ entryDate: "2027-01-10", sides: ["Dr 6-1201 30000", "Cr 1-1303 30000"] }]);
      expect(await tiktokOrdersOnEstimatedFees(tx as never, "2027-01-01")).toEqual({ count: 1, orderNos: [order.orderNo] });

      await tx.insert(fiscalPeriods).values({ month: "2027-01-01", status: "closed", closedAt: new Date(), closedByStaffUserId: staff.id });
      await fees(tx, order.id, "actual", { admin_fee: 26_600, seller_shipping_subsidy: 3_000 });
      const repost = await postAll(tx);
      expect(repost).toMatchObject({ insertedCount: 1, reversedCount: 1 });
      const m2 = await journalsFor(tx, "order", order.id, "channel_fees");
      // Original (January), its reversal and the actual, both in February (the first open month), the
      // actual keeping its January source date.
      expect(m2.map((entry) => [entry.kind, entry.entryDate, entry.sourceDate])).toEqual([
        ["system", "2027-01-10", "2027-01-10"],
        ["reversal", "2027-02-01", "2027-01-10"],
        ["system", "2027-02-01", "2027-01-10"],
      ]);
      expect(m2[2]?.sides).toEqual(["Dr 6-1201 26600", "Dr 6-1202 3000", "Cr 1-1303 29600"]);
      expect(await postAll(tx)).toMatchObject({ insertedCount: 0, reversedCount: 0 });
      expect((await tiktokOrdersOnEstimatedFees(tx as never, "2027-01-01")).count).toBe(0);
    });
  });
});

describe("S7 refund-only (Q10, Q19)", () => {
  test("Retur penjualan on the refund date, no HPP or stock line; 1-1303 at 0 after settlement and payout", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const { order, tiktokOrderId } = await tiktokOrder(tx, variant.sku, staff.id, { orderDate: "2026-12-04", collection: "2026-12-04T23:30:00Z", complete: true });
      await fees(tx, order.id, "actual", { platform_commission: 21_600, admin_fee: 5_000, seller_shipping_subsidy: 3_000 });
      const [refund] = await tx
        .insert(marketplaceRefunds)
        .values({ orderId: order.id, channelId: "tiktok", channelRefundId: `RET-${tiktokOrderId}`, kind: "refund_only", amount: 50_000, refundedAt: new Date("2026-12-10T17:30:00Z") })
        .returning();
      const orderSettlement = 250_000 - 29_600;
      await statement(tx, `st-${tiktokOrderId}`, "2026-12-12T03:00:00Z", orderSettlement - 50_000, `pay-${tiktokOrderId}`, [
        { id: `tx-o-${tiktokOrderId}`, type: "ORDER", tiktokOrderId, settlement: orderSettlement },
        { id: `tx-r-${tiktokOrderId}`, type: "REFUND", tiktokOrderId, settlement: -50_000 },
      ]);
      await payout(tx, `pay-${tiktokOrderId}`, "2026-12-14T17:10:00Z", orderSettlement - 50_000);
      await postAll(tx);

      expect(await journalsFor(tx, "marketplace_refund", refund!.id, "refunded")).toMatchObject([{ sourceDate: "2026-12-11", sides: ["Dr 4-1301 50000", "Cr 1-1303 50000"] }]);
      const net = await orderNet(tx, order.id);
      expect(net["1-1303"]).toBe(orderSettlement - 50_000);
      expect(net["5-1101"]).toBe(87_917);
      expect(net["1-1505"]).toBe(0);
      expect(net["1-1504"]).toBe(-87_917);
      expect(await tx.select().from(stockMovements).where(eq(stockMovements.type, "return")).then((rows) => rows.filter((row) => row.sku === variant.sku))).toEqual([]);
      expect(await accountNetFor(tx, "1-1303", [order.id, refund!.id, `pay-${tiktokOrderId}`])).toBe(0);
      const check = await getTikTokReconciliation("2026-12-31", tx);
      expect(check.orders.rows.find((row) => row.orderId === order.id)).toMatchObject({ status: "ok", ledger: orderSettlement - 50_000 });
      expect(await postAll(tx)).toMatchObject({ insertedCount: 0, reversedCount: 0 });
    });
  });

  test("held behind M1 while collection_time is missing (no journal, no second issue), then both post in one run", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const { order } = await tiktokOrder(tx, variant.sku, staff.id, { orderDate: "2026-12-04", collection: null });
      const [refund] = await tx
        .insert(marketplaceRefunds)
        .values({ orderId: order.id, channelId: "tiktok", channelRefundId: `RET-${randomUUID()}`, kind: "refund_only", amount: 40_000, refundedAt: new Date("2026-12-09T03:00:00Z") })
        .returning();
      await postAll(tx);
      expect(await journalsFor(tx, "marketplace_refund", refund!.id, "refunded")).toEqual([]);
      expect(await openIssues(tx, refund!.id)).toEqual([]);
      expect((await openIssues(tx, order.id)).map((issue) => issue.code)).toEqual(["marketplace_ship_date_missing"]);

      await tx.update(orders).set({ marketplaceShippedAt: new Date("2026-12-05T03:00:00Z") }).where(eq(orders.id, order.id));
      await postAll(tx);
      expect(await journalsFor(tx, "order", order.id, "recognised")).toHaveLength(1);
      expect(await journalsFor(tx, "marketplace_refund", refund!.id, "refunded")).toHaveLength(1);
    });
  });

  test("Ringkasan omzet is lower by the refund in the refund's month, and check 4 shows no difference for the order", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const { order } = await tiktokOrder(tx, variant.sku, staff.id, { orderDate: "2026-12-04", collection: "2026-12-04T23:30:00Z", complete: true });
      await fees(tx, order.id, "actual", { admin_fee: 5_000 });
      const december = { start: new Date("2026-11-30T17:00:00Z"), end: new Date("2026-12-31T17:00:00Z") };
      const before = await getPeriodTotals(december, { canViewProfit: true }, tx as never);
      const channelBefore = (await getChannelBreakdown(december, { canViewProfit: true }, tx as never)).find((row) => row.channelId === "tiktok");

      await tx.insert(marketplaceRefunds).values({ orderId: order.id, channelId: "tiktok", channelRefundId: `RET-${randomUUID()}`, kind: "refund_only", amount: 50_000, refundedAt: new Date("2026-12-10T17:30:00Z") });
      const after = await getPeriodTotals(december, { canViewProfit: true }, tx as never);
      expect(after.money!.omzet).toBe(before.money!.omzet - 50_000);
      expect(after.money!.refundOnly).toBe(before.money!.refundOnly + 50_000);
      expect(after.money!.hpp).toBe(before.money!.hpp);
      expect(after.orders).toBe(before.orders);
      const channelAfter = (await getChannelBreakdown(december, { canViewProfit: true }, tx as never)).find((row) => row.channelId === "tiktok");
      expect(channelAfter!.omzet).toBe(channelBefore!.omzet! - 50_000);
      expect(channelAfter!.orders).toBe(channelBefore!.orders);

      await postAll(tx);
      const range = { from: "2026-12-01", to: "2026-12-31" };
      const now = new Date("2027-01-15T03:00:00Z");
      const check = await getPnlReconciliation(range, tx, now);
      const summary = await getExpenseSummary(range, now, tx);
      expect(check.managementNet).toBe(summary.net);
      const netSales = check.components.find((component) => component.component === "net_sales")!;
      expect(netSales.lines.some((line) => line.sampleKeys.includes(order.id))).toBe(false);
      for (const component of check.components) expect(component.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(component.difference);
    });
  });

  test("a December order refunded in January: December's omzet is unchanged, January's is lower", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const { order } = await tiktokOrder(tx, variant.sku, staff.id, { orderDate: "2026-12-04", collection: "2026-12-04T23:30:00Z", complete: true });
      const december = { start: new Date("2026-11-30T17:00:00Z"), end: new Date("2026-12-31T17:00:00Z") };
      const january = { start: new Date("2026-12-31T17:00:00Z"), end: new Date("2027-01-31T17:00:00Z") };
      const [decBefore, janBefore] = [await getPeriodTotals(december, { canViewProfit: true }, tx as never), await getPeriodTotals(january, { canViewProfit: true }, tx as never)];
      await tx.insert(marketplaceRefunds).values({ orderId: order.id, channelId: "tiktok", channelRefundId: `RET-${randomUUID()}`, kind: "refund_only", amount: 30_000, refundedAt: new Date("2027-01-05T03:00:00Z") });
      expect((await getPeriodTotals(december, { canViewProfit: true }, tx as never)).money!.omzet).toBe(decBefore.money!.omzet);
      expect((await getPeriodTotals(january, { canViewProfit: true }, tx as never)).money!.omzet).toBe(janBefore.money!.omzet - 30_000);
    });
  });
});

async function insertExpense(tx: TestTx, staffId: string, date: string, amount: number) {
  const fileId = randomUUID();
  const sha = fileId.replaceAll("-", "").padEnd(64, "0");
  await tx.insert(privateFiles).values({
    id: fileId,
    purpose: "expense_proof",
    storageKey: `test/expense_proof/${fileId}.jpg`,
    contentType: "image/jpeg",
    byteSize: 1,
    sha256: sha,
    originalFilename: "bukti.jpg",
    originalContentType: "image/jpeg",
    originalByteSize: 1,
    originalSha256: sha,
    uploadedByStaffUserId: staffId,
  });
  const [expense] = await tx
    .insert(businessExpenses)
    .values({ expenseNo: `BYA-T-${randomUUID().slice(0, 8)}`, expenseDate: date, category: "ads_tiktok", channelId: "tiktok", amount, method: "platform_balance", proofFileId: fileId, recordedByStaffUserId: staffId })
    .returning({ id: businessExpenses.id });
  return expense!.id;
}

describe("M5 adjustments by the accountant's mapping (Q8)", () => {
  test("an unmapped type is a posting issue; Pemetaan Akun lists it with the ads suggestion; once mapped it posts, idempotently", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const id = randomUUID().slice(0, 8);
      const type = `ADS_PAYMENT_${id.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
      await statement(tx, `st-adj-${id}`, "2026-12-09T20:00:00Z", -75_000, null, [{ id: `tx-adj-${id}`, type, settlement: -75_000 }]);
      await postAll(tx);
      expect(await openIssues(tx, `tx-adj-${id}`)).toEqual([{ code: "tiktok_adjustment_unmapped", event: "adjustment" }]);
      expect(await journalsFor(tx, "tiktok_statement_transaction", `tx-adj-${id}`, "adjustment")).toEqual([]);

      const page = await getMappingPage(tx as never);
      const row = page.tiktokAdjustments.find((entry) => entry.type === type);
      expect(row).toMatchObject({ accountCode: null, suggestedAccountCode: "6-1101", transactionCount: 1 });
      expect(page.tiktokAdjustmentIssueCount).toBeGreaterThanOrEqual(1);

      await expect(setAccountMapping(`tiktok.adjustment.${type.toLowerCase()}`, "1-1303", staff.id, tx as never)).rejects.toThrow(MAPPING_MESSAGES.targetProblem.seller_balance);
      await expect(setAccountMapping("tiktok.adjustment.never_seen_type", "6-1101", staff.id, tx as never)).rejects.toThrow(MAPPING_MESSAGES.unknownKey);
      await setAccountMapping(`tiktok.adjustment.${type.toLowerCase()}`, "6-1101", staff.id, tx as never);
      await postAll(tx);
      expect(await journalsFor(tx, "tiktok_statement_transaction", `tx-adj-${id}`, "adjustment")).toMatchObject([{ sourceDate: "2026-12-10", sides: ["Dr 6-1101 75000", "Cr 1-1303 75000"] }]);
      expect(await openIssues(tx, `tx-adj-${id}`)).toEqual([]);
      expect(await postAll(tx)).toMatchObject({ insertedCount: 0, reversedCount: 0 });

      // The same ad also recorded as a business expense paid from the balance (M4): listed as a pair.
      const expenseId = await insertExpense(tx, staff.id, "2026-12-11", 75_000);
      const check = await getTikTokReconciliation("2026-12-31", tx);
      expect(check.adsPairs.some((pair) => pair.expense.id === expenseId && pair.amount === 75_000 && pair.month === "2026-12")).toBe(true);
    });
  });
});

describe("review fixes (T8 code review)", () => {
  test("S7 waits for M1 whatever blocks it (an unmapped channel), and Ringkasan never subtracts what S7 will not book", async () => {
    await withRollback(async (tx) => {
      const { variant, staff } = await setup(tx);
      const { order } = await tiktokOrder(tx, variant.sku, staff.id, { orderDate: "2026-12-04", collection: "2026-12-04T23:30:00Z" });
      const [refund] = await tx
        .insert(marketplaceRefunds)
        .values({ orderId: order.id, channelId: "tiktok", channelRefundId: `RET-${randomUUID()}`, kind: "refund_only", amount: 40_000, refundedAt: new Date("2026-12-09T03:00:00Z") })
        .returning();
      await tx.execute(sql`delete from account_mappings where mapping_key = 'revenue.channel.tiktok'`);
      await postAll(tx);
      expect((await openIssues(tx, order.id)).map((issue) => issue.code)).toContain("unmapped_sales_channel");
      expect(await journalsFor(tx, "marketplace_refund", refund!.id, "refunded")).toEqual([]);

      // A refund-only row on an order still at to_ship (S7: marketplace_refund_not_shipped) stays out of omzet.
      setNow("2026-12-06T02:00:00Z");
      const waiting = await createOrder(
        { channelId: "tiktok", channelOrderNo: `57${Date.now()}9`, orderDate: "2026-12-06", items: [{ sku: variant.sku, qty: 1, unitPrice: 270_000 }], discountAmount: 0, shippingAmount: 0, status: "to_ship" },
        staff.id,
        tx as never,
      );
      vi.useRealTimers();
      const december = { start: new Date("2026-11-30T17:00:00Z"), end: new Date("2026-12-31T17:00:00Z") };
      const before = await getPeriodTotals(december, { canViewProfit: true }, tx as never);
      await tx.insert(marketplaceRefunds).values({ orderId: waiting.id, channelId: "tiktok", channelRefundId: `RET-${randomUUID()}`, kind: "refund_only", amount: 10_000, refundedAt: new Date("2026-12-07T03:00:00Z") });
      expect((await getPeriodTotals(december, { canViewProfit: true }, tx as never)).money!.omzet).toBe(before.money!.omzet);
    });
  });

  test("(d) an estimate TikTok no longer lists, or one settled under another transaction id, is not owed any more", async () => {
    await withRollback(async (tx) => {
      const id = randomUUID().slice(0, 8);
      const unsettled = async (transactionId: string, orderId: string, amount: number, lastSeen: string) => {
        const snap = await snapshot(tx, "unsettled_transaction", transactionId);
        await tx.execute(sql`
          insert into tiktok_unsettled_transactions (transaction_id, type, tiktok_order_id, est_settlement_amount, content_sha256, latest_snapshot_id, first_seen_at, last_seen_at)
          values (${transactionId}, 'ORDER', ${orderId}, ${amount}, ${SHA}, ${snap}::uuid, '2026-12-05T00:00:00Z', ${lastSeen}::timestamptz)`);
      };
      const owedBefore = await getTikTokReconciliation("2026-12-31", tx);
      await unsettled(`u-live-${id}`, `91${id}`, 100_000, "2026-12-30T00:00:00Z");
      await unsettled(`u-gone-${id}`, `92${id}`, 70_000, "2026-12-06T00:00:00Z");
      await unsettled(`u-other-id-${id}`, `93${id}`, 50_000, "2026-12-30T00:00:00Z");
      await statement(tx, `st-${id}`, "2026-12-20T03:00:00Z", 50_000, null, [{ id: `tx-real-${id}`, type: "ORDER", tiktokOrderId: `93${id}`, settlement: 50_000 }]);
      const owed = await getTikTokReconciliation("2026-12-31", tx);
      // Live estimate counted; the one TikTok stopped listing is not; the settled one counts once, as settled.
      expect(owed.balance.unsettled - owedBefore.balance.unsettled).toBe(100_000);
      expect(owed.balance.settledNotPaidOut - owedBefore.balance.settledNotPaidOut).toBe(50_000);
    });
  });
});
