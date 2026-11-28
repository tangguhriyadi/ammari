import { describe, expect, test } from "vitest";
import { createTikTokClient, type FetchLike } from "../src/client";
import {
  TIKTOK_PAYMENT_ALLOWLIST,
  TIKTOK_STATEMENT_ALLOWLIST,
  TIKTOK_STATEMENT_TRANSACTION_ALLOWLIST,
  TIKTOK_UNSETTLED_ALLOWLIST,
  getTikTokOrderTransactions,
  getTikTokPayments,
  getTikTokStatementTransactions,
  getTikTokStatements,
  getTikTokUnsettledTransactions,
  projectTikTokOrderTransactions,
  projectTikTokPayment,
  projectTikTokStatement,
  projectTikTokStatementTransaction,
  projectTikTokUnsettledTransaction,
} from "../src/finance";
import { Secret } from "../src/secret";
import { seeded } from "./random";

// docs/plans/tiktok-shop-integration.md T7: the finance read side (read only, Q15). Amounts are
// strings parsed with the strict whole-rupiah parser (Q6): anything else is a `money_format` problem,
// never rounded. Fee breakdown keys are TikTok's own type names, kept as received (an unknown one is
// never dropped). No buyer field or bank account number survives an allowlist (§6).

const START = Date.UTC(2026, 10, 28, 3, 0, 0);
const BUYER = { name: "Siti Buyer", phone: "+6281234567890", account: "1234567890123456" };

function rawStatement(overrides: Record<string, unknown> = {}) {
  return {
    id: "7300000000000000001",
    statement_time: 1764288000,
    currency: "IDR",
    settlement_amount: "205000",
    revenue_amount: "249000",
    fee_amount: "-24000",
    adjustment_amount: "-20000",
    shipping_cost_amount: "0",
    payment_status: "PAID",
    payment_id: "7400000000000000001",
    seller_contact: { phone: BUYER.phone },
    ...overrides,
  };
}

function rawTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "7500000000000000001",
    type: "ORDER",
    order_id: "576653688135258178",
    order_create_time: 1764200000,
    currency: "IDR",
    settlement_amount: "225000",
    revenue_amount: "249000",
    fee_tax_amount: "-24000",
    shipping_cost_amount: "0",
    fee_tax_breakdown: { fee: { platform_commission_amount: "-14940", transaction_fee_amount: "-9060" }, tax: {} },
    shipping_cost_breakdown: { actual_shipping_fee_amount: "-15000", customer_paid_shipping_fee_amount: "15000", supplementary_component: { platform_shipping_fee_discount_amount: "0" } },
    buyer_name: BUYER.name,
    recipient_address: { phone: BUYER.phone },
    ...overrides,
  };
}

