import type { ProductionBatchStatus, PurchaseItemType, SupplierPaymentMethod } from "@ammari/db/schema";
import { batchTagihan, summarizePayment, type BatchCostLine, type PaymentStatus } from "@/lib/supplier-payments/status";

// "Pengeluaran produksi" (docs/plans/expense-master-data.md §3.9, session S6): the pure half of the
// read-only tab on Biaya. Every row is one non-voided supplier payment; this module turns the
// database rows into what the tab shows (category and item labels, "Pembayaran ke-n", the bill's
// CURRENT status, a source link only when the viewer may open it). No DB access, so every rule is
// unit-tested without a database. "Biaya produksi" is a display label here and nowhere else: it is
// never an expense_categories row, so it can never reach the P&L (§3.11).

/** The fixed category label of every row. Not a category: the P&L never sees it. */
export const PRODUCTION_OUTFLOW_CATEGORY_LABEL = "Biaya produksi";
export const PURCHASE_OUTFLOW_ITEM_LABEL = "Biaya bahan baku";
/** A batch payee whose lines carry no name (should not happen: component_name is NOT NULL). */
export const BATCH_OUTFLOW_FALLBACK_ITEM_LABEL = "Ongkos produksi";
export const NO_PAYEE_LABEL = "Tanpa penerima";

export const PRODUCTION_OUTFLOW_BANNER =
  "Ini pembayaran untuk stok bahan dan ongkos produksi. Tidak mengurangi laba bersih lagi: biayanya masuk laporan laba rugi sebagai HPP saat barangnya terjual.";

export type ProductionOutflowSource = "purchase" | "production";

/** "Kain", "Aksesoris" or "Kain & aksesoris" from the purchase's line types; null when it has no
 * line (cannot be paid in practice, but a label must never throw). */
export function purchaseItemDetail(types: Iterable<PurchaseItemType>): string | null {
  const set = new Set(types);
  const fabric = set.has("fabric");
  const accessory = set.has("accessory");
  if (fabric && accessory) return "Kain & aksesoris";
  if (fabric) return "Kain";
  if (accessory) return "Aksesoris";
  return null;
}

/** The payee's own component names on the batch, distinct, in line order: "Ongkos jahit,
 * Finishing". */
export function batchItemLabel(componentNames: readonly string[]): string {
  const distinct = [...new Set(componentNames.map((name) => name.trim()).filter((name) => name !== ""))];
  return distinct.length > 0 ? distinct.join(", ") : BATCH_OUTFLOW_FALLBACK_ITEM_LABEL;
}

/** The numbering key: one PO, or one batch + payee (a batch is paid per payee, P12). */
export function outflowTargetKey(target: OutflowTarget): string {
  return target.type === "purchase" ? `purchase:${target.purchaseId}` : `batch:${target.productionBatchId}:${target.supplierId ?? "none"}`;
}

export type OutflowTarget =
  | { type: "purchase"; purchaseId: string }
  | { type: "production_batch"; productionBatchId: string; supplierId: string | null };

export interface OrdinalPayment {
  id: string;
  target: OutflowTarget;
  paidAt: string;
  createdAt: Date;
  paymentNo: string;
  voided: boolean;
}

/** "Pembayaran ke-n" (owner answer D9): each payment's position among its target's NON-voided
 * payments, ordered by paid date, then recording time, then payment number. Rows are append-only,
 * so the order is stable; a voided payment gets no number, and the payments after it are counted
 * without it. */
export function paymentOrdinals(payments: readonly OrdinalPayment[]): Map<string, number> {
  const byTarget = new Map<string, OrdinalPayment[]>();
  for (const payment of payments) {
    if (payment.voided) continue;
    const key = outflowTargetKey(payment.target);
    const list = byTarget.get(key);
    if (list) list.push(payment);
    else byTarget.set(key, [payment]);
  }
  const ordinals = new Map<string, number>();
  for (const list of byTarget.values()) {
    list.sort(
      (a, b) =>
        (a.paidAt < b.paidAt ? -1 : a.paidAt > b.paidAt ? 1 : 0) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.paymentNo < b.paymentNo ? -1 : a.paymentNo > b.paymentNo ? 1 : 0),
    );
    list.forEach((payment, index) => ordinals.set(payment.id, index + 1));
  }
  return ordinals;
}

/** The purchase's CURRENT status, exactly as the PO page derives it (summarizePayment over §3.1's
 * tagihan and the non-voided payments). */
export function purchaseOutflowStatus(tagihan: number, paid: number): PaymentStatus {
  return summarizePayment(tagihan, paid).status;
}

/** The batch payee's CURRENT status, exactly as the batch page derives it (batchTagihan per
 * payee, then summarizePayment). A payee with no line on the batch has no bill. */
export function batchPayeeOutflowStatus(status: ProductionBatchStatus, lines: readonly BatchCostLine[], supplierId: string | null, paid: number): PaymentStatus {
  const due = batchTagihan(status, lines);
  const payee = due?.payees.find((candidate) => candidate.supplierId === supplierId);
  return summarizePayment(payee?.tagihan ?? 0, paid).status;
}

/** The permissions that open each source page (§3.9): /purchases/[id] needs inventory.view,
 * /production/[id] production.manage. Keuangan holds the first only, so a batch number stays
 * plain text for them instead of a link that 403s. */
export const OUTFLOW_SOURCE_PERMISSIONS = {
  purchase: "inventory.view",
  production_batch: "production.manage",
} as const;

export function outflowSourceHref(target: OutflowTarget, permissionKeys: readonly string[]): string | null {
  if (target.type === "purchase") {
    return permissionKeys.includes(OUTFLOW_SOURCE_PERMISSIONS.purchase) ? `/purchases/${target.purchaseId}` : null;
  }
  return permissionKeys.includes(OUTFLOW_SOURCE_PERMISSIONS.production_batch) ? `/production/${target.productionBatchId}` : null;
}

export interface ProductionOutflowRow {
  id: string;
  paymentNo: string;
  paidAt: string;
  amount: number;
  method: SupplierPaymentMethod;
  source: ProductionOutflowSource;
  /** "PO-203103-001" or the batch number. */
  sourceNo: string;
  /** null when the viewer may not open the source page. */
  sourceHref: string | null;
  categoryLabel: string;
  itemLabel: string;
  /** "Kain & aksesoris" for a purchase; null for a batch (its item already names the work). */
  itemDetail: string | null;
  payeeName: string;
  /** "Pembayaran ke-n" among the target's non-voided payments. */
  ordinal: number;
  status: PaymentStatus;
}
