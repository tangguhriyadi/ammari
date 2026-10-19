import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  accessories,
  defectMovements,
  fabricColors,
  fabrics,
  goodsReceiptItems,
  goodsReceipts,
  productionBatchItems,
  products,
  productVariants,
  purchaseItems,
  staffUsers,
  type DefectDisposalType,
  type DefectItemKind,
  type DefectMovementType,
  type Size,
} from "@ammari/db/schema";
import { ActionError } from "@/lib/errors";
import { defaultDb, type Database, type Tx } from "@/lib/db";
import { toCentiQty } from "@/lib/receipts/valuation";

// The defect ledger (docs/plans/suppliers-goods-receipt.md §3.5, D14/D23, session S5): balances,
// the per-line settled reader the receipt paths use, the reject write and its reversal, and the
// read models for the stock and document pages. Nothing outside this module, the receipt code and
// the pages that deliberately show defect stock reads defect_movements — sellable stock, orders,
// packing and the storefront never see it (D14), by construction rather than by a WHERE clause.

export type DefectItemRef = { kind: "sku"; sku: string } | { kind: "fabric"; fabricId: string } | { kind: "accessory"; accessoryId: string };

export type DefectSourceLine = { purchaseItemId: string } | { productionBatchItemId: string };

export interface DefectBalance {
  qty: number;
  valueAmount: number;
}

function itemCondition(item: DefectItemRef): SQL {
  switch (item.kind) {
    case "sku":
      return eq(defectMovements.sku, item.sku);
    case "fabric":
      return eq(defectMovements.fabricId, item.fabricId);
    case "accessory":
      return eq(defectMovements.accessoryId, item.accessoryId);
  }
}

function itemColumns(item: DefectItemRef) {
  return {
    itemKind: item.kind,
    sku: item.kind === "sku" ? item.sku : null,
    fabricId: item.kind === "fabric" ? item.fabricId : null,
    accessoryId: item.kind === "accessory" ? item.accessoryId : null,
  };
}

function itemKey(item: DefectItemRef): string {
  return item.kind === "sku" ? `sku:${item.sku}` : item.kind === "fabric" ? `fabric:${item.fabricId}` : `accessory:${item.accessoryId}`;
}

/** An item's pooled defect stock: SUM(qty) / SUM(value_amount) over its ledger (D23), never a
 * stored counter. A write that decides on it must hold the item's row lock (the same
 * lockVariantForUpdate / lockFabricForUpdate / lockAccessoryForUpdate the sellable path takes). */
export async function getDefectBalance(item: DefectItemRef, db: Database = defaultDb): Promise<DefectBalance> {
  const [row] = await db
    .select({
      qty: sql<string>`coalesce(sum(${defectMovements.qty}), 0)`,
      valueAmount: sql<string>`coalesce(sum(${defectMovements.valueAmount}), 0)::bigint`,
    })
    .from(defectMovements)
    .where(itemCondition(item));
  return { qty: Number(row?.qty ?? 0), valueAmount: Number(row?.valueAmount ?? 0) };
}

/** The part of each source line's qtySettled (§4.2, D16) that lives in the defect ledger, and the
 * value booked with it: SUM over the line's rows with disposal_type NULL — rejects, returns to the
 * supplier, and their reversals (rejected − returned_out, net of reversals). Releases and their
 * reversals always carry a disposal_type (§3.5: copied onto the reversal), and never change
 * qtySettled. Keyed by the source line id. */
async function defectSettledByLine(
  column: typeof defectMovements.purchaseItemId | typeof defectMovements.productionBatchItemId,
  lineIds: readonly string[],
  db: Database,
): Promise<Map<string, DefectBalance>> {
  if (lineIds.length === 0) return new Map();
  const rows = await db
    .select({
      lineId: column,
      qty: sql<string>`sum(${defectMovements.qty})`,
      valueAmount: sql<string>`sum(${defectMovements.valueAmount})::bigint`,
    })
    .from(defectMovements)
    .where(and(inArray(column, [...lineIds]), isNull(defectMovements.disposalType)))
    .groupBy(column);
  return new Map(rows.map((row) => [row.lineId!, { qty: Number(row.qty), valueAmount: Number(row.valueAmount) }]));
}

export function getDefectSettledByPurchaseLine(lineIds: readonly string[], db: Database = defaultDb) {
  return defectSettledByLine(defectMovements.purchaseItemId, lineIds, db);
}

export function getDefectSettledByBatchLine(lineIds: readonly string[], db: Database = defaultDb) {
  return defectSettledByLine(defectMovements.productionBatchItemId, lineIds, db);
}

export interface RejectMovementInput {
  item: DefectItemRef;
  source: DefectSourceLine;
  goodsReceiptItemId: string;
  qty: number;
  valueAmount: number;
  occurredAt: string;
  note: string;
}

