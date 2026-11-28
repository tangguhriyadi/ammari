import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { orderChannelFees, tiktokOrders, tiktokPayouts, tiktokStatements, tiktokSyncCursors } from "@ammari/db/schema";
import { insertOrder, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { Secret, createTikTokClient, projectTikTokOrder, type FetchLike, type TikTokAuthClient, type TikTokTokenSet, type TokenKeyring } from "@ammari/tiktok-shop";
import { saveTikTokConnection } from "./connection";
import { ingestTikTokOrder } from "./order-store";
import { TIKTOK_FINANCE_EVERY_MS, runTikTokSync } from "./sync";

// docs/plans/tiktok-shop-integration.md T7 through the sync run, against a real database (each test
// rolls back) and an in-memory TikTok that answers the five finance reads (all GET: nothing is ever
// written to TikTok, Q15). Finance runs at most every 30 minutes and only with seller.finance.info.

const NOW = new Date("2026-12-05T03:00:00.000Z");
const DAY = 86_400_000;
const SHOP_ID = "7495540735365777508";
const KEYRING: TokenKeyring = { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(32).fill(4))]]) };
const ORDER_ID = "576653688135299001";
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

async function connect(db: TestDatabase, scopes: string[]) {
  const staff = await insertStaffUser(db);
  const tokens: TikTokTokenSet = {
    accessToken: new Secret("ROW_access_t7"),
    accessTokenExpiresAt: new Date(NOW.getTime() + 7 * DAY),
    refreshToken: new Secret("ROW_refresh_t7"),
    refreshTokenExpiresAt: new Date(NOW.getTime() + 60 * DAY),
    grantedScopes: scopes,
    sellerName: "Ammari",
    sellerBaseRegion: "ID",
  };
  const result = await saveTikTokConnection(db, { tokens, shop: { shopId: SHOP_ID, shopCipher: "ROW_cipher", shopName: "Ammari", region: "ID", sellerType: "LOCAL" }, staffUserId: staff.id, keyring: KEYRING, now: new Date(NOW.getTime() - DAY) });
  if (!result.ok) throw new Error(result.reason);
}

/** A TikTok order already applied to admin (T5), so its fees can be written. */
async function appliedOrder(db: TestDatabase): Promise<string> {
  const projected = projectTikTokOrder({ id: ORDER_ID, status: "IN_TRANSIT", update_time: seconds(NOW) - 3600, paid_time: seconds(NOW) - 7200, payment: { currency: "IDR" }, line_items: [] });
  if (!projected.ok) throw new Error("projection failed");
  await ingestTikTokOrder(db, projected.order, "poll", NOW);
  const order = await insertOrder(db, { channelId: "tiktok", channelOrderNo: ORDER_ID, status: "shipped" });
  await db.update(tiktokOrders).set({ orderId: order.id }).where(eq(tiktokOrders.tiktokOrderId, ORDER_ID));
  return order.id;
}

interface Fake {
  fetch: FetchLike;
  calls: { method: string; path: string }[];
  unsettled: Record<string, unknown>[];
  statements: Record<string, unknown>[];
  transactions: Map<string, Record<string, unknown>[]>;
  orderTransactions: Map<string, Record<string, unknown>>;
  payments: Record<string, unknown>[];
  clock: { ms: number };
}

function fakeTikTok(): Fake {
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: "Success", request_id: "fake", data }), { status: 200 });
  const fake: Fake = {
    calls: [],
    unsettled: [],
    statements: [],
    transactions: new Map(),
    orderTransactions: new Map(),
    payments: [],
    clock: { ms: NOW.getTime() },
    fetch: async (input, init) => {
      const url = new URL(input);
      fake.calls.push({ method: String(init.method), path: url.pathname });
      if (url.pathname === "/order/202309/orders/search") return ok({ orders: [], next_page_token: "" });
      if (url.pathname === "/return_refund/202309/returns/search") return ok({ return_orders: [] });
      if (url.pathname === "/return_refund/202309/cancellations/search") return ok({ cancellations: [] });
      if (url.pathname === "/finance/202507/orders/unsettled") return ok({ transactions: fake.unsettled });
      if (url.pathname === "/finance/202309/statements") {
        const ge = Number(url.searchParams.get("statement_time_ge"));
        const lt = Number(url.searchParams.get("statement_time_lt"));
        return ok({ statements: fake.statements.filter((s) => (s.statement_time as number) >= ge && (s.statement_time as number) < lt) });
      }
      const byStatement = /^\/finance\/202501\/statements\/([^/]+)\/statement_transactions$/.exec(url.pathname);
      if (byStatement) {
        const list = fake.transactions.get(decodeURIComponent(byStatement[1]!));
        return list ? ok({ statement_transactions: list }) : new Response(JSON.stringify({ code: 36009998, message: "no", request_id: "x" }), { status: 200 });
      }
      const byOrder = /^\/finance\/202501\/orders\/([^/]+)\/statement_transactions$/.exec(url.pathname);
      if (byOrder) {
        const data = fake.orderTransactions.get(decodeURIComponent(byOrder[1]!));
        return data ? ok(data) : new Response(JSON.stringify({ code: 36009999, message: "no", request_id: "x" }), { status: 200 });
      }
      if (url.pathname === "/finance/202309/payments") {
        const ge = Number(url.searchParams.get("create_time_ge"));
        const lt = Number(url.searchParams.get("create_time_lt"));
        return ok({ payments: fake.payments.filter((p) => (p.create_time as number) >= ge && (p.create_time as number) < lt) });
      }
      return new Response(JSON.stringify({ code: 40001, message: "nope", request_id: "x" }), { status: 404 });
    },
  };
  return fake;
}

