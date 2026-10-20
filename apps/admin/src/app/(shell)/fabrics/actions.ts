"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { FABRIC_PRICE_UNITS, STOCK_ADJUSTMENT_REASONS } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { optionalMoneyString } from "@/lib/products/money-schema";
import { runAction, type ActionResult } from "@/lib/products/action-result";
import * as fabricQueries from "@/lib/products/fabric-queries";
import * as fabricStockQueries from "@/lib/inventory/fabric-stock";
import { revalidateAdmin } from "@/lib/admin-revalidate";

// Fabrics and their colors also show on products (fabric/color pickers, list column), fabric
// stock, and production (fabric balance and SKU picker).
const FABRIC_SECTIONS = ["/fabrics", "/products", "/stock", "/production"] as const;

// ---------- Fabrics ----------

const fabricSchema = z.object({
  name: z.string().trim().min(1, "Nama bahan wajib diisi."),
  supplier: z.string().trim().optional(),
  composition: z.string().trim().optional(),
  priceAmount: optionalMoneyString.optional(),
  priceUnit: z.enum(FABRIC_PRICE_UNITS).optional(),
  careInstructions: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

// Trimmed only, never required at the schema level — a completely blank row is a valid (ignored)
// input, so "name required" is a business rule enforced in createFabricWithColors, not here.
const fabricColorRowSchema = z.object({
  name: z.string(),
  supplierColorCode: z.string().optional(),
  hex: z.string().optional(),
});

const createFabricWithColorsSchema = fabricSchema.extend({
  colors: z.array(fabricColorRowSchema).default([]),
});

function toFabricInput(parsed: z.infer<typeof fabricSchema>) {
  const hasPrice = parsed.priceAmount !== null && parsed.priceAmount !== undefined;
  return {
    name: parsed.name,
    supplier: parsed.supplier || null,
    composition: parsed.composition || null,
    priceAmount: hasPrice ? parsed.priceAmount! : null,
    priceUnit: hasPrice ? (parsed.priceUnit ?? "meter") : null,
    careInstructions: parsed.careInstructions || null,
    notes: parsed.notes || null,
  };
}

export async function createFabricAction(
  input: z.input<typeof createFabricWithColorsSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("products.manage");
  const parsed = createFabricWithColorsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const { fabric } = await fabricQueries.createFabricWithColors(
      toFabricInput(parsed.data),
      parsed.data.colors.map((color) => ({
        name: color.name,
        supplierColorCode: color.supplierColorCode || null,
        hex: color.hex || null,
      })),
      session.staffUser.id,
    );
    revalidateAdmin(...FABRIC_SECTIONS);
    return { id: fabric.id };
  });
}

export async function updateFabricAction(
  id: string,
  input: z.input<typeof fabricSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("products.manage");
  const parsed = fabricSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const fabric = await fabricQueries.updateFabric(id, toFabricInput(parsed.data), session.staffUser.id);
    revalidateAdmin(...FABRIC_SECTIONS);
    return { id: fabric.id };
  });
}

export async function deleteFabricAction(id: string): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  const result = await runAction(async () => {
    await fabricQueries.deleteFabric(id, session.staffUser.id);
    revalidateAdmin(...FABRIC_SECTIONS);
    return undefined;
  });
  // Redirect from the server, not router.push() on the client: this delete is started from the
  // deleted record's own page, and the revalidation above re-renders the CURRENT page in the action
  // response, which would now hit notFound() and flash a 404 before a client-side push landed.
  if (result.ok) redirect("/fabrics");
  return result;
}

// ---------- Fabric colors ----------

const fabricColorSchema = z.object({
  name: z.string().trim().min(1, "Nama warna wajib diisi."),
  supplierColorCode: z.string().trim().optional(),
  hex: z.string().trim().optional(),
});

export async function createFabricColorAction(
  fabricId: string,
  input: z.input<typeof fabricColorSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("products.manage");
  const parsed = fabricColorSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const color = await fabricQueries.createFabricColor(
      fabricId,
      {
        name: parsed.data.name,
        supplierColorCode: parsed.data.supplierColorCode || null,
        hex: parsed.data.hex || null,
      },
      session.staffUser.id,
    );
    revalidateAdmin(...FABRIC_SECTIONS);
    return { id: color.id };
  });
}

export async function updateFabricColorAction(
  id: string,
  input: z.input<typeof fabricColorSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("products.manage");
  const parsed = fabricColorSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const color = await fabricQueries.updateFabricColor(
      id,
      {
        name: parsed.data.name,
        supplierColorCode: parsed.data.supplierColorCode || null,
        hex: parsed.data.hex || null,
      },
      session.staffUser.id,
    );
    revalidateAdmin(...FABRIC_SECTIONS);
    return { id: color.id };
  });
}

const setFabricColorActiveSchema = z.object({
  id: z.string().uuid(),
  isActive: z.boolean(),
});

export async function setFabricColorActiveAction(input: z.input<typeof setFabricColorActiveSchema>): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  const parsed = setFabricColorActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await fabricQueries.setFabricColorActive(parsed.data.id, parsed.data.isActive, session.staffUser.id);
    revalidateAdmin(...FABRIC_SECTIONS);
    return undefined;
  });
}

export async function deleteFabricColorAction(id: string): Promise<ActionResult> {
  const session = await requirePermission("products.manage");
  return runAction(async () => {
    await fabricQueries.deleteFabricColor(id, session.staffUser.id);
    revalidateAdmin(...FABRIC_SECTIONS);
    return undefined;
  });
}

// ---------- Fabric stock: void / adjustment ----------

// No "record purchase" action here any more — see accessories/actions.ts for why.

const voidFabricPurchaseSchema = z.object({ movementId: z.string().uuid() });

export async function voidFabricPurchaseAction(input: z.input<typeof voidFabricPurchaseSchema>): Promise<ActionResult> {
  const session = await requirePermission("inventory.manage");
  const parsed = voidFabricPurchaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await fabricStockQueries.voidFabricPurchase(parsed.data.movementId, session.staffUser.id);
    revalidateAdmin(...FABRIC_SECTIONS, "/purchases");
    return undefined;
  });
}

const recordFabricAdjustmentSchema = z.object({
  fabricId: z.string().uuid(),
  // NOT decimalQuantityString — that parser is unsigned-only (built for a quantity that's
  // always positive, like fabric_yards on a batch), but an adjustment's delta must allow a
  // negative value (damaged/lost yards). Same coerce-number shape stock/actions.ts's own
  // adjustStockSchema uses for its (integer) deltaQty, extended with a 2-decimal-place check.
  deltaQty: z.coerce
    .number()
    .refine((value) => Number.isFinite(value) && value !== 0, "Jumlah tidak boleh 0.")
    .refine((value) => Number(value.toFixed(2)) === value, "Maksimal 2 desimal."),
  reason: z.enum(STOCK_ADJUSTMENT_REASONS),
  note: z.string().trim().optional(),
});

export async function recordFabricAdjustmentAction(
  input: z.input<typeof recordFabricAdjustmentSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = recordFabricAdjustmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const movement = await fabricStockQueries.recordFabricAdjustment(
      { fabricId: parsed.data.fabricId, deltaQty: parsed.data.deltaQty, reason: parsed.data.reason, note: parsed.data.note || null },
      session.staffUser.id,
    );
    revalidateAdmin(...FABRIC_SECTIONS);
    return { id: movement.id };
  });
}
