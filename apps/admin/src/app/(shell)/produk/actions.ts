"use server";

import { z } from "zod";
import { PRODUCT_CLOSURES, SIZE_MODES, SIZES } from "@ammari/db/schema";
import { generateProductCode, generateSlug } from "@ammari/db/catalog";
import { requirePermission } from "@/lib/auth/require-permission";
import { moneyString, optionalMoneyString } from "@/lib/products/money-schema";
import { runAction, type ActionResult } from "@/lib/products/action-result";
import * as productQueries from "@/lib/products/queries";

// ---------- Products ----------

const createProductSchema = z.object({
  name: z.string().trim().min(1, "Nama produk wajib diisi."),
  code: z.string().trim().min(1, "Kode produk wajib diisi.").toUpperCase(),
  slug: z.string().trim().min(1, "Slug wajib diisi.").toLowerCase(),
  fabricId: z.string().uuid("Pilih bahan."),
  closure: z.enum(PRODUCT_CLOSURES),
  sizeMode: z.enum(SIZE_MODES),
  basePrice: moneyString,
  description: z.string().trim().optional(),
  isActive: z.boolean(),
});

const updateProductSchema = createProductSchema.omit({ code: true, sizeMode: true });

export async function createProductAction(
  input: z.input<typeof createProductSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("products.manage");
  const parsed = createProductSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const product = await productQueries.createProduct(
      {
        name: parsed.data.name,
        code: parsed.data.code,
        slug: parsed.data.slug,
        fabricId: parsed.data.fabricId,
        closure: parsed.data.closure,
        sizeMode: parsed.data.sizeMode,
        basePrice: parsed.data.basePrice,
        description: parsed.data.description || null,
        isActive: parsed.data.isActive,
      },
      session.staffUser.id,
    );
    return { id: product.id };
  });
}

export async function updateProductAction(
  id: string,
  input: z.input<typeof updateProductSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("products.manage");
  const parsed = updateProductSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const product = await productQueries.updateProduct(
      id,
      {
        name: parsed.data.name,
        slug: parsed.data.slug,
        fabricId: parsed.data.fabricId,
        closure: parsed.data.closure,
        basePrice: parsed.data.basePrice,
        description: parsed.data.description || null,
        isActive: parsed.data.isActive,
      },
      session.staffUser.id,
    );
    return { id: product.id };
  });
}

/** Pure client-side convenience — not a security boundary. Lets the create form pre-fill a
 * suggested slug/code as the user types a name; the real uniqueness guarantee is still the DB
 * unique constraint, enforced by createProductAction above. Exported so both the client form and
 * tests use the exact same derivation. */
export async function suggestProductIdentifiersAction(name: string): Promise<{ code: string; slug: string }> {
  return { code: generateProductCode(name), slug: generateSlug(name) };
}

// ---------- Variants ----------

const addVariantsSchema = z.object({
  productId: z.string().uuid(),
  // One or more colors, each with its own sizes — all created in a single atomic call (see
  // productQueries.addVariants' doc comment).
  selections: z
    .array(
      z.object({
        fabricColorId: z.string().uuid("Pilih warna."),
        sizes: z.array(z.enum(SIZES)).min(1, "Pilih minimal satu ukuran."),
      }),
    )
    .min(1, "Pilih minimal satu warna."),
});

export async function addVariantsAction(
  input: z.input<typeof addVariantsSchema>,
): Promise<ActionResult<{ skus: string[] }>> {
  const session = await requirePermission("products.manage");
  const parsed = addVariantsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const created = await productQueries.addVariants(
      { productId: parsed.data.productId, selections: parsed.data.selections },
      session.staffUser.id,
    );
    return { skus: created.map((variant) => variant.sku) };
  });
}

const updateVariantSchema = z.object({
  sku: z.string().trim().min(1),
  priceOverrideAmount: optionalMoneyString.optional(),
  minStockQty: z.coerce.number().int().nonnegative(),
});

export async function updateVariantAction(input: z.input<typeof updateVariantSchema>): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  const parsed = updateVariantSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await productQueries.updateVariant(
      { sku: parsed.data.sku, priceOverrideAmount: parsed.data.priceOverrideAmount ?? null, minStockQty: parsed.data.minStockQty },
      session.staffUser.id,
    );
    return undefined;
  });
}

const bulkSetMinStockSchema = z.object({
  productId: z.string().uuid(),
  minStockQty: z.coerce.number().int().nonnegative(),
});

export async function bulkSetMinStockAction(
  input: z.input<typeof bulkSetMinStockSchema>,
): Promise<ActionResult<{ affected: number }>> {
  const session = await requirePermission("products.manage");
  const parsed = bulkSetMinStockSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const affected = await productQueries.bulkSetMinStock(parsed.data.productId, parsed.data.minStockQty, session.staffUser.id);
    return { affected };
  });
}

const setVariantActiveSchema = z.object({
  sku: z.string().trim().min(1),
  isActive: z.boolean(),
});

export async function setVariantActiveAction(input: z.input<typeof setVariantActiveSchema>): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  const parsed = setVariantActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await productQueries.setVariantActive(parsed.data.sku, parsed.data.isActive, session.staffUser.id);
    return undefined;
  });
}
