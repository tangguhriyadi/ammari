"use server";

import { z } from "zod";
import { SIZES, STOCK_ADJUSTMENT_REASONS } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as accessoryQueries from "@/lib/inventory/accessories";

const accessorySchema = z.object({
  name: z.string().trim().min(1, "Nama aksesoris wajib diisi."),
  size: z.enum(SIZES).optional(),
  sizeGroup: z.string().trim().optional(),
  isActive: z.boolean().default(true),
  notes: z.string().trim().optional(),
});

function toAccessoryInput(parsed: z.infer<typeof accessorySchema>) {
  return {
    name: parsed.name,
    size: parsed.size ?? null,
    sizeGroup: parsed.sizeGroup || null,
    isActive: parsed.isActive,
    notes: parsed.notes || null,
  };
}

export async function createAccessoryAction(
  input: z.input<typeof accessorySchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = accessorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const accessory = await accessoryQueries.createAccessory(toAccessoryInput(parsed.data), session.staffUser.id);
    return { id: accessory.id };
  });
}

export async function updateAccessoryAction(
  id: string,
  input: z.input<typeof accessorySchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = accessorySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const accessory = await accessoryQueries.updateAccessory(id, toAccessoryInput(parsed.data), session.staffUser.id);
    return { id: accessory.id };
  });
}

const setActiveSchema = z.object({ id: z.string().uuid(), isActive: z.boolean() });

export async function setAccessoryActiveAction(input: z.input<typeof setActiveSchema>): Promise<ActionResult> {
  const session = await requirePermission("inventory.manage");
  const parsed = setActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await accessoryQueries.setAccessoryActive(parsed.data.id, parsed.data.isActive, session.staffUser.id);
    return undefined;
  });
}

// ---------- Void / adjustment ----------

// No "record purchase" action here any more: since purchase documents (docs/plans/
// suppliers-goods-receipt.md S3), stock from a purchase only enters through a goods receipt
// (/purchases/[id]). The void below stays for LEGACY single-row purchases.

const voidPurchaseSchema = z.object({ movementId: z.string().uuid() });

export async function voidAccessoryPurchaseAction(input: z.input<typeof voidPurchaseSchema>): Promise<ActionResult> {
  const session = await requirePermission("inventory.manage");
  const parsed = voidPurchaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await accessoryQueries.voidAccessoryPurchase(parsed.data.movementId, session.staffUser.id);
    return undefined;
  });
}

const recordAdjustmentSchema = z.object({
  accessoryId: z.string().uuid(),
  deltaQty: z.coerce.number().int("Jumlah harus bilangan bulat.").refine((value) => value !== 0, "Jumlah tidak boleh 0."),
  reason: z.enum(STOCK_ADJUSTMENT_REASONS),
  note: z.string().trim().optional(),
});

export async function recordAccessoryAdjustmentAction(
  input: z.input<typeof recordAdjustmentSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = recordAdjustmentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const movement = await accessoryQueries.recordAccessoryAdjustment(
      { accessoryId: parsed.data.accessoryId, deltaQty: parsed.data.deltaQty, reason: parsed.data.reason, note: parsed.data.note || null },
      session.staffUser.id,
    );
    return { id: movement.id };
  });
}

export async function listDistinctSizeGroupsAction(): Promise<string[]> {
  await requirePermission("inventory.manage");
  return accessoryQueries.listDistinctSizeGroups();
}

export async function listActiveAccessoriesAction() {
  await requirePermission("inventory.view");
  return accessoryQueries.listActiveAccessories();
}