/** The reject write (§5 step 6): one 'reject' row per receipt line with qty_rejected > 0, mirroring
 * it 1:1 (defect_movements_reject_goods_receipt_item_unique_idx is the DB backstop). Runs inside
 * the receipt's transaction, after the caller locked the document row and then the item rows. */
export async function insertRejectMovements(tx: Tx, rows: readonly RejectMovementInput[], actorStaffUserId: string) {
  if (rows.length === 0) return [];
  return tx
    .insert(defectMovements)
    .values(
      rows.map((row) => ({
        ...itemColumns(row.item),
        type: "reject" as const,
        qty: row.qty,
        valueAmount: row.valueAmount,
        goodsReceiptItemId: row.goodsReceiptItemId,
        purchaseItemId: "purchaseItemId" in row.source ? row.source.purchaseItemId : null,
        productionBatchItemId: "productionBatchItemId" in row.source ? row.source.productionBatchItemId : null,
        occurredAt: row.occurredAt,
        note: row.note,
        createdByStaffUserId: actorStaffUserId,
      })),
    )
    .returning();
}

function itemRefOf(row: typeof defectMovements.$inferSelect): DefectItemRef {
  if (row.sku) return { kind: "sku", sku: row.sku };
  if (row.fabricId) return { kind: "fabric", fabricId: row.fabricId };
  if (row.accessoryId) return { kind: "accessory", accessoryId: row.accessoryId };
  throw new Error(`defect movement ${row.id} names no item`);
}

/** The reject half of §5 `reverseGoodsReceipt`, inside the caller's transaction (the document row
 * and every affected item row are already locked):
 * 1. find the 'reject' row of every receipt item with qty_rejected <> 0 and check the 1:1 mirror;
 * 2. refuse if a reject was already reversed on its own, or if its line has any live return or
 *    release ("Batalkan pengembalian atau pelepasan dulu" — reversing through a
 *    disposition would invalidate its recorded value), and, as a backstop, if the item's defect
 *    balance would go negative;
 * 3. insert one exact negating 'reversal' row per reject (same item and source line,
 *    goods_receipt_item_id = the REVERSAL receipt's item for that line) and stamp the originals. */
export async function reverseRejectsInTx(
  tx: Tx,
  params: {
    items: readonly { id: string; qtyRejected: number }[];
    reversalItemIdFor: (receiptItemId: string) => string;
    occurredAt: string;
    note: string;
  },
  actorStaffUserId: string,
) {
  const withRejects = params.items.filter((item) => toCentiQty(item.qtyRejected) !== 0n);
  if (withRejects.length === 0) return { reversals: [] };

  const rejects = await tx
    .select()
    .from(defectMovements)
    .where(and(eq(defectMovements.type, "reject"), inArray(defectMovements.goodsReceiptItemId, withRejects.map((item) => item.id))));
  const rejectByItem = new Map(rejects.map((row) => [row.goodsReceiptItemId!, row]));
  for (const item of withRejects) {
    const reject = rejectByItem.get(item.id);
    if (!reject || toCentiQty(reject.qty) !== toCentiQty(item.qtyRejected)) throw new Error(`receipt item ${item.id} and its reject movement disagree`);
    if (reject.reversedAt !== null) throw new ActionError("Barang cacat dari penerimaan ini sudah dibatalkan sebelumnya.");
  }

  // Order-independent on purpose: created_at is the transaction START time, so a return/release
  // that committed after a reject could still carry an earlier timestamp. Any live (non-reversed)
  // return or release on the same source line blocks reversing its rejects.
  for (const reject of rejects) {
    const sourceCondition = reject.purchaseItemId
      ? eq(defectMovements.purchaseItemId, reject.purchaseItemId)
      : eq(defectMovements.productionBatchItemId, reject.productionBatchItemId!);
    const [disposition] = await tx
      .select({ id: defectMovements.id })
      .from(defectMovements)
      .where(and(sourceCondition, inArray(defectMovements.type, ["return_out", "dispose"]), isNull(defectMovements.reversedAt)))
      .limit(1);
    if (disposition) {
      throw new ActionError(
        "Penerimaan ini tidak bisa dibatalkan karena barang cacatnya sudah dikembalikan atau dilepas. Batalkan pengembalian atau pelepasan dulu.",
      );
    }
  }

  // Backstop, per item (several lines of one receipt can never share an item, but sum anyway).
  const rejectedByItem = new Map<string, { item: DefectItemRef; centi: bigint }>();
  for (const reject of rejects) {
    const item = itemRefOf(reject);
    const entry = rejectedByItem.get(itemKey(item)) ?? { item, centi: 0n };
    entry.centi += toCentiQty(reject.qty);
    rejectedByItem.set(itemKey(item), entry);
  }
  for (const { item, centi } of rejectedByItem.values()) {
    const balance = await getDefectBalance(item, tx);
    if (toCentiQty(balance.qty) < centi) throw new ActionError("Pembatalan ini akan membuat stok barang cacat menjadi negatif.");
  }

  const reversals = await tx
    .insert(defectMovements)
    .values(
      rejects.map((reject) => ({
        itemKind: reject.itemKind,
        sku: reject.sku,
        fabricId: reject.fabricId,
        accessoryId: reject.accessoryId,
        type: "reversal" as const,
        qty: -reject.qty,
        valueAmount: -reject.valueAmount,
        goodsReceiptItemId: params.reversalItemIdFor(reject.goodsReceiptItemId!),
        purchaseItemId: reject.purchaseItemId,
        productionBatchItemId: reject.productionBatchItemId,
        occurredAt: params.occurredAt,
        reversesMovementId: reject.id,
        note: params.note,
        createdByStaffUserId: actorStaffUserId,
      })),
    )
    .returning();
  await tx
    .update(defectMovements)
    .set({ reversedAt: new Date(), reversedByStaffUserId: actorStaffUserId })
    .where(inArray(defectMovements.id, rejects.map((reject) => reject.id)));
  return { reversals };
}

