import { describe, expect, test } from "vitest";
import { TikTokApiError, createTikTokClient, type FetchLike } from "../src/client";
import { getTikTokWarehouses, ownTikTokWarehouseIds, searchTikTokProducts } from "../src/products";
import { Secret } from "../src/secret";
import { seeded } from "./random";

// docs/plans/tiktok-stock-sync.md S1: the read-only listing calls (Search Products, Get Warehouse
// List). An in-memory fake answers; nothing reaches TikTok. Only ids, statuses, titles, SKU labels and
// per-warehouse quantities leave this module (a warehouse's address never does).

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
    random: seeded(5),
  });
  return { client, calls };
}

const ok = (data: unknown) => ({ body: { code: 0, message: "Success", request_id: "req", data } });
const call = { accessToken: new Secret("ROW_dummy_token"), shopCipher: "ROW_cipher", deadline: START + 150_000 };

describe("searchTikTokProducts", () => {
  test("POST the 202309 search, page_size 100, page_token percent-encoded; ids, status, title, SKUs and inventory kept", async () => {
    const h = harness([
      ok({
        products: [
          {
            id: "1729000000000000000",
            status: "ACTIVATE",
            title: "Gamis Poka\u0000 Sage",
            description: "<p>long html</p>",
            skus: [
              {
                id: "1729000000000000001",
                seller_sku: "POKA-FZ-SAGE-M",
                price: { amount: "259000", currency: "IDR" },
                sales_attributes: [
                  { name: "Warna", value_name: "Sage" },
                  { name: "Ukuran", value_name: "M" },
                ],
                inventory: [
                  { warehouse_id: "wh-own", quantity: 4 },
                  { warehouse_id: "wh-fbt", quantity: 9 },
                ],
              },
            ],
          },
        ],
        next_page_token: "p+/1==",
        total_count: 2,
      }),
      ok({ products: [{ id: "1729000000000000100", status: "DRAFT", skus: [] }], total_count: 2 }),
    ]);
    const first = await searchTikTokProducts(h.client, { ...call });
    expect(first.nextPageToken).toBe("p+/1==");
    expect(first.invalid).toBe(0);
    expect(first.products).toEqual([
      {
        productId: "1729000000000000000",
        status: "ACTIVATE",
        title: "Gamis Poka Sage",
        skuCount: 1,
        skus: [
          {
            skuId: "1729000000000000001",
            sellerSku: "POKA-FZ-SAGE-M",
            label: "Sage · M",
            inventory: [
              { warehouse_id: "wh-own", quantity: 4 },
              { warehouse_id: "wh-fbt", quantity: 9 },
            ],
          },
        ],
        invalidSkus: 0,
      },
    ]);
    const second = await searchTikTokProducts(h.client, { pageToken: first.nextPageToken, ...call });
    expect(second.nextPageToken).toBeNull();
    expect(second.products[0]).toMatchObject({ productId: "1729000000000000100", status: "DRAFT", title: null, skus: [] });

    const [a, b] = h.calls;
    expect(a!.url.pathname).toBe("/product/202309/products/search");
    expect(a!.init.method).toBe("POST");
    expect(a!.url.searchParams.get("page_size")).toBe("100");
    expect(a!.url.searchParams.has("page_token")).toBe(false);
    expect(JSON.parse(String(a!.init.body))).toEqual({});
    expect(b!.url.search).toContain("page_token=p%2B%2F1%3D%3D");
  });

  test("a product without a usable id or status is counted invalid; a SKU without an id is counted on its product", async () => {
    const h = harness([
      ok({
        products: [{ status: "ACTIVATE", skus: [] }, { id: "../x", status: "ACTIVATE" }, { id: "1", status: 5 }, "junk", { id: "2", status: "ACTIVATE", skus: [{ seller_sku: "X" }, { id: "s,1" }, { id: "21", inventory: "nope" }] }],
        total_count: 5,
      }),
    ]);
    const page = await searchTikTokProducts(h.client, { ...call });
    expect(page.invalid).toBe(4);
    expect(page.products).toHaveLength(1);
    expect(page.products[0]).toMatchObject({ productId: "2", invalidSkus: 2, skuCount: 3, skus: [{ skuId: "21", sellerSku: null, label: null, inventory: [] }] });
    expect(page).toMatchObject({ entries: 5, totalCount: 5 });
  });

  test("a product whose skus key is missing or not a list is invalid (never read as a product with no SKUs); an empty list is fine", async () => {
    const h = harness([ok({ products: [{ id: "1", status: "ACTIVATE" }, { id: "2", status: "ACTIVATE", skus: "x" }, { id: "3", status: "DRAFT", skus: [] }], total_count: 3 })]);
    const page = await searchTikTokProducts(h.client, { ...call });
    expect(page.invalid).toBe(2);
    expect(page.products.map((p) => p.productId)).toEqual(["3"]);
  });

  test("an inventory entry in an unexpected shape is kept as a warehouse-less entry (the rules then hold the SKU)", async () => {
    const h = harness([ok({ products: [{ id: "1", status: "ACTIVATE", skus: [{ id: "11", inventory: [{ warehouse_id: "wh-own", quantity: 1 }, "odd", { warehouse_id: "a/b", quantity: 2 }] }] }], total_count: 1 })]);
    const page = await searchTikTokProducts(h.client, { ...call });
    expect(page.products[0]!.skus[0]!.inventory).toEqual([
      { warehouse_id: "wh-own", quantity: 1 },
      { warehouse_id: null, quantity: null },
      { warehouse_id: null, quantity: 2 },
    ]);
  });

  test("an answer without the products list is refused (a renamed key is never read as an empty shop)", async () => {
    const h = harness([ok({ items: [], total_count: 3 })]);
    await expect(searchTikTokProducts(h.client, { ...call })).rejects.toMatchObject({ kind: "invalid_response" });
    const empty = harness([ok({ total_count: 0 })]);
    await expect(searchTikTokProducts(empty.client, { ...call })).resolves.toEqual({ products: [], entries: 0, totalCount: 0, invalid: 0, nextPageToken: null });
  });

  test("a TikTok error stays a typed error with codes only", async () => {
    const h = harness([{ body: { code: 12019999, message: "secret details", request_id: "rq" } }]);
    const error = await searchTikTokProducts(h.client, { ...call }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TikTokApiError);
    expect(JSON.stringify(error)).not.toContain("secret details");
  });
});

