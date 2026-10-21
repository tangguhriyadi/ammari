import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb } from "@ammari/db/test-utils";
import { claimRateLimits, shippingAreas } from "@ammari/db/schema";
import { FAKE_SHIPPING_AREAS } from "@ammari/commerce/shipping";

// docs/plans/cart-checkout.md §4.5.1, session 8: the area search route against the real
// `ammari_test` database (committed writes, cleaned up below) with the fake provider, so nothing
// reaches Biteship. Next's headers() is replaced by a fixed client IP.

let clientIp: string | null = "203.0.113.80";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(clientIp ? { "cf-connecting-ip": clientIp } : {}),
}));
vi.mock("@/lib/db", async () => ({ defaultDb: (await import("@ammari/db/test-utils")).testDb }));

const { GET } = await import("./route");
const { clearAreaSearchCache } = await import("@/lib/shipping/area-search-cache");
const { AREA_SEARCH_LIMIT } = await import("@/lib/shipping/messages");

const ENV_KEYS = ["STOREFRONT_CART_ENABLED", "SHIPPING_RATE_PROVIDER", "E2E_TEST_LOGIN", "BITESHIP_API_KEY"] as const;
const usedIps = new Set<string>();

function search(q: string | null, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  const url = new URL("http://localhost:3000/api/shipping/areas");
  if (q !== null) url.searchParams.set("q", q);
  return GET(new Request(url, { headers }));
}

describe("GET /api/shipping/areas", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    process.env.STOREFRONT_CART_ENABLED = "true";
    process.env.SHIPPING_RATE_PROVIDER = "fake";
    process.env.E2E_TEST_LOGIN = "true";
    clientIp = `203.0.113.${80 + usedIps.size}`;
    usedIps.add(clientIp);
    clearAreaSearchCache();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await testDb.delete(shippingAreas).where(inArray(shippingAreas.providerAreaId, FAKE_SHIPPING_AREAS.map((area) => area.providerAreaId)));
    if (usedIps.size > 0) {
      await testDb
        .delete(claimRateLimits)
        .where(and(eq(claimRateLimits.action, "area_search"), inArray(claimRateLimits.ip, [...usedIps])));
    }
  });

  test("flag off: 404 without touching anything", async () => {
    process.env.STOREFRONT_CART_ENABLED = "false";
    const response = await search("kecamatan e2e");
    expect(response.status).toBe(404);
    const rows = await testDb.select().from(claimRateLimits).where(eq(claimRateLimits.ip, clientIp!));
    expect(rows).toHaveLength(0);
  });

  test("returns our own area ids and labels, never the provider id, and stores the areas", async () => {
    const response = await search("  kecamatan   e2e murah ");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as { areas: Array<{ id: string; label: string; hasPostalCode: boolean }> };
    expect(body.areas).toEqual([{ id: expect.any(String), label: "Kecamatan E2E Murah, Kota E2E, Provinsi E2E 40111", hasPostalCode: true }]);
    expect(JSON.stringify(body)).not.toContain("E2EMURAH40111");

    const [row] = await testDb.select().from(shippingAreas).where(eq(shippingAreas.id, body.areas[0]!.id));
    expect(row!.providerAreaId).toBe("E2EMURAH40111");
  });

  test("a repeated query (any case or spacing) is answered from memory without the provider", async () => {
    const first = (await (await search("Kecamatan E2E Murah")).json()) as { areas: Array<{ id: string }> };
    // Remove the stored row: a provider call would upsert it again under a new id, a cache hit
    // answers with the remembered one and writes nothing.
    await testDb.delete(shippingAreas).where(eq(shippingAreas.id, first.areas[0]!.id));
    const again = (await (await search("  kecamatan   e2e murah ")).json()) as { areas: Array<{ id: string }> };
    expect(again).toEqual(first);
    const rows = await testDb.select().from(shippingAreas).where(eq(shippingAreas.providerAreaId, "E2EMURAH40111"));
    expect(rows).toHaveLength(0);
  });

  test("an area without a kode pos says so", async () => {
    const body = (await (await search("tanpa kode pos")).json()) as { areas: Array<{ hasPostalCode: boolean }> };
    expect(body.areas).toEqual([expect.objectContaining({ hasPostalCode: false })]);
  });

  test("no match: an empty list", async () => {
    const response = await search("tidak ada di mana pun");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ areas: [] });
  });

  test.each([
    [null, "Ketik minimal 3 huruf."],
    ["ab", "Ketik minimal 3 huruf."],
    // Zero-width characters are dropped and control characters become spaces before the length check.
    ["  a​b\u0000  ", "Ketik minimal 3 huruf."],
    ["a".repeat(61), "Pencarian terlalu panjang."],
  ])("query %j: 400 %s", async (q, message) => {
    const response = await search(q);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
  });

  test("cross-site requests are refused before any write; same-origin and typed URLs pass", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const response = await search("kecamatan e2e", { "sec-fetch-site": site });
      expect(response.status).toBe(403);
    }
    const rows = await testDb.select().from(claimRateLimits).where(eq(claimRateLimits.ip, clientIp!));
    expect(rows).toHaveLength(0);
    expect((await search("kecamatan e2e", { "sec-fetch-site": "none" })).status).toBe(200);
    expect((await search("kecamatan e2e", {})).status).toBe(200);
  });

  test(`refuses above ${AREA_SEARCH_LIMIT} searches per IP in 10 minutes`, async () => {
    await testDb.insert(claimRateLimits).values(Array.from({ length: AREA_SEARCH_LIMIT }, () => ({ ip: clientIp!, action: "area_search" })));
    const response = await search("kecamatan e2e");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("600");
    expect(await response.json()).toEqual({ error: "Terlalu banyak pencarian. Coba lagi sebentar lagi." });
  });

  test("a provider outage is a 503 with the Indonesian message, logged by reason only", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await search("pencarian gagal");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Pencarian alamat belum bisa dipakai. Coba lagi sebentar lagi." });
    expect(consoleError).toHaveBeenCalledWith(
      "[shipping] area search failed: unavailable",
      expect.objectContaining({ reason: "unavailable", message: "fake area search outage" }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("pencarian gagal");
  });

  test("no configured provider fails closed with 503", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.SHIPPING_RATE_PROVIDER;
    delete process.env.BITESHIP_API_KEY;
    const response = await search("kecamatan e2e");
    expect(response.status).toBe(503);
    expect(consoleError).toHaveBeenCalledWith("[shipping] rate provider not configured", {
      problems: expect.arrayContaining(["BITESHIP_API_KEY is not set"]),
    });
  });

  test("the fake provider is refused outside an e2e run", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.E2E_TEST_LOGIN;
    expect((await search("kecamatan e2e")).status).toBe(503);
    expect(consoleError).toHaveBeenCalled();
  });

  test("an unexpected failure is a logged 500 with the generic message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    clientIp = null;
    const nodeEnv = process.env.NODE_ENV;
    vi.stubEnv("NODE_ENV", "production");
    try {
      const response = await search("kecamatan e2e");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Terjadi kesalahan. Coba lagi." });
      expect(consoleError).toHaveBeenCalledWith("[cart] missing or invalid CF-Connecting-IP header; refusing area search");
    } finally {
      vi.unstubAllEnvs();
      expect(process.env.NODE_ENV).toBe(nodeEnv);
    }
  });
});
