import "server-only";
import { eq } from "drizzle-orm";
import { products } from "@ammari/db/schema";
import { isPostgresConstraintViolation } from "@ammari/commerce/errors";
import { ActionError, FieldError } from "./errors";
import {
  basePriceBreaksDiscountMessage,
  checkDiscountRules,
  DISCOUNT_PRICE_ISSUE_MESSAGES,
  DISCOUNT_PRICE_REQUIRED_MESSAGE,
  DISCOUNT_WINDOW_MESSAGE,
} from "./discount";
import { defaultDb, lockProductForUpdate, writeAuditLog, type Database } from "./db";

// The per-product discount write path (docs/plans/product-discount.md §4.1). Separate from
// updateProduct on purpose: the discount section saves on its own, with its own audit entry.

export interface ProductDiscountInput {
  discountPriceAmount: number | null;
  discountEnabled: boolean;
  discountStartsAt: Date | null;
  discountEndsAt: Date | null;
}

/** "Hapus diskon": price and dates cleared, toggle off. */
export const CLEARED_DISCOUNT: ProductDiscountInput = {
  discountPriceAmount: null,
  discountEnabled: false,
  discountStartsAt: null,
  discountEndsAt: null,
};

type ProductRow = typeof products.$inferSelect;

/** What the audit entry records, before and after: the base price too, so the percent at that
 * moment can be reconstructed (plan §4.1). */
function discountSnapshot(row: ProductRow) {
  return {
    basePrice: row.basePrice,
    discountPriceAmount: row.discountPriceAmount,
    discountEnabled: row.discountEnabled,
    discountStartsAt: row.discountStartsAt,
    discountEndsAt: row.discountEndsAt,
  };
}

/** Turns a 23514 from one of migration 0036's discount CHECKs into a friendly FieldError, and
 * returns (the caller rethrows) for anything else. Only a backstop: the app checks the same rules
 * first against the locked row, so this fires only if a rule check is ever missed. With
 * `from: "basePrice"` the price CHECK fired on a base price edit (updateProduct), so the base
 * price field gets the plan §3.2 message naming the stored sale price. */
export function mapDiscountConstraintViolation(
  error: unknown,
  context: { from: "discount" } | { from: "basePrice"; discountPriceAmount: number },
): void {
  if (isPostgresConstraintViolation(error, "23514", ["products_discount_price_amount_check"])) {
    if (context.from === "basePrice") throw new FieldError("basePrice", basePriceBreaksDiscountMessage(context.discountPriceAmount));
    throw new FieldError("discountPriceAmount", DISCOUNT_PRICE_ISSUE_MESSAGES.not_below_base);
  }
  if (isPostgresConstraintViolation(error, "23514", ["products_discount_enabled_price_check"])) {
    throw new FieldError("discountPriceAmount", DISCOUNT_PRICE_REQUIRED_MESSAGE);
  }
  if (isPostgresConstraintViolation(error, "23514", ["products_discount_window_check"])) {
    throw new FieldError("discountEndsAt", DISCOUNT_WINDOW_MESSAGE);
  }
}

/** Saves a product's discount: one transaction, the product row locked (so a concurrent base
 * price edit cannot slip between the check and the write), every plan §3.2 rule re-checked here
 * against the locked base price, and one audit entry `discount_update` with before/after. */
export async function updateProductDiscount(
  productId: string,
  input: ProductDiscountInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
  now: Date = new Date(),
) {
  return db.transaction(async (tx) => {
    const before = await lockProductForUpdate(tx, productId);
    if (!before) throw new ActionError("Produk tidak ditemukan.");

    const broken = checkDiscountRules({ basePrice: before.basePrice, ...input }, now);
    if (broken) throw new FieldError(broken.field, broken.message);

    try {
      const [after] = await tx.update(products).set(input).where(eq(products.id, productId)).returning();
      if (!after) throw new Error("failed to update product discount");
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "discount_update",
        entityType: "product",
        entityId: productId,
        before: discountSnapshot(before),
        after: discountSnapshot(after),
      });
      return after;
    } catch (error) {
      mapDiscountConstraintViolation(error, { from: "discount" });
      throw error;
    }
  });
}
