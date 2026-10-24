import type { ChannelFeeComponent, OrderStatus } from "@ammari/db/schema";
import { formatRupiah } from "@ammari/ui/lib";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status-labels";
import type { ParsedImport } from "./parse-file";
import type { ImportPlan, PlanAction, PlanEntry, ReviewCode, UnknownSkuGroup } from "./plan";

// What the browser gets for a preview (docs/plans/marketplace-import.md §11, §12): an ALLOWLIST built
// from the parse and the plan, never the plan itself. Money (omzet, voucher, fees, rounding) is only
// filled in for staff with `finance.view_profit`; without it every money field is null and no
// message carries a rupiah amount. Counts, statuses, SKUs and order numbers are for everyone with
// `orders.import`. Never buyer data: the parse holds none past the header row.

export const FEE_COMPONENT_LABELS: Record<ChannelFeeComponent, string> = {
  admin_fee: "Biaya Administrasi",
  service_fee: "Biaya Layanan",
  platform_commission: "Komisi platform",
  affiliate_commission: "Komisi afiliasi",
  seller_shipping_subsidy: "Subsidi ongkir penjual",
  other: "Biaya lain",
};

export interface PreviewExistingOrder {
  orderId: string;
  orderNo: string;
  status: OrderStatus;
  /** Entered by hand on /orders/new ("Cocok dengan pesanan manual ..."). */
  manual: boolean;
  /** As stored, when it differs from the file's number (other case or spaces). */
  storedChannelOrderNo: string;
}

export interface PreviewReason {
  code: ReviewCode;
  message: string;
  /** stock_short: the admin SKU, for "Lihat stok". */
  stockSku: string | null;
}

export interface PreviewRow {
  channelOrderNo: string;
  action: PlanAction;
  rowNumbers: number[];
  rawStatus: string | null;
  /** ISO instant; create only. */
  orderedAt: string | null;
  /** The admin status the order ends at (create), or moves to (update); null when it stays. */
  targetStatus: OrderStatus | null;
  pieces: number | null;
  /** Omzet of a new order (subtotal - voucher). Finance only. */
  omzetAmount: number | null;
  existing: PreviewExistingOrder | null;
  /** Indonesian, one line per change (update). Money lines finance only. */
  changes: string[];
  reasons: PreviewReason[];
  warnings: string[];
  skipReason: "unpaid" | "undone_before_import" | null;
  /** Manual matches this order uses ("SKU-FILE -> SKU-ADMIN"). */
  skuMatches: { fileSku: string; adminSku: string }[];
}

export interface ImportPreview {
  digest: string;
  channelId: ParsedImport["channelId"];
  channelLabel: string;
  canViewProfit: boolean;
  file: {
    format: ParsedImport["format"];
    sheetName: string;
    headerRowNumber: number;
    dataRowCount: number;
    orderCount: number;
    from: string | null;
    to: string | null;
    rowErrorCount: number;
    rowErrors: ParsedImport["rowErrors"];
  };
  counts: ImportPlan["counts"];
  totals: { newOrderCount: number; newPieces: number; newOmzetAmount: number | null; newVoucherAmount: number | null; newFeeAmount: number | null };
  saveBlockers: string[];
  warnings: string[];
  unknownStatuses: ParsedImport["unknownStatuses"];
  previousCommitAt: string | null;
  rows: PreviewRow[];
  unknownSkus: UnknownSkuGroup[];
  skuMatches: ImportPlan["skuMatches"];
  /** New + updated: what Simpan writes. */
  saveCount: number;
  canSave: boolean;
}

function arrow(before: string, after: string): string {
  return `${before} → ${after}`;
}

function rupiahOrNone(amount: number | null): string {
  return amount === null ? "belum ada" : formatRupiah(amount);
}

