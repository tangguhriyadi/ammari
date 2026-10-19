import "server-only";
import { productionBatches } from "@ammari/db/schema";
import type { Tx } from "@/lib/db";
import { nextDocumentNumber } from "@/lib/documents/document-number";

/** Generates the next "PRD-YYYYMM-NNN" batch number for whichever month `now` falls in
 * (Asia/Jakarta). A thin caller of nextDocumentNumber, which owns the advisory-lock and
 * split-on-'-' sequence logic (and its full doc comment); `unique(batch_no)` stays the backstop.
 * MUST be called inside `tx` (a real transaction). */
export async function generateBatchNumber(tx: Tx, now: Date = new Date()): Promise<string> {
  return nextDocumentNumber(tx, "PRD", productionBatches.batchNo, now);
}
