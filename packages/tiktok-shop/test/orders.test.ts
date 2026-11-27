import { describe, expect, test } from "vitest";
import { TikTokApiError, createTikTokClient, type FetchLike } from "../src/client";
import { TIKTOK_ORDER_ALLOWLIST, canonicalJson, getTikTokOrderDetails, projectTikTokOrder, searchTikTokOrders } from "../src/orders";
import { applyAllowlist } from "../src/allowlist";
import { Secret } from "../src/secret";
import { seeded } from "./random";

// docs/plans/tiktok-shop-integration.md T4: the order allowlist (buyer PII never survives, buyer
// message only in its own field), Search Orders (both bounds, ascending by update_time, page_token
// percent-encoded), Get Order Detail (≤ 50 ids), and the client's 429/503 rules on these calls. An
// in-memory fake answers every request.

const START = Date.UTC(2026, 10, 27, 3, 0, 0);
const BUYER = {
  name: "Siti Buyer",
  phone: "+6281234567890",
  email: "siti@example.test",
  address: "Jl. Rahasia No. 7, Bandung",
};

/** A raw order full of buyer fields, nested and new. */
function rawOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "576653688135258178",
    status: "AWAITING_SHIPMENT",
    create_time: 1764200000,
    paid_time: 1764200100,
    update_time: 1764200200,
    rts_sla_time: 1764400000,
    is_on_hold_order: false,
    buyer_message: "  Tolong dibungkus rapi ya  ",
    buyer_email: BUYER.email,
    user_id: "7000123",
    seller_note: `catatan untuk ${BUYER.name}`,
    recipient_address: { name: BUYER.name, phone_number: BUYER.phone, full_address: BUYER.address, district_info: [{ address_name: "Bandung" }] },
    payment: { currency: "IDR", sub_total: "259000", total_amount: "249000", seller_discount: "10000", buyer_phone: BUYER.phone },
    line_items: [
      {
        id: "li-1",
        sku_id: "1729000000000000001",
        product_id: "1729000000000000000",
        seller_sku: "POKA-FZ-SAGE-M",
        product_name: "Gamis Poka",
        sku_name: "Sage, M",
        original_price: "259000",
        sale_price: "249000",
        seller_discount: "10000",
        platform_discount: "0",
        buyer_nickname: BUYER.name,
        gift_note: { to: BUYER.name },
      },
      "not-an-object",
    ],
    packages: [{ id: "pkg-1", recipient: BUYER.name }],
    future_field_with_buyer: { contact: BUYER.phone },
    ...overrides,
  };
}

