"use server";

import { z } from "zod";
import { DEFECT_DISPOSAL_TYPES } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { disposeDefects, returnDefectsToSupplier, reverseDefectMovement, validateDisposal } from "@/lib/defects/dispositions";
import type { DefectSourceLine } from "@/lib/defects/queries";
import { parseDecimalQuantity } from "@/lib/production/decimal-quantity";
import { parseRupiah } from "@/lib/products/money";
import { MAX_QTY } from "@/lib/purchases/queries";

// Defect dispositions (docs/plans/suppliers-goods-receipt.md S6): return to supplier/tailor,
// release (Lelang / Hibah / Dibuang/Dimusnahkan) and their reversals. Shared by purchase documents
// and production batches. Every one needs inventory.manage (D10: they destroy or convert value),
// checked here on the server; the lib re-validates everything inside its transaction.

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Input tidak valid.";
}

const sourceSchema = {
  sourceType: z.enum(["purchase", "production_batch"]),
  lineId: z.string().uuid("Barang tidak ditemukan."),
};

function toSource(sourceType: "purchase" | "production_batch", lineId: string): DefectSourceLine {
  return sourceType === "purchase" ? { purchaseItemId: lineId } : { productionBatchItemId: lineId };
}

const qtySchema = z.string().transform((value, ctx) => {
  const parsed = parseDecimalQuantity(value);
  if (parsed === null || parsed > MAX_QTY) {
    ctx.addIssue({ code: "custom", message: "Jumlah tidak valid." });
    return z.NEVER;
  }
  return parsed;
});

const occurredAtSchema = z.string().date("Tanggal tidak valid.");

const returnSchema = z.object({
  ...sourceSchema,
  qty: qtySchema,
  reason: z.string().trim().min(1, "Alasan wajib diisi.").max(1000, "Alasan terlalu panjang."),
  occurredAt: occurredAtSchema,
});

export async function returnDefectsAction(input: z.input<typeof returnSchema>): Promise<ActionResult<{ reopened: boolean }>> {
  const session = await requirePermission("inventory.manage");
  const parsed = returnSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    const { reopened } = await returnDefectsToSupplier(
      { source: toSource(parsed.data.sourceType, parsed.data.lineId), qty: parsed.data.qty, reason: parsed.data.reason, occurredAt: parsed.data.occurredAt },
      session.staffUser.id,
    );
    return { reopened };
  });
}

const disposeSchema = z
  .object({
    ...sourceSchema,
    qty: qtySchema,
    disposalType: z.enum(DEFECT_DISPOSAL_TYPES, { message: "Pilih jenis pelepasan." }),
    /** "Hasil lelang" in rupiah; blank for Hibah and Dibuang/Dimusnahkan. */
    proceeds: z.string().transform((value, ctx) => {
      if (value.trim() === "") return 0;
      const parsed = parseRupiah(value);
      if (parsed === null || !Number.isSafeInteger(parsed)) {
        ctx.addIssue({ code: "custom", message: "Hasil lelang tidak valid." });
        return z.NEVER;
      }
      return parsed;
    }),
    note: z.string().trim().min(1, "Catatan wajib diisi.").max(1000, "Catatan terlalu panjang."),
    occurredAt: occurredAtSchema,
  })
  .superRefine((value, ctx) => {
    const invalid = validateDisposal(value.disposalType, value.proceeds);
    if (invalid) ctx.addIssue({ code: "custom", message: invalid, path: ["proceeds"] });
  });

export async function disposeDefectsAction(input: z.input<typeof disposeSchema>): Promise<ActionResult> {
  const session = await requirePermission("inventory.manage");
  const parsed = disposeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    await disposeDefects(
      {
        source: toSource(parsed.data.sourceType, parsed.data.lineId),
        qty: parsed.data.qty,
        disposalType: parsed.data.disposalType,
        proceedsAmount: parsed.data.proceeds,
        note: parsed.data.note,
        occurredAt: parsed.data.occurredAt,
      },
      session.staffUser.id,
    );
    return undefined;
  });
}

const reverseSchema = z.object({ movementId: z.string().uuid("Catatan barang cacat tidak ditemukan.") });

export async function reverseDefectMovementAction(input: z.input<typeof reverseSchema>): Promise<ActionResult> {
  const session = await requirePermission("inventory.manage");
  const parsed = reverseSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  return runAction(async () => {
    await reverseDefectMovement(parsed.data.movementId, session.staffUser.id);
    return undefined;
  });
}
