import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertProductVariant } from "@ammari/db/test-fixtures";
import { claimRateLimits, products, shippingAreas, shippingRateCache } from "@ammari/db/schema";
import { loadShippingArea, searchShippingAreas, SHIPPING_AREA_RESULT_LIMIT } from "./areas";
import { consumeShippingCallBudget, SHIPPING_BUDGET_ACTIONS, SHIPPING_BUDGET_IP } from "./budget";
import { allowlistServicesKey } from "./cache";
import { shippingRuntimeFromEnv } from "./config";
import { FAKE_ORIGIN_AREA_ID, createFakeShippingRateProvider } from "./fake";
import { ShippingRateError, type ShippingArea, type ShippingRateProvider } from "./provider";
import { quoteShipping, type ShippingQuoteDeps } from "./quote";
import { SHIPPING_PACKAGING_GRAMS, SHIPPING_SERVICE_ALLOWLIST, type RatedService } from "./rules";
import { fakeBiteshipKey } from "../../test/fake-keys";

// docs/plans/cart-checkout.md §4.5.1, §4.5.4, session 8: area search with the shipping_areas
// upsert, the daily provider budgets, the rate cache and quoteShipping, against the test database
// and the fake provider. Nothing here reaches Biteship.

function area(overrides: Partial<ShippingArea> = {}): ShippingArea {
  return {
    providerAreaId: `TEST${randomUUID().replace(/-/g, "").toUpperCase()}`,
    province: "Provinsi Uji",
    city: "Kota Uji",
    district: "Kecamatan Uji",
    subdistrict: null,
    postalCode: "40111",
    ...overrides,
  };
}

function stubProvider(areas: ShippingArea[], rates: RatedService[] | Error = []) {
  const provider: ShippingRateProvider = {
    name: "fake",
    searchAreas: vi.fn(async () => areas),
    quoteRates: vi.fn(async () => {
      if (rates instanceof Error) throw rates;
      return rates;
    }),
  };
  return provider;
}

async function weightedVariant(tx: TestDatabase, weightGrams: number | null, basePrice = 259_000) {
  const fixture = await insertProductVariant(tx);
  await tx.update(products).set({ shippingWeightGrams: weightGrams, basePrice }).where(eq(products.id, fixture.product.id));
  return fixture.variant;
}

async function storedArea(tx: TestDatabase, values: Partial<ShippingArea> = {}) {
  const [option] = await searchShippingAreas(tx, stubProvider([area(values)]), "uji");
  if (!option) throw new Error("expected an area");
  return option;
}