// ---------- Reads ----------

/** Defect quantity per SKU (pooled across sources), for the stock-count page's read-only figure.
 * Quantity only, no value: safe for every caller. SKUs with no defect stock are absent. */
export async function getDefectQtyBySku(skus: readonly string[], db: Database = defaultDb): Promise<Map<string, number>> {
  if (skus.length === 0) return new Map();
  const rows = await db
    .select({ sku: defectMovements.sku, qty: sql<string>`sum(${defectMovements.qty})` })
    .from(defectMovements)
    .where(inArray(defectMovements.sku, [...skus]))
    .groupBy(defectMovements.sku);
  return new Map(rows.filter((row) => Number(row.qty) !== 0).map((row) => [row.sku!, Number(row.qty)]));
}

export interface DefectStockSkuRow {
  sku: string;
  productId: string;
  productName: string;
  colorName: string;
  size: Size;
  qty: number;
  /** Cost data: stripped (null) by the caller for a viewer without finance.view_profit. */
  valueAmount: number | null;
}

export interface DefectStockMaterialRow {
  kind: "fabric" | "accessory";
  id: string;
  name: string;
  qty: number;
  valueAmount: number | null;
}

/** "/stock/defects": every SKU with a non-zero defect balance. One grouped query. */
export async function listDefectStockSkus(db: Database = defaultDb): Promise<DefectStockSkuRow[]> {
  const rows = await db
    .select({
      sku: defectMovements.sku,
      productId: products.id,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      qty: sql<string>`sum(${defectMovements.qty})`,
      valueAmount: sql<string>`sum(${defectMovements.valueAmount})::bigint`,
    })
    .from(defectMovements)
    .innerJoin(productVariants, eq(productVariants.sku, defectMovements.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(defectMovements.itemKind, "sku"))
    .groupBy(defectMovements.sku, products.id, products.name, fabricColors.name, productVariants.size)
    .having(sql`sum(${defectMovements.qty}) <> 0`)
    .orderBy(products.name, fabricColors.name, productVariants.size);
  return rows.map((row) => ({ ...row, sku: row.sku!, qty: Number(row.qty), valueAmount: Number(row.valueAmount) }));
}

/** "/stock/defects": every fabric and accessory with a non-zero defect balance, fabrics first. */
export async function listDefectStockMaterials(db: Database = defaultDb): Promise<DefectStockMaterialRow[]> {
  const [fabricRows, accessoryRows] = await Promise.all([
    db
      .select({
        id: fabrics.id,
        name: fabrics.name,
        qty: sql<string>`sum(${defectMovements.qty})`,
        valueAmount: sql<string>`sum(${defectMovements.valueAmount})::bigint`,
      })
      .from(defectMovements)
      .innerJoin(fabrics, eq(fabrics.id, defectMovements.fabricId))
      .groupBy(fabrics.id, fabrics.name)
      .having(sql`sum(${defectMovements.qty}) <> 0`)
      .orderBy(fabrics.name),
    db
      .select({
        id: accessories.id,
        name: accessories.name,
        qty: sql<string>`sum(${defectMovements.qty})`,
        valueAmount: sql<string>`sum(${defectMovements.valueAmount})::bigint`,
      })
      .from(defectMovements)
      .innerJoin(accessories, eq(accessories.id, defectMovements.accessoryId))
      .groupBy(accessories.id, accessories.name)
      .having(sql`sum(${defectMovements.qty}) <> 0`)
      .orderBy(accessories.name),
  ]);
  return [
    ...fabricRows.map((row) => ({ kind: "fabric" as const, ...row, qty: Number(row.qty), valueAmount: Number(row.valueAmount) })),
    ...accessoryRows.map((row) => ({ kind: "accessory" as const, ...row, qty: Number(row.qty), valueAmount: Number(row.valueAmount) })),
  ];
}

export interface DocumentDefectMovementRow {
  id: string;
  type: DefectMovementType;
  itemKind: DefectItemKind;
  itemName: string;
  qty: number;
  /** Cost data: stripped (null) by the caller for a viewer without finance.view_profit. */
  valueAmount: number | null;
  disposalType: DefectDisposalType | null;
  proceedsAmount: number | null;
  occurredAt: string;
  receiptNo: string | null;
  note: string | null;
  createdAt: Date;
  createdByName: string | null;
  reversedAt: Date | null;
}

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

/** One document's defect history, newest first: every defect row naming one of its lines (a single
 * indexed read per §3.5 — the source line is always set). */
async function listDefectMovementsForLines(
  column: typeof defectMovements.purchaseItemId | typeof defectMovements.productionBatchItemId,
  lineIds: readonly string[],
  db: Database,
): Promise<DocumentDefectMovementRow[]> {
  if (lineIds.length === 0) return [];
  const rows = await db
    .select({
      id: defectMovements.id,
      type: defectMovements.type,
      itemKind: defectMovements.itemKind,
      fabricName: fabrics.name,
      accessoryName: accessories.name,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      qty: defectMovements.qty,
      valueAmount: defectMovements.valueAmount,
      disposalType: defectMovements.disposalType,
      proceedsAmount: defectMovements.proceedsAmount,
      occurredAt: defectMovements.occurredAt,
      receiptNo: goodsReceipts.receiptNo,
      note: defectMovements.note,
      createdAt: defectMovements.createdAt,
      createdByName: staffUsers.name,
      reversedAt: defectMovements.reversedAt,
    })
    .from(defectMovements)
    .leftJoin(fabrics, eq(fabrics.id, defectMovements.fabricId))
    .leftJoin(accessories, eq(accessories.id, defectMovements.accessoryId))
    .leftJoin(productVariants, eq(productVariants.sku, defectMovements.sku))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .leftJoin(goodsReceiptItems, eq(goodsReceiptItems.id, defectMovements.goodsReceiptItemId))
    .leftJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptItems.goodsReceiptId))
    .leftJoin(staffUsers, eq(staffUsers.id, defectMovements.createdByStaffUserId))
    .where(inArray(column, [...lineIds]))
    .orderBy(desc(defectMovements.createdAt), desc(defectMovements.id));
  return rows.map(({ fabricName, accessoryName, productName, colorName, size, ...row }) => ({
    ...row,
    itemName:
      row.itemKind === "sku" ? `${productName} · ${colorName} · ${sizeLabel(size ?? "")}` : ((fabricName ?? accessoryName) as string),
  }));
}