describe("projectTikTokStatement", () => {
  test("keeps ids, time, status and amounts; parses the amounts as signed whole rupiah", () => {
    const result = projectTikTokStatement(rawStatement());
    if (!result.ok) throw new Error("projection failed");
    expect(result.value).toMatchObject({
      statementId: "7300000000000000001",
      currency: "IDR",
      amounts: { settlement: 205000, revenue: 249000, fee: -24000, adjustment: -20000, shippingCost: 0 },
      problem: null,
      paymentStatus: "PAID",
      paymentId: "7400000000000000001",
    });
    expect(result.value.statementTime.getTime()).toBe(1764288000 * 1000);
    expect(JSON.stringify(result.value.payload)).not.toContain(BUYER.phone);
    expect(result.value.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ["a decimal", { settlement_amount: "205000.50" }, "money_format", "settlement_amount"],
    ["an exponent", { fee_amount: "-2.4e4" }, "money_format", "fee_amount"],
    ["a JSON number", { revenue_amount: 249000 }, "money_format", "revenue_amount"],
    ["an absent settlement", { settlement_amount: undefined }, "money_format", "settlement_amount"],
    ["an empty value", { adjustment_amount: "" }, "money_format", "adjustment_amount"],
    ["another currency", { currency: "USD" }, "currency", "currency"],
    ["no currency", { currency: undefined }, "currency", "currency"],
  ])("%s is a problem, never rounded or defaulted", (_name, overrides, problem, field) => {
    const result = projectTikTokStatement(rawStatement(overrides));
    if (!result.ok) throw new Error("projection failed");
    expect(result.value.problem).toBe(problem);
    expect(result.value.problemField).toBe(field);
  });

  test("a bad amount becomes null, never a rounded number", () => {
    const result = projectTikTokStatement(rawStatement({ settlement_amount: "205000.50" }));
    if (!result.ok) throw new Error("projection failed");
    expect(result.value.amounts.settlement).toBeNull();
  });

  test("free text or a list under an allowlisted field is dropped, never stored", () => {
    const result = projectTikTokStatement(rawStatement({ payment_status: `PAID ${BUYER.name}`, payment_id: ["a", "b"], currency: "IDR" }));
    if (!result.ok) throw new Error("projection failed");
    expect(result.value.payload).not.toHaveProperty("payment_status");
    expect(result.value.payload).not.toHaveProperty("payment_id");
    expect(result.value.paymentStatus).toBeNull();
    const payout = projectTikTokPayment({ id: "p", status: "a note with spaces", amount: { value: "1", currency: "IDR" } });
    if (!payout.ok) throw new Error("projection failed");
    expect(JSON.stringify(payout.value.payload)).not.toContain("note");
  });

  test("a `.` or `..` id is refused (it would be a path segment)", () => {
    expect(projectTikTokStatement(rawStatement({ id: ".." }))).toEqual({ ok: false, id: null });
  });

  test("no id or no statement time cannot be versioned", () => {
    expect(projectTikTokStatement(rawStatement({ id: undefined }))).toEqual({ ok: false, id: null });
    expect(projectTikTokStatement(rawStatement({ statement_time: "1764288000" }))).toEqual({ ok: false, id: "7300000000000000001" });
  });
});

describe("projectTikTokStatementTransaction", () => {
  test("type kept as received; fee lines named by TikTok's own keys, nested shipping flattened", () => {
    const result = projectTikTokStatementTransaction("7300000000000000001", rawTransaction());
    if (!result.ok) throw new Error("projection failed");
    expect(result.value).toMatchObject({ transactionId: "7500000000000000001", statementId: "7300000000000000001", type: "ORDER", tiktokOrderId: "576653688135258178", problem: null });
    expect(result.value.amounts).toEqual({ settlement: 225000, revenue: 249000, feeTax: -24000, shippingCost: 0, adjustment: null });
    expect(result.value.fees).toEqual([
      { skuId: "", group: "fee", type: "platform_commission_amount", amount: -14940 },
      { skuId: "", group: "fee", type: "transaction_fee_amount", amount: -9060 },
      { skuId: "", group: "shipping", type: "actual_shipping_fee_amount", amount: -15000 },
      { skuId: "", group: "shipping", type: "customer_paid_shipping_fee_amount", amount: 15000 },
      { skuId: "", group: "shipping", type: "supplementary_component.platform_shipping_fee_discount_amount", amount: 0 },
    ]);
    const json = JSON.stringify(result.value.payload);
    for (const value of Object.values(BUYER)) expect(json).not.toContain(value);
    expect(result.value.payload).toMatchObject({ fee_tax_breakdown: { fee: { platform_commission_amount: "-14940" } } });
  });

  test("an unknown fee type is kept under its own name, never dropped", () => {
    const result = projectTikTokStatementTransaction("s", rawTransaction({ fee_tax_breakdown: { fee: { brand_new_fee_amount: "-500" } } }));
    if (!result.ok) throw new Error("projection failed");
    expect(result.value.fees).toEqual(expect.arrayContaining([{ skuId: "", group: "fee", type: "brand_new_fee_amount", amount: -500 }]));
  });

  test("an adjustment type and its linked order are kept", () => {
    const result = projectTikTokStatementTransaction("s", { id: "a-1", type: "GMV_PAYMENT_FOR_ADS", adjustment_amount: "-20000", settlement_amount: "-20000" });
    if (!result.ok) throw new Error("projection failed");
    expect(result.value).toMatchObject({ type: "GMV_PAYMENT_FOR_ADS", tiktokOrderId: null, amounts: { settlement: -20000, adjustment: -20000 } });
    const linked = projectTikTokStatementTransaction("s", { id: "a-2", type: "SHIPPING_FEE_ADJUSTMENT", adjustment_order_id: "576653688135258178", settlement_amount: "-1000" });
    if (!linked.ok) throw new Error("projection failed");
    expect(linked.value.tiktokOrderId).toBe("576653688135258178");
  });

  test.each([
    ["a decimal fee", { fee_tax_breakdown: { fee: { platform_commission_amount: "-14940.5" } } }, "fee_tax_breakdown.fee.platform_commission_amount"],
    ["a JSON number fee", { fee_tax_breakdown: { fee: { platform_commission_amount: -14940 } } }, "fee_tax_breakdown.fee.platform_commission_amount"],
    ["a non snake_case key", { fee_tax_breakdown: { fee: { "Platform Fee": "-1" } } }, "fee_tax_breakdown.fee.?"],
    ["a breakdown nested too deep", { shipping_cost_breakdown: { a: { b: { c: "1" } } } }, "shipping_cost_breakdown.a.b"],
    ["a breakdown that is not an object", { shipping_cost_breakdown: "-1000" }, "shipping_cost_breakdown"],
    ["a fee group other than fee and tax", { fee_tax_breakdown: { fee: {}, levy: { a_amount: "-1" } } }, "fee_tax_breakdown.levy"],
    ["a decimal settlement", { settlement_amount: "1.5" }, "settlement_amount"],
  ])("%s is money_format", (_name, overrides, field) => {
    const result = projectTikTokStatementTransaction("s", rawTransaction(overrides));
    if (!result.ok) throw new Error("projection failed");
    expect(result.value.problem).toBe("money_format");
    expect(result.value.problemField).toBe(field);
  });

  test("free text under a breakdown key never reaches the payload", () => {
    const result = projectTikTokStatementTransaction("s", rawTransaction({ fee_tax_breakdown: { fee: { note_amount: BUYER.name } } }));
    if (!result.ok) throw new Error("projection failed");
    expect(JSON.stringify(result.value.payload)).not.toContain(BUYER.name);
    expect(result.value.problem).toBe("money_format");
  });

  test("no id or no type cannot be versioned", () => {
    expect(projectTikTokStatementTransaction("s", rawTransaction({ id: undefined }))).toEqual({ ok: false, id: null });
    expect(projectTikTokStatementTransaction("s", rawTransaction({ type: "order" }))).toEqual({ ok: false, id: "7500000000000000001" });
  });
});

describe("projectTikTokOrderTransactions", () => {
  test("SKU-level lines when TikTok split the transaction; the order-level breakdown is then not counted twice", () => {
    const result = projectTikTokOrderTransactions("576653688135258178", {
      order_id: "576653688135258178",
      statement_transactions: [
        {
          id: "7500000000000000001",
          statement_id: "7300000000000000001",
          fee_tax_breakdown: { fee: { platform_commission_amount: "-14940" } },
          sku_statement_transactions: [
            { sku_id: "sku-a", fee_tax_breakdown: { fee: { platform_commission_amount: "-9000" } }, buyer_name: BUYER.name, product_name: "Gamis Siti" },
            { sku_id: "sku-b", fee_tax_breakdown: { fee: { platform_commission_amount: "-5940" } } },
          ],
        },
        { id: "7500000000000000002", fee_tax_breakdown: { fee: { platform_commission_amount: "1000" } } },
        { type: "ORDER" },
      ],
    });
    expect(result.invalid).toBe(1);
    expect(result.transactions).toEqual([
      {
        transactionId: "7500000000000000001",
        statementId: "7300000000000000001",
        problem: null,
        problemField: null,
        fees: [
          { skuId: "sku-a", group: "fee", type: "platform_commission_amount", amount: -9000 },
          { skuId: "sku-b", group: "fee", type: "platform_commission_amount", amount: -5940 },
        ],
      },
      { transactionId: "7500000000000000002", statementId: null, problem: null, problemField: null, fees: [{ skuId: "", group: "fee", type: "platform_commission_amount", amount: 1000 }] },
    ]);
    expect(JSON.stringify(result.payload)).not.toContain(BUYER.name);
    expect(JSON.stringify(result.payload)).not.toContain("Gamis Siti");
  });

  test("a SKU listed twice has its amounts summed per fee type (one stored row, nothing overwritten)", () => {
    const result = projectTikTokOrderTransactions("576653688135258178", {
      statement_transactions: [{ id: "t", sku_statement_transactions: [{ sku_id: "a", fee_tax_breakdown: { fee: { x_amount: "-1" } } }, { sku_id: "a", fee_tax_breakdown: { fee: { x_amount: "-2" } } }] }],
    });
    expect(result.transactions[0]!.fees).toEqual([{ skuId: "a", group: "fee", type: "x_amount", amount: -3 }]);
  });

  test("a SKU without an id is money_format for that transaction", () => {
    const result = projectTikTokOrderTransactions("576653688135258178", { statement_transactions: [{ id: "t", sku_statement_transactions: [{ fee_tax_breakdown: { fee: { x_amount: "-1" } } }] }] });
    expect(result.transactions[0]!.problem).toBe("money_format");
  });
});

describe("projectTikTokUnsettledTransaction", () => {
  test("estimated amounts and order-level estimated fee lines", () => {
    const result = projectTikTokUnsettledTransaction({
      id: "7600000000000000001",
      type: "ORDER",
      order_id: "576653688135258178",
      est_settlement_amount: "225000",
      est_revenue_amount: "249000",
      est_fee_tax_amount: "-24000",
      fee_tax_breakdown: { fee: { platform_commission_amount: "-14940", transaction_fee_amount: "-9060" } },
      buyer_name: BUYER.name,
    });
    if (!result.ok) throw new Error("projection failed");
    expect(result.value).toMatchObject({ transactionId: "7600000000000000001", type: "ORDER", tiktokOrderId: "576653688135258178", problem: null, amounts: { settlement: 225000, revenue: 249000, feeTax: -24000, shippingCost: null } });
    expect(result.value.fees.map((line) => [line.type, line.amount])).toEqual([
      ["platform_commission_amount", -14940],
      ["transaction_fee_amount", -9060],
    ]);
    expect(JSON.stringify(result.value.payload)).not.toContain(BUYER.name);
  });

  test("an ORDER or REFUND that names no order is refused (never stored as an adjustment)", () => {
    expect(projectTikTokUnsettledTransaction({ id: "u", type: "ORDER", est_settlement_amount: "1" })).toEqual({ ok: false, id: "u" });
    expect(projectTikTokStatementTransaction("s", { id: "t", type: "REFUND", order_id: "not an id", settlement_amount: "1" })).toEqual({ ok: false, id: "t" });
    expect(projectTikTokStatementTransaction("s", { id: "a", type: "GMV_PAYMENT_FOR_ADS", settlement_amount: "1" })).toMatchObject({ ok: true });
  });

  test("an estimate that is not whole rupiah is money_format", () => {
    const result = projectTikTokUnsettledTransaction({ id: "u", type: "ORDER", order_id: "576653688135258178", est_settlement_amount: "1000.10" });
    if (!result.ok) throw new Error("projection failed");
    expect(result.value.problem).toBe("money_format");
  });
});

describe("projectTikTokPayment", () => {
  test("amount, times, status; only the last four digits of the bank account", () => {
    const result = projectTikTokPayment({ id: "7400000000000000001", create_time: 1764300000, paid_time: 1764310000, status: "PAID", amount: { value: "205000", currency: "IDR" }, bank_account: `************${BUYER.account.slice(-4)}`, account_holder: BUYER.name });
    if (!result.ok) throw new Error("projection failed");
    expect(result.value).toMatchObject({ paymentId: "7400000000000000001", status: "PAID", currency: "IDR", amount: 205000, problem: null, bankAccountLast4: "3456" });
    expect(result.value.paidTime?.getTime()).toBe(1764310000 * 1000);
    const json = JSON.stringify(result.value.payload);
    expect(json).not.toContain("bank_account");
    expect(json).not.toContain(BUYER.name);
    expect(json).not.toContain("*");
  });

  test("a decimal payout or another currency is a problem", () => {
    const decimal = projectTikTokPayment({ id: "p", amount: { value: "205000.01", currency: "IDR" } });
    const usd = projectTikTokPayment({ id: "p", amount: { value: "205000", currency: "USD" } });
    if (!decimal.ok || !usd.ok) throw new Error("projection failed");
    expect(decimal.value).toMatchObject({ problem: "money_format", amount: null });
    expect(usd.value.problem).toBe("currency");
  });
});

test("the allowlists name no buyer or bank field", () => {
  const keys = JSON.stringify([TIKTOK_STATEMENT_ALLOWLIST, TIKTOK_STATEMENT_TRANSACTION_ALLOWLIST, TIKTOK_UNSETTLED_ALLOWLIST, TIKTOK_PAYMENT_ALLOWLIST]);
  for (const key of ["buyer", "recipient", "address", "phone", "email", "user_id", "bank_account", "holder", "note"]) expect(keys).not.toContain(key);
});

// ---- Calls ----------------------------------------------------------------------------------

type Reply = { status?: number; body?: unknown };

function harness(replies: Reply[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: new URL(input), init });
    const reply = replies.shift();
    if (!reply) throw new Error("test: no more replies");
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  let clock = START;
  const client = createTikTokClient({
    appKey: new Secret("dummyappkey"),
    appSecret: new Secret("dummyappsecret0123456789"),
    baseUrl: "https://tiktok.test",
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random: seeded(7),
  });
  return { client, calls };
}