describe("projectTikTokOrder / TIKTOK_ORDER_ALLOWLIST", () => {
  test("no buyer field survives anywhere in the payload, and the buyer message is only in its own field", () => {
    const result = projectTikTokOrder(rawOrder());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.order.payload);
    for (const value of [...Object.values(BUYER), "7000123", "Tolong dibungkus", "buyer_message", "recipient_address", "buyer_email", "user_id", "seller_note", "future_field_with_buyer", "buyer_nickname", "gift_note", "buyer_phone"]) {
      expect(json).not.toContain(value);
    }
    expect(result.order.buyerMessage).toBe("Tolong dibungkus rapi ya");
    expect(result.order.payload).toMatchObject({
      id: "576653688135258178",
      status: "AWAITING_SHIPMENT",
      payment: { currency: "IDR", sub_total: "259000", total_amount: "249000", seller_discount: "10000" },
      line_items: [{ sku_id: "1729000000000000001", seller_sku: "POKA-FZ-SAGE-M", original_price: "259000" }],
      packages: [{ id: "pkg-1" }],
    });
    expect((result.order.payload.line_items as unknown[]).length).toBe(1);
    expect(result.order.updateTime.toISOString()).toBe(new Date(1764200200 * 1000).toISOString());
    expect(result.order.paidTime?.getTime()).toBe(1764200100 * 1000);
    expect(result.order.isOnHoldOrder).toBe(false);
  });

  test("every allowlisted key is a scalar or a nested spec: an object smuggled under a scalar key is dropped", () => {
    const projected = applyAllowlist({ id: { name: BUYER.name }, status: [BUYER.phone], payment: "x", line_items: [{ seller_sku: { phone: BUYER.phone } }] }, TIKTOK_ORDER_ALLOWLIST);
    expect(JSON.stringify(projected)).not.toContain(BUYER.name);
    expect(projected).toEqual({ status: [BUYER.phone], line_items: [{}] });
  });

  test("the content hash ignores key order and changes with content", () => {
    const a = projectTikTokOrder(rawOrder());
    const reordered = Object.fromEntries(Object.entries(rawOrder()).reverse());
    const b = projectTikTokOrder(reordered);
    const c = projectTikTokOrder(rawOrder({ status: "IN_TRANSIT" }));
    if (!a.ok || !b.ok || !c.ok) throw new Error("projection failed");
    expect(a.order.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.order.contentSha256).toBe(a.order.contentSha256);
    expect(c.order.contentSha256).not.toBe(a.order.contentSha256);
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    // The buyer message is not part of the version: changing only it gives the same hash.
    const d = projectTikTokOrder(rawOrder({ buyer_message: "lain" }));
    if (!d.ok) throw new Error("projection failed");
    expect(d.order.contentSha256).toBe(a.order.contentSha256);
  });

  test("an order without a usable id, status or update_time cannot be versioned", () => {
    expect(projectTikTokOrder(rawOrder({ update_time: "1764200200" }))).toEqual({ ok: false, reason: "invalid_order", tiktokOrderId: "576653688135258178" });
    expect(projectTikTokOrder(rawOrder({ status: "" }))).toMatchObject({ ok: false });
    expect(projectTikTokOrder(rawOrder({ id: 12 }))).toEqual({ ok: false, reason: "invalid_order", tiktokOrderId: null });
    expect(projectTikTokOrder(null)).toMatchObject({ ok: false });
  });

  test("strings Postgres jsonb refuses are cleaned (NUL dropped, lone surrogate replaced), so the order stays storable", () => {
    const result = projectTikTokOrder(rawOrder({ cancel_reason: "a\u0000b\uD800c", line_items: [{ sku_id: "s", product_name: "Gamis\u0000" }] }));
    if (!result.ok) throw new Error("projection failed");
    expect(result.order.payload.cancel_reason).toBe("ab\uFFFDc");
    expect(result.order.payload.line_items).toEqual([{ sku_id: "s", product_name: "Gamis" }]);
    expect(projectTikTokOrder(rawOrder({ id: "1,2" }))).toMatchObject({ ok: false });
  });

  test("the buyer message is capped at 1000 characters without splitting a character", () => {
    const long = "😀".repeat(1_200);
    const result = projectTikTokOrder(rawOrder({ buyer_message: long }));
    if (!result.ok) throw new Error("projection failed");
    expect(Array.from(result.order.buyerMessage!)).toHaveLength(1_000);
    expect(projectTikTokOrder(rawOrder({ buyer_message: "   " }))).toMatchObject({ ok: true, order: { buyerMessage: null } });
  });
});

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

function harness(replies: Reply[]) {
  let clock = START;
  const calls: { url: URL; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: new URL(input), init });
    const reply = replies.shift();
    if (!reply) throw new Error("test: no more replies");
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
  };
  const client = createTikTokClient({
    appKey: new Secret("dummyappkey"),
    appSecret: new Secret("dummyappsecret0123456789"),
    baseUrl: "https://tiktok.test",
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: seeded(3),
  });
  return { client, calls, sleeps };
}

const ok = (data: unknown) => ({ body: { code: 0, message: "Success", request_id: "req", data } });
const call = { accessToken: new Secret("ROW_dummy_token"), shopCipher: "ROW_cipher", deadline: START + 150_000 };

