import { describe, expect, test } from "vitest";
import { TikTokApiError, createTikTokClient, type FetchLike } from "../src/client";
import { updateTikTokInventory } from "../src/inventory";
import { Secret } from "../src/secret";
import { seeded } from "./random";

// docs/plans/tiktok-stock-sync.md S2: Update Inventory, the integration's only write call. An in-memory
// fake answers; nothing reaches TikTok. The body names only Ammari's own warehouse per SKU, always in
// INCREMENTAL mode; per-SKU errors under a top-level code 0 are failures, never a success (§0, A4).

const START = Date.UTC(2026, 11, 2, 3, 0, 0);

type Reply = { status?: number; body?: unknown };

function harness(replies: Reply[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  let clock = START;
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: new URL(input), init });
    const reply = replies.shift();
    if (!reply) throw new Error("test: no more replies");
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  const client = createTikTokClient({
    appKey: new Secret("dummyappkey"),
    appSecret: new Secret("dummyappsecret0123456789"),
    baseUrl: "https://tiktok.test",
    fetch,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random: seeded(9),
  });
  return { client, calls };
}

const ok = (data?: unknown) => ({ body: { code: 0, message: "Success", request_id: "req", ...(data === undefined ? {} : { data }) } });
const call = { accessToken: new Secret("ROW_dummy_token"), shopCipher: "ROW_cipher", deadline: START + 150_000 };
const skus = [
  { skuId: "1729000000000000001", warehouseId: "7300000000000000001", quantity: 6 },
  { skuId: "1729000000000000002", warehouseId: "7300000000000000001", quantity: 0 },
];

describe("updateTikTokInventory", () => {
  test("POST /product/202309/products/{id}/inventory/update, INCREMENTAL, one inventory entry per SKU", async () => {
    const h = harness([ok({})]);
    const result = await updateTikTokInventory(h.client, { productId: "1729000000000000000", skus, ...call });
    expect(h.calls).toHaveLength(1);
    const sent = h.calls[0]!;
    expect(sent.url.pathname).toBe("/product/202309/products/1729000000000000000/inventory/update");
    expect(sent.init.method).toBe("POST");
    expect(JSON.parse(String(sent.init.body))).toEqual({
      skus: [
        { id: "1729000000000000001", inventory: [{ warehouse_id: "7300000000000000001", quantity: 6 }] },
        { id: "1729000000000000002", inventory: [{ warehouse_id: "7300000000000000001", quantity: 0 }] },
      ],
      sku_warehouse_stock_update_mode: "INCREMENTAL",
    });
    expect([...result.entries()]).toEqual([
      ["1729000000000000001", { ok: true }],
      ["1729000000000000002", { ok: true }],
    ]);
  });

  test("no data at all on code 0 is a success for every SKU", async () => {
    const h = harness([ok()]);
    const result = await updateTikTokInventory(h.client, { productId: "1729000000000000000", skus, ...call });
    expect([...result.values()].every((r) => r.ok)).toBe(true);
  });

  test("per-SKU errors under code 0 are failures with their code (sku_id at the top or under detail)", async () => {
    const h = harness([
      ok({
        errors: [
          { code: 12052393, message: "locked by promotion", detail: { sku_id: "1729000000000000001" } },
          { code: 12052901, message: "status", sku_id: "1729000000000000002" },
        ],
      }),
    ]);
    const result = await updateTikTokInventory(h.client, { productId: "1729000000000000000", skus, ...call });
    expect(result.get("1729000000000000001")).toEqual({ ok: false, code: "12052393" });
    expect(result.get("1729000000000000002")).toEqual({ ok: false, code: "12052901" });
  });

  test("a generic per-SKU code with a named code in extra_errors takes the named one", async () => {
    const h = harness([ok({ errors: [{ code: 12052900, message: "partial", detail: { sku_id: "1729000000000000001", extra_errors: [{ code: 12052530, message: "wh", warehouse_id: "7300000000000000001" }] } }] })]);
    const result = await updateTikTokInventory(h.client, { productId: "1729000000000000000", skus, ...call });
    expect(result.get("1729000000000000001")).toEqual({ ok: false, code: "12052530" });
    expect(result.get("1729000000000000002")).toEqual({ ok: true });
  });

  test("an error entry naming no SKU (or one not sent) fails every SKU of the call: never read as a success", async () => {
    const h = harness([ok({ errors: [{ code: 12052097, message: "warehouse" }, { code: 1, detail: { sku_id: "999" } }] })]);
    const result = await updateTikTokInventory(h.client, { productId: "1729000000000000000", skus, ...call });
    expect(result.get("1729000000000000001")).toEqual({ ok: false, code: "12052097" });
    expect(result.get("1729000000000000002")).toEqual({ ok: false, code: "12052097" });
  });

  test("an error entry without a readable code is an invalid_response failure", async () => {
    const h = harness([ok({ errors: [{ message: "?", detail: { sku_id: "1729000000000000001" } }, "junk"] })]);
    const result = await updateTikTokInventory(h.client, { productId: "1729000000000000000", skus, ...call });
    expect(result.get("1729000000000000001")).toEqual({ ok: false, code: "invalid_response" });
    expect(result.get("1729000000000000002")).toEqual({ ok: false, code: "invalid_response" });
  });

  test("a top-level non-zero code is a TikTokApiError (api) carrying the code, nothing else", async () => {
    const h = harness([{ body: { code: 12052901, message: "status not allowed", request_id: "r1" } }]);
    const error = await updateTikTokInventory(h.client, { productId: "1729000000000000000", skus, ...call }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TikTokApiError);
    expect((error as TikTokApiError).toJSON()).toEqual({ kind: "api", path: "/product/202309/products/1729000000000000000/inventory/update", httpStatus: 200, code: 12052901, requestId: "r1" });
  });

  test.each([
    ["no SKU", []],
    ["101 SKUs", Array.from({ length: 101 }, (_, i) => ({ skuId: `17290000000000${String(i).padStart(5, "0")}`, warehouseId: "w1", quantity: 1 }))],
    ["a duplicate SKU", [skus[0]!, skus[0]!]],
    ["a fraction", [{ ...skus[0]!, quantity: 1.5 }]],
    ["a negative quantity", [{ ...skus[0]!, quantity: -1 }]],
    ["above 999,999", [{ ...skus[0]!, quantity: 1_000_000 }]],
    ["an unusable warehouse id", [{ ...skus[0]!, warehouseId: "../x" }]],
    ["an unusable SKU id", [{ ...skus[0]!, skuId: "a b" }]],
  ])("refuses to send %s (no request at all)", async (_name, input) => {
    const h = harness([]);
    await expect(updateTikTokInventory(h.client, { productId: "1729000000000000000", skus: input as never, ...call })).rejects.toThrow(/updateTikTokInventory/);
    expect(h.calls).toHaveLength(0);
  });

  test("refuses an unusable product id", async () => {
    const h = harness([]);
    await expect(updateTikTokInventory(h.client, { productId: "1/2", skus, ...call })).rejects.toThrow(/updateTikTokInventory/);
  });
});
