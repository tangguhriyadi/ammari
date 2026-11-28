import { describe, expect, test } from "vitest";
import { createTikTokClient, type FetchLike } from "../src/client";
import { TIKTOK_CANCELLATION_ALLOWLIST, TIKTOK_RETURN_ALLOWLIST, projectTikTokAfterSale, searchTikTokAfterSales } from "../src/returns";
import { Secret } from "../src/secret";
import { seeded } from "./random";

// docs/plans/tiktok-shop-integration.md T6: Search Returns and Search Cancellations (read only, Q15),
// their allowlists (no buyer field survives, §6), and the projection that versions each request by
// its `update_time`. An in-memory fake answers every request.

const START = Date.UTC(2026, 10, 28, 3, 0, 0);
const BUYER = { name: "Siti Buyer", phone: "+6281234567890", email: "siti@example.test", reasonText: "barangnya kebesaran, mohon maaf" };

function rawReturn(overrides: Record<string, unknown> = {}) {
  return {
    return_id: "4035000000000000001",
    order_id: "576653688135258178",
    return_type: "REFUND",
    return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
    role: "BUYER",
    create_time: 1764300000,
    update_time: 1764300100,
    return_reason: "ecom_order_delivered_refund_reason_not_as_described",
    return_reason_text: BUYER.reasonText,
    buyer_contact: { name: BUYER.name, phone: BUYER.phone },
    buyer_email: BUYER.email,
    seller_next_action_response: [{ action: "SELLER_RESPOND_REFUND", deadline: 1764472900, note: BUYER.name }],
    refund_amount: { currency: "IDR", refund_total: "249000", refund_subtotal: "249000", refund_shipping_fee: "0", buyer_phone: BUYER.phone },
    return_line_items: [{ return_line_item_id: "r-li-1", order_line_item_id: "li-1", sku_id: "1729000000000000001", seller_sku: "POKA-FZ-SAGE-M", product_name: "Gamis Poka", refund_amount: { currency: "IDR", refund_total: "249000" }, product_image: { url: "https://x" } }],
    future_field: { contact: BUYER.phone },
    ...overrides,
  };
}

function rawCancellation(overrides: Record<string, unknown> = {}) {
  return {
    cancel_id: "4036000000000000001",
    order_id: "576653688135258178",
    cancel_type: "BUYER_CANCEL",
    cancel_status: "CANCELLATION_REQUEST_PENDING",
    role: "BUYER",
    create_time: 1764300000,
    update_time: 1764300050,
    cancel_reason: "buyer_changed_mind",
    cancel_reason_text: BUYER.reasonText,
    buyer_email: BUYER.email,
    refund_amount: { currency: "IDR", refund_total: "249000" },
    cancel_line_items: [{ cancel_line_item_id: "c-li-1", order_line_item_id: "li-1", sku_id: "1729000000000000001" }],
    ...overrides,
  };
}

describe("projectTikTokAfterSale", () => {
  test("a return keeps ids, statuses, times, deadlines, amounts and line ids; no buyer field or free text survives", () => {
    const result = projectTikTokAfterSale("return", rawReturn());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = JSON.stringify(result.record.payload);
    for (const value of [...Object.values(BUYER), "buyer_contact", "buyer_email", "return_reason_text", "future_field", "product_image", "note"]) expect(json).not.toContain(value);
    expect(result.record).toMatchObject({ kind: "return", requestId: "4035000000000000001", tiktokOrderId: "576653688135258178", status: "RETURN_OR_REFUND_REQUEST_PENDING", requestType: "REFUND" });
    expect(result.record.updateTime.getTime()).toBe(1764300100 * 1000);
    expect(result.record.createTime?.getTime()).toBe(1764300000 * 1000);
    expect(result.record.payload).toMatchObject({
      refund_amount: { currency: "IDR", refund_total: "249000", refund_subtotal: "249000" },
      seller_next_action_response: [{ action: "SELLER_RESPOND_REFUND", deadline: 1764472900 }],
      return_line_items: [{ order_line_item_id: "li-1", sku_id: "1729000000000000001" }],
    });
    expect(result.record.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a cancellation keeps its own field names and drops the reason text", () => {
    const result = projectTikTokAfterSale("cancellation", rawCancellation());
    if (!result.ok) throw new Error("projection failed");
    expect(result.record).toMatchObject({ kind: "cancellation", requestId: "4036000000000000001", status: "CANCELLATION_REQUEST_PENDING", requestType: "BUYER_CANCEL" });
    expect(JSON.stringify(result.record.payload)).not.toContain(BUYER.reasonText);
    expect(JSON.stringify(result.record.payload)).not.toContain(BUYER.email);
    expect(result.record.payload.cancel_line_items).toEqual([{ cancel_line_item_id: "c-li-1", order_line_item_id: "li-1", sku_id: "1729000000000000001" }]);
  });

  test("the same content hashes the same whatever the key order", () => {
    const a = projectTikTokAfterSale("return", rawReturn());
    const b = projectTikTokAfterSale("return", Object.fromEntries(Object.entries(rawReturn()).reverse()));
    if (!a.ok || !b.ok) throw new Error("projection failed");
    expect(a.record.contentSha256).toBe(b.record.contentSha256);
  });

  test("no id, no order id, no status or no update_time cannot be versioned", () => {
    expect(projectTikTokAfterSale("return", rawReturn({ return_id: undefined }))).toEqual({ ok: false, reason: "invalid_record", requestId: null });
    expect(projectTikTokAfterSale("return", rawReturn({ order_id: "" }))).toMatchObject({ ok: false, requestId: "4035000000000000001" });
    expect(projectTikTokAfterSale("return", rawReturn({ return_status: "lower case" }))).toMatchObject({ ok: false });
    expect(projectTikTokAfterSale("return", rawReturn({ update_time: "1764300100" }))).toMatchObject({ ok: false });
    expect(projectTikTokAfterSale("cancellation", rawCancellation({ cancel_id: 12 }))).toMatchObject({ ok: false });
    expect(projectTikTokAfterSale("return", "nope")).toMatchObject({ ok: false });
  });

  test("an absent type stays null (never guessed)", () => {
    const result = projectTikTokAfterSale("return", rawReturn({ return_type: undefined }));
    if (!result.ok) throw new Error("projection failed");
    expect(result.record.requestType).toBeNull();
  });

  test("the allowlists name no buyer field", () => {
    const keys = JSON.stringify([TIKTOK_RETURN_ALLOWLIST, TIKTOK_CANCELLATION_ALLOWLIST]);
    for (const key of ["buyer", "recipient", "address", "phone", "email", "user_id", "reason_text", "note"]) expect(keys).not.toContain(key);
  });
});

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
    random: seeded(5),
  });
  return { client, calls };
}

