import type { ProductionReceiptStatus } from "@ammari/db/schema";

// Pure receipt-progress rules for a posted production batch (docs/plans/suppliers-goods-receipt.md
// D5, session S4). Production output is whole pcs, so plain integer comparison is exact.

export interface BatchLineProgress {
  /** Planned pcs on the batch line (production_batch_items.qty, frozen at posting). */
  planned: number;
  /** Net received pcs (receipts minus reversals, plus any legacy at-posting stock row). */
  received: number;
}

/** Statuses a receipt may still be posted against, and a short-close may still be applied to. */
export const OPEN_BATCH_RECEIPT_STATUSES: readonly ProductionReceiptStatus[] = ["pending", "partially_received"];

export function isOpenBatchReceiptStatus(status: ProductionReceiptStatus): boolean {
  return OPEN_BATCH_RECEIPT_STATUSES.includes(status);
}

/** `received` when every line received its planned pcs, `pending` when nothing has arrived on any
 * line (e.g. after the only receipt was reversed), `partially_received` otherwise. */
export function batchReceiptProgressStatus(lines: readonly BatchLineProgress[]): "pending" | "partially_received" | "received" {
  if (lines.length > 0 && lines.every((line) => line.received === line.planned)) return "received";
  if (lines.every((line) => line.received === 0)) return "pending";
  return "partially_received";
}

/** The status after a receipt or a reversal changed the received quantities. A short-closed batch
 * stays closed (closing is the owner's decision, and a reversal does not undo it); every other
 * status follows the receipts. */
export function batchStatusAfterReceiptChange(current: ProductionReceiptStatus, lines: readonly BatchLineProgress[]): ProductionReceiptStatus {
  if (current === "closed") return "closed";
  return batchReceiptProgressStatus(lines);
}

export const PRODUCTION_RECEIPT_STATUS_LABELS: Record<ProductionReceiptStatus, string> = {
  pending: "Belum diterima",
  partially_received: "Diterima sebagian",
  received: "Diterima lengkap",
  closed: "Ditutup",
};
