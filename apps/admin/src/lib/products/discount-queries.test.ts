import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { insertProductVariant, insertStaffUser, insertVariantForProduct } from "@ammari/db/test-fixtures";
import { auditLog, products } from "@ammari/db/schema";
import { ActionError, FieldError } from "./errors";
import { CLEARED_DISCOUNT, mapDiscountConstraintViolation, updateProductDiscount } from "./discount-queries";
import { listProducts, updateProduct } from "./queries";

const NOW = new Date("2026-10-23T05:00:00Z");

async function productAt(tx: TestTx, basePrice: number) {
  const { fabric, color } = await insertProductVariant(tx);
  const { product } = await insertVariantForProduct(tx, fabric.id, color.id, { basePrice, name: `Contoh Gamis Diskon ${basePrice}` });
  return product;
}

async function discountAudits(tx: TestTx, productId: string) {
  return tx
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, productId), eq(auditLog.action, "discount_update")));
}

describe("updateProductDiscount", () => {
  test("saves the sale price, toggle and window, and writes one discount_update audit entry with before/after", async () => {
    await withRollback(async (tx) => {
      const product = await productAt(tx, 350_000);
      const staff = await insertStaffUser(tx);
      const startsAt = new Date("2026-10-31T17:00:00Z");
      const endsAt = new Date("2026-11-30T17:00:00Z");

      const after = await updateProductDiscount(
        product.id,
        { discountPriceAmount: 279_000, discountEnabled: true, discountStartsAt: startsAt, discountEndsAt: endsAt },
        staff.id,
        tx,
        NOW,
      );
      expect(after).toMatchObject({ discountPriceAmount: 279_000, discountEnabled: true, discountStartsAt: startsAt, discountEndsAt: endsAt });

      const audits = await discountAudits(tx, product.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorStaffUserId: staff.id, entityType: "product" });
      expect(audits[0]?.before).toEqual({ basePrice: 350_000, discountPriceAmount: null, discountEnabled: false, discountStartsAt: null, discountEndsAt: null });
      expect(audits[0]?.after).toEqual({
        basePrice: 350_000,
        discountPriceAmount: 279_000,
        discountEnabled: true,
        discountStartsAt: startsAt.toISOString(),
        discountEndsAt: endsAt.toISOString(),
      });
    });
  });

  test("clearing (Hapus diskon) nulls everything and is audit logged too", async () => {
    await withRollback(async (tx) => {
      const product = await productAt(tx, 350_000);
      await updateProductDiscount(product.id, { discountPriceAmount: 279_000, discountEnabled: true, discountStartsAt: null, discountEndsAt: null }, null, tx, NOW);
      const after = await updateProductDiscount(product.id, CLEARED_DISCOUNT, null, tx, NOW);
      expect(after).toMatchObject(CLEARED_DISCOUNT);

      const audits = await discountAudits(tx, product.id);
      expect(audits).toHaveLength(2);
      expect(audits.some((audit) => (audit.after as { discountPriceAmount: unknown }).discountPriceAmount === null)).toBe(true);
    });
  });

  test("a sale price can stay stored with the toggle off", async () => {
    await withRollback(async (tx) => {
      const product = await productAt(tx, 350_000);
      const after = await updateProductDiscount(product.id, { discountPriceAmount: 279_000, discountEnabled: false, discountStartsAt: null, discountEndsAt: null }, null, tx, NOW);
      expect(after).toMatchObject({ discountPriceAmount: 279_000, discountEnabled: false });
    });
  });

  test.each([
    [{ discountPriceAmount: 350_000 }, "discountPriceAmount", "Harga setelah diskon harus lebih kecil dari harga normal."],
    [{ discountPriceAmount: 0 }, "discountPriceAmount", "Harga setelah diskon harus lebih dari Rp 0."],
    [{ discountPriceAmount: 348_000 }, "discountPriceAmount", "Diskon minimal 1%."],
    [{ discountPriceAmount: null }, "discountPriceAmount", "Isi harga setelah diskon dulu."],
    [
      { discountStartsAt: new Date("2026-11-02T00:00:00Z"), discountEndsAt: new Date("2026-11-01T00:00:00Z") },
      "discountEndsAt",
      "Waktu selesai harus setelah waktu mulai.",
    ],
    [{ discountEndsAt: new Date("2026-10-23T04:00:00Z") }, "discountEndsAt", "Waktu selesai sudah lewat."],
  ])("refuses %o with a FieldError on %s, writing nothing", async (patch, field, message) => {
    await withRollback(async (tx) => {
      const product = await productAt(tx, 350_000);
      const input = { discountPriceAmount: 279_000, discountEnabled: true, discountStartsAt: null, discountEndsAt: null, ...patch };
      const error = await updateProductDiscount(product.id, input, null, tx, NOW).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FieldError);
      expect(error).toMatchObject({ field, message });
      expect(await discountAudits(tx, product.id)).toHaveLength(0);
    });
  });

  test("an unknown product is an ActionError, not a crash", async () => {
    await withRollback(async (tx) => {
      await expect(updateProductDiscount("00000000-0000-4000-8000-000000000000", CLEARED_DISCOUNT, null, tx, NOW)).rejects.toBeInstanceOf(ActionError);
    });
  });
});