describe("searchTikTokOrders", () => {
  test("both update_time bounds in the body, ascending by update_time, page_token percent-encoded and signed raw", async () => {
    const token = "abc+/def==";
    const h = harness([ok({ orders: [{ id: "1", buyer_email: BUYER.email }], next_page_token: token }), ok({ orders: [{ id: "2" }] })]);
    const ge = new Date(START - 6 * 3_600_000);
    const lt = new Date(START - 120_000);
    const first = await searchTikTokOrders(h.client, { updateTimeGe: ge, updateTimeLt: lt, ...call });
    expect(first).toEqual({ orderIds: ["1"], invalidIds: 0, nextPageToken: token });
    const second = await searchTikTokOrders(h.client, { updateTimeGe: ge, updateTimeLt: lt, pageToken: first.nextPageToken, ...call });
    expect(second).toEqual({ orderIds: ["2"], invalidIds: 0, nextPageToken: null });

    const [a, b] = h.calls;
    expect(a!.url.pathname).toBe("/order/202309/orders/search");
    expect(a!.init.method).toBe("POST");
    expect(JSON.parse(String(a!.init.body))).toEqual({ update_time_ge: Math.floor(ge.getTime() / 1000), update_time_lt: Math.floor(lt.getTime() / 1000) });
    expect(a!.url.searchParams.get("sort_field")).toBe("update_time");
    expect(a!.url.searchParams.get("sort_order")).toBe("ASC");
    expect(a!.url.searchParams.get("page_size")).toBe("100");
    expect(a!.url.searchParams.has("page_token")).toBe(false);
    // The raw query string carries the token percent-encoded: `+` would otherwise read as a space.
    expect(b!.url.search).toContain("page_token=abc%2B%2Fdef%3D%3D");
    expect(b!.url.searchParams.get("page_token")).toBe(token);
  });

  test("an entry without a usable id is counted, never fails the page", async () => {
    const h = harness([ok({ orders: [{ id: "1" }, { id: "a,b" }, { nope: true }, "x", { id: "2" }] })]);
    await expect(searchTikTokOrders(h.client, { updateTimeGe: new Date(START - 60_000), updateTimeLt: new Date(START), ...call })).resolves.toEqual({ orderIds: ["1", "2"], invalidIds: 3, nextPageToken: null });
  });

  test("refuses an empty or reversed window before calling TikTok", async () => {
    const h = harness([]);
    await expect(searchTikTokOrders(h.client, { updateTimeGe: new Date(START), updateTimeLt: new Date(START + 500), ...call })).rejects.toThrow(/before/);
    expect(h.calls).toHaveLength(0);
  });

  test("429 is retried with backoff and then answered; a persistent 503 gives up as unavailable after 2 short retries", async () => {
    const h = harness([{ status: 429, body: { code: 36009002, message: "rate", request_id: "rl" }, headers: { "retry-after": "2" } }, ok({ orders: [] })]);
    await expect(searchTikTokOrders(h.client, { updateTimeGe: new Date(START - 60_000), updateTimeLt: new Date(START), ...call })).resolves.toEqual({ orderIds: [], invalidIds: 0, nextPageToken: null });
    expect(h.sleeps).toEqual([2_000]);

    const unavailable = harness([{ status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }]);
    const error = await searchTikTokOrders(unavailable.client, { updateTimeGe: new Date(START - 60_000), updateTimeLt: new Date(START), ...call }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TikTokApiError);
    expect((error as TikTokApiError).kind).toBe("unavailable");
    expect(unavailable.sleeps).toEqual([1_000, 3_000]);
  });
});

describe("getTikTokOrderDetails", () => {
  test("at most 50 ids per call, comma-joined; returns projections only", async () => {
    const h = harness([ok({ orders: [rawOrder(), { id: "bad" }] })]);
    const result = await getTikTokOrderDetails(h.client, ["576653688135258178", "bad"], call);
    expect(h.calls[0]!.url.pathname).toBe("/order/202507/orders");
    expect(h.calls[0]!.url.searchParams.get("ids")).toBe("576653688135258178,bad");
    expect(result.orders.map((order) => order.tiktokOrderId)).toEqual(["576653688135258178"]);
    expect(result.invalid).toEqual(["bad"]);
    expect(JSON.stringify(result.orders)).not.toContain(BUYER.phone);

    await expect(getTikTokOrderDetails(h.client, Array.from({ length: 51 }, (_, index) => String(index)), call)).rejects.toThrow(/at most 50/);
    await expect(getTikTokOrderDetails(h.client, ["a,b"], call)).rejects.toThrow(/invalid order id/);
    expect(h.calls).toHaveLength(1);
  });
});