describe("searchShippingAreas", () => {
  test("upserts every returned area and returns our ids with the display label", async () => {
    await withRollback(async (tx) => {
      const first = area({ district: "Pesanggrahan", city: "Jakarta Selatan", province: "DKI Jakarta", postalCode: "12250" });
      const second = area({ district: "Pesanggrahan", city: "Jakarta Selatan", province: "DKI Jakarta", postalCode: "12260" });
      const options = await searchShippingAreas(tx, stubProvider([first, second]), "pesanggrahan");

      expect(options.map((option) => option.label)).toEqual([
        "Pesanggrahan, Jakarta Selatan, DKI Jakarta 12250",
        "Pesanggrahan, Jakarta Selatan, DKI Jakarta 12260",
      ]);
      expect(options.every((option) => option.hasPostalCode)).toBe(true);
      const rows = await tx.select().from(shippingAreas).where(eq(shippingAreas.providerAreaId, first.providerAreaId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: options[0]!.id,
        district: "Pesanggrahan",
        postalCode: "12250",
        subdistrict: null,
        searchText: "pesanggrahan jakarta selatan dki jakarta 12250",
      });
      // The browser-facing option never carries the provider id.
      expect(JSON.stringify(options)).not.toContain(first.providerAreaId);
    });
  });

  test("a repeat search refreshes the same row in place", async () => {
    await withRollback(async (tx) => {
      const original = area();
      const [before] = await searchShippingAreas(tx, stubProvider([original]), "uji");
      await tx.update(shippingAreas).set({ lastSyncedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(shippingAreas.id, before!.id));

      const [after] = await searchShippingAreas(tx, stubProvider([{ ...original, district: "Kecamatan Baru", postalCode: null }]), "uji");
      expect(after!.id).toBe(before!.id);
      expect(after!.hasPostalCode).toBe(false);
      const [row] = await tx.select().from(shippingAreas).where(eq(shippingAreas.id, before!.id));
      expect(row).toMatchObject({ district: "Kecamatan Baru", postalCode: null, label: "Kecamatan Baru, Kota Uji, Provinsi Uji" });
      expect(row!.lastSyncedAt.getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00Z").getTime());
    });
  });

  test("a provider id repeated in one answer is upserted once (first wins)", async () => {
    await withRollback(async (tx) => {
      const twin = area();
      const options = await searchShippingAreas(tx, stubProvider([twin, { ...twin, district: "Duplikat" }]), "uji");
      expect(options).toHaveLength(1);
      expect(options[0]!.label).toContain("Kecamatan Uji");
    });
  });

  test("returns at most the result limit, in the provider's order", async () => {
    await withRollback(async (tx) => {
      const many = Array.from({ length: SHIPPING_AREA_RESULT_LIMIT + 3 }, (_, index) => area({ district: `Kecamatan ${index}` }));
      const options = await searchShippingAreas(tx, stubProvider(many), "kecamatan");
      expect(options).toHaveLength(SHIPPING_AREA_RESULT_LIMIT);
      expect(options[0]!.label).toMatch(/^Kecamatan 0,/);
      expect(options.at(-1)!.label).toMatch(new RegExp(`^Kecamatan ${SHIPPING_AREA_RESULT_LIMIT - 1},`));
    });
  });

  test("no areas: an empty list and no write", async () => {
    await withRollback(async (tx) => {
      const [{ count: before }] = (await tx.execute(sql`select count(*)::int as count from shipping_areas`)) as unknown as [{ count: number }];
      expect(await searchShippingAreas(tx, stubProvider([]), "zzz")).toEqual([]);
      const [{ count: after }] = (await tx.execute(sql`select count(*)::int as count from shipping_areas`)) as unknown as [{ count: number }];
      expect(after).toBe(before);
    });
  });

  test("a provider failure propagates as a typed error", async () => {
    const failing: ShippingRateProvider = {
      name: "fake",
      searchAreas: async () => {
        throw new ShippingRateError("unavailable", "down");
      },
      quoteRates: async () => [],
    };
    await withRollback(async (tx) => {
      await expect(searchShippingAreas(tx, failing, "uji")).rejects.toMatchObject({ reason: "unavailable" });
    });
  });
});

describe("loadShippingArea", () => {
  test("loads our row by id; anything else is null", async () => {
    await withRollback(async (tx) => {
      const option = await storedArea(tx);
      expect(await loadShippingArea(tx, option.id)).toMatchObject({ id: option.id, district: "Kecamatan Uji", postalCode: "40111" });
      expect(await loadShippingArea(tx, randomUUID())).toBeNull();
      expect(await loadShippingArea(tx, "not-a-uuid")).toBeNull();
      expect(await loadShippingArea(tx, "'; drop table shipping_areas; --")).toBeNull();
    });
  });
});

describe("consumeShippingCallBudget", () => {
  test("allows exactly the daily limit, per kind, then refuses", async () => {
    await withRollback(async (tx) => {
      // Rows from earlier test runs (committed elsewhere) must not count: start from a clean day
      // inside this transaction only.
      await tx.delete(claimRateLimits).where(eq(claimRateLimits.ip, SHIPPING_BUDGET_IP));
      for (let i = 0; i < 3; i += 1) await consumeShippingCallBudget(tx, "rates", 3);
      await expect(consumeShippingCallBudget(tx, "rates", 3)).rejects.toMatchObject({ reason: "budget_exhausted" });
      // Maps has its own budget.
      await consumeShippingCallBudget(tx, "maps", 3);

      const rows = await tx
        .select({ action: claimRateLimits.action })
        .from(claimRateLimits)
        .where(eq(claimRateLimits.ip, SHIPPING_BUDGET_IP));
      expect(rows.filter((row) => row.action === SHIPPING_BUDGET_ACTIONS.rates)).toHaveLength(4);
      expect(rows.filter((row) => row.action === SHIPPING_BUDGET_ACTIONS.maps)).toHaveLength(1);
    });
  });

  test("only today's requests (Asia/Jakarta) count", async () => {
    await withRollback(async (tx) => {
      await tx.delete(claimRateLimits).where(eq(claimRateLimits.ip, SHIPPING_BUDGET_IP));
      // Yesterday in Jakarta: one second before today's Jakarta midnight.
      await tx.execute(sql`
        insert into claim_rate_limits (ip, action, created_at)
        select ${SHIPPING_BUDGET_IP}::inet, ${SHIPPING_BUDGET_ACTIONS.rates}, (date_trunc('day', now() at time zone 'Asia/Jakarta') at time zone 'Asia/Jakarta') - interval '1 second'
        from generate_series(1, 5)`);
      await consumeShippingCallBudget(tx, "rates", 1);
      await expect(consumeShippingCallBudget(tx, "rates", 1)).rejects.toBeInstanceOf(ShippingRateError);
    });
  });
});

describe("quoteShipping", () => {
  function deps(provider: ShippingRateProvider, overrides: Partial<ShippingQuoteDeps> = {}): ShippingQuoteDeps {
    return { provider, originAreaId: "ORIGIN-UJI", cacheMinutes: 360, ...overrides };
  }

  test("cheapest allowlisted service, split, parcel weight and goods value sent once", async () => {
    await withRollback(async (tx) => {
      const a = await weightedVariant(tx, 650, 259_000);
      const b = await weightedVariant(tx, 800, 289_000);
      const option = await storedArea(tx);
      const provider = stubProvider([], [
        { courierCode: "jne", serviceCode: "ctc", cost: 9_000 },
        { courierCode: "sicepat", serviceCode: "reg", cost: 35_000 },
        { courierCode: "jne", serviceCode: "reg", cost: 34_000 },
      ]);

      const result = await quoteShipping(tx, deps(provider), { areaId: option.id, lines: [{ sku: a.sku, qty: 2 }, { sku: b.sku, qty: 1 }] });
      const weight = 2 * 650 + 800 + SHIPPING_PACKAGING_GRAMS;
      expect(result).toEqual({
        ok: true,
        quote: {
          courierCode: "jne",
          serviceCode: "reg",
          label: "JNE Reguler",
          costAmount: 34_000,
          subsidyAmount: 20_000,
          buyerAmount: 14_000,
          weightGrams: weight,
          destinationId: expect.stringMatching(/^TEST/),
          quotedAt: expect.any(Date),
        },
      });
      expect(provider.quoteRates).toHaveBeenCalledTimes(1);
      expect(provider.quoteRates).toHaveBeenCalledWith({
        originAreaId: "ORIGIN-UJI",
        destinationAreaId: expect.stringMatching(/^TEST/),
        weightGrams: weight,
        goodsValue: 2 * 259_000 + 289_000,
        courierCodes: ["jne", "jnt", "sicepat", "idexpress", "anteraja", "pos"],
      });
    });
  });

  test("a fresh cache row is reused without a provider call and keeps only allowlisted services", async () => {
    await withRollback(async (tx) => {
      const variant = await weightedVariant(tx, 700);
      const option = await storedArea(tx);
      const provider = stubProvider([], [
        { courierCode: "jne", serviceCode: "ctc", cost: 9_000 },
        { courierCode: "jnt", serviceCode: "ez", cost: 18_000 },
      ]);
      const input = { areaId: option.id, lines: [{ sku: variant.sku, qty: 1 }] };

      const first = await quoteShipping(tx, deps(provider), input);
      const second = await quoteShipping(tx, deps(provider), input);
      expect(provider.quoteRates).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);

      const [row] = await tx.select().from(shippingRateCache).where(eq(shippingRateCache.originId, "ORIGIN-UJI"));
      expect(row!.result).toEqual({ services: [{ courierCode: "jnt", serviceCode: "ez", cost: 18_000 }] });
      expect(row!.servicesKey).toBe(allowlistServicesKey());
      expect(row!.weightGrams).toBe(700 + SHIPPING_PACKAGING_GRAMS);
    });
  });

  test("a stale row, another weight or another allowlist asks the provider again", async () => {
    await withRollback(async (tx) => {
      const variant = await weightedVariant(tx, 700);
      const option = await storedArea(tx);
      const provider = stubProvider([], [{ courierCode: "jnt", serviceCode: "ez", cost: 18_000 }]);
      const input = { areaId: option.id, lines: [{ sku: variant.sku, qty: 1 }] };

      await quoteShipping(tx, deps(provider), input);
      await tx.update(shippingRateCache).set({ fetchedAt: sql`now() - interval '361 minutes'` }).where(eq(shippingRateCache.originId, "ORIGIN-UJI"));
      await quoteShipping(tx, deps(provider), input);
      expect(provider.quoteRates).toHaveBeenCalledTimes(2);

      await quoteShipping(tx, deps(provider), { ...input, lines: [{ sku: variant.sku, qty: 2 }] });
      expect(provider.quoteRates).toHaveBeenCalledTimes(3);

      const narrower = SHIPPING_SERVICE_ALLOWLIST.filter((entry) => entry.courierCode === "jnt");
      await quoteShipping(tx, deps(provider, { allowlist: narrower }), input);
      expect(provider.quoteRates).toHaveBeenCalledTimes(4);
    });
  });

  test("the provider has no courier: no_service, and the empty answer is cached", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const variant = await weightedVariant(tx, 700);
      const option = await storedArea(tx);
      const provider = stubProvider([], []);
      const input = { areaId: option.id, lines: [{ sku: variant.sku, qty: 1 }] };
      expect(await quoteShipping(tx, deps(provider), input)).toEqual({ ok: false, reason: "no_service" });
      expect(await quoteShipping(tx, deps(provider), input)).toEqual({ ok: false, reason: "no_service" });
      expect(provider.quoteRates).toHaveBeenCalledTimes(1);
    });
  });

  test("services that were all filtered out: no_service, logged loudly with the codes, never cached", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const variant = await weightedVariant(tx, 700);
      const option = await storedArea(tx);
      const provider = stubProvider([], [
        { courierCode: "jne", serviceCode: "ctc", cost: 9_000 },
        { courierCode: "jne", serviceCode: "reg", cost: 0 },
      ]);
      const input = { areaId: option.id, lines: [{ sku: variant.sku, qty: 1 }] };
      expect(await quoteShipping(tx, deps(provider), input)).toEqual({ ok: false, reason: "no_service" });
      expect(await quoteShipping(tx, deps(provider), input)).toEqual({ ok: false, reason: "no_service" });
      expect(provider.quoteRates).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledWith("[shipping] quote: every service the provider returned was filtered out", {
        provider: "fake",
        returned: ["jne:ctc", "jne:reg"],
      });
    });
  });

  test("a failed cache write keeps the fresh quote", async () => {
    await withRollback(async (tx) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const variant = await weightedVariant(tx, 700);
      const option = await storedArea(tx);
      const provider = stubProvider([], [{ courierCode: "jnt", serviceCode: "ez", cost: 18_000 }]);
      // Every other query goes to the real transaction; only the cache insert fails.
      const failingCacheWrites = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "insert") {
            return (table: unknown) => {
              if (table === shippingRateCache) throw new Error("simulated cache write failure");
              return target.insert(table as typeof shippingAreas);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const result = await quoteShipping(failingCacheWrites, deps(provider), { areaId: option.id, lines: [{ sku: variant.sku, qty: 1 }] });
      expect(result).toMatchObject({ ok: true, quote: { courierCode: "jnt", costAmount: 18_000 } });
      expect(consoleError).toHaveBeenCalledWith("[shipping] rate cache write failed; using the fresh quote uncached", expect.any(String));
    });
  });

  test("an unparseable cache row is a logged miss", async () => {
    await withRollback(async (tx) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const variant = await weightedVariant(tx, 700);
      const option = await storedArea(tx);
      const provider = stubProvider([], [{ courierCode: "jnt", serviceCode: "ez", cost: 18_000 }]);
      const input = { areaId: option.id, lines: [{ sku: variant.sku, qty: 1 }] };
      await quoteShipping(tx, deps(provider), input);
      await tx.update(shippingRateCache).set({ result: { services: "broken" } }).where(eq(shippingRateCache.originId, "ORIGIN-UJI"));
      await quoteShipping(tx, deps(provider), input);
      expect(provider.quoteRates).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith("[shipping] rate cache row unparseable; treated as a miss", {
        destinationId: expect.any(String),
        issues: ["invalid_type"],
      });
    });
  });

  test("a provider failure is a typed refusal, logged without secrets, and never cached", async () => {
    await withRollback(async (tx) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const variant = await weightedVariant(tx, 700);
      const option = await storedArea(tx);
      const provider = stubProvider([], new ShippingRateError("unavailable", "Biteship rates answered 402", { status: 402, providerCode: 40009001 }));
      const input = { areaId: option.id, lines: [{ sku: variant.sku, qty: 1 }] };

      expect(await quoteShipping(tx, deps(provider), input)).toEqual({ ok: false, reason: "unavailable" });
      expect(consoleError).toHaveBeenCalledWith("[shipping] quote refused: unavailable", {
        provider: "fake",
        reason: "unavailable",
        status: 402,
        providerCode: 40009001,
        message: "Biteship rates answered 402",
        cause: undefined,
      });
      const cached = await tx.select().from(shippingRateCache).where(eq(shippingRateCache.originId, "ORIGIN-UJI"));
      expect(cached).toHaveLength(0);
      consoleError.mockRestore();
    });
  });

  test("a product without a weight refuses, names the SKUs and never calls the provider", async () => {
    await withRollback(async (tx) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const weighed = await weightedVariant(tx, 700);
      const unweighed = await weightedVariant(tx, null);
      const option = await storedArea(tx);
      const provider = stubProvider([]);
      const result = await quoteShipping(tx, deps(provider), {
        areaId: option.id,
        lines: [{ sku: weighed.sku, qty: 1 }, { sku: unweighed.sku, qty: 1 }, { sku: "SKU-DOES-NOT-EXIST", qty: 1 }],
      });
      expect(result).toEqual({ ok: false, reason: "missing_weight", missingSkus: ["SKU-DOES-NOT-EXIST", unweighed.sku].sort() });
      expect(provider.quoteRates).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith("[shipping] quote refused: product without a shipping weight", {
        skus: ["SKU-DOES-NOT-EXIST", unweighed.sku].sort(),
      });
      consoleError.mockRestore();
    });
  });

  test("unknown or provider-less area, and no lines, refuse before any lookup", async () => {
    await withRollback(async (tx) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const variant = await weightedVariant(tx, 700);
      const provider = stubProvider([]);
      const lines = [{ sku: variant.sku, qty: 1 }];
      expect(await quoteShipping(tx, deps(provider), { areaId: randomUUID(), lines })).toEqual({ ok: false, reason: "unknown_area" });
      expect(await quoteShipping(tx, deps(provider), { areaId: "nope", lines })).toEqual({ ok: false, reason: "unknown_area" });

      const [legacy] = await tx
        .insert(shippingAreas)
        .values({ province: "P", city: "C", district: "D", postalCode: "40111", searchText: "d", label: "D", providerAreaId: null })
        .returning();
      expect(await quoteShipping(tx, deps(provider), { areaId: legacy!.id, lines })).toEqual({ ok: false, reason: "unknown_area" });

      const option = await storedArea(tx);
      expect(await quoteShipping(tx, deps(provider), { areaId: option.id, lines: [] })).toEqual({ ok: false, reason: "empty" });
      expect(provider.quoteRates).not.toHaveBeenCalled();
      await expect(quoteShipping(tx, deps(provider), { areaId: option.id, lines: [{ sku: variant.sku, qty: 0 }] })).rejects.toThrow(RangeError);
    });
  });

  test("with the fake provider: Rp12.000 is fully subsidized, Rp95.000 leaves Rp75.000", async () => {
    await withRollback(async (tx) => {
      const variant = await weightedVariant(tx, 700);
      const fake = createFakeShippingRateProvider();
      const fakeDeps = deps(fake, { originAreaId: FAKE_ORIGIN_AREA_ID });
      const [murah] = await searchShippingAreas(tx, fake, "e2e murah");
      const [jauh] = await searchShippingAreas(tx, fake, "e2e jauh");
      const [noService] = await searchShippingAreas(tx, fake, "tanpa layanan");
      const [down] = await searchShippingAreas(tx, fake, "e2e gangguan");
      const lines = [{ sku: variant.sku, qty: 1 }];
      const consoleSpies = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];

      expect(await quoteShipping(tx, fakeDeps, { areaId: murah!.id, lines })).toMatchObject({
        ok: true,
        quote: { label: "JNE Reguler", costAmount: 12_000, subsidyAmount: 12_000, buyerAmount: 0 },
      });
      expect(await quoteShipping(tx, fakeDeps, { areaId: jauh!.id, lines })).toMatchObject({
        ok: true,
        quote: { label: "POS Kilat Khusus", costAmount: 95_000, subsidyAmount: 20_000, buyerAmount: 75_000 },
      });
      expect(await quoteShipping(tx, fakeDeps, { areaId: noService!.id, lines })).toEqual({ ok: false, reason: "no_service" });
      expect(await quoteShipping(tx, fakeDeps, { areaId: down!.id, lines })).toEqual({ ok: false, reason: "unavailable" });
      await expect(searchShippingAreas(tx, fake, "pencarian gagal")).rejects.toMatchObject({ reason: "unavailable" });
      for (const spy of consoleSpies) spy.mockRestore();
    });
  });
});

