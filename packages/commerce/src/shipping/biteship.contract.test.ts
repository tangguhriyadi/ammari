import { describe, expect, test } from "vitest";
import { createBiteshipClient } from "./biteship";
import { SHIPPING_SERVICE_ALLOWLIST, allowlistCourierCodes, allowlistedServices } from "./rules";

// Opt-in contract test against the REAL Biteship API (docs/plans/cart-checkout.md §13, session 8).
// Skipped unless run by hand:
//   BITESHIP_CONTRACT_TEST=1 BITESHIP_API_KEY=biteship_test.... BITESHIP_ORIGIN_AREA_ID=... \
//     pnpm --filter @ammari/commerce exec vitest run src/shipping/biteship.contract.test.ts
// Test-mode Maps and Rates are real data and billed (a few rupiah per run). It prints every service
// code Biteship returns, so the allowlist in ./rules.ts can be checked against reality. It never
// writes to any database.

const enabled = process.env.BITESHIP_CONTRACT_TEST === "1";
const apiKey = process.env.BITESHIP_API_KEY ?? "";
const originAreaId = process.env.BITESHIP_ORIGIN_AREA_ID ?? "";

describe.skipIf(!enabled)("Biteship contract (opt-in, real API)", () => {
  const client = createBiteshipClient({ apiKey, baseUrl: process.env.BITESHIP_BASE_URL ?? "https://api.biteship.com" });

  test("maps search and rates return the documented shapes and the allowlisted codes", { timeout: 30_000 }, async () => {
    expect(apiKey.startsWith("biteship_test.")).toBe(true);
    expect(originAreaId).not.toBe("");

    const areas = await client.searchAreas("Pesanggrahan");
    expect(areas.length).toBeGreaterThan(0);
    const destination = areas[0]!;
    console.info("[contract] first area", destination);

    const services = await client.quoteRates({
      originAreaId,
      destinationAreaId: destination.providerAreaId,
      weightGrams: 1_000,
      goodsValue: 269_000,
      courierCodes: allowlistCourierCodes(),
    });
    console.info("[contract] services returned", services);
    const matched = allowlistedServices(services);
    console.info("[contract] allowlisted matches", matched);
    console.info(
      "[contract] allowlist entries with no match",
      SHIPPING_SERVICE_ALLOWLIST.filter((entry) => !matched.some((m) => m.courierCode === entry.courierCode && m.serviceCode === entry.serviceCode)),
    );
    expect(matched.length).toBeGreaterThan(0);
  });
});
