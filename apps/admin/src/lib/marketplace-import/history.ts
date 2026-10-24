import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { channels, importBatches, importBatchOrders, orders, staffUsers, type OrderStatus } from "@ammari/db/schema";
import { channelDisplayNameSql } from "@/lib/orders/channel-label";
import { defaultDb, type Database } from "@/lib/db";

// "Riwayat impor" and the batch detail (/import/[id]) (docs/plans/marketplace-import.md §11). Read
// from import_batches / import_batch_orders, so `orders.import` is enough (no audit_log.view). The
// batch summary and each order's `changes` carry money (totals, voucher, fees); they are reduced to
// counts and statuses here for staff without `finance.view_profit`, never in the UI.

export const IMPORT_HISTORY_LIMIT = 50;

export interface ImportCounts {
  create: number;
  update: number;
  unchanged: number;
  review: number;
  skip: number;
}

export interface ImportBatchRow {
  id: string;
  channelName: string;
  filename: string;
  uploadedByName: string;
  committedAt: Date;
  rowCount: number | null;
  counts: ImportCounts | null;
  /** Finance only. */
  newOmzetAmount: number | null;
  skuMatchCount: number;
}

function countsOf(summary: unknown): ImportCounts | null {
  if (!summary || typeof summary !== "object") return null;
  const counts = (summary as { counts?: unknown }).counts;
  if (!counts || typeof counts !== "object") return null;
  const value = counts as Record<string, unknown>;
  const read = (key: keyof ImportCounts) => (typeof value[key] === "number" ? (value[key] as number) : 0);
  return { create: read("create"), update: read("update"), unchanged: read("unchanged"), review: read("review"), skip: read("skip") };
}

function omzetOf(summary: unknown): number | null {
  const totals = summary && typeof summary === "object" ? (summary as { totals?: { newOmzetAmount?: unknown } }).totals : undefined;
  return typeof totals?.newOmzetAmount === "number" ? totals.newOmzetAmount : null;
}

export interface SkuMatchSummary {
  fileSku: string;
  adminSku: string;
  channelOrderNos: string[];
}

function skuMatchesOf(summary: unknown): SkuMatchSummary[] {
  const raw = summary && typeof summary === "object" ? (summary as { skuMatches?: unknown }).skuMatches : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): SkuMatchSummary[] => {
    if (!item || typeof item !== "object") return [];
    const { fileSku, adminSku, channelOrderNos } = item as Record<string, unknown>;
    if (typeof fileSku !== "string" || typeof adminSku !== "string") return [];
    return [{ fileSku, adminSku, channelOrderNos: Array.isArray(channelOrderNos) ? channelOrderNos.filter((no): no is string => typeof no === "string") : [] }];
  });
}

const batchColumns = {
  id: importBatches.id,
  channelName: channelDisplayNameSql(channels.id, channels.name),
  filename: importBatches.filename,
  uploadedByName: staffUsers.name,
  committedAt: importBatches.committedAt,
  rowCount: importBatches.rowCount,
  summary: importBatches.summary,
};

/** Only committed batches are read (committedOrderBatch), and those always carry committed_at. */
function committedAtOf(row: { id: string; committedAt: Date | null }): Date {
  if (!row.committedAt) throw new Error(`import batch ${row.id} is committed without committed_at`);
  return row.committedAt;
}

function toRow(row: { id: string; channelName: string; filename: string; uploadedByName: string; committedAt: Date | null; rowCount: number | null; summary: unknown }, canViewProfit: boolean): ImportBatchRow {
  return {
    id: row.id,
    channelName: row.channelName,
    filename: row.filename,
    uploadedByName: row.uploadedByName,
    committedAt: committedAtOf(row),
    rowCount: row.rowCount,
    counts: countsOf(row.summary),
    newOmzetAmount: canViewProfit ? omzetOf(row.summary) : null,
    skuMatchCount: skuMatchesOf(row.summary).length,
  };
}

const committedOrderBatch = and(eq(importBatches.kind, "orders"), eq(importBatches.status, "committed"), sql`${importBatches.committedAt} is not null`);

export async function listImportBatches(options: { canViewProfit: boolean }, db: Database = defaultDb): Promise<ImportBatchRow[]> {
  const rows = await db
    .select(batchColumns)
    .from(importBatches)
    .innerJoin(channels, eq(channels.id, importBatches.channelId))
    .innerJoin(staffUsers, eq(staffUsers.id, importBatches.uploadedBy))
    .where(committedOrderBatch)
    .orderBy(desc(importBatches.committedAt))
    .limit(IMPORT_HISTORY_LIMIT);
  return rows.map((row) => toRow(row, options.canViewProfit));
}