const refusingAuth: TikTokAuthClient = {
  getAccessToken: async () => {
    throw new Error("test: no token exchange expected");
  },
  refreshAccessToken: async () => {
    throw new Error("test: no refresh expected");
  },
};

function deps(fake: Fake) {
  const api = createTikTokClient({ appKey: new Secret("dummyappkey"), appSecret: new Secret("dummyappsecret0123456789"), baseUrl: "https://tiktok.test", fetch: fake.fetch, now: () => fake.clock.ms, sleep: async () => {}, random: () => 0 });
  return { api, auth: refusingAuth, keyring: KEYRING, now: () => new Date(fake.clock.ms) };
}

async function fees(db: TestDatabase, orderId: string) {
  return (await db.select({ component: orderChannelFees.component, amount: orderChannelFees.amount, source: orderChannelFees.source }).from(orderChannelFees).where(eq(orderChannelFees.orderId, orderId))).sort((a, b) => a.component.localeCompare(b.component));
}

const STATEMENT_ID = "7300000000000009001";

function settledFake(fake: Fake) {
  fake.statements = [{ id: STATEMENT_ID, statement_time: seconds(NOW) - DAY / 1000, currency: "IDR", settlement_amount: "205000", payment_status: "PAID", payment_id: "7400000000000009001" }];
  fake.transactions.set(STATEMENT_ID, [
    { id: "7500000000000009001", type: "ORDER", order_id: ORDER_ID, settlement_amount: "225000", revenue_amount: "249000", fee_tax_amount: "-24000", shipping_cost_amount: "0" },
    { id: "7500000000000009002", type: "GMV_PAYMENT_FOR_ADS", settlement_amount: "-20000", adjustment_amount: "-20000" },
  ]);
  fake.orderTransactions.set(ORDER_ID, {
    order_id: ORDER_ID,
    statement_transactions: [
      {
        id: "7500000000000009001",
        statement_id: STATEMENT_ID,
        sku_statement_transactions: [
          { sku_id: "sku-a", fee_tax_breakdown: { fee: { platform_commission_amount: "-10000", transaction_fee_amount: "-5000" } } },
          { sku_id: "sku-b", fee_tax_breakdown: { fee: { platform_commission_amount: "-5000", transaction_fee_amount: "-4000" } } },
        ],
      },
    ],
  });
  fake.payments = [{ id: "7400000000000009001", create_time: seconds(NOW) - 3600, paid_time: seconds(NOW) - 1800, status: "PAID", amount: { value: "205000", currency: "IDR" }, bank_account: "*****1234" }];
}

