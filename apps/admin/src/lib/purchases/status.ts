import type { PurchaseStatus } from "@ammari/db/schema";
import { toCentiQty } from "@/lib/receipts/valuation";

// Pure status rules for a purchase document (docs/plans/suppliers-goods-receipt.md §5, D19).
// Quantities are compared in integer hundredths, never as floats.

export interface LineProgress {
  qtyOrdered: number;
  /** Net accepted into sellable stock so far (receipts minus reversals). */
  accepted: number;
  /** Net rejected into defect stock so far (receipts minus reversals, S5). Rejects count as
   * "arrived" (D19) but never complete a line: only accepted units do (§4.2's worked example —
   * 8 good + 2 defective of 10 is `partially_received` with nothing outstanding). */
  rejected: number;
}

/** Statuses a receipt may still be posted against, and a close may still be applied to. */
export const OPEN_PURCHASE_STATUSES: readonly PurchaseStatus[] = ["ordered", "partially_received"];
export const TERMINAL_PURCHASE_STATUSES: readonly PurchaseStatus[] = ["closed", "cancelled"];

export function isOpenPurchaseStatus(status: PurchaseStatus): boolean {
  return OPEN_PURCHASE_STATUSES.includes(status);
}

/** D19: nothing arrived means accepted = 0 AND rejected = 0 on every line. */
function nothingArrived(lines: readonly LineProgress[]): boolean {
  return lines.every((line) => toCentiQty(line.accepted) === 0n && toCentiQty(line.rejected) === 0n);
}

/** `received` when every line's ACCEPTED equals its ordered quantity, `ordered` when nothing has
 * arrived on any line (e.g. after the only receipt was reversed), `partially_received` otherwise —
 * including a line fully settled with rejects, which the owner then short-closes (or, from S6,
 * exchanges). */
export function receiptProgressStatus(lines: readonly LineProgress[]): "ordered" | "partially_received" | "received" {
  if (lines.length > 0 && lines.every((line) => toCentiQty(line.accepted) === toCentiQty(line.qtyOrdered))) return "received";
  if (nothingArrived(lines)) return "ordered";
  return "partially_received";
}

/** D19: one close action; `cancelled` when nothing ever arrived, `closed` otherwise. */
export function closedStatus(lines: readonly LineProgress[]): "closed" | "cancelled" {
  return nothingArrived(lines) ? "cancelled" : "closed";
}

/** The status after a receipt or a reversal changed the accepted quantities. An open or received
 * document follows the receipts. A closed/cancelled document stays closed (closing is the owner's
 * decision, and a reversal does not undo it), but which of the two it is keeps following D19's
 * rule on the CURRENT net quantities: reversing the only receipt of a closed document leaves a
 * document where nothing arrived, which is `cancelled`. */
export function statusAfterReceiptChange(current: PurchaseStatus, lines: readonly LineProgress[]): PurchaseStatus {
  if (TERMINAL_PURCHASE_STATUSES.includes(current)) return closedStatus(lines);
  return receiptProgressStatus(lines);
}

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  ordered: "Dipesan",
  partially_received: "Diterima sebagian",
  received: "Diterima lengkap",
  closed: "Ditutup",
  cancelled: "Dibatalkan",
};