export interface ImportBatchOrderRow {
  orderId: string;
  orderNo: string;
  channelOrderNo: string | null;
  action: "created" | "updated";
  /** The order's status now. */
  status: OrderStatus;
  /** Indonesian lines describing what this import did. Money lines finance only. */
  changes: ImportedChange[];
}

export type ImportedChange =
  | { kind: "status"; before: OrderStatus | null; after: OrderStatus }
  | { kind: "return_pending"; value: "set" | "cleared" }
  | { kind: "voucher"; before: number | null; after: number | null }
  | { kind: "fee"; component: string; before: number | null; after: number | null }
  | { kind: "channel_status"; before: string | null; after: string }
  | { kind: "sku_match"; fileSku: string; adminSku: string };

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** import_batch_orders.changes (written by @ammari/commerce/marketplace-import) -> typed lines. */
function changesOf(action: "created" | "updated", raw: unknown, canViewProfit: boolean): ImportedChange[] {
  if (!raw || typeof raw !== "object") return [];
  const value = raw as Record<string, unknown>;
  const result: ImportedChange[] = [];
  const money = (amount: unknown) => (canViewProfit ? num(amount) : null);
  if (action === "created") {
    const status = str(value.status);
    if (status) result.push({ kind: "status", before: null, after: status as OrderStatus });
    if (value.returnPending === true) result.push({ kind: "return_pending", value: "set" });
  } else {
    const status = value.status as { before?: unknown; after?: unknown } | null | undefined;
    if (status && str(status.after)) result.push({ kind: "status", before: str(status.before) as OrderStatus | null, after: str(status.after) as OrderStatus });
    if (value.returnPending === "set" || value.returnPending === "cleared") result.push({ kind: "return_pending", value: value.returnPending });
    const discount = value.discountAmount as { before?: unknown; after?: unknown } | null | undefined;
    if (discount) result.push({ kind: "voucher", before: money(discount.before), after: money(discount.after) });
    if (Array.isArray(value.fees)) {
      for (const fee of value.fees as { component?: unknown; before?: unknown; after?: unknown }[]) {
        const component = str(fee?.component);
        if (component) result.push({ kind: "fee", component, before: money(fee.before), after: money(fee.after) });
      }
    }
    const channelStatus = value.channelStatus as { before?: unknown; after?: unknown } | null | undefined;
    if (channelStatus && str(channelStatus.after)) result.push({ kind: "channel_status", before: str(channelStatus.before), after: str(channelStatus.after)! });
  }
  if (Array.isArray(value.skuMatches)) {
    for (const match of value.skuMatches as { fileSku?: unknown; adminSku?: unknown }[]) {
      const fileSku = str(match?.fileSku);
      const adminSku = str(match?.adminSku);
      if (fileSku && adminSku) result.push({ kind: "sku_match", fileSku, adminSku });
    }
  }
  return result;
}

export interface ImportBatchDetail extends ImportBatchRow {
  fileSha256: string | null;
  skuMatches: SkuMatchSummary[];
  orders: ImportBatchOrderRow[];
}

export async function getImportBatchDetail(id: string, options: { canViewProfit: boolean }, db: Database = defaultDb): Promise<ImportBatchDetail | null> {
  const [batch] = await db
    .select({ ...batchColumns, fileSha256: importBatches.fileSha256 })
    .from(importBatches)
    .innerJoin(channels, eq(channels.id, importBatches.channelId))
    .innerJoin(staffUsers, eq(staffUsers.id, importBatches.uploadedBy))
    .where(and(eq(importBatches.id, id), committedOrderBatch))
    .limit(1);
  if (!batch) return null;
  const rows = await db
    .select({ orderId: orders.id, orderNo: orders.orderNo, channelOrderNo: orders.channelOrderNo, status: orders.status, action: importBatchOrders.action, changes: importBatchOrders.changes })
    .from(importBatchOrders)
    .innerJoin(orders, eq(orders.id, importBatchOrders.orderId))
    .where(eq(importBatchOrders.importBatchId, id))
    .orderBy(asc(importBatchOrders.action), asc(orders.channelOrderNo));
  return {
    ...toRow(batch, options.canViewProfit),
    fileSha256: batch.fileSha256,
    skuMatches: skuMatchesOf(batch.summary),
    orders: rows.map((row) => ({
      orderId: row.orderId,
      orderNo: row.orderNo,
      channelOrderNo: row.channelOrderNo,
      action: row.action,
      status: row.status,
      changes: changesOf(row.action, row.changes, options.canViewProfit),
    })),
  };
}