describe("getTikTokWarehouses / ownTikTokWarehouseIds", () => {
  test("GET the 202309 warehouse list; only a domestic sales warehouse is Ammari's own; no address is returned", async () => {
    const h = harness([
      ok({
        warehouses: [
          { id: "wh-own", name: "Gudang Bandung", type: "SALES_WAREHOUSE", sub_type: "DOMESTIC_WAREHOUSE", effect_status: "ENABLED", address: { full_address: "Jl. Rahasia 7" } },
          { id: "wh-return", type: "RETURN_WAREHOUSE", sub_type: "DOMESTIC_WAREHOUSE" },
          { id: "wh-cb", type: "SALES_WAREHOUSE", sub_type: "CB_OVERSEA_WAREHOUSE" },
          { id: "wh-odd", type: "SALES_WAREHOUSE" },
          { type: "SALES_WAREHOUSE", sub_type: "DOMESTIC_WAREHOUSE" },
        ],
      }),
    ]);
    const { warehouses, invalid } = await getTikTokWarehouses(h.client, call);
    expect(h.calls[0]!.url.pathname).toBe("/logistics/202309/warehouses");
    expect(h.calls[0]!.init.method).toBe("GET");
    expect(invalid).toBe(1);
    expect(JSON.stringify(warehouses)).not.toContain("Rahasia");
    expect(warehouses).toEqual([
      { id: "wh-own", type: "SALES_WAREHOUSE", subType: "DOMESTIC_WAREHOUSE" },
      { id: "wh-return", type: "RETURN_WAREHOUSE", subType: "DOMESTIC_WAREHOUSE" },
      { id: "wh-cb", type: "SALES_WAREHOUSE", subType: "CB_OVERSEA_WAREHOUSE" },
      { id: "wh-odd", type: "SALES_WAREHOUSE", subType: null },
    ]);
    expect([...ownTikTokWarehouseIds(warehouses)]).toEqual(["wh-own"]);
  });

  test("an answer without the warehouses list is refused", async () => {
    const h = harness([ok({ list: [] })]);
    await expect(getTikTokWarehouses(h.client, call)).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