describe("mapDiscountConstraintViolation (23514 backstop)", () => {
  const violation = (constraint: string) => Object.assign(new Error("check violation"), { code: "23514", constraint_name: constraint });

  test("maps each discount CHECK to a friendly FieldError", () => {
    expect(() => mapDiscountConstraintViolation(violation("products_discount_price_amount_check"), { from: "discount" })).toThrow(
      "Harga setelah diskon harus lebih kecil dari harga normal.",
    );
    expect(() => mapDiscountConstraintViolation(violation("products_discount_enabled_price_check"), { from: "discount" })).toThrow(
      "Isi harga setelah diskon dulu.",
    );
    expect(() => mapDiscountConstraintViolation(violation("products_discount_window_check"), { from: "discount" })).toThrow(
      "Waktu selesai harus setelah waktu mulai.",
    );
  });

  test("on a base price edit, blames the base price with the plan §3.2 message", () => {
    let caught: unknown;
    try {
      mapDiscountConstraintViolation(violation("products_discount_price_amount_check"), { from: "basePrice", discountPriceAmount: 279_000 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FieldError);
    expect(caught).toMatchObject({
      field: "basePrice",
      message: "Harga normal harus lebih besar dari harga diskon (Rp 279.000) dan diskon minimal 1%. Ubah atau hapus diskon dulu.",
    });
  });

  test("leaves anything else alone for the caller to rethrow", () => {
    expect(() => mapDiscountConstraintViolation(violation("products_base_price_check"), { from: "discount" })).not.toThrow();
    expect(() => mapDiscountConstraintViolation(Object.assign(new Error("dup"), { code: "23505" }), { from: "discount" })).not.toThrow();
  });
});

describe("updateProduct with a stored discount (session 1 review blocker)", () => {
  async function saveBasePrice(tx: TestTx, product: typeof products.$inferSelect, basePrice: number) {
    return updateProduct(
      product.id,
      { name: product.name, slug: product.slug, fabricId: product.fabricId, closure: product.closure, basePrice, isActive: product.isActive, highlights: [] },
      null,
      tx,
    );
  }

  test.each([279_000, 270_000, 281_000])(
    "lowering the base price to %i (at/below the sale price, or under 1%% off) is a friendly FieldError on basePrice, not a 500",
    async (newBase) => {
      await withRollback(async (tx) => {
        const product = await productAt(tx, 350_000);
        await updateProductDiscount(product.id, { discountPriceAmount: 279_000, discountEnabled: false, discountStartsAt: null, discountEndsAt: null }, null, tx, NOW);
        const error = await saveBasePrice(tx, product, newBase).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(FieldError);
        expect(error).toMatchObject({
          field: "basePrice",
          message: "Harga normal harus lebih besar dari harga diskon (Rp 279.000) dan diskon minimal 1%. Ubah atau hapus diskon dulu.",
        });
        const [row] = await tx.select({ basePrice: products.basePrice }).from(products).where(eq(products.id, product.id));
        expect(row?.basePrice).toBe(350_000);
      });
    },
  );

  test("a base price that keeps the discount valid still saves", async () => {
    await withRollback(async (tx) => {
      const product = await productAt(tx, 350_000);
      await updateProductDiscount(product.id, { discountPriceAmount: 279_000, discountEnabled: true, discountStartsAt: null, discountEndsAt: null }, null, tx, NOW);
      const after = await saveBasePrice(tx, product, 299_000);
      expect(after.basePrice).toBe(299_000);
    });
  });
});

describe("listProducts discount chip", () => {
  test("reports the status and the effective price, and null status without a sale price", async () => {
    await withRollback(async (tx) => {
      const active = await productAt(tx, 350_000);
      await updateProductDiscount(active.id, { discountPriceAmount: 279_000, discountEnabled: true, discountStartsAt: null, discountEndsAt: null }, null, tx, NOW);
      const scheduled = await productAt(tx, 360_000);
      await updateProductDiscount(
        scheduled.id,
        { discountPriceAmount: 300_000, discountEnabled: true, discountStartsAt: new Date("2026-12-01T00:00:00Z"), discountEndsAt: null },
        null,
        tx,
        NOW,
      );
      const plain = await productAt(tx, 370_000);

      const { rows } = await listProducts("Contoh Gamis Diskon", undefined, "100", tx, NOW);
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(active.id)).toMatchObject({ discountStatus: "active", basePrice: 350_000, effectivePrice: 279_000 });
      expect(byId.get(scheduled.id)).toMatchObject({ discountStatus: "scheduled", effectivePrice: 360_000 });
      expect(byId.get(plain.id)).toMatchObject({ discountStatus: null, effectivePrice: 370_000 });
      expect(byId.get(active.id)).not.toHaveProperty("discountPriceAmount");
    });
  });
});
