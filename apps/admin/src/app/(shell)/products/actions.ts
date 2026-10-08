"use server";

import { z } from "zod";
import { PRODUCT_CLOSURES, SIZE_MODES, SIZES } from "@ammari/db/schema";
import { generateProductCode, generateSlug } from "@ammari/db/catalog";
import { requirePermission } from "@/lib/auth/require-permission";
import { moneyString, optionalMoneyString } from "@/lib/products/money-schema";
import { runAction, type ActionResult } from "@/lib/products/action-result";
import * as productQueries from "@/lib/products/queries";
import * as imageQueries from "@/lib/products/image-queries";
import * as recipeQueries from "@/lib/inventory/recipes";

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
): Promise<ActionResult<{ skus: string[]; inactiveColorNames: string[] }>> {
  const session = await requirePermission("products.manage");
  const parsed = addVariantsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const { created, inactiveColorNames } = await productQueries.addVariants(
      { productId: parsed.data.productId, selections: parsed.data.selections },
      session.staffUser.id,
    );
    return { skus: created.map((variant) => variant.sku), inactiveColorNames };
  });
}

const bulkUpdateVariantsSchema = z.object({
  productId: z.string().uuid(),
  // Every dirty row of one color-group table, saved together — see
  // productQueries.updateVariantsBulk's doc comment for the atomicity/audit-log guarantee.
  updates: z
    .array(
      z.object({
        sku: z.string().trim().min(1),
        priceOverrideAmount: optionalMoneyString.optional(),
        minStockQty: z.coerce
          .number()
          .int("Stok minimum harus bilangan bulat.")
          .nonnegative("Stok minimum tidak boleh negatif."),
      }),
    )
    .min(1),
});

export async function bulkUpdateVariantsAction(
  input: z.input<typeof bulkUpdateVariantsSchema>,
): Promise<ActionResult<{ updated: string[] }>> {
  const session = await requirePermission("products.manage");
  const parsed = bulkUpdateVariantsSchema.safeParse(input);
  if (!parsed.success) {
    // Mapped to `${sku}:${field}` keys (not just the first issue) so the UI can show each
    // invalid row's error next to ITS OWN field, not just one generic message for the whole
    // group — zod's array-schema issues carry a `path` of ["updates", rowIndex, fieldName] (the
    // "updates" segment is the object key the array sits under, NOT part of the row address),
    // and the sku for a given row index comes from the ORIGINAL (unparsed) input since parsing
    // failed.
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const [, index, field] = issue.path;
      if (typeof index !== "number" || typeof field !== "string") continue;
      const sku = input.updates[index]?.sku;
      if (!sku) continue;
      fieldErrors[`${sku}:${field}`] = issue.message;
    }
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Input tidak valid.",
      fieldErrors: Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined,
    };
  }
  return runAction(async () => {
    const updated = await productQueries.updateVariantsBulk(
      {
        productId: parsed.data.productId,
        updates: parsed.data.updates.map((update) => ({
          sku: update.sku,
          priceOverrideAmount: update.priceOverrideAmount ?? null,
          minStockQty: update.minStockQty,
        })),
      },
      session.staffUser.id,
    );
    return { updated: updated.map((variant) => variant.sku) };
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

// ---------- Photos ----------
//
// One file per call, by design — the client (product-photos-section.tsx) downscales each file
// in the browser (max 2400px long edge) and uploads sequentially, so a multi-file "pilih 3 foto"
// submit is 3 separate calls with their own progress/error, not one big multipart body. The
// server still independently re-validates size/type (see image-processing.ts) regardless of
// what the browser already did.

const uploadProductImageSchema = z.object({
  productId: z.string().uuid(),
  fabricColorId: z.string().uuid().nullable(),
  altText: z.string().trim().optional(),
});

export async function uploadProductImageAction(
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("products.manage");

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "File tidak ditemukan." };

  const parsed = uploadProductImageSchema.safeParse({
    productId: formData.get("productId"),
    fabricColorId: formData.get("fabricColorId") || null,
    altText: formData.get("altText") || undefined,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };

  return runAction(async () => {
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const image = await imageQueries.uploadProductImage(
      {
        productId: parsed.data.productId,
        fabricColorId: parsed.data.fabricColorId,
        altText: parsed.data.altText,
        fileBuffer,
      },
      session.staffUser.id,
    );
    return { id: image.id };
  });
}

const deleteProductImageSchema = z.object({ imageId: z.string().uuid() });

export async function deleteProductImageAction(input: z.input<typeof deleteProductImageSchema>): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  const parsed = deleteProductImageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await imageQueries.deleteProductImage(parsed.data.imageId, session.staffUser.id);
    return undefined;
  });
}

const reorderProductImagesSchema = z.object({
  productId: z.string().uuid(),
  fabricColorId: z.string().uuid().nullable(),
  orderedImageIds: z.array(z.string().uuid()).min(1),
});

export async function reorderProductImagesAction(
  input: z.input<typeof reorderProductImagesSchema>,
): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  const parsed = reorderProductImagesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await imageQueries.reorderProductImages(
      { productId: parsed.data.productId, fabricColorId: parsed.data.fabricColorId, orderedImageIds: parsed.data.orderedImageIds },
      session.staffUser.id,
    );
    return undefined;
  });
}

const setProductThumbnailSchema = z.object({ productId: z.string().uuid(), imageId: z.string().uuid() });

export async function setProductThumbnailAction(
  input: z.input<typeof setProductThumbnailSchema>,
): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  const parsed = setProductThumbnailSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await imageQueries.setProductThumbnail(parsed.data.productId, parsed.data.imageId, session.staffUser.id);
    return undefined;
  });
}

const updateImageAltTextSchema = z.object({ imageId: z.string().uuid(), altText: z.string().trim().optional() });

export async function updateImageAltTextAction(
  input: z.input<typeof updateImageAltTextSchema>,
): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  const parsed = updateImageAltTextSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await imageQueries.updateImageAltText(parsed.data.imageId, parsed.data.altText || null, session.staffUser.id);
    return undefined;
  });
}

// ---------- Accessory recipe (BOM) ----------

const recipeLineSchema = z
  .object({
    accessoryId: z.string().uuid().optional(),
    sizeGroup: z.string().trim().optional(),
    qtyPerPcs: z.coerce.number().int("Jumlah per pcs harus bilangan bulat.").positive("Jumlah per pcs harus lebih dari 0."),
  })
  .refine((line) => Boolean(line.accessoryId) !== Boolean(line.sizeGroup), {
    message: "Pilih satu aksesoris ATAU satu grup ukuran untuk setiap baris.",
  });

const saveRecipeSchema = z.object({
  productId: z.string().uuid(),
  lines: z.array(recipeLineSchema),
});

export async function saveRecipeAction(input: z.input<typeof saveRecipeSchema>): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  const parsed = saveRecipeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await recipeQueries.saveRecipeForProduct(
      parsed.data.productId,
      parsed.data.lines.map((line) => ({ accessoryId: line.accessoryId ?? null, sizeGroup: line.sizeGroup ?? null, qtyPerPcs: line.qtyPerPcs })),
      session.staffUser.id,
    );
    return undefined;
  });
}
