"use server";

import { z } from "zod";
import { SUPPLIER_KINDS } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as supplierQueries from "@/lib/suppliers/queries";
import { revalidateAdmin } from "@/lib/admin-revalidate";

// Supplier names also show on purchase documents, the receipts filter, and production cost lines.
const SUPPLIER_SECTIONS = ["/suppliers", "/purchases", "/receipts", "/production"] as const;

// A FIXED set, not free text — `z.enum` rejects anything outside SUPPLIER_KINDS outright,
// never trusting the form's checkboxes alone (a Server Action is a public POST endpoint). The
// no-duplicate `.refine` and the implicit max (there are only 4 keys) are ALSO enforced at the
// DB level by suppliers_kinds_* (migration 0022) — kept here so a bad request gets a clean
// Indonesian validation error instead of a raw constraint violation. The `.transform`
// re-sorts into SUPPLIER_KINDS' own canonical order, so storage order never depends on which
// checkbox was clicked first — same shape as products' highlightsSchema.
const supplierKindsSchema = z
  .array(z.enum(SUPPLIER_KINDS))
  .refine((kinds) => new Set(kinds).size === kinds.length, "Jenis supplier tidak boleh duplikat.")
  .transform((kinds) => SUPPLIER_KINDS.filter((kind) => kinds.includes(kind)));

// Only `name` is required (docs/plans/suppliers-goods-receipt.md D13) — every other field is
// optional, and an empty string is stored as NULL rather than "" so "no phone recorded" has one
// representation, not two.
const supplierSchema = z.object({
  name: z.string().trim().min(1, "Nama supplier wajib diisi.").max(200, "Nama supplier terlalu panjang."),
  kinds: supplierKindsSchema.optional(),
  // Capped like every other free-text action input: the columns are unbounded `text`, and each
  // update also copies the row into audit_log.
  phone: z.string().trim().max(50, "Nomor telepon terlalu panjang.").optional(),
  address: z.string().trim().max(1000, "Alamat terlalu panjang.").optional(),
  bankName: z.string().trim().max(200, "Nama bank terlalu panjang.").optional(),
  bankAccountNo: z.string().trim().max(100, "Nomor rekening terlalu panjang.").optional(),
  bankAccountName: z.string().trim().max(200, "Nama pemilik rekening terlalu panjang.").optional(),
  notes: z.string().trim().max(1000, "Catatan terlalu panjang.").optional(),
  isActive: z.boolean().default(true),
});

function toSupplierInput(parsed: z.infer<typeof supplierSchema>): supplierQueries.SupplierInput {
  return {
    name: parsed.name,
    kinds: [...(parsed.kinds ?? [])],
    phone: parsed.phone || null,
    address: parsed.address || null,
    bankName: parsed.bankName || null,
    bankAccountNo: parsed.bankAccountNo || null,
    bankAccountName: parsed.bankAccountName || null,
    notes: parsed.notes || null,
    isActive: parsed.isActive,
  };
}

export async function createSupplierAction(input: z.input<typeof supplierSchema>): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = supplierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const supplier = await supplierQueries.createSupplier(toSupplierInput(parsed.data), session.staffUser.id);
    revalidateAdmin(...SUPPLIER_SECTIONS);
    return { id: supplier.id };
  });
}

export async function updateSupplierAction(
  id: string,
  input: z.input<typeof supplierSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("inventory.manage");
  if (!supplierQueries.isSupplierId(id)) return { ok: false, error: "Supplier tidak ditemukan." };
  const parsed = supplierSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const supplier = await supplierQueries.updateSupplier(id, toSupplierInput(parsed.data), session.staffUser.id);
    revalidateAdmin(...SUPPLIER_SECTIONS);
    return { id: supplier.id };
  });
}

const setActiveSchema = z.object({ id: z.string().uuid(), isActive: z.boolean() });

export async function setSupplierActiveAction(input: z.input<typeof setActiveSchema>): Promise<ActionResult> {
  const session = await requirePermission("inventory.manage");
  const parsed = setActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await supplierQueries.setSupplierActive(parsed.data.id, parsed.data.isActive, session.staffUser.id);
    revalidateAdmin(...SUPPLIER_SECTIONS);
    return undefined;
  });
}
