import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  CHANNEL_FEE_COMPONENTS,
  importBatches,
  orderChannelFees,
  orderItems,
  orders,
  productVariants,
  stockMovements,
  type ChannelFeeComponent,
  type OrderStatus,
} from "@ammari/db/schema";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { formatDate } from "@ammari/ui/lib";
import { defaultDb, type Database } from "@/lib/db";
import { adapterFor } from "./adapters";
import type { FeeAmounts } from "./adapters/types";
import type { ImportLine, ImportOrder, OrderProblemCode } from "./group-orders";
import type { ParsedImport } from "./parse-file";
import { decideStatus } from "./status-rules";
import { parseSku } from "./values";

// The planner (docs/plans/marketplace-import.md §1, §6 to §8, session 3): a parsed file + the
// database (READ ONLY) -> what Simpan would do to each order, and a digest of it. The preview shows
// the plan; the commit (session 4) re-plans inside its transaction, after the channel's advisory
// lock, compares digests, and only then writes. Nothing here writes, and nothing here reads a
// buyer column: the input is the parser's orders, which never carry any.
//
// Matching is by SKU only (owner addition A). Product/variation names from the file are passed
// through as display hints next to an unknown SKU and never compared with admin names.

/** Manual matches accepted per Periksa file / Simpan (one per distinct unknown SKU in a file). */
export const MAX_SKU_OVERRIDES = 500;
/** orders_channel_status_check. Only statuses the adapter knows are stored, so this never bites in
 * practice; a longer text waits in Perlu dicek rather than failing the commit. */
const MAX_CHANNEL_STATUS_CHARS = 64;

export type ReviewCode = OrderProblemCode | "unknown_status" | "final_in_admin" | "unknown_sku" | "ambiguous_match" | "lines_differ" | "stock_short";

export interface ReviewReason {
  code: ReviewCode;
  /** Indonesian, shown as is. Never cell contents beyond SKUs and our own numbers. */
  message: string;
  /** The SKU the reason is about (unknown_sku: the file's, null for a blank cell; stock_short: the admin's). */
  sku?: string | null;
}

/** One admin line as Simpan would write it. */
export interface PlannedLine {
  /** The admin SKU (the file's own, or the manual match). */
  sku: string;
  qty: number;
  unitPrice: number;
  /** Sum of the file's charged amounts for this line. */
  lineTotal: number;
  rowNumbers: number[];
}

export interface SkuMatch {
  fileSku: string;
  adminSku: string;
}

/** The admin order a file order matched (by channel + trimmed, case-insensitive number). */
export interface ExistingOrderRef {
  orderId: string;
  orderNo: string;
  /** As stored; differs from the file's number when it was typed by hand with other case/spaces. */
  storedChannelOrderNo: string;
  status: OrderStatus;
  /** Entered by staff on /orders/new ("Cocok dengan pesanan manual ORD-..."). */
  manual: boolean;
}

interface EntryBase {
  /** The file's number, normalized (trimmed, uppercase); the key of the plan. */
  channelOrderNo: string;
  rowNumbers: number[];
}

export interface CreateEntry extends EntryBase {
  action: "create";
  rawStatus: string;
  orderedAt: Date;
  lines: PlannedLine[];
  subtotalAmount: number;
  /** The seller voucher. */
  discountAmount: number;
  /** subtotal - discount (no shipping: buyer ongkir is not ours, plan §4). */
  totalAmount: number;
  /** sum(lineTotal) - subtotal, from merged-line rounding ("Selisih pembulatan"). */
  roundingDifference: number;
  /** Every fee component whose column is in the file (0 included: a known zero). */
  fees: FeeAmounts;
  /** Run in order after creating at `to_ship` (stock leaves at creation). */
  transitions: OrderStatus[];
  setReturnPending: boolean;
  skuMatches: SkuMatch[];
}

export interface FeeChange {
  component: ChannelFeeComponent;
  /** null: no row yet. */
  before: number | null;
  after: number;
}

export interface UpdateEntry extends EntryBase {
  action: "update";
  existing: ExistingOrderRef;
  rawStatus: string;
  transitions: OrderStatus[];
  setReturnPending: boolean;
  clearReturnPending: boolean;
  /** null: unchanged. `before` is what the commit's conditional UPDATE expects to find. */
  discount: { before: number; after: number } | null;
  totalAmount: { before: number; after: number } | null;
  /** Only components that change; a component missing from the file is left as is. */
  fees: FeeChange[];
  channelStatus: { before: string | null; after: string } | null;
  warnings: string[];
  skuMatches: SkuMatch[];
}

