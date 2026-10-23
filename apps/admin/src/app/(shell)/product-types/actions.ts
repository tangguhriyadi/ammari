"use server";

import { z } from "zod";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as productTypeQueries from "@/lib/product-types/queries";
import { isProductTypeCode } from "@/lib/product-types/codes";
import { revalidateAdmin } from "@/lib/admin-revalidate";

// The type name shows on the product list/form; nothing on the storefront reads it yet.
const PRODUCT_TYPE_SECTIONS = ["/product-types", "/products"] as const;

// Same permission as managing products (owner decision) — no new key.
const PERMISSION = "products.manage";

const productTypeCodeSchema = z
  .string({ error: "Kode wajib diisi." })
  .trim()
  .toUpperCase()
  .min(1, "Kode wajib diisi.")
  .max(30, "Kode maksimal 30 karakter.")
  .refine(isProductTypeCode, "Kode hanya boleh huruf besar, angka, dan garis bawah, diawali huruf (mis. DRESS).");

const productTypeFieldsSchema = z.object({
  name: z.string({ error: "Nama jenis produk wajib diisi." }).trim().min(1, "Nama jenis produk wajib diisi.").max(100, "Nama jenis produk terlalu panjang."),
  sortOrder: z.coerce
    .number({ error: "Urutan harus bilangan bulat." })
    .int("Urutan harus bilangan bulat.")
    .min(0, "Urutan tidak boleh negatif.")
    .max(9999, "Urutan maksimal 9999.")
    .default(0),
  isActive: z.boolean().default(true),
});

const createProductTypeSchema = productTypeFieldsSchema.extend({ code: productTypeCodeSchema });

function validationError(error: z.ZodError): ActionResult<never> {
  const issue = error.issues[0];
  const message = issue?.message ?? "Input tidak valid.";
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  return { ok: false, error: message, fieldErrors: field ? { [field]: message } : undefined };
}

export async function createProductTypeAction(
  input: z.input<typeof createProductTypeSchema>,
): Promise<ActionResult<{ code: string }>> {
  const session = await requirePermission(PERMISSION);
  const parsed = createProductTypeSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const created = await productTypeQueries.createProductType(parsed.data, session.staffUser.id);
    revalidateAdmin(...PRODUCT_TYPE_SECTIONS);
    return { code: created.code };
  });
}

/** The code is not part of the input: it's immutable (migration 0037's trigger). */
export async function updateProductTypeAction(
  code: string,
  input: z.input<typeof productTypeFieldsSchema>,
): Promise<ActionResult<{ code: string }>> {
  const session = await requirePermission(PERMISSION);
  if (!isProductTypeCode(code)) return { ok: false, error: "Jenis produk tidak ditemukan." };
  const parsed = productTypeFieldsSchema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error);
  return runAction(async () => {
    const updated = await productTypeQueries.updateProductType(code, parsed.data, session.staffUser.id);
    revalidateAdmin(...PRODUCT_TYPE_SECTIONS);
    return { code: updated.code };
  });
}

const setActiveSchema = z.object({ code: z.string().refine(isProductTypeCode, "Jenis produk tidak ditemukan."), isActive: z.boolean() });

export async function setProductTypeActiveAction(input: z.input<typeof setActiveSchema>): Promise<ActionResult> {
  const session = await requirePermission(PERMISSION);
  const parsed = setActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await productTypeQueries.setProductTypeActive(parsed.data.code, parsed.data.isActive, session.staffUser.id);
    revalidateAdmin(...PRODUCT_TYPE_SECTIONS);
    return undefined;
  });
}