describe("finance in the sync run", () => {
  test("without seller.finance.info, finance never calls TikTok", async () => {
    await withRollback(async (db) => {
      await connect(db, ["seller.order.info"]);
      const fake = fakeTikTok();
      const summary = await runTikTokSync(db, deps(fake));
      expect(summary.finance.skipped).toBe("no_scope");
      expect(fake.calls.some((call) => call.path.startsWith("/finance/"))).toBe(false);
    });
  });

  test("estimate first, then the settled actual replaces it; statements, payouts stored; only GET calls", async () => {
    await withRollback(async (db) => {
      await connect(db, ["seller.order.info", "seller.finance.info"]);
      const orderId = await appliedOrder(db);
      const fake = fakeTikTok();
      fake.unsettled = [{ id: "7600000000000009001", type: "ORDER", order_id: ORDER_ID, est_settlement_amount: "225000", est_fee_tax_amount: "-24900", est_shipping_cost_amount: "0", fee_tax_breakdown: { fee: { platform_commission_amount: "-14940", transaction_fee_amount: "-9960" } } }];

      const first = await runTikTokSync(db, deps(fake));
      expect(first.error).toBeNull();
      expect(first.finance).toMatchObject({ skipped: null, unsettled: 1, statements: 0, feesWritten: 1 });
      expect(await fees(db, orderId)).toEqual([
        { component: "admin_fee", amount: 9960, source: "estimate" },
        { component: "platform_commission", amount: 14940, source: "estimate" },
      ]);

      // Five minutes later: not due yet (every 30 minutes).
      fake.clock.ms += 5 * 60_000;
      expect((await runTikTokSync(db, deps(fake))).finance.skipped).toBe("not_due");

      // Settled: the statement, its transactions, the SKU-level fees and the payout arrive.
      settledFake(fake);
      fake.clock.ms += TIKTOK_FINANCE_EVERY_MS;
      const settled = await runTikTokSync(db, deps(fake));
      expect(settled.error).toBeNull();
      expect(settled.finance).toMatchObject({ skipped: null, statements: 1, statementTransactions: 2, statementsHeld: 0, orderFetches: 1, payouts: 1, feesWritten: 1 });
      expect(await fees(db, orderId)).toEqual([
        { component: "admin_fee", amount: 9000, source: "actual" },
        { component: "platform_commission", amount: 15000, source: "actual" },
      ]);
      const [statement] = await db.select().from(tiktokStatements).where(eq(tiktokStatements.statementId, STATEMENT_ID));
      expect(statement).toMatchObject({ heldReason: null, paymentId: "7400000000000009001", settlementAmount: 205000 });
      expect(statement!.transactionsCompleteSha256).toMatch(/^[0-9a-f]{64}$/);
      const [payout] = await db.select().from(tiktokPayouts);
      expect(payout).toMatchObject({ amount: 205000, bankAccountLast4: "1234", status: "PAID" });
      expect(fake.calls.every((call) => call.method === "GET" || !call.path.startsWith("/finance/"))).toBe(true);

      // A re-run over the same data changes nothing and fetches the order's fees no more.
      fake.clock.ms += TIKTOK_FINANCE_EVERY_MS;
      const callsBefore = fake.calls.length;
      const again = await runTikTokSync(db, deps(fake));
      expect(again.finance).toMatchObject({ orderFetches: 0, feesWritten: 0 });
      expect(fake.calls.slice(callsBefore).some((call) => call.path.includes(`/orders/${ORDER_ID}/`))).toBe(false);
      const cursors = await db.select({ resource: tiktokSyncCursors.resource, lastOkAt: tiktokSyncCursors.lastOkAt }).from(tiktokSyncCursors);
      for (const resource of ["unsettled", "statements", "payments"]) expect(cursors.find((row) => row.resource === resource)?.lastOkAt).not.toBeNull();
    });
  });

  test("a statement entry without an id holds the statements cursor (incomplete); the rest is still stored and the other polls run", async () => {
    await withRollback(async (db) => {
      await connect(db, ["seller.order.info", "seller.finance.info"]);
      const fake = fakeTikTok();
      settledFake(fake);
      fake.statements.push({ statement_time: seconds(NOW) - DAY / 1000, settlement_amount: "1" });
      const summary = await runTikTokSync(db, deps(fake));
      expect(summary.error).toEqual({ kind: "incomplete", code: "finance_invalid" });
      expect(summary.finance.statements).toBe(1);
      expect(summary.finance.payouts).toBe(1);
      const [cursor] = await db.select().from(tiktokSyncCursors).where(eq(tiktokSyncCursors.resource, "statements"));
      // The earlier, complete slice moved it; it stays before the slice holding the bad entry.
      expect(cursor!.windowEnd!.getTime()).toBeLessThan(NOW.getTime() - DAY);
    });
  });

  test("one order whose fees TikTok refuses is named and retried; it does not stop the run", async () => {
    await withRollback(async (db) => {
      await connect(db, ["seller.order.info", "seller.finance.info"]);
      await appliedOrder(db);
      const fake = fakeTikTok();
      settledFake(fake);
      fake.orderTransactions.clear();
      const summary = await runTikTokSync(db, deps(fake));
      expect(summary.error).toBeNull();
      expect(summary.finance.failed).toBe(1);
      expect(summary.finance.problems).toEqual(expect.arrayContaining([expect.objectContaining({ id: `order:${ORDER_ID}`, kind: "failed" })]));
      expect(summary.finance.payouts).toBe(1);
    });
  });

  test("one statement whose transactions TikTok refuses is named and holds the cursor; the others and the order fees still go through", async () => {
    await withRollback(async (db) => {
      await connect(db, ["seller.order.info", "seller.finance.info"]);
      const orderId = await appliedOrder(db);
      const fake = fakeTikTok();
      settledFake(fake);
      // An older statement (8 days back, another slice) whose transaction list TikTok refuses.
      fake.statements.unshift({ id: "7300000000000009000", statement_time: seconds(NOW) - (8 * DAY) / 1000, currency: "IDR", settlement_amount: "1", payment_status: "PAID" });
      const summary = await runTikTokSync(db, deps(fake));
      expect(summary.error).toEqual({ kind: "incomplete", code: "finance_invalid" });
      expect(summary.finance.problems).toEqual(expect.arrayContaining([expect.objectContaining({ id: "statement:7300000000000009000", kind: "failed" })]));
      expect(summary.finance).toMatchObject({ statements: 2, orderFetches: 1, payouts: 1 });
      expect(await fees(db, orderId)).toEqual([
        { component: "admin_fee", amount: 9000, source: "actual" },
        { component: "platform_commission", amount: 15000, source: "actual" },
      ]);
    });
  });
});