function rowFor(entry: PlanEntry, canViewProfit: boolean): PreviewRow {
  const base: PreviewRow = {
    channelOrderNo: entry.channelOrderNo,
    action: entry.action,
    rowNumbers: entry.rowNumbers,
    rawStatus: null,
    orderedAt: null,
    targetStatus: null,
    pieces: null,
    omzetAmount: null,
    existing: null,
    changes: [],
    reasons: [],
    warnings: [],
    skipReason: null,
    skuMatches: [],
  };
  const existing = "existing" in entry && entry.existing ? entry.existing : null;
  if (existing) {
    base.existing = { orderId: existing.orderId, orderNo: existing.orderNo, status: existing.status, manual: existing.manual, storedChannelOrderNo: existing.storedChannelOrderNo };
  }
  switch (entry.action) {
    case "create": {
      const rounding = canViewProfit && entry.roundingDifference !== 0 ? [`Selisih pembulatan ${formatRupiah(Math.abs(entry.roundingDifference))}`] : [];
      return {
        ...base,
        rawStatus: entry.rawStatus,
        orderedAt: entry.orderedAt.toISOString(),
        targetStatus: entry.transitions.at(-1) ?? "to_ship",
        pieces: entry.lines.reduce((sum, line) => sum + line.qty, 0),
        omzetAmount: canViewProfit ? entry.totalAmount : null,
        warnings: [...rounding, ...(entry.setReturnPending ? ["Retur di marketplace: pesanan ditandai, stok belum dikembalikan."] : [])],
        skuMatches: entry.skuMatches,
      };
    }
    case "update": {
      const changes: string[] = [];
      const target = entry.transitions.at(-1) ?? null;
      if (target) changes.push(`Status: ${arrow(ORDER_STATUS_LABELS[entry.existing.status], ORDER_STATUS_LABELS[target])}`);
      if (entry.setReturnPending) changes.push("Ditandai retur di marketplace");
      if (entry.clearReturnPending) changes.push("Tanda retur di marketplace dihapus");
      if (entry.discount) changes.push(canViewProfit ? `Voucher penjual: ${arrow(formatRupiah(entry.discount.before), formatRupiah(entry.discount.after))}` : "Voucher penjual berubah");
      for (const fee of entry.fees) {
        const label = FEE_COMPONENT_LABELS[fee.component];
        changes.push(canViewProfit ? `${label}: ${arrow(rupiahOrNone(fee.before), formatRupiah(fee.after))}` : `${label} berubah`);
      }
      if (entry.channelStatus) changes.push(`Status marketplace: ${arrow(entry.channelStatus.before ?? "belum ada", entry.channelStatus.after)}`);
      return { ...base, rawStatus: entry.rawStatus, targetStatus: target, changes, warnings: entry.warnings, skuMatches: entry.skuMatches };
    }
    case "unchanged":
      return { ...base, warnings: entry.warnings };
    case "review":
      return { ...base, reasons: entry.reasons.map((reason) => ({ code: reason.code, message: reason.message, stockSku: reason.code === "stock_short" ? (reason.sku ?? null) : null })) };
    case "skip":
      return { ...base, rawStatus: entry.rawStatus, skipReason: entry.reason };
  }
}

export function toImportPreview(parsed: ParsedImport, plan: ImportPlan, options: { canViewProfit: boolean }): ImportPreview {
  const { canViewProfit } = options;
  const saveCount = plan.counts.create + plan.counts.update;
  return {
    digest: plan.digest,
    channelId: parsed.channelId,
    channelLabel: parsed.channelLabel,
    canViewProfit,
    file: {
      format: parsed.format,
      sheetName: parsed.sheetName,
      headerRowNumber: parsed.headerRowNumber,
      dataRowCount: parsed.dataRowCount,
      orderCount: parsed.orders.length + parsed.problems.length,
      from: parsed.orderedAtRange?.from.toISOString() ?? null,
      to: parsed.orderedAtRange?.to.toISOString() ?? null,
      rowErrorCount: parsed.rowErrorCount,
      rowErrors: parsed.rowErrors,
    },
    counts: plan.counts,
    totals: {
      newOrderCount: plan.totals.newOrderCount,
      newPieces: plan.totals.newPieces,
      newOmzetAmount: canViewProfit ? plan.totals.newOmzetAmount : null,
      newVoucherAmount: canViewProfit ? plan.totals.newVoucherAmount : null,
      newFeeAmount: canViewProfit ? plan.totals.newFeeAmount : null,
    },
    saveBlockers: plan.saveBlockers,
    warnings: parsed.warnings,
    unknownStatuses: parsed.unknownStatuses,
    previousCommitAt: plan.previousCommit?.committedAt.toISOString() ?? null,
    rows: plan.entries.map((entry) => rowFor(entry, canViewProfit)),
    unknownSkus: plan.unknownSkus,
    skuMatches: plan.skuMatches,
    saveCount,
    canSave: plan.saveBlockers.length === 0 && saveCount > 0,
  };
}
