import type { StockAdjustmentReason } from "@ammari/db/schema";
import { jakartaDateOf } from "../dates";
import type { JournalLineDraft } from "../journal";
import { resolveOrIssue, systemAccount, type PostingContext, type PostingEvent, type PostingOutcome, type PostingRule } from "./types";

// Raw-material adjustments (docs/plans/accounting.md §4.4 P7, Session 7), dated created_at (Jakarta):
//   (fabric_stock_movement | accessory_movement, id, adjustment):
//     a loss (value < 0): Dr 6-4101 Selisih persediaan (recount/other) or 6-4102 Kerusakan &
//        kehilangan persediaan (damaged/lost) / Cr 1-1501 kain or 1-1502 aksesoris;
//     a gain (value > 0): the same accounts, the other way round.
//   Operating expenses, never HPP [D-16]. A fabric colour reclassification (one fabric, two
//   adjustment rows written together that net to zero, lib/inventory/fabric-stock.ts
//   reclassifyFabricStock) stays inside 1-1501: no journal.
//
//   Legacy single-row purchases (type 'purchase', ref_type 'manual') predate goods receipts and the
//   cut-over; one dated on or after the posting start is never guessed into a journal: it is the
//   posting issue `legacy_raw_purchase` (raw materials enter the books only through goods receipts,
//   D-14). Their voids post nothing (the original never has a journal, plan §2).
//   Consumption by production (type 'production') is R1, Session 8.

export const FABRIC_MOVEMENT_SOURCE_TYPE = "fabric_stock_movement";
export const ACCESSORY_MOVEMENT_SOURCE_TYPE = "accessory_movement";

export type RawMaterialKind = "fabric" | "accessory";

export interface RawMaterialMovementSnapshot {
  id: string;
  material: RawMaterialKind;
  itemName: string;
  kind: "adjustment" | "legacy_purchase";
  reason: StockAdjustmentReason | null;
  qty: number;
  valueAmount: number;
  createdAt: Date;
  /** One leg of a colour reclassification pair (nets to zero inside the fabric account). */
  isReclassification: boolean;
  /** A legacy purchase voided since (its void is the owner's fix: no issue any more). */
  voided: boolean;
}

const INVENTORY_KEY: Record<RawMaterialKind, string> = { fabric: "inventory.fabric", accessory: "inventory.accessory" };

/** recount/other → Selisih persediaan; damaged/lost → Kerusakan & kehilangan persediaan [D-16]. */
export function adjustmentExpenseKey(reason: StockAdjustmentReason): string {
  return reason === "damaged" || reason === "lost" ? "expense.inventory_loss" : "expense.inventory_variance";
}

const REASON_LABEL: Record<StockAdjustmentReason, string> = { recount: "hitung ulang", damaged: "rusak", lost: "hilang", other: "lainnya" };
const MATERIAL_LABEL: Record<RawMaterialKind, string> = { fabric: "kain", accessory: "aksesoris" };

export function rawMaterialAdjustmentOutcome(movement: RawMaterialMovementSnapshot, context: PostingContext): PostingOutcome {
  if (movement.valueAmount === 0 || movement.isReclassification) return { kind: "none" };
  if (!movement.reason) return { kind: "issue", issueCode: "adjustment_reason_missing", details: { movementId: movement.id } };
  const reason = movement.reason;
  return resolveOrIssue(() => {
    const inventory = systemAccount(context, INVENTORY_KEY[movement.material]);
    const expense = systemAccount(context, adjustmentExpenseKey(reason));
    const amount = Math.abs(movement.valueAmount);
    const memo = movement.itemName;
    const lines: JournalLineDraft[] =
      movement.valueAmount < 0
        ? [
            { accountCode: expense, debit: amount, credit: 0, memo },
            { accountCode: inventory, debit: 0, credit: amount, memo },
          ]
        : [
            { accountCode: inventory, debit: amount, credit: 0, memo },
            { accountCode: expense, debit: 0, credit: amount, memo },
          ];
    return { kind: "journal", description: `Penyesuaian stok ${MATERIAL_LABEL[movement.material]} ${movement.itemName} (${REASON_LABEL[reason]})`, lines };
  });
}

export const rawMaterialAdjustmentRule: PostingRule<RawMaterialMovementSnapshot> = {
  name: "raw_material_adjustment",
  ruleVersion: 1,
  events(movement, context) {
    const sourceType = movement.material === "fabric" ? FABRIC_MOVEMENT_SOURCE_TYPE : ACCESSORY_MOVEMENT_SOURCE_TYPE;
    const sourceDate = jakartaDateOf(movement.createdAt);
    if (sourceDate < context.postingStartDate) {
      return [{ key: { sourceType, sourceId: movement.id, sourceEvent: movement.kind === "adjustment" ? "adjustment" : "legacy_purchase" }, sourceDate, outcome: { kind: "none" } }];
    }
    if (movement.kind === "legacy_purchase") {
      if (movement.voided) return [{ key: { sourceType, sourceId: movement.id, sourceEvent: "legacy_purchase" }, sourceDate, outcome: { kind: "none" } }];
      return [
        {
          key: { sourceType, sourceId: movement.id, sourceEvent: "legacy_purchase" },
          sourceDate,
          outcome: { kind: "issue", issueCode: "legacy_raw_purchase", details: { material: movement.material, itemName: movement.itemName, valueAmount: movement.valueAmount } },
        },
      ];
    }
    const event: PostingEvent = { key: { sourceType, sourceId: movement.id, sourceEvent: "adjustment" }, sourceDate, outcome: rawMaterialAdjustmentOutcome(movement, context) };
    return [event];
  },
};

/** Marks the legs of fabric colour reclassifications: adjustment rows of one fabric written in the
 * same transaction (same created_at), at least two, netting to zero in both qty and value. A
 * single adjustment never qualifies (recordFabricAdjustment writes one row per call). */
export function markReclassifications<T extends { material: RawMaterialKind; kind: string; createdAt: Date; qty: number; valueAmount: number; groupKey: string }>(
  movements: T[],
): (T & { isReclassification: boolean })[] {
  const groups = new Map<string, T[]>();
  for (const movement of movements) {
    if (movement.material !== "fabric" || movement.kind !== "adjustment") continue;
    const key = `${movement.groupKey}|${movement.createdAt.getTime()}`;
    groups.set(key, [...(groups.get(key) ?? []), movement]);
  }
  const reclassified = new Set<T>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const qtyCenti = group.reduce((sum, movement) => sum + Math.round(movement.qty * 100), 0);
    const value = group.reduce((sum, movement) => sum + movement.valueAmount, 0);
    if (qtyCenti === 0 && value === 0) for (const movement of group) reclassified.add(movement);
  }
  return movements.map((movement) => ({ ...movement, isReclassification: reclassified.has(movement) }));
}