export interface UnchangedEntry extends EntryBase {
  action: "unchanged";
  existing: ExistingOrderRef;
  warnings: string[];
}

export interface ReviewEntry extends EntryBase {
  action: "review";
  existing: ExistingOrderRef | null;
  reasons: ReviewReason[];
}

export interface SkipEntry extends EntryBase {
  action: "skip";
  /** unpaid: Belum Bayar; undone_before_import: cancelled/returned before we ever saw it. */
  reason: "unpaid" | "undone_before_import";
  rawStatus: string;
}

export type PlanEntry = CreateEntry | UpdateEntry | UnchangedEntry | ReviewEntry | SkipEntry;
export type PlanAction = PlanEntry["action"];

export interface UnknownSkuGroup {
  /** Uppercased as in the file; null for blank SKU cells (cannot be matched by hand). */
  fileSku: string | null;
  /** Product / variation names from the file, display only (never stored, never matched). */
  nameHints: string[];
  orders: { channelOrderNo: string; rowNumbers: number[] }[];
}

export interface ImportPlan {
  channelId: ParsedImport["channelId"];
  /** Sorted by channelOrderNo. */
  entries: PlanEntry[];
  counts: Record<PlanAction, number>;
  /** New orders only (finance fields: the caller strips them without `finance.view_profit`). */
  totals: { newOrderCount: number; newPieces: number; newOmzetAmount: number; newVoucherAmount: number; newFeeAmount: number };
  /** Distinct unknown SKUs still unmatched, for "Cocokkan ke varian". */
  unknownSkus: UnknownSkuGroup[];
  /** Manual matches this plan used (audit + batch summary at Simpan). */
  skuMatches: (SkuMatch & { channelOrderNos: string[] })[];
  /** From the parse: while not empty nothing may be saved. NOT part of the digest: the commit must
   * refuse on this list itself, after re-planning, whatever the digest says. */
  saveBlockers: string[];
  /** The latest committed batch of the same bytes on this channel ("File ini sudah pernah disimpan"). */
  previousCommit: { batchId: string; committedAt: Date } | null;
  /** sha256 (hex) of the canonical plan; Simpan proceeds only while it still matches. */
  digest: string;
}

export type PlanError = { code: "invalid_sku_override"; message: string };
export type PlanResult = { ok: true; value: ImportPlan } | { ok: false; error: PlanError };

export interface PlanOptions {
  /** fileSku -> adminSku, this import only (plan §8.1). Normalized like file SKUs. */
  skuOverrides?: Readonly<Record<string, string>>;
}

interface ExistingRow {
  id: string;
  orderNo: string;
  channelOrderNo: string;
  status: OrderStatus;
  subtotalAmount: number;
  shippingAmount: number;
  discountAmount: number;
  totalAmount: number;
  orderDate: Date;
  channelStatus: string | null;
  returnPending: boolean;
  createdByStaffUserId: string | null;
}

function overrideError(message: string): PlanResult {
  return { ok: false, error: { code: "invalid_sku_override", message } };
}

function normalizeSku(value: string): string | null {
  const parsed = parseSku(value);
  return parsed.ok ? parsed.value : null;
}

/** Validates the manual matches against the file and the variants (plan §8.1): only SKUs the file
 * contains and admin does not know, each onto an existing admin SKU. */
function validateOverrides(
  raw: Readonly<Record<string, string>>,
  fileSkus: ReadonlySet<string>,
  knownSkus: ReadonlySet<string>,
): { ok: true; value: Map<string, string> } | { ok: false; result: PlanResult } {
  const overrides = new Map<string, string>();
  for (const [rawFileSku, rawAdminSku] of Object.entries(raw)) {
    const fileSku = normalizeSku(rawFileSku);
    const adminSku = typeof rawAdminSku === "string" ? normalizeSku(rawAdminSku) : null;
    if (!fileSku || !adminSku) return { ok: false, result: overrideError("Pencocokan SKU tidak valid. Periksa file lagi.") };
    if (!fileSkus.has(fileSku)) return { ok: false, result: overrideError(`SKU ${fileSku} tidak ada di file ini. Periksa file lagi.`) };
    if (knownSkus.has(fileSku)) return { ok: false, result: overrideError(`SKU ${fileSku} sudah cocok dengan varian admin, jadi tidak perlu dicocokkan.`) };
    if (!knownSkus.has(adminSku)) return { ok: false, result: overrideError(`SKU admin ${adminSku} tidak ditemukan.`) };
    if (overrides.has(fileSku) && overrides.get(fileSku) !== adminSku) return { ok: false, result: overrideError(`SKU ${fileSku} dicocokkan ke dua varian berbeda.`) };
    overrides.set(fileSku, adminSku);
  }
  return { ok: true, value: overrides };
}

