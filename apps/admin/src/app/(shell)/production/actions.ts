"use server";

import { z } from "zod";
import { requirePermission } from "@/lib/auth/require-permission";
import { requireAllPermissions } from "@/lib/auth/require-all-permissions";
import { parseRupiah } from "@/lib/products/money";
import { optionalDecimalQuantityString } from "@/lib/production/decimal-quantity";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as productionQueries from "@/lib/production/queries";
import { getFabricBalance } from "@/lib/inventory/fabric-stock";
import { saveAccessoryOverride } from "@/lib/production/accessory-needs";

const lineSchema = z.object({
  sku: z.string().trim().min(1),
  qty: z.coerce.number().int("Jumlah harus bilangan bulat.").positive("Jumlah harus lebih dari 0."),
});

// A blank price is valid HERE (resolves to 0) — a freshly-added extra-cost line with no default
// price yet should save as 0, not block the whole draft; posting itself doesn't require any
// particular cost line to be non-zero.
const draftCostAmount = z.string().transform((value, ctx) => {
  if (value.trim() === "") return 0;
  const parsed = parseRupiah(value);
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: "Format harga tidak valid." });
    return z.NEVER;
  }
  return parsed;
});

// No `quantity` field — never submitted by the client for either cost_type. See
// lib/production/queries.ts's ExtraCostLineInput/syncExtraCostLines doc comments: a 'variable'
// line's quantity is always the batch's current total pcs, computed server-side; a 'fixed'
// line's is always exactly 1. The form only ever collects a price (labeled "Harga per pcs" or
// "Nominal" depending on the line's cost_type).
const extraCostLineSchema = z.object({
  id: z.string().uuid().optional(),
  costComponentId: z.string().uuid("Pilih komponen biaya."),
  unitPrice: draftCostAmount,
});

const draftFieldsSchema = z.object({
  producedAt: z.string().date("Tanggal tidak valid."),
  fabricYards: optionalDecimalQuantityString,
  notes: z.string().trim().optional(),
  // A duplicate SKU here would hit production_batch_items_batch_sku_key (23505) at insert time
  // regardless — correctness isn't at risk — but rejecting it here gives a friendly, field-
  // scoped message instead of a raw constraint error reaching the UI.
  lines: z
    .array(lineSchema)
    .refine(
      (lines) => new Set(lines.map((line) => line.sku)).size === lines.length,
      "Satu SKU tidak boleh muncul dua kali dalam satu batch.",
    ),
  // Omitted entirely by a form rendered for a session without finance.view_profit — see
  // lib/production/queries.ts's CreateDraftInput/UpdateDraftInput doc comments. There is no
  // `costs`/fabric-cost field at all anymore — fabric cost is computed only at posting (see
  // postBatch); the draft form shows a read-only, non-binding estimate instead (see
  // fabric-cost-estimate.ts).
  extraCosts: z.array(extraCostLineSchema).optional(),
});

const createDraftSchema = draftFieldsSchema.extend({
  fabricId: z.string().uuid("Pilih bahan."),
});

export async function createDraftAction(
  input: z.input<typeof createDraftSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("production.manage");
  const parsed = createDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  // A session without finance.view_profit must never have its submitted extra costs (there
  // shouldn't be any — the form doesn't render those fields) applied; stripped server-side too,
  // in case a direct action call ever tries to sneak them in. `undefined`, not `?? []` — see
  // CreateDraftInput/UpdateDraftInput's own doc comments in queries.ts: coercing an omitted
  // field to `[]` would make syncExtraCostLines treat "field omitted" as "the full set is now
  // empty", silently deleting every existing extra-cost line on an update.
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  const extraCosts = canViewProfit ? parsed.data.extraCosts : undefined;
  return runAction(async () => {
    const batch = await productionQueries.createDraft(
      {
        fabricId: parsed.data.fabricId,
        producedAt: parsed.data.producedAt,
        fabricYards: parsed.data.fabricYards,
        notes: parsed.data.notes || null,
        lines: parsed.data.lines,
        extraCosts,
      },
      session.staffUser.id,
    );
    return { id: batch.id };
  });
}

export async function updateDraftAction(
  id: string,
  input: z.input<typeof draftFieldsSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePermission("production.manage");
  const parsed = draftFieldsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  const canViewProfit = session.permissionKeys.includes("finance.view_profit");
  // See the identical comment in createDraftAction above.
  const extraCosts = canViewProfit ? parsed.data.extraCosts : undefined;
  return runAction(async () => {
    const batch = await productionQueries.updateDraft(
      id,
      {
        producedAt: parsed.data.producedAt,
        fabricYards: parsed.data.fabricYards,
        notes: parsed.data.notes || null,
        lines: parsed.data.lines,
        extraCosts,
      },
      session.staffUser.id,
    );
    return { id: batch.id };
  });
}

const idSchema = z.object({ id: z.string().uuid() });

export async function deleteDraftAction(input: z.input<typeof idSchema>): Promise<ActionResult> {
  const session = await requirePermission("production.manage");
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await productionQueries.deleteDraft(parsed.data.id, session.staffUser.id);
    return undefined;
  });
}

/** Posting needs BOTH production.manage AND finance.view_profit (docs/SPEC.md-adjacent plan
 * decision) — a production.manage-only user can create/edit drafts but never posts one. */
export async function postBatchAction(
  input: z.input<typeof idSchema>,
): Promise<ActionResult<{ id: string; unitCostAmount: number; totalPcs: number }>> {
  const session = await requireAllPermissions(["production.manage", "finance.view_profit"]);
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(() => productionQueries.postBatch(parsed.data.id, session.staffUser.id));
}

export async function suggestEligibleSkusAction(fabricId: string) {
  await requirePermission("production.manage");
  return productionQueries.listEligibleSkusForFabric(fabricId);
}

/** Cost data (a moving-average cost is derived from it) — gated behind finance.view_profit, not
 * just production.manage, same discipline every other cost figure in this feature follows. Feeds
 * the draft form's read-only fabric-cost ESTIMATE only (see fabric-cost-estimate.ts) — never
 * authoritative; postBatch computes the real value at posting from whatever the balance is AT
 * THAT MOMENT. */
export async function getFabricBalanceAction(fabricId: string) {
  await requirePermission("finance.view_profit");
  return getFabricBalance(fabricId);
}

const setAccessoryOverrideSchema = z.object({
  batchId: z.string().uuid(),
  accessoryId: z.string().uuid(),
  // Quantities, not cost — production.manage alone is enough (no finance.view_profit needed),
  // same reasoning getAccessoryNeedsForBatch itself is safe for any production.manage session.
  overrideQty: z.number().int().min(0).nullable(),
});

export async function setAccessoryOverrideAction(input: z.input<typeof setAccessoryOverrideSchema>): Promise<ActionResult> {
  const session = await requirePermission("production.manage");
  const parsed = setAccessoryOverrideSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await saveAccessoryOverride(parsed.data.batchId, parsed.data.accessoryId, parsed.data.overrideQty, session.staffUser.id);
    return undefined;
  });
}
