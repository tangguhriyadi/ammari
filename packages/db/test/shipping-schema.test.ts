import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { customerAddresses, orders, products, shippingAreas, shippingRateCache } from "../src/schema";
import { withRollback, type TestTx } from "./helpers";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, shippingQuoteValues } from "./fixtures";

// Constraint tests for migration 0031 (docs/plans/cart-checkout.md §3 "Migration 0031", §4.5,
// session 7). Same savepoint idiom as checkout-schema.test.ts: each expected violation runs in a
// nested transaction so one test can check several constraints.

function constraintOf(error: unknown): string | undefined {
  const fields = (value: unknown) => value as { constraint_name?: string; cause?: unknown } | undefined;
  return fields(error)?.constraint_name ?? fields(fields(error)?.cause)?.constraint_name;
}

async function expectViolation(tx: TestTx, constraint: string, write: (sp: TestTx) => Promise<unknown>) {
  let caught: unknown;
  try {
    await tx.transaction(async (sp) => {
      await write(sp);
    });
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a violation of ${constraint}`).toBeDefined();
  expect(constraintOf(caught)).toBe(constraint);
}

/** All eight quote columns empty, as on every order before migration 0031. */
const NO_QUOTE = {
  shippingAmount: 0,
  shippingCostAmount: null,
  shippingSubsidyAmount: null,
  shippingCourierCode: null,
  shippingServiceCode: null,
  shippingCourierLabel: null,
  shippingWeightGrams: null,
  shippingDestinationId: null,
  shippingQuotedAt: null,
} satisfies Partial<typeof orders.$inferInsert>;

function area(overrides: Partial<typeof shippingAreas.$inferInsert> = {}): typeof shippingAreas.$inferInsert {
  return {
    province: "Jawa Barat",
    city: "Kota Bandung",
    district: "Coblong",
    subdistrict: "Dago",
    postalCode: "40135",
    searchText: "dago coblong kota bandung jawa barat 40135",
    label: "Dago, Coblong, Kota Bandung, Jawa Barat 40135",
    komerceDestinationId: `komerce-${randomUUID()}`,
    ...overrides,
  };
}

describe("products.shipping_weight_grams", () => {
  test("is optional and, when set, between 50 and 30000 grams", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      expect(product.shippingWeightGrams).toBeNull();
      for (const grams of [50, 800, 30_000]) {
        const [row] = await tx.update(products).set({ shippingWeightGrams: grams }).where(eq(products.id, product.id)).returning();
        expect(row!.shippingWeightGrams).toBe(grams);
      }
      for (const grams of [0, 49, 30_001]) {
        await expectViolation(tx, "products_shipping_weight_grams_check", (sp) =>
          sp.update(products).set({ shippingWeightGrams: grams }).where(eq(products.id, product.id)),
        );
      }
    });
  });

  test("a published product without a weight stays valid (products published before 0031)", async () => {
    await withRollback(async (tx) => {
      const { product } = await insertProductVariant(tx);
      const [row] = await tx
        .update(products)
        .set({ isPublishedOnStorefront: true })
        .where(eq(products.id, product.id))
        .returning();
      expect(row).toMatchObject({ isPublishedOnStorefront: true, shippingWeightGrams: null });
    });
  });
});

describe("orders locked shipping quote", () => {
  test("a non-checkout order needs no quote; a checkout order must carry one", async () => {
    await withRollback(async (tx) => {
      const manual = await insertOrder(tx, { channelId: "web", channelOrderNo: null });
      expect(manual).toMatchObject({ shippingCostAmount: null, shippingQuotedAt: null, shippingAmount: 10_000 });

      const checkout = await insertOrder(tx, checkoutOrderValues());
      expect(checkout).toMatchObject({ shippingCostAmount: 12_000, shippingSubsidyAmount: 12_000, shippingAmount: 0 });

      await expectViolation(tx, "orders_checkout_shipping_quote_check", (sp) =>
        insertOrder(sp, { ...checkoutOrderValues(), ...NO_QUOTE }),
      );
    });
  });

  test("the eight quote columns are all set or all null", async () => {
    await withRollback(async (tx) => {
      for (const missing of [
        "shippingSubsidyAmount",
        "shippingCourierCode",
        "shippingServiceCode",
        "shippingCourierLabel",
        "shippingWeightGrams",
        "shippingDestinationId",
        "shippingQuotedAt",
      ] as const) {
        await expectViolation(tx, "orders_shipping_quote_all_or_none_check", (sp) =>
          insertOrder(sp, { ...checkoutOrderValues(), [missing]: null }),
        );
      }
      // Cost missing while the rest is set is the same rule (no checkout order needed for it).
      await expectViolation(tx, "orders_shipping_quote_all_or_none_check", (sp) =>
        insertOrder(sp, { channelId: "web", channelOrderNo: null, ...shippingQuoteValues(), shippingCostAmount: null }),
      );
    });
  });

  test("buyer's share = cost - subsidy, subsidy between 0 and the cost, so the total still balances", async () => {
    await withRollback(async (tx) => {
      // Subsidy split at the plan's boundary costs (§5): 0, 19.999, 20.000, 20.001 and 200.000.
      for (const [cost, subsidy, share] of [
        [0, 0, 0],
        [19_999, 19_999, 0],
        [20_000, 20_000, 0],
        [20_001, 20_000, 1],
        [200_000, 20_000, 180_000],
      ] as const) {
        const order = await insertOrder(tx, {
          ...checkoutOrderValues(),
          ...shippingQuoteValues(cost, subsidy),
          subtotalAmount: 259_000,
          discountAmount: 20_000,
        });
        expect(order).toMatchObject({ shippingAmount: share, totalAmount: 259_000 + share - 20_000 });
      }

      await expectViolation(tx, "orders_shipping_quote_amounts_check", (sp) =>
        insertOrder(sp, { ...checkoutOrderValues(), ...shippingQuoteValues(35_000, 20_000), shippingAmount: 35_000 }),
      );
      await expectViolation(tx, "orders_shipping_quote_amounts_check", (sp) =>
        insertOrder(sp, { ...checkoutOrderValues(), ...shippingQuoteValues(12_000, 12_000), shippingSubsidyAmount: 13_000 }),
      );
      await expectViolation(tx, "orders_shipping_quote_amounts_check", (sp) =>
        insertOrder(sp, { ...checkoutOrderValues(), ...shippingQuoteValues(12_000, 12_000), shippingSubsidyAmount: -1, shippingAmount: 13_000 }),
      );
      await expectViolation(tx, "orders_shipping_weight_grams_check", (sp) =>
        insertOrder(sp, { ...checkoutOrderValues(), shippingWeightGrams: 0 }),
      );
    });
  });
});

describe("shipping_areas (Komerce destinations)", () => {
  test("keyed by komerce_destination_id; two kelurahan may share province, city, kecamatan and kode pos", async () => {
    await withRollback(async (tx) => {
      const [dago] = await tx.insert(shippingAreas).values(area()).returning();
      const [lebakSiliwangi] = await tx
        .insert(shippingAreas)
        .values(area({ subdistrict: "Lebak Siliwangi" }))
        .returning();
      expect(dago!.lastSyncedAt).toBeInstanceOf(Date);
      expect(lebakSiliwangi!.id).not.toBe(dago!.id);

      await expectViolation(tx, "shipping_areas_komerce_destination_id_key", (sp) =>
        sp.insert(shippingAreas).values(area({ komerceDestinationId: dago!.komerceDestinationId })),
      );
    });
  });

  test("the session 8 upsert refreshes a row in place by its Komerce id", async () => {
    await withRollback(async (tx) => {
      const values = area();
      const [first] = await tx.insert(shippingAreas).values(values).returning();
      const [again] = await tx
        .insert(shippingAreas)
        .values({ ...values, label: "Dago, Coblong, Kota Bandung, Jawa Barat", postalCode: null })
        .onConflictDoUpdate({
          target: shippingAreas.komerceDestinationId,
          set: { label: sql`excluded.label`, postalCode: sql`excluded.postal_code`, lastSyncedAt: sql`now()` },
        })
        .returning();
      expect(again).toMatchObject({ id: first!.id, postalCode: null, label: "Dago, Coblong, Kota Bandung, Jawa Barat" });
    });
  });

  test("kode pos may be missing, but when present it is five digits", async () => {
    await withRollback(async (tx) => {
      const [noPostal] = await tx.insert(shippingAreas).values(area({ postalCode: null })).returning();
      expect(noPostal!.postalCode).toBeNull();
      await expectViolation(tx, "shipping_areas_postal_code_format_check", (sp) =>
        sp.insert(shippingAreas).values(area({ postalCode: "4013" })),
      );
    });
  });
});

describe("customer_addresses.subdistrict", () => {
  test("is optional (an area can be a whole kecamatan)", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx);
      const [saved] = await tx.insert(shippingAreas).values(area()).returning();
      const base = {
        customerId: customer.id,
        recipientName: "Siti",
        phone: "+6281234567890",
        addressLine: "Jl. Contoh 1",
        shippingAreaId: saved!.id,
        province: "Jawa Barat",
        city: "Kota Bandung",
        district: "Coblong",
        postalCode: "40135",
      };
      const [withKelurahan] = await tx.insert(customerAddresses).values({ ...base, subdistrict: "Dago" }).returning();
      const [without] = await tx.insert(customerAddresses).values(base).returning();
      expect(withKelurahan!.subdistrict).toBe("Dago");
      expect(without!.subdistrict).toBeNull();
    });
  });
});

describe("shipping_rate_cache", () => {
  test("one row per (origin, destination, weight, allowlist), refreshed in place by the upsert", async () => {
    await withRollback(async (tx) => {
      const key = { originId: "origin-1", destinationId: `dest-${randomUUID()}`, weightGrams: 900, servicesKey: "allowlist-v1" };
      const [first] = await tx
        .insert(shippingRateCache)
        .values({ ...key, result: { services: [{ courier: "jne", service: "REG", price: 12_000 }] } })
        .returning();
      const [refreshed] = await tx
        .insert(shippingRateCache)
        .values({ ...key, result: { services: [{ courier: "jne", service: "REG", price: 13_000 }] } })
        .onConflictDoUpdate({
          target: [shippingRateCache.originId, shippingRateCache.destinationId, shippingRateCache.weightGrams, shippingRateCache.servicesKey],
          set: { result: sql`excluded.result`, fetchedAt: sql`now()` },
        })
        .returning();
      expect(refreshed!.id).toBe(first!.id);
      expect(refreshed!.result).toEqual({ services: [{ courier: "jne", service: "REG", price: 13_000 }] });

      // A different weight or allowlist is its own row.
      await tx.insert(shippingRateCache).values({ ...key, weightGrams: 1_000, result: {} });
      await tx.insert(shippingRateCache).values({ ...key, servicesKey: "allowlist-v2", result: {} });

      await expectViolation(tx, "shipping_rate_cache_lookup_key", (sp) => sp.insert(shippingRateCache).values({ ...key, result: {} }));
      await expectViolation(tx, "shipping_rate_cache_weight_grams_check", (sp) =>
        sp.insert(shippingRateCache).values({ ...key, weightGrams: 0, result: {} }),
      );
    });
  });
});