export async function listDefectMovementsForPurchase(purchaseId: string, db: Database = defaultDb): Promise<DocumentDefectMovementRow[]> {
  const lines = await db.select({ id: purchaseItems.id }).from(purchaseItems).where(eq(purchaseItems.purchaseId, purchaseId)).orderBy(asc(purchaseItems.id));
  return listDefectMovementsForLines(defectMovements.purchaseItemId, lines.map((line) => line.id), db);
}

export async function listDefectMovementsForBatch(batchId: string, db: Database = defaultDb): Promise<DocumentDefectMovementRow[]> {
  const lines = await db
    .select({ id: productionBatchItems.id })
    .from(productionBatchItems)
    .where(eq(productionBatchItems.productionBatchId, batchId))
    .orderBy(asc(productionBatchItems.id));
  return listDefectMovementsForLines(defectMovements.productionBatchItemId, lines.map((line) => line.id), db);
}

/** Cost figures stripped for a viewer without finance.view_profit (quantities always visible — the
 * same split /accessories applies to its own value_amount). */
export function stripDefectMovementAmounts(rows: readonly DocumentDefectMovementRow[], canViewProfit: boolean): DocumentDefectMovementRow[] {
  if (canViewProfit) return [...rows];
  return rows.map((row) => ({ ...row, valueAmount: null, proceedsAmount: null }));
}

/** Value still held in defect stock from one document's rows (net of reversals and, from S6, of
 * what was returned or released). Exact per row — the pool averages only across documents. */
export function heldDefectValue(rows: readonly DocumentDefectMovementRow[]): number | null {
  if (rows.some((row) => row.valueAmount === null)) return null;
  return rows.reduce((sum, row) => sum + (row.valueAmount ?? 0), 0);
}

