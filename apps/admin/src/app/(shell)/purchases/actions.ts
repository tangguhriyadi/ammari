"use server";

import { z } from "zod";
import { requirePermission } from "@/lib/auth/require-permission";
import { moneyString } from "@/lib/products/money-schema";
import { decimalQuantityString } from "@/lib/production/decimal-quantity";
import { runAction, type ActionResult } from "@/lib/action-result";
import { recordFabricPurchase, voidFabricPurchase } from "@/lib/inventory/fabric-stock";
import { recordAccessoryPurchase, voidAccessoryPurchase } from "@/lib/inventory/accessories";

const purchaseBaseSchema = {
  totalAmountPaid: moneyString,
  purchasedAt: z.string().date("Tanggal tidak valid."),
  supplier: z.string().trim().optional(),
  note: z.string().trim().optional(),
};

const recordPurchaseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fabric"), itemId: z.string().uuid(), qty: decimalQuantityString, ...purchaseBaseSchema }),
  z.object({
    type: z.literal("accessory"),
    itemId: z.string().uuid(),
    qty: z.coerce.number().int("Jumlah harus bilangan bulat.").positive("Jumlah harus lebih dari 0."),
    ...purchaseBaseSchema,
  }),
]);

/** Dispatches to the existing, unchanged fabric/accessory purchase lib functions — this feature
 * adds no new ledger logic of its own, only a combined entry point and list/detail view over
 * both tables (see lib/inventory/purchases.ts's own doc comments). */
export async function recordPurchaseAction(
  input: z.input<typeof recordPurchaseSchema>,
): Promise<ActionResult<{ id: string; type: "fabric" | "accessory" }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = recordPurchaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const common = {
      totalAmountPaid: parsed.data.totalAmountPaid,
      purchasedAt: parsed.data.purchasedAt,
      supplier: parsed.data.supplier || null,
      note: parsed.data.note || null,
    };
    if (parsed.data.type === "fabric") {
      const movement = await recordFabricPurchase({ fabricId: parsed.data.itemId, qty: parsed.data.qty, ...common }, session.staffUser.id);
      return { id: movement.id, type: "fabric" as const };
    }
    const movement = await recordAccessoryPurchase({ accessoryId: parsed.data.itemId, qty: parsed.data.qty, ...common }, session.staffUser.id);
    return { id: movement.id, type: "accessory" as const };
  });
}

const voidPurchaseSchema = z.object({
  type: z.enum(["fabric", "accessory"]),
  movementId: z.string().uuid(),
});

/** Voiding lives ONLY here (the /purchases/[id] detail page) — the raw-material stock ledgers
 * under /stock no longer carry their own void button, they link here instead. The underlying
 * lib functions already re-check `type = 'purchase'` themselves (see voidFabricPurchase/
 * voidAccessoryPurchase's own "Hanya transaksi pembelian yang bisa dibatalkan." guard) before
 * this dispatcher ever runs, so a non-purchase movement id is rejected regardless of how it got
 * here. */
export async function voidPurchaseAction(input: z.input<typeof voidPurchaseSchema>): Promise<ActionResult> {
  const session = await requirePermission("inventory.manage");
  const parsed = voidPurchaseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    if (parsed.data.type === "fabric") {
      await voidFabricPurchase(parsed.data.movementId, session.staffUser.id);
    } else {
      await voidAccessoryPurchase(parsed.data.movementId, session.staffUser.id);
    }
    return undefined;
  });
}