const ok = (data: unknown) => ({ body: { code: 0, message: "Success", request_id: "req", data } });
const call = { accessToken: new Secret("ROW_dummy_token"), shopCipher: "ROW_cipher", deadline: START + 150_000 };

describe("searchTikTokAfterSales", () => {
  test("returns by update_time window: POST, both bounds, ascending, page_token percent-encoded; records projected", async () => {
    const token = "r+/t==";
    const h = harness([ok({ return_orders: [rawReturn(), { return_id: "bad" }], next_page_token: token })]);
    const ge = new Date(START - 3_600_000);
    const lt = new Date(START - 120_000);
    const page = await searchTikTokAfterSales(h.client, "return", { updateTimeGe: ge, updateTimeLt: lt, pageToken: "p+/1=", ...call });
    expect(page.records.map((record) => record.requestId)).toEqual(["4035000000000000001"]);
    expect(page.invalid).toBe(1);
    expect(page.nextPageToken).toBe(token);
    const [request] = h.calls;
    expect(request!.url.pathname).toBe("/return_refund/202309/returns/search");
    expect(request!.init.method).toBe("POST");
    expect(JSON.parse(String(request!.init.body))).toEqual({ update_time_ge: Math.floor(ge.getTime() / 1000), update_time_lt: Math.floor(lt.getTime() / 1000) });
    expect(request!.url.searchParams.get("sort_field")).toBe("update_time");
    expect(request!.url.searchParams.get("sort_order")).toBe("ASC");
    expect(request!.url.searchParams.get("page_token")).toBe("p+/1=");
    expect(request!.url.search).toContain("page_token=p%2B%2F1%3D");
    expect(JSON.stringify(page.records)).not.toContain(BUYER.phone);
  });

  test("cancellations by order ids (a topic 11 trigger), the last page has no token", async () => {
    const h = harness([ok({ cancellations: [rawCancellation()], next_page_token: "" })]);
    const page = await searchTikTokAfterSales(h.client, "cancellation", { orderIds: ["576653688135258178"], ...call });
    expect(page.records).toHaveLength(1);
    expect(page.nextPageToken).toBeNull();
    const [request] = h.calls;
    expect(request!.url.pathname).toBe("/return_refund/202309/cancellations/search");
    expect(JSON.parse(String(request!.init.body))).toEqual({ order_ids: ["576653688135258178"] });
  });

  test("a list under another name than assumed is refused, never read as no requests", async () => {
    const h = harness([ok({ returns: [rawReturn()], next_page_token: "" }), ok({ next_page_token: "" })]);
    await expect(searchTikTokAfterSales(h.client, "return", { orderIds: ["576653688135258178"], ...call })).rejects.toMatchObject({ kind: "invalid_response" });
    // No list and nothing that looks like one: an empty page.
    expect((await searchTikTokAfterSales(h.client, "return", { orderIds: ["576653688135258178"], ...call })).records).toEqual([]);
  });

  test("a window must be forward and order ids must be usable", async () => {
    const h = harness([]);
    await expect(searchTikTokAfterSales(h.client, "return", { updateTimeGe: new Date(START), updateTimeLt: new Date(START), ...call })).rejects.toThrow();
    await expect(searchTikTokAfterSales(h.client, "return", { orderIds: [], ...call })).rejects.toThrow();
    await expect(searchTikTokAfterSales(h.client, "return", { orderIds: ["a,b"], ...call })).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
});
