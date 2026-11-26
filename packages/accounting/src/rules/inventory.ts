import type { DefectDisposalType, StockAdjustmentReason } from "@ammari/db/schema";
import { jakartaDateOf } from "../dates";
import type { JournalLineDraft } from "../journal";
import { adjustmentExpenseKey } from "./raw-materials";
import { DEFECT_MOVEMENT_SOURCE_TYPE } from "./purchases";
import { mappedAccount, resolveOrIssue, systemAccount, type PostingContext, type PostingEvent, type PostingOutcome, type PostingRule } from "./types";

// Finished-goods adjustments and defect releases (docs/plans/accounting.md §4.6, Session 8).
//
//   A1 (stock_movement, id, adjustment), dated created_at (Jakarta): a finished-goods stock
//      adjustment or stock count at its value_amount. A loss: Dr 6-4101 Selisih persediaan
//      (recount/other) or 6-4102 Kerusakan & kehilangan persediaan (damaged/lost) / Cr 1-1504; a
//      gain the other way round. Operating expenses, never HPP [D-16]. Own use (prive) is a manual
//      reclass journal on top (plan §5.1), so the stock ledger stays the single truth.
//   A2 (defect_movement, id, dispose), dated occurred_at: a defect released (Hibah, Dibuang, Lelang):
//      Dr 6-4103 Barang cacat dilepas / Cr 1-1506 its value (operating expense, never HPP [D-7]);
//      auction proceeds: Dr Kas tunai (cash.method.cash, D-17) / Cr 7-1101 Hasil lelang barang cacat
//      (Pendapatan lain-lain). Its reversal (defect_movement, <reversal row id>, dispose) books the
//      reversal row's own (negated) value and proceeds, posted only while the original has an
//      active journal.

export const STOCK_MOVEMENT_SOURCE_TYPE = "stock_movement";

export interface FinishedGoodsAdjustmentSnapshot {
  id: string;
  sku: string;
  reason: StockAdjustmentReason | null;
  qty: number;
  valueAmount: number;
  createdAt: Date;
}

const REASON_LABEL: Record<StockAdjustmentReason, string> = { recount: "hitung ulang", damaged: "rusak", lost: "hilang", other: "lainnya" };

/** A signed amount as one line: positive = debit, negative = credit, zero = no line. */
function signedLine(accountCode: string, debitPositive: number, extra: Partial<JournalLineDraft> = {}): JournalLineDraft[] {
  if (debitPositive === 0) return [];
  return [{ accountCode, debit: Math.max(debitPositive, 0), credit: Math.max(-debitPositive, 0), ...extra }];
}

function ordered(description: string, lines: JournalLineDraft[]): PostingOutcome {
  const sorted = [...lines.filter((line) => line.debit > 0), ...lines.filter((line) => line.credit > 0)];
  return sorted.length === 0 ? { kind: "none" } : { kind: "journal", description, lines: sorted };
}

export function finishedGoodsAdjustmentOutcome(movement: FinishedGoodsAdjustmentSnapshot, context: PostingContext): PostingOutcome {
  // Value 0: the pre-0011 backfill, or an adjustment of an empty pool. Nothing moved in rupiah.
  if (movement.valueAmount === 0) return { kind: "none" };
  if (!movement.reason) return { kind: "issue", issueCode: "adjustment_reason_missing", details: { movementId: movement.id } };
  const reason = movement.reason;
  return resolveOrIssue(() => {
    const inventory = systemAccount(context, "inventory.finished_goods");
    const expense = systemAccount(context, adjustmentExpenseKey(reason));
    return ordered(`Penyesuaian stok barang jadi ${movement.sku} (${REASON_LABEL[reason]})`, [
      ...signedLine(inventory, movement.valueAmount, { memo: movement.sku }),
      ...signedLine(expense, -movement.valueAmount, { memo: movement.sku }),
    ]);
  });
}

export const finishedGoodsAdjustmentRule: PostingRule<FinishedGoodsAdjustmentSnapshot> = {
  name: "finished_goods_adjustment",
  ruleVersion: 1,
  events(movement, context) {
    const sourceDate = jakartaDateOf(movement.createdAt);
    const outcome: PostingOutcome = sourceDate < context.postingStartDate ? { kind: "none" } : finishedGoodsAdjustmentOutcome(movement, context);
    return [{ key: { sourceType: STOCK_MOVEMENT_SOURCE_TYPE, sourceId: movement.id, sourceEvent: "adjustment" }, sourceDate, outcome }];
  },
};

export interface DefectDisposalSnapshot {
  id: string;
  type: "dispose" | "reversal";
  /** For a reversal: the dispose row it negates. */
  reversesMovementId: string | null;
  disposalType: DefectDisposalType;
  occurredAt: string;
  /** Signed: negative for a release (value left the defect pool), positive for its reversal. */
  valueAmount: number;
  /** Signed: >= 0 for a release, its negation for the reversal. */
  proceedsAmount: number;
  itemName: string;
}

const DISPOSAL_LABEL: Record<DefectDisposalType, string> = { auction: "lelang", donation: "hibah", discarded: "dibuang" };

export function defectDisposalOutcome(movement: DefectDisposalSnapshot, context: PostingContext): PostingOutcome {
  return resolveOrIssue(() => {
    const defect = systemAccount(context, "inventory.defect");
    const expense = systemAccount(context, "expense.defect_release");
    const lines: JournalLineDraft[] = [...signedLine(expense, -movement.valueAmount, { memo: movement.itemName }), ...signedLine(defect, movement.valueAmount, { memo: movement.itemName })];
    if (movement.proceedsAmount !== 0) {
      const cash = mappedAccount(context, "cash.method.cash", "unmapped_payment_method", { method: "cash" });
      const income = systemAccount(context, "other_income.defect_auction");
      lines.push(...signedLine(cash, movement.proceedsAmount, { memo: movement.itemName, cashAccountCode: cash }), ...signedLine(income, -movement.proceedsAmount, { memo: movement.itemName }));
    }
    const verb = movement.type === "dispose" ? "Pelepasan" : "Pembatalan pelepasan";
    return ordered(`${verb} barang cacat (${DISPOSAL_LABEL[movement.disposalType]}): ${movement.itemName}`, lines);
  });
}

export const defectDisposalRule: PostingRule<DefectDisposalSnapshot> = {
  name: "defect_disposal",
  ruleVersion: 1,
  events(movement, context): PostingEvent[] {
    const key = (id: string) => ({ sourceType: DEFECT_MOVEMENT_SOURCE_TYPE, sourceId: id, sourceEvent: "dispose" });
    if (movement.type === "dispose") {
      const outcome: PostingOutcome = movement.occurredAt < context.postingStartDate ? { kind: "none" } : defectDisposalOutcome(movement, context);
      return [{ key: key(movement.id), sourceDate: movement.occurredAt, outcome }];
    }
    if (!movement.reversesMovementId) return [];
    return [{ key: key(movement.id), sourceDate: movement.occurredAt, outcome: defectDisposalOutcome(movement, context), requiresActiveJournalFor: key(movement.reversesMovementId) }];
  },
};
