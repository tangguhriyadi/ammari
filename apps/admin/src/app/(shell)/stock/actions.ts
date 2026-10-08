"use server";

import { z } from "zod";
import { STOCK_ADJUSTMENT_REASONS } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as stockQueries from "@/lib/stock/queries";

const adjustStockSchema = z.object({
  sku: z.string().trim().min(1),
  // A single signed integer field in the UI ("+/- quantity") — zero is rejected since it would
  // create a no-op movement that still has to satisfy stock_movements_qty_check (qty <> 0).
  deltaQty: z.coerce.number().int("Jumlah harus bilangan bulat.").refine((value) => value !== 0, "Jumlah tidak boleh 0."),
  reason: z.enum(STOCK_ADJUSTMENT_REASONS),
  note: z.string().trim().optional(),
});

export async function adjustStockAction(input: z.input<typeof adjustStockSchema>): Promise<ActionResult> {
  const session = await requirePermission("stock.adjust");
  const parsed = adjustStockSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await stockQueries.adjustStock(
      { sku: parsed.data.sku, deltaQty: parsed.data.deltaQty, reason: parsed.data.reason, note: parsed.data.note || null },
      session.staffUser.id,
    );
    return undefined;
  });
}

const stockCountSchema = z.object({
  productId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        sku: z.string().trim().min(1),
        physicalQty: z.coerce.number().int("Jumlah harus bilangan bulat.").nonnegative("Jumlah tidak boleh negatif."),
      }),
    )
    // A duplicate SKU in one submission would have each line's negative-stock check run
    // against the SAME pre-submission balance (saveStockCount inserts every line's movement
    // together, only after the whole array is validated) — each line looks individually safe
    // but their COMBINED effect isn't re-validated, which could drive stock negative undetected.
    // Rejected outright rather than "last one wins": there's no sensible way to use a line that
    // counts the same SKU twice in a single physical count anyway.
    .refine(
      (lines) => new Set(lines.map((line) => line.sku)).size === lines.length,
      "Satu SKU tidak boleh muncul dua kali dalam satu hitung stok.",
    ),
});

export async function saveStockCountAction(
  input: z.input<typeof stockCountSchema>,
): Promise<ActionResult<{ changedSkus: string[] }>> {
  const session = await requirePermission("stock.adjust");
  const parsed = stockCountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(() => stockQueries.saveStockCount(parsed.data.productId, parsed.data.lines, session.staffUser.id));
}