describe("shippingRuntimeFromEnv", () => {
  const complete = {
    BITESHIP_API_KEY: fakeBiteshipKey("test"),
    BITESHIP_BASE_URL: "https://api.biteship.com",
    BITESHIP_ORIGIN_AREA_ID: "IDNP9IDNC23IDND245IDZ40132",
  };

  test("the real client only when key, base URL and origin are all set", async () => {
    await withRollback(async (tx) => {
      const ok = shippingRuntimeFromEnv(tx, complete);
      expect(ok.ok && ok.runtime.provider.name).toBe("biteship");
      expect(ok.ok && ok.runtime.originAreaId).toBe(complete.BITESHIP_ORIGIN_AREA_ID);
      expect(ok.ok && ok.runtime.cacheMinutes).toBe(360);

      const none = shippingRuntimeFromEnv(tx, {});
      expect(none).toEqual({
        ok: false,
        problems: ["BITESHIP_API_KEY is not set", "BITESHIP_BASE_URL is not set", "BITESHIP_ORIGIN_AREA_ID is not set"],
      });
    });
  });

  test("problems name variables, never values", async () => {
    await withRollback(async (tx) => {
      const result = shippingRuntimeFromEnv(tx, {
        ...complete,
        BITESHIP_BASE_URL: "http://api.biteship.com",
        BITESHIP_DAILY_RATES_BUDGET: "-1",
        SHIPPING_QUOTE_CACHE_MINUTES: "abc",
        DEPLOY_ENV: "production",
      });
      expect(result).toEqual({
        ok: false,
        problems: [
          "SHIPPING_QUOTE_CACHE_MINUTES must be a positive whole number of minutes",
          "BITESHIP_API_KEY is a test key but DEPLOY_ENV is production or unset",
          "BITESHIP_BASE_URL must be https://api.biteship.com",
          "BITESHIP_DAILY_RATES_BUDGET must be a positive whole number",
        ],
      });
      expect(JSON.stringify(result)).not.toContain(complete.BITESHIP_API_KEY);
    });
  });

  test("the key only ever goes to Biteship's own host; budgets must be plain digits", async () => {
    await withRollback(async (tx) => {
      for (const baseUrl of ["https://evil.example", "https://api.biteship.com.evil.example", "https://user:pw@api.biteship.com", "https://api.biteship.com/?x=1", "https://api.biteship.com:8443"]) {
        expect(shippingRuntimeFromEnv(tx, { ...complete, BITESHIP_BASE_URL: baseUrl })).toEqual({
          ok: false,
          problems: ["BITESHIP_BASE_URL must be https://api.biteship.com"],
        });
      }
      expect(shippingRuntimeFromEnv(tx, { ...complete, BITESHIP_BASE_URL: "https://api.biteship.com/" }).ok).toBe(true);
      for (const budget of ["1e3", "0x10", "12.5", "0"]) {
        expect(shippingRuntimeFromEnv(tx, { ...complete, BITESHIP_DAILY_MAPS_BUDGET: budget }).ok).toBe(false);
      }
    });
  });

  test("a test key is refused in a production build that does not name its environment", async () => {
    await withRollback(async (tx) => {
      expect(shippingRuntimeFromEnv(tx, { ...complete, NODE_ENV: "production" }).ok).toBe(false);
      expect(shippingRuntimeFromEnv(tx, { ...complete, NODE_ENV: "production", DEPLOY_ENV: "dev" }).ok).toBe(true);
    });
  });

  test("a live key is fine in production; an unknown provider name is refused", async () => {
    await withRollback(async (tx) => {
      expect(shippingRuntimeFromEnv(tx, { ...complete, BITESHIP_API_KEY: fakeBiteshipKey("live"), DEPLOY_ENV: "production" }).ok).toBe(true);
      expect(shippingRuntimeFromEnv(tx, { ...complete, SHIPPING_RATE_PROVIDER: "komerce" })).toEqual({
        ok: false,
        problems: ["SHIPPING_RATE_PROVIDER must be biteship or fake"],
      });
    });
  });

  test("the fake only in an e2e run, never in a production build", async () => {
    await withRollback(async (tx) => {
      const e2e = shippingRuntimeFromEnv(tx, { SHIPPING_RATE_PROVIDER: "fake", NODE_ENV: "development", E2E_TEST_LOGIN: "true" });
      expect(e2e.ok && e2e.runtime.provider.name).toBe("fake");
      expect(shippingRuntimeFromEnv(tx, { SHIPPING_RATE_PROVIDER: "fake", NODE_ENV: "production", E2E_TEST_LOGIN: "true" }).ok).toBe(false);
      expect(shippingRuntimeFromEnv(tx, { SHIPPING_RATE_PROVIDER: "fake", NODE_ENV: "development" }).ok).toBe(false);
    });
  });

  test("the Biteship client draws on the daily budget before each request", async () => {
    await withRollback(async (tx) => {
      await tx.delete(claimRateLimits).where(eq(claimRateLimits.ip, SHIPPING_BUDGET_IP));
      // Stubbed BEFORE the client exists (test/setup.ts also refuses any non-local request).
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response(JSON.stringify({ success: true, areas: [] }), { status: 200 }));
      const result = shippingRuntimeFromEnv(tx, { ...complete, BITESHIP_DAILY_MAPS_BUDGET: "1" });
      if (!result.ok) throw new Error("expected a runtime");
      try {
        await result.runtime.provider.searchAreas("abc");
        await expect(result.runtime.provider.searchAreas("abc")).rejects.toMatchObject({ reason: "budget_exhausted" });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
      const rows = await tx
        .select()
        .from(claimRateLimits)
        .where(and(eq(claimRateLimits.ip, SHIPPING_BUDGET_IP), eq(claimRateLimits.action, SHIPPING_BUDGET_ACTIONS.maps)));
      expect(rows).toHaveLength(2);
    });
  });
});

