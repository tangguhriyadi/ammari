import { describe, expect, test } from "vitest";
import { fabrics } from "../src/schema";
import { withRollback, type TestTx } from "./helpers";

/** drizzle-orm wraps the driver error as "Failed query: ..." and puts the real Postgres message
 * on `.cause` — same unwrapping product-variants.test.ts uses. For a plain CHECK violation, the
 * useful signal is `.code` (23514 = check_violation). */
async function causeOf(promise: Promise<unknown>): Promise<{ message: string; code?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    return { message: String(cause), code: (cause as { code?: string } | undefined)?.code };
  }
  throw new Error("expected promise to reject, but it resolved");
}

function insertFabric(tx: TestTx, overrides: Partial<typeof fabrics.$inferInsert> = {}) {
  return tx.insert(fabrics).values({ name: "Katun Rayon", ...overrides });
}

describe("fabrics price CHECK constraints", () => {
  test("rejects a negative price_amount", async () => {
    await withRollback(async (tx) => {
      const { code } = await causeOf(insertFabric(tx, { priceAmount: -1000, priceUnit: "meter" }));
      expect(code).toBe("23514"); // fabrics_price_amount_check
    });
  });

  test("rejects price_unit set without price_amount", async () => {
    await withRollback(async (tx) => {
      const { code } = await causeOf(insertFabric(tx, { priceAmount: null, priceUnit: "meter" }));
      expect(code).toBe("23514"); // fabrics_price_amount_unit_pair_check
    });
  });

  test("rejects price_amount set without price_unit", async () => {
    await withRollback(async (tx) => {
      const { code } = await causeOf(insertFabric(tx, { priceAmount: 85_000, priceUnit: null }));
      expect(code).toBe("23514"); // fabrics_price_amount_unit_pair_check
    });
  });

  test("rejects an invalid price_unit", async () => {
    await withRollback(async (tx) => {
      // @ts-expect-error -- intentionally an invalid value, to exercise the DB-level CHECK rather
      // than TypeScript's own FabricPriceUnit narrowing.
      const { code } = await causeOf(insertFabric(tx, { priceAmount: 85_000, priceUnit: "kilogram" }));
      expect(code).toBe("23514"); // fabrics_price_unit_check
    });
  });

  test("accepts both null (price not yet known)", async () => {
    await withRollback(async (tx) => {
      await expect(insertFabric(tx, { priceAmount: null, priceUnit: null })).resolves.not.toThrow();
    });
  });

  test("accepts a valid amount+unit pair, for both units", async () => {
    await withRollback(async (tx) => {
      await expect(insertFabric(tx, { name: "Poka", priceAmount: 85_000, priceUnit: "yard" })).resolves.not.toThrow();
      await expect(insertFabric(tx, { name: "Marina", priceAmount: 75_000, priceUnit: "meter" })).resolves.not.toThrow();
    });
  });
});