const ok = (data: unknown) => ({ body: { code: 0, message: "Success", request_id: "req", data } });
const call = { accessToken: new Secret("ROW_dummy_token"), shopCipher: "ROW_cipher", deadline: START + 150_000 };
const from = new Date(START - 7 * 86_400_000);
const to = new Date(START);

describe("finance calls (GET only, read only)", () => {
  test("Get Statements: window bounds, ascending, page_token percent-encoded; records projected, invalid counted", async () => {
    const h = harness([ok({ statements: [rawStatement(), { id: "bad" }], next_page_token: "s+/t==" })]);
    const page = await getTikTokStatements(h.client, { ...call, from, to, pageToken: "a+b/c=" });
    const request = h.calls[0]!;
    expect(request.init.method).toBe("GET");
    expect(request.url.pathname).toBe("/finance/202309/statements");
    expect(request.url.searchParams.get("statement_time_ge")).toBe(String(Math.floor(from.getTime() / 1000)));
    expect(request.url.searchParams.get("statement_time_lt")).toBe(String(Math.floor(to.getTime() / 1000)));
    expect(request.url.searchParams.get("sort_order")).toBe("ASC");
    expect(request.url.search).toContain("page_token=a%2Bb%2Fc%3D");
    expect(page.records).toHaveLength(1);
    expect(page).toMatchObject({ invalid: 1, invalidIds: ["bad"], nextPageToken: "s+/t==" });
  });

  test("Get Transactions by Statement: the statement id is in the path, each transaction tied to it", async () => {
    const h = harness([ok({ statement_transactions: [rawTransaction()], next_page_token: "" })]);
    const page = await getTikTokStatementTransactions(h.client, "7300000000000000001", call);
    expect(h.calls[0]!.url.pathname).toBe("/finance/202501/statements/7300000000000000001/statement_transactions");
    expect(page.records[0]!.statementId).toBe("7300000000000000001");
    expect(page.nextPageToken).toBeNull();
  });

  test("Get Transactions by Order, Get Unsettled Transactions, Get Payments", async () => {
    const h = harness([
      ok({ order_id: "576653688135258178", statement_transactions: [{ id: "t1", sku_statement_transactions: [{ sku_id: "s", fee_tax_breakdown: { fee: { a_amount: "-1" } } }] }] }),
      ok({ transactions: [{ id: "u1", type: "ORDER", order_id: "576653688135258178", est_settlement_amount: "1" }] }),
      ok({ payments: [{ id: "p1", amount: { value: "1", currency: "IDR" } }] }),
    ]);
    const order = await getTikTokOrderTransactions(h.client, "576653688135258178", call);
    const unsettled = await getTikTokUnsettledTransactions(h.client, { ...call, from, to });
    const payments = await getTikTokPayments(h.client, { ...call, from, to });
    expect(h.calls.map((c) => [c.init.method, c.url.pathname])).toEqual([
      ["GET", "/finance/202501/orders/576653688135258178/statement_transactions"],
      ["GET", "/finance/202507/orders/unsettled"],
      ["GET", "/finance/202309/payments"],
    ]);
    expect(h.calls[1]!.url.searchParams.get("search_time_ge")).not.toBeNull();
    expect(h.calls[2]!.url.searchParams.get("create_time_lt")).not.toBeNull();
    expect(order.transactions[0]!.fees).toEqual([{ skuId: "s", group: "fee", type: "a_amount", amount: -1 }]);
    expect(unsettled.records[0]!.transactionId).toBe("u1");
    expect(payments.records[0]!.amount).toBe(1);
  });

  test("a list under another name than assumed is refused, never read as empty", async () => {
    const h = harness([ok({ statement_list: [rawStatement()] })]);
    await expect(getTikTokStatements(h.client, { ...call, from, to })).rejects.toMatchObject({ kind: "invalid_response" });
  });

  test("an empty answer is no records (not an error)", async () => {
    const h = harness([ok({})]);
    await expect(getTikTokPayments(h.client, { ...call, from, to })).resolves.toMatchObject({ records: [], nextPageToken: null });
  });

  test("bounds are validated before any call", async () => {
    const h = harness([]);
    await expect(getTikTokStatements(h.client, { ...call, from: to, to: from })).rejects.toThrow(/before/);
    await expect(getTikTokStatementTransactions(h.client, "bad id", call)).rejects.toThrow(/statement id/);
    expect(h.calls).toHaveLength(0);
  });
});