/** The file's lines mapped onto admin SKUs and merged again (two file SKUs matched onto one admin
 * SKU become one line, SPEC §5.2), or the unknown ones. */
function resolveLines(
  lines: readonly ImportLine[],
  knownSkus: ReadonlySet<string>,
  overrides: ReadonlyMap<string, string>,
): { lines: PlannedLine[]; unknown: ImportLine[]; matches: SkuMatch[] } {
  const merged = new Map<string, PlannedLine>();
  const unknown: ImportLine[] = [];
  const matches: SkuMatch[] = [];
  for (const line of lines) {
    let adminSku: string | null = null;
    if (line.sku !== null && knownSkus.has(line.sku)) adminSku = line.sku;
    else if (line.sku !== null) {
      adminSku = overrides.get(line.sku) ?? null;
      if (adminSku !== null) matches.push({ fileSku: line.sku, adminSku });
    }
    if (adminSku === null) {
      unknown.push(line);
      continue;
    }
    const existing = merged.get(adminSku);
    if (existing) {
      existing.qty += line.qty;
      existing.lineTotal += line.lineTotal;
      existing.rowNumbers.push(...line.rowNumbers);
    } else {
      merged.set(adminSku, { sku: adminSku, qty: line.qty, unitPrice: 0, lineTotal: line.lineTotal, rowNumbers: [...line.rowNumbers] });
    }
  }
  const resolved = [...merged.values()]
    .map((line) => ({ ...line, unitPrice: Math.round(line.lineTotal / line.qty), rowNumbers: [...line.rowNumbers].sort((a, b) => a - b) }))
    .sort((a, b) => compareText(a.sku, b.sku));
  return { lines: resolved, unknown, matches };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function existingRef(row: ExistingRow): ExistingOrderRef {
  return { orderId: row.id, orderNo: row.orderNo, storedChannelOrderNo: row.channelOrderNo, status: row.status, manual: row.createdByStaffUserId !== null };
}

/** Lines are never changed by an import (decision 6): any difference in SKU set, qty or price. */
function linesDiffer(planned: readonly PlannedLine[], stored: readonly { sku: string; qty: number; unitPrice: number }[]): string[] {
  const storedBySku = new Map(stored.map((item) => [item.sku, item]));
  const plannedBySku = new Map(planned.map((line) => [line.sku, line]));
  const differing = new Set<string>();
  for (const line of planned) {
    const item = storedBySku.get(line.sku);
    if (!item || item.qty !== line.qty || item.unitPrice !== line.unitPrice) differing.add(line.sku);
  }
  for (const item of stored) if (!plannedBySku.has(item.sku)) differing.add(item.sku);
  return [...differing].sort(compareText);
}

function feesInCanonicalOrder(fees: FeeAmounts): [ChannelFeeComponent, number][] {
  return CHANNEL_FEE_COMPONENTS.flatMap((component): [ChannelFeeComponent, number][] => {
    const amount = fees[component];
    return amount === undefined ? [] : [[component, amount]];
  });
}

export async function planImport(parsed: ParsedImport, options: PlanOptions = {}, db: Database = defaultDb): Promise<PlanResult> {
  const adapter = adapterFor(parsed.channelId);
  if (!adapter) throw new Error(`planImport: no adapter for channel ${parsed.channelId}`);
  const { statusMap, label: channelLabel } = adapter;
  const rawOverrides = options.skuOverrides ?? {};
  if (Object.keys(rawOverrides).length > MAX_SKU_OVERRIDES) return overrideError(`Terlalu banyak pencocokan SKU (maks. ${MAX_SKU_OVERRIDES}).`);

  // ---- Reads (all of them, before any decision) ----
  const fileSkus = new Set(parsed.orders.flatMap((order) => order.lines.flatMap((line) => (line.sku === null ? [] : [line.sku]))));
  const candidateSkus = new Set(fileSkus);
  for (const value of Object.values(rawOverrides)) {
    const sku = typeof value === "string" ? normalizeSku(value) : null;
    if (sku) candidateSkus.add(sku);
  }
  const knownSkus = new Set(
    candidateSkus.size === 0
      ? []
      : (await db.select({ sku: productVariants.sku }).from(productVariants).where(inArray(productVariants.sku, [...candidateSkus]))).map((row) => row.sku),
  );

  const validated = validateOverrides(rawOverrides, fileSkus, knownSkus);
  if (!validated.ok) return validated.result;
  const overrides = validated.value;

  // Matched by channel + trimmed, case-insensitive number (plan §6), so a manual order typed with
  // stray spaces or lowercase is the same order. A range scan of one channel's rows of
  // orders_channel_id_channel_order_no_key, filtered on the expression (a few thousand rows; an
  // expression index only pays off far beyond that). The commit's INSERT uses the exact key.
  // btrim strips the same ASCII whitespace JS trim() does for a typed number; the file side only
  // ever holds [A-Z0-9], so upper() on anything non-ASCII can never produce a false match.
  const fileOrderNos = [...new Set([...parsed.orders.map((order) => order.channelOrderNo), ...parsed.problems.map((problem) => problem.channelOrderNo)])];
  const normalizedNo = sql<string>`upper(btrim(${orders.channelOrderNo}, E' \t\r\n\f\v'))`;
  const existingRows: (ExistingRow & { normalizedNo: string })[] =
    fileOrderNos.length === 0
      ? []
      : await db
          .select({
            id: orders.id,
            orderNo: orders.orderNo,
            channelOrderNo: sql<string>`${orders.channelOrderNo}`,
            normalizedNo,
            status: orders.status,
            subtotalAmount: orders.subtotalAmount,
            shippingAmount: orders.shippingAmount,
            discountAmount: orders.discountAmount,
            totalAmount: orders.totalAmount,
            orderDate: orders.orderDate,
            channelStatus: orders.channelStatus,
            returnPending: sql<boolean>`'marketplace_return_pending' = any(${orders.needsAttention})`,
            createdByStaffUserId: orders.createdByStaffUserId,
          })
          .from(orders)
          .where(and(eq(orders.channelId, parsed.channelId), inArray(normalizedNo, fileOrderNos)))
          .orderBy(orders.orderNo);
  const existingByNo = new Map<string, ExistingRow[]>();
  for (const row of existingRows) {
    existingByNo.set(row.normalizedNo, [...(existingByNo.get(row.normalizedNo) ?? []), row]);
  }

  const existingIds = existingRows.map((row) => row.id);
  const storedItems = new Map<string, { sku: string; qty: number; unitPrice: number }[]>();
  const storedFees = new Map<string, Map<ChannelFeeComponent, number>>();
  if (existingIds.length > 0) {
    for (const item of await db
      .select({ orderId: orderItems.orderId, sku: orderItems.sku, qty: orderItems.qty, unitPrice: orderItems.unitPrice })
      .from(orderItems)
      .where(inArray(orderItems.orderId, existingIds))) {
      storedItems.set(item.orderId, [...(storedItems.get(item.orderId) ?? []), item]);
    }
    for (const fee of await db
      .select({ orderId: orderChannelFees.orderId, component: orderChannelFees.component, amount: orderChannelFees.amount })
      .from(orderChannelFees)
      .where(inArray(orderChannelFees.orderId, existingIds))) {
      const byComponent = storedFees.get(fee.orderId) ?? new Map<ChannelFeeComponent, number>();
      byComponent.set(fee.component, fee.amount);
      storedFees.set(fee.orderId, byComponent);
    }
  }

  // Physical stock only (web holds are not consulted for marketplace sales, SPEC §5.2), the same
  // sum the stock ledger checks. Read once; the cumulative check below spends it file-wide.
  const physical = new Map<string, number>();
  if (knownSkus.size > 0) {
    for (const row of await db
      .select({ sku: stockMovements.sku, qty: sql<string>`coalesce(sum(${stockMovements.qty}), 0)::bigint` })
      .from(stockMovements)
      .where(inArray(stockMovements.sku, [...knownSkus]))
      .groupBy(stockMovements.sku)) {
      // bigint arrives as a string from postgres.js (a raw sql fragment bypasses column mapping).
      physical.set(row.sku, Number(row.qty));
    }
  }

  const [previous] = await db
    .select({ batchId: importBatches.id, committedAt: importBatches.committedAt })
    .from(importBatches)
    // Per channel by design: the same bytes on another channel are another import.
    .where(
      and(eq(importBatches.channelId, parsed.channelId), eq(importBatches.fileSha256, parsed.fileSha256), eq(importBatches.status, "committed"), isNotNull(importBatches.committedAt)),
    )
    .orderBy(desc(importBatches.committedAt))
    .limit(1);

  // ---- Decisions (pure from here on) ----
  const entries: PlanEntry[] = [];
  const unknownGroups = new Map<string, UnknownSkuGroup>();
  const allocated = new Map<string, number>();

  for (const problem of parsed.problems) {
    const matches = existingByNo.get(problem.channelOrderNo) ?? [];
    entries.push({
      action: "review",
      channelOrderNo: problem.channelOrderNo,
      rowNumbers: problem.rowNumbers,
      existing: matches.length === 1 ? existingRef(matches[0]!) : null,
      reasons: [{ code: problem.code, message: problem.message }],
    });
  }

  const planOrder = (order: ImportOrder): PlanEntry => {
    const base = { channelOrderNo: order.channelOrderNo, rowNumbers: order.rowNumbers };
    const matches = existingByNo.get(order.channelOrderNo) ?? [];
    if (matches.length > 1) {
      return {
        ...base,
        action: "review",
        existing: null,
        reasons: [
          {
            code: "ambiguous_match",
            message: `Nomor pesanan ini cocok dengan lebih dari satu pesanan di admin (${matches.map((row) => row.orderNo).join(", ")}). Periksa manual.`,
          },
        ],
      };
    }
    const current = matches[0] ?? null;
    const reviewOf = (reasons: ReviewReason[]): ReviewEntry => ({ ...base, action: "review", existing: current ? existingRef(current) : null, reasons });

    const decision = decideStatus(statusMap[order.statusKey]?.rule, current ? { status: current.status, returnPending: current.returnPending } : null);
    // Skipped before anything else: an order that will not be imported needs no SKU or stock.
    if (decision.kind === "skip") return { ...base, action: "skip", reason: decision.reason, rawStatus: order.rawStatus };

    const reasons: ReviewReason[] = [];
    if (decision.kind === "review") reasons.push({ code: decision.reason, message: decision.message });
    else if (order.rawStatus.length > MAX_CHANNEL_STATUS_CHARS) reasons.push({ code: "unknown_status", message: "Status pesanan ini terlalu panjang, jadi pesanan belum diimpor." });

    const resolved = resolveLines(order.lines, knownSkus, overrides);
    for (const line of resolved.unknown) {
      const key = line.sku ?? "";
      const group = unknownGroups.get(key) ?? { fileSku: line.sku, nameHints: [], orders: [] };
      for (const hint of line.nameHints) if (!group.nameHints.includes(hint) && group.nameHints.length < 3) group.nameHints.push(hint);
      group.orders.push({ channelOrderNo: order.channelOrderNo, rowNumbers: line.rowNumbers });
      unknownGroups.set(key, group);
      reasons.push({
        code: "unknown_sku",
        sku: line.sku,
        message:
          line.sku === null
            ? `SKU kosong di baris ${line.rowNumbers.join(", ")}.`
            : `SKU tidak dikenal: ${line.sku} (baris ${line.rowNumbers.join(", ")}). Perbaiki SKU di ${channelLabel} supaya impor berikutnya cocok otomatis, atau cocokkan ke varian.`,
      });
    }

    const subtotalAmount = resolved.lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
    if (resolved.unknown.length === 0 && order.sellerVoucherAmount > subtotalAmount) {
      reasons.push({ code: "voucher_exceeds_subtotal", message: "Voucher penjual lebih besar dari total harga produk, jadi pesanan belum diimpor." });
    }

    if (current && resolved.unknown.length === 0) {
      const differing = linesDiffer(resolved.lines, storedItems.get(current.id) ?? []);
      if (differing.length > 0) {
        reasons.push({
          code: "lines_differ",
          message: `Item di marketplace berbeda dengan yang tercatat di ${current.orderNo} (${differing.join(", ")}). Item tidak diubah oleh impor; periksa manual di halaman pesanan.`,
        });
      }
    }
    if (reasons.length > 0) return reviewOf(reasons);

    // Stock leaves when the order reaches to_ship: at creation for a new order, or on an existing
    // order's awaiting_payment -> to_ship step. Cumulative across the file (plan §7); a short order
    // spends nothing, so a later smaller one may still fit.
    const needsStock = decision.kind === "create" || (decision.kind === "update" && decision.transitions.includes("to_ship"));
    if (needsStock) {
      const short = resolved.lines.flatMap((line) => {
        const remaining = (physical.get(line.sku) ?? 0) - (allocated.get(line.sku) ?? 0);
        return remaining < line.qty ? [{ code: "stock_short" as const, sku: line.sku, message: `Stok ${line.sku} di admin tersisa ${Math.max(remaining, 0)}, pesanan butuh ${line.qty}.` }] : [];
      });
      if (short.length > 0) return reviewOf(short);
      for (const line of resolved.lines) allocated.set(line.sku, (allocated.get(line.sku) ?? 0) + line.qty);
    }

    if (decision.kind === "create") {
      return {
        ...base,
        action: "create",
        rawStatus: order.rawStatus,
        orderedAt: order.orderedAt,
        lines: resolved.lines,
        subtotalAmount,
        discountAmount: order.sellerVoucherAmount,
        totalAmount: subtotalAmount - order.sellerVoucherAmount,
        roundingDifference: resolved.lines.reduce((sum, line) => sum + line.lineTotal, 0) - subtotalAmount,
        fees: Object.fromEntries(feesInCanonicalOrder(order.fees)),
        transitions: decision.transitions,
        setReturnPending: decision.setReturnPending,
        skuMatches: resolved.matches,
      };
    }

    // An existing order (decision is update or unchanged; review returned above).
    if (!current) throw new Error(`planImport: decision ${decision.kind} without an admin order (${order.channelOrderNo})`);
    const existing = current;
    const warnings: string[] = [];
    // order_date is never changed by an import (decision 13). Manual orders carry Jakarta midnight
    // of the typed date, so only a different CALENDAR day is worth a warning.
    if (jakartaDate(order.orderedAt) !== jakartaDate(existing.orderDate)) {
      warnings.push(`Tanggal pesanan di file (${formatDate(order.orderedAt)}) berbeda dengan di admin (${formatDate(existing.orderDate)}); tanggal di admin tidak diubah.`);
    }
    const discount = order.sellerVoucherAmount !== existing.discountAmount ? { before: existing.discountAmount, after: order.sellerVoucherAmount } : null;
    const totalAmount = discount
      ? { before: existing.totalAmount, after: existing.subtotalAmount + existing.shippingAmount - order.sellerVoucherAmount }
      : null;
    const stored = storedFees.get(existing.id);
    const fees: FeeChange[] = feesInCanonicalOrder(order.fees).flatMap(([component, after]) => {
      const before = stored?.get(component) ?? null;
      return before === after ? [] : [{ component, before, after }];
    });
    const channelStatus = existing.channelStatus !== order.rawStatus ? { before: existing.channelStatus, after: order.rawStatus } : null;
    const statusChange = decision.kind === "update" ? decision : null;

    if (!statusChange && !discount && fees.length === 0 && !channelStatus) {
      return { ...base, action: "unchanged", existing: existingRef(existing), warnings };
    }
    return {
      ...base,
      action: "update",
      existing: existingRef(existing),
      rawStatus: order.rawStatus,
      transitions: statusChange?.transitions ?? [],
      setReturnPending: statusChange?.setReturnPending ?? false,
      clearReturnPending: statusChange?.clearReturnPending ?? false,
      discount,
      totalAmount,
      fees,
      channelStatus,
      warnings,
      skuMatches: resolved.matches,
    };
  };

  // Earliest order first, so the stock check hands short stock to the order placed first.
  const byTime = [...parsed.orders].sort((a, b) => a.orderedAt.getTime() - b.orderedAt.getTime() || compareText(a.channelOrderNo, b.channelOrderNo));
  for (const order of byTime) entries.push(planOrder(order));

  entries.sort((a, b) => compareText(a.channelOrderNo, b.channelOrderNo));

  const counts: Record<PlanAction, number> = { create: 0, update: 0, unchanged: 0, review: 0, skip: 0 };
  const totals: ImportPlan["totals"] = { newOrderCount: 0, newPieces: 0, newOmzetAmount: 0, newVoucherAmount: 0, newFeeAmount: 0 };
  const matchUse = new Map<string, SkuMatch & { channelOrderNos: string[] }>();
  for (const entry of entries) {
    counts[entry.action]++;
    if (entry.action === "create") {
      totals.newOrderCount++;
      totals.newPieces += entry.lines.reduce((sum, line) => sum + line.qty, 0);
      totals.newOmzetAmount += entry.totalAmount;
      totals.newVoucherAmount += entry.discountAmount;
      totals.newFeeAmount += Object.values(entry.fees).reduce((sum, amount) => sum + (amount ?? 0), 0);
    }
    if (entry.action === "create" || entry.action === "update") {
      for (const match of entry.skuMatches) {
        const use = matchUse.get(match.fileSku) ?? { ...match, channelOrderNos: [] };
        if (!use.channelOrderNos.includes(entry.channelOrderNo)) use.channelOrderNos.push(entry.channelOrderNo);
        matchUse.set(match.fileSku, use);
      }
    }
  }

  const unknownSkus = [...unknownGroups.values()]
    .map((group) => ({ ...group, orders: [...group.orders].sort((a, b) => compareText(a.channelOrderNo, b.channelOrderNo)) }))
    .sort((a, b) => compareText(a.fileSku ?? "", b.fileSku ?? ""));
  const skuMatches = [...matchUse.values()].sort((a, b) => compareText(a.fileSku, b.fileSku));

  return {
    ok: true,
    value: {
      channelId: parsed.channelId,
      entries,
      counts,
      totals,
      unknownSkus,
      skuMatches,
      saveBlockers: parsed.saveBlockers,
      previousCommit: previous && previous.committedAt ? { batchId: previous.batchId, committedAt: previous.committedAt } : null,
      digest: planDigest(parsed.channelId, entries),
    },
  };
}

// ---------- Digest ----------

/** What Simpan would do, and nothing else: per order its key, action, target, lines, amounts, fees
 * and the "before" values the commit relies on (plan §1). Messages, row numbers and name hints are
 * left out, so wording or display changes never invalidate a preview; a changed decision does. */
function digestPayload(entry: PlanEntry): unknown {
  const key = { no: entry.channelOrderNo, action: entry.action };
  switch (entry.action) {
    case "create":
      return {
        ...key,
        status: entry.rawStatus,
        orderedAt: entry.orderedAt.toISOString(),
        lines: entry.lines.map((line) => [line.sku, line.qty, line.unitPrice]),
        subtotal: entry.subtotalAmount,
        discount: entry.discountAmount,
        total: entry.totalAmount,
        fees: feesInCanonicalOrder(entry.fees),
        transitions: entry.transitions,
        returnPending: entry.setReturnPending,
        matches: entry.skuMatches.map((match) => [match.fileSku, match.adminSku]),
      };
    case "update":
      return {
        ...key,
        orderId: entry.existing.orderId,
        from: entry.existing.status,
        status: entry.rawStatus,
        transitions: entry.transitions,
        setReturnPending: entry.setReturnPending,
        clearReturnPending: entry.clearReturnPending,
        discount: entry.discount,
        total: entry.totalAmount,
        fees: entry.fees.map((fee) => [fee.component, fee.before, fee.after]),
        channelStatus: entry.channelStatus,
        matches: entry.skuMatches.map((match) => [match.fileSku, match.adminSku]),
      };
    case "unchanged":
      return { ...key, orderId: entry.existing.orderId, from: entry.existing.status };
    case "review":
      return { ...key, orderId: entry.existing?.orderId ?? null, reasons: entry.reasons.map((reason) => [reason.code, reason.sku ?? null]) };
    case "skip":
      return { ...key, reason: entry.reason };
  }
}

/** JSON with object keys sorted at every level, so equal plans always hash equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function planDigest(channelId: string, entries: readonly PlanEntry[]): string {
  const sorted = [...entries].sort((a, b) => compareText(a.channelOrderNo, b.channelOrderNo));
  return createHash("sha256")
    .update(canonicalJson({ version: 1, channelId, entries: sorted.map(digestPayload) }))
    .digest("hex");
}
