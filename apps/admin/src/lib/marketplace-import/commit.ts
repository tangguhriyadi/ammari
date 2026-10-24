import "server-only";
import { commitMarketplaceImport, type MarketplaceCommitPlan } from "@ammari/commerce/marketplace-import";
import { defaultDb, type Database } from "@/lib/db";
import type { ParsedImport } from "./parse-file";
import { planImport, type ImportPlan, type PlanOptions } from "./plan";

// Simpan (docs/plans/marketplace-import.md §1, §6, session 4). The browser sends the same file, the
// same manual SKU matches and the digest of the preview the owner saw. Inside the commit
// transaction, after the channel's advisory lock (@ammari/commerce/marketplace-import), the file is
// planned AGAIN with the transaction's own reads, and only written when:
//   - the parse and the fresh plan have no save blockers (the Shopee mapping lock, rows that belong to
//     no order): the digest does not cover them, so they are enforced here on their own;
//   - the fresh digest equals the one the owner saw (otherwise: the fresh preview, nothing written);
//   - something is left to write.
// Each existing order is then re-checked under its own row lock by the commerce module.

export const STALE_PREVIEW_MESSAGE = "Data berubah sejak pemeriksaan. Periksa lagi sebelum menyimpan.";
export const NOTHING_TO_SAVE_MESSAGE = "Tidak ada pesanan baru atau yang berubah untuk disimpan.";
export const BUSY_MESSAGE = "Sebagian data sedang dipakai proses lain, jadi belum ada yang disimpan. Coba simpan lagi sebentar lagi.";

export type CommitOutcome =
  | { kind: "committed"; batchId: string; created: number; updated: number; reviewCount: number; stockSkus: string[] }
  /** The preview is out of date (digest differs, or a row drifted under its lock): show `plan`. */
  | { kind: "stale"; plan: ImportPlan }
  | { kind: "blocked"; plan: ImportPlan; blockers: string[] }
  | { kind: "nothing_to_save"; plan: ImportPlan }
  | { kind: "invalid"; message: string }
  /** A row lock timed out or deadlocked; nothing was written. */
  | { kind: "busy" };

export interface CommitImportInput {
  parsed: ParsedImport;
  fileName: string;
  options: PlanOptions;
  /** The digest of the preview the owner confirmed. */
  expectedDigest: string;
  actorStaffUserId: string;
}

/** The plan's writes in the commerce module's shape (no display fields). */
export function toCommitPlan(plan: ImportPlan): MarketplaceCommitPlan {
  const creates: MarketplaceCommitPlan["creates"] = [];
  const updates: MarketplaceCommitPlan["updates"] = [];
  for (const entry of plan.entries) {
    if (entry.action === "create") {
      creates.push({
        channelOrderNo: entry.channelOrderNo,
        rawStatus: entry.rawStatus,
        orderedAt: entry.orderedAt,
        lines: entry.lines.map((line) => ({ sku: line.sku, qty: line.qty, unitPrice: line.unitPrice })),
        subtotalAmount: entry.subtotalAmount,
        discountAmount: entry.discountAmount,
        totalAmount: entry.totalAmount,
        fees: entry.fees,
        transitions: entry.transitions,
        setReturnPending: entry.setReturnPending,
        skuMatches: entry.skuMatches,
      });
    } else if (entry.action === "update") {
      updates.push({
        orderId: entry.existing.orderId,
        channelOrderNo: entry.channelOrderNo,
        rawStatus: entry.rawStatus,
        expected: entry.expected,
        transitions: entry.transitions,
        setReturnPending: entry.setReturnPending,
        clearReturnPending: entry.clearReturnPending,
        discount: entry.discount,
        totalAmount: entry.totalAmount,
        fees: entry.fees,
        channelStatus: entry.channelStatus,
        skuMatches: entry.skuMatches,
      });
    }
  }
  return {
    creates,
    updates,
    skuMatches: plan.skuMatches,
    // The history view strips `totals` (money) for staff without finance.view_profit (history.ts).
    summary: { version: 1, counts: plan.counts, totals: plan.totals, skuMatches: plan.skuMatches, digest: plan.digest },
  };
}

async function planOrMessage(parsed: ParsedImport, options: PlanOptions, db: Database): Promise<{ ok: true; plan: ImportPlan } | { ok: false; message: string }> {
  const result = await planImport(parsed, options, db);
  return result.ok ? { ok: true, plan: result.value } : { ok: false, message: result.error.message };
}

export async function commitImport(input: CommitImportInput, db: Database = defaultDb): Promise<CommitOutcome> {
  const { parsed } = input;
  // Refused before the transaction too: nothing to lock for a file that may not be saved at all.
  if (parsed.saveBlockers.length > 0) {
    const planned = await planOrMessage(parsed, input.options, db);
    return planned.ok ? { kind: "blocked", plan: planned.plan, blockers: parsed.saveBlockers } : { kind: "invalid", message: planned.message };
  }

  // The in-transaction plan that was written (for the success notice's "N perlu dicek").
  const written: { plan: ImportPlan | null } = { plan: null };
  const result = await commitMarketplaceImport<CommitOutcome>(
    {
      channelId: parsed.channelId,
      actorStaffUserId: input.actorStaffUserId,
      batch: { filename: input.fileName, fileSha256: parsed.fileSha256, rowCount: parsed.dataRowCount },
      replan: async (tx) => {
        const planned = await planOrMessage(parsed, input.options, tx);
        if (!planned.ok) return { proceed: false, result: { kind: "invalid", message: planned.message } };
        const { plan } = planned;
        if (plan.saveBlockers.length > 0) return { proceed: false, result: { kind: "blocked", plan, blockers: plan.saveBlockers } };
        if (plan.digest !== input.expectedDigest) return { proceed: false, result: { kind: "stale", plan } };
        if (plan.counts.create + plan.counts.update === 0) return { proceed: false, result: { kind: "nothing_to_save", plan } };
        written.plan = plan;
        return { proceed: true, plan: toCommitPlan(plan) };
      },
    },
    db,
  );

  if (result.status === "aborted") return result.result;
  if (result.status === "busy") return { kind: "busy" };
  if (result.status === "drift") {
    // Rolled back; the owner sees what is true now. The reason is ours (order numbers, SKUs,
    // statuses), never cell contents.
    console.warn("[marketplace-import] commit drifted, re-planning", { channelId: parsed.channelId, reason: result.reason });
    const planned = await planOrMessage(parsed, input.options, db);
    return planned.ok ? { kind: "stale", plan: planned.plan } : { kind: "invalid", message: planned.message };
  }
  if (!written.plan) throw new Error("commitImport: committed without a plan");
  return {
    kind: "committed",
    batchId: result.value.batchId,
    created: result.value.createdOrderIds.length,
    updated: result.value.updatedOrderIds.length,
    reviewCount: written.plan.counts.review,
    stockSkus: result.value.stockSkus,
  };
}
