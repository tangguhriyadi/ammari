import "server-only";
import { and, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import {
  accessories,
  accessoryMovements,
  costComponents,
  fabrics,
  fabricColors,
  fabricStockMovements,
  productionBatches,
  productionBatchAccessoryOverrides,
  productionBatchFabricUsages,
  productionBatchCosts,
  productionBatchItems,
  products,
  productVariants,
  staffUsers,
  supplierPayments,
  suppliers,
} from "@ammari/db/schema";
import type { CostComponentType, CostComponentUnit, ProductionBatchStatus, ProductionReceiptStatus } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { ActionError, FieldError, isPostgresErrorCode, mapUniqueViolation } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { lockAccessoryForUpdate, lockFabricForUpdate } from "@/lib/inventory/db";
import { getAccessoryBalance } from "@/lib/inventory/accessories";
import { getFabricColorBalance } from "@/lib/inventory/fabric-stock";
import { valueDeltaForConsumption, type RawMaterialBalance } from "@ammari/commerce/moving-average";
import { lockProductionBatchForUpdate, type Tx } from "./db";
import { generateBatchNumber } from "./batch-number";
import { calculateUnitCost } from "./unit-cost";
import { allocateBatchHpp, costLineQuantity } from "./batch-hpp";
import { resolveAccessoryNeeds } from "./accessory-needs";
import { lockSelectableSuppliers } from "@/lib/suppliers/queries";
import { effectiveReceiptStatuses } from "@/lib/receipts/production";
import { summarizePayment, type PaymentSummary } from "@/lib/supplier-payments/status";

// ---------- Eligible SKUs for a fabric ----------

export interface EligibleSkuRow {
  sku: string;
  size: string;
  productId: string;
  productName: string;
  productSizeMode: "sized" | "all_size";
  colorId: string;
  colorName: string;
  colorHex: string | null;
}

/** Active variants of any product using this fabric — the SKU picker's source list. Flat rows;
 * grouped product -> color -> size client-side (same division of labor as VariantBuilder's own
 * color groups). */
export async function listEligibleSkusForFabric(fabricId: string, db: Database = defaultDb): Promise<EligibleSkuRow[]> {
  return db
    .select({
      sku: productVariants.sku,
      size: productVariants.size,
      productId: products.id,
      productName: products.name,
      productSizeMode: products.sizeMode,
      colorId: fabricColors.id,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(and(eq(productVariants.fabricId, fabricId), eq(productVariants.isActive, true)))
    .orderBy(products.name, fabricColors.name, productVariants.size);
}

export interface ProductUsingFabricRow {
  id: string;
  name: string;
}

/** The product(s) tied to this fabric REGARDLESS of variant active-state (`products.fabric_id`
 * directly, not through `product_variants`) — the "no active variants" messaging's link target.
 * `listEligibleSkusForFabric` above returning `[]` is ambiguous on its own: it could mean no
 * product uses this fabric at all, or it could mean a product DOES use it but every one of its
 * variants is currently deactivated (a very different, fixable-in-admin situation — see
 * ExtraCostLines' own doc comment). This distinguishes the two without changing
 * listEligibleSkusForFabric's own contract. */
export async function listProductsUsingFabric(fabricId: string, db: Database = defaultDb): Promise<ProductUsingFabricRow[]> {
  return db.select({ id: products.id, name: products.name }).from(products).where(eq(products.fabricId, fabricId)).orderBy(products.name);
}

// ---------- List ----------

/** The /production "Pembayaran" filter (docs/plans/purchase-payments.md §9), same tabs as
 * /purchases: "Tanpa tagihan" is listed under "Semua" only. */
export const BATCH_PAYMENT_FILTERS = ["unpaid", "partial", "paid"] as const;
export type BatchPaymentFilter = (typeof BATCH_PAYMENT_FILTERS)[number];

export interface ListBatchesRow {
  id: string;
  batchNo: string;
  producedAt: string;
  // `null` only for the one batch created before this column existed — the UI renders "—" for
  // it, never 0 (0 would falsely imply zero yards were actually used).
  fabricYards: number | null;
  status: ProductionBatchStatus;
  /** Output receipt progress (S4); always 'pending' for a draft. */
  receiptStatus: ProductionReceiptStatus;
  fabricName: string;
  totalPcs: number;
  /** Derived payment state over every payee (§3.2), null for a draft (no tagihan yet). The status
   * is visible to every viewer of the page (A8); the amounts are cost data, stripped by the
   * caller (stripBatchListPaymentAmounts). */
  payment: PaymentSummary | { status: PaymentSummary["status"] } | null;
}

export async function listBatches(
  filters: { status?: ProductionBatchStatus; payment?: BatchPaymentFilter },
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: ListBatchesRow[]; pagination: Pagination }> {
  // §3.2 in SQL: Σ of the batch's service lines (never fabric/accessories, A2) and Σ of its
  // non-voided payments. Mirrors computeBatchPaymentSummary's overall figure; queries.test.ts
  // asserts the two agree.
  const serviceTotals = db
    .select({
      productionBatchId: productionBatchCosts.productionBatchId,
      tagihan: sql<string>`sum(${productionBatchCosts.total})::bigint`.as("tagihan"),
    })
    .from(productionBatchCosts)
    .groupBy(productionBatchCosts.productionBatchId)
    .as("service_totals");
  const paidTotals = db
    .select({
      productionBatchId: supplierPayments.productionBatchId,
      paid: sql<string>`sum(${supplierPayments.amount})::bigint`.as("paid"),
    })
    .from(supplierPayments)
    .where(and(isNull(supplierPayments.voidedAt), isNotNull(supplierPayments.productionBatchId)))
    .groupBy(supplierPayments.productionBatchId)
    .as("batch_paid_totals");

  const tagihan = sql`coalesce(${serviceTotals.tagihan}, 0)`;
  const paid = sql`coalesce(${paidTotals.paid}, 0)`;
  const isPosted = eq(productionBatches.status, "posted");
  const paymentCondition = {
    unpaid: and(isPosted, sql`${paid} = 0 and ${tagihan} > 0`),
    partial: and(isPosted, sql`${paid} > 0 and ${paid} < ${tagihan}`),
    paid: and(isPosted, sql`${paid} > 0 and ${paid} >= ${tagihan}`),
  } satisfies Record<BatchPaymentFilter, SQL | undefined>;

  const conditions = [
    filters.status ? eq(productionBatches.status, filters.status) : undefined,
    filters.payment ? paymentCondition[filters.payment] : undefined,
  ].filter((c) => c !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // The count needs the two aggregates only when it filters on them.
  const countQuery = db.select({ totalCount: count() }).from(productionBatches).$dynamic();
  const [totalCountRow] = await (filters.payment
    ? countQuery
        .leftJoin(serviceTotals, eq(serviceTotals.productionBatchId, productionBatches.id))
        .leftJoin(paidTotals, eq(paidTotals.productionBatchId, productionBatches.id))
    : countQuery
  ).where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const rows = await db
    .select({
      id: productionBatches.id,
      batchNo: productionBatches.batchNo,
      producedAt: productionBatches.producedAt,
      fabricYards: productionBatches.fabricYards,
      status: productionBatches.status,
      receiptStatus: productionBatches.receiptStatus,
      fabricName: fabrics.name,
      totalPcs: sql<number>`coalesce(sum(${productionBatchItems.qty})::int, 0)`,
      tagihan: sql<string>`${tagihan}`,
      paid: sql<string>`${paid}`,
    })
    .from(productionBatches)
    .innerJoin(fabrics, eq(fabrics.id, productionBatches.fabricId))
    .leftJoin(productionBatchItems, eq(productionBatchItems.productionBatchId, productionBatches.id))
    .leftJoin(serviceTotals, eq(serviceTotals.productionBatchId, productionBatches.id))
    .leftJoin(paidTotals, eq(paidTotals.productionBatchId, productionBatches.id))
    .where(where)
    .groupBy(productionBatches.id, fabrics.name, serviceTotals.tagihan, paidTotals.paid)
    .orderBy(desc(productionBatches.producedAt), desc(productionBatches.batchNo))
    .limit(pagination.limit)
    .offset(pagination.offset);

  // Show the EFFECTIVE receipt status, the same one the batch page shows (see
  // BatchReceiptSummary.receiptStatus): a batch the previous release posted after migration 0025
  // is stored 'pending' though its at-posting stock already counts as received.
  const effective = await effectiveReceiptStatuses(rows, db);
  return {
    rows: rows.map(({ tagihan: rowTagihan, paid: rowPaid, ...row }) => ({
      ...row,
      receiptStatus: effective.get(row.id) ?? row.receiptStatus,
      payment: row.status === "posted" ? summarizePayment(Number(rowTagihan), Number(rowPaid)) : null,
    })),
    pagination,
  };
}

/** The list's payment amounts stripped for a viewer without finance.view_profit: the badge
 * stays (A8), every amount goes. */
export function stripBatchListPaymentAmounts(rows: ListBatchesRow[], canViewProfit: boolean): ListBatchesRow[] {
  if (canViewProfit) return rows;
  return rows.map((row) => ({ ...row, payment: row.payment ? { status: row.payment.status } : null }));
}

// ---------- Detail ----------

export interface BatchLineRow {
  id: string;
  sku: string;
  /** The SKU's product: groups lines for HPP per product (cost lines can be scoped to one). */
  productId: string;
  qty: number;
  // IS real cost data (the per-pcs HPP, computed at posting) — unlike every other field on this
  // row, this one is NOT safe to render outside a finance.view_profit-gated component. It is
  // only safe to SELECT here (not a leak in itself) because every current caller of
  // getBatchDetail either never renders it (ProductionBatchReadOnly ignores it entirely) or only
  // renders it already inside a `canViewProfit` branch (BatchCostsSection). Do not add a new
  // renderer of `lines` that prints this field without checking finance.view_profit first.
  unitCostAmount: number;
  size: string;
  colorName: string;
  colorHex: string | null;
  productName: string;
  productSizeMode: "sized" | "all_size";
  // The product's selling price — public information (shown on the catalog), not a cost figure,
  // so it's fine to include here for every caller regardless of finance.view_profit. Only the
  // Batas-HPP comparison that COMBINES this with cost data is gated (see BatchCostsSection).
  productBasePrice: number;
}

export interface BatchDetail {
  id: string;
  batchNo: string;
  fabricId: string;
  fabricName: string;
  producedAt: string;
  fabricYards: number | null;
  notes: string | null;
  status: ProductionBatchStatus;
  receiptStatus: ProductionReceiptStatus;
  postedAt: Date | null;
  postedByName: string | null;
  lines: BatchLineRow[];
  /** Yards per source bucket (quantities, not cost). Empty for a draft not yet saved with usage
   * rows and for every batch posted before stock per colour (its consumption was colourless). */
  fabricUsages: BatchFabricUsageRow[];
}

export interface BatchFabricUsageRow {
  /** `null` = "Tanpa warna". */
  fabricColorId: string | null;
  colorName: string | null;
  colorHex: string | null;
  /** The colour's CURRENT active state (true for "Tanpa warna"). */
  colorIsActive: boolean;
  yards: number;
}

/** Colours by name, "Tanpa warna" last (the order every per-colour list in the admin uses). */
function byColorName<T extends { colorName: string | null }>(a: T, b: T): number {
  if (a.colorName === null) return b.colorName === null ? 0 : 1;
  if (b.colorName === null) return -1;
  return a.colorName.localeCompare(b.colorName, "id");
}

async function listBatchFabricUsages(id: string, db: Database): Promise<BatchFabricUsageRow[]> {
  const rows = await db
    .select({
      fabricColorId: productionBatchFabricUsages.fabricColorId,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      colorIsActive: sql<boolean>`coalesce(${fabricColors.isActive}, true)`,
      yards: productionBatchFabricUsages.yards,
    })
    .from(productionBatchFabricUsages)
    .leftJoin(fabricColors, eq(fabricColors.id, productionBatchFabricUsages.fabricColorId))
    .where(eq(productionBatchFabricUsages.productionBatchId, id));
  return rows.sort(byColorName);
}

/** Deliberately selects ONLY non-cost columns from production_batches — fabric_cost_amount is
 * never part of this query's result at all, not merely hidden by the caller. fabric_yards is
 * NOT cost data (a physical quantity, not money) so every caller gets it regardless of
 * finance.view_profit — the "yard per pcs" hint needs it even for a production.manage-only
 * session. See getBatchCosts/getBatchExtraCosts for the separate, permission-gated queries. */
export async function getBatchDetail(id: string, db: Database = defaultDb): Promise<BatchDetail | null> {
  const [batch] = await db
    .select({
      id: productionBatches.id,
      batchNo: productionBatches.batchNo,
      fabricId: productionBatches.fabricId,
      fabricName: fabrics.name,
      producedAt: productionBatches.producedAt,
      fabricYards: productionBatches.fabricYards,
      notes: productionBatches.notes,
      status: productionBatches.status,
      receiptStatus: productionBatches.receiptStatus,
      postedAt: productionBatches.postedAt,
      postedByName: staffUsers.name,
    })
    .from(productionBatches)
    .innerJoin(fabrics, eq(fabrics.id, productionBatches.fabricId))
    .leftJoin(staffUsers, eq(staffUsers.id, productionBatches.postedByStaffUserId))
    .where(eq(productionBatches.id, id))
    .limit(1);
  if (!batch) return null;

  const lines = await db
    .select({
      id: productionBatchItems.id,
      sku: productionBatchItems.sku,
      qty: productionBatchItems.qty,
      unitCostAmount: productionBatchItems.unitCostAmount,
      productId: products.id,
      size: productVariants.size,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      productName: products.name,
      productSizeMode: products.sizeMode,
      productBasePrice: products.basePrice,
    })
    .from(productionBatchItems)
    .innerJoin(productVariants, eq(productVariants.sku, productionBatchItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(productionBatchItems.productionBatchId, id))
    .orderBy(products.name, fabricColors.name, productVariants.size);

  return { ...batch, lines, fabricUsages: await listBatchFabricUsages(id, db) };
}

export interface BatchFabricConsumptionRow {
  /** `null` = "Tanpa warna" (also every batch posted before stock per colour). */
  fabricColorId: string | null;
  colorName: string | null;
  colorHex: string | null;
  /** Positive yards consumed. */
  qty: number;
  /** Positive cost of that consumption — cost data, same gating contract as getBatchCosts. */
  valueAmount: number;
}

/** The posted batch's fabric cost per colour bucket, read back from its own
 * fabric_stock_movements rows (the ledger is the record, as for getBatchAccessoryConsumption).
 * Same gating contract as getBatchCosts. Empty for a draft. */
export async function getBatchFabricConsumption(id: string, db: Database = defaultDb): Promise<BatchFabricConsumptionRow[]> {
  const rows = await db
    .select({
      fabricColorId: fabricStockMovements.fabricColorId,
      colorName: fabricColors.name,
      colorHex: fabricColors.hex,
      qty: sql<string>`-sum(${fabricStockMovements.qty})`,
      valueAmount: sql<string>`-sum(${fabricStockMovements.valueAmount})::bigint`,
    })
    .from(fabricStockMovements)
    .leftJoin(fabricColors, eq(fabricColors.id, fabricStockMovements.fabricColorId))
    .where(and(eq(fabricStockMovements.refType, "production_batch"), eq(fabricStockMovements.refId, id)))
    .groupBy(fabricStockMovements.fabricColorId, fabricColors.name, fabricColors.hex);
  return rows.map((row) => ({ ...row, qty: Number(row.qty), valueAmount: Number(row.valueAmount) })).sort(byColorName);
}

export interface BatchCosts {
  fabricCostAmount: number;
}

/** The ONLY query function that reads production_batches.fabric_cost_amount — callers must gate
 * this behind `session.permissionKeys.includes("finance.view_profit")` THEMSELVES (same contract
 * as getCurrentCostAssumption/ProductBatasHpp in lib/products): render the Server Component that
 * calls this conditionally, so the component (and this query) never runs at all for a session
 * without the permission, rather than running it and hiding the result. Only ever meaningful once
 * `status = 'posted'` — a draft's fabric_cost_amount is still its 0 column default (the fabric
 * cost is no longer settable at draft time at all; see fabric-usage.ts (estimateFabricUsageCost) for the draft's
 * own live estimate instead). */
export async function getBatchCosts(id: string, db: Database = defaultDb): Promise<BatchCosts | null> {
  const [row] = await db
    .select({ fabricCostAmount: productionBatches.fabricCostAmount })
    .from(productionBatches)
    .where(eq(productionBatches.id, id))
    .limit(1);
  return row ?? null;
}

export interface ExtraCostLineRow {
  id: string;
  costComponentId: string;
  componentName: string;
  componentUnit: CostComponentUnit;
  costType: CostComponentType;
  quantity: number;
  unitPrice: number;
  total: number;
  /** Who is paid for this line (plan D9). `supplierName` is the line's own SNAPSHOT, taken when
   * the supplier was set, and is what every display uses, so a later rename of the supplier
   * never changes what a (posted) batch says. Both null for a line nobody attributed, including
   * every line from before migration 0023. */
  supplierId: string | null;
  supplierName: string | null;
  /** The referenced supplier's CURRENT active state (null when there is none) — lets the draft
   * form keep showing a since-deactivated supplier as the line's current value without offering
   * it as a new choice. Never used for the name (see supplierName). */
  supplierIsActive: boolean | null;
  /** "Berlaku untuk" (migration 0047): null = "Semua produk" (spread over the whole batch), else
   * the one product this line applies to, with its CURRENT name. */
  productId: string | null;
  productName: string | null;
}

/** Same gating contract as getBatchCosts — itemized extra costs are cost data too. */
export async function getBatchExtraCosts(id: string, db: Database = defaultDb): Promise<ExtraCostLineRow[]> {
  return db
    .select({
      id: productionBatchCosts.id,
      costComponentId: productionBatchCosts.costComponentId,
      componentName: productionBatchCosts.componentName,
      componentUnit: productionBatchCosts.componentUnit,
      costType: productionBatchCosts.costType,
      quantity: productionBatchCosts.quantity,
      unitPrice: productionBatchCosts.unitPrice,
      total: productionBatchCosts.total,
      supplierId: productionBatchCosts.supplierId,
      supplierName: productionBatchCosts.supplierName,
      supplierIsActive: suppliers.isActive,
      productId: productionBatchCosts.productId,
      productName: products.name,
    })
    .from(productionBatchCosts)
    .leftJoin(suppliers, eq(suppliers.id, productionBatchCosts.supplierId))
    .leftJoin(products, eq(products.id, productionBatchCosts.productId))
    .where(eq(productionBatchCosts.productionBatchId, id))
    .orderBy(productionBatchCosts.createdAt);
}

export interface BatchAccessoryConsumptionRow {
  accessoryId: string;
  accessoryName: string;
  /** Positive pcs consumed (the stored movement's own qty is negative — a consumption — this is
   * its absolute value, matching how the UI wants to display it). */
  qty: number;
  /** Positive cost of that consumption. Same gating contract as getBatchCosts — cost data. */
  valueAmount: number;
  /** Whether a production.manage session overrode this accessory's computed need before posting
   * (production_batch_accessory_overrides — the row is never deleted by posting, so it's still
   * readable afterward). A security-review finding on the override feature: a production.manage
   * session (which may lack finance.view_profit) can change a posted batch's recorded cost by
   * overriding how much of an accessory was "needed" — this flag lets a finance.view_profit
   * viewer at least SEE which lines were overridden, as a (lightweight, not a hard block) audit
   * signal, surfaced in BatchCostsSection. */
  overridden: boolean;
}

/** The posted batch's "Aksesoris" breakdown — one row per resolved accessory actually consumed
 * by this batch, read back from its own accessory_movements rows (ref_type='production_batch',
 * ref_id=this batch's id) rather than a separate summary table; the ledger IS the record. Same
 * gating contract as getBatchCosts/getBatchExtraCosts (cost data). Empty for a draft (no
 * consumption has happened yet) or a batch with no accessory recipe at all. */
export async function getBatchAccessoryConsumption(id: string, db: Database = defaultDb): Promise<BatchAccessoryConsumptionRow[]> {
  const rows = await db
    .select({
      accessoryId: accessoryMovements.accessoryId,
      accessoryName: accessories.name,
      qty: accessoryMovements.qty,
      valueAmount: accessoryMovements.valueAmount,
      overrideId: productionBatchAccessoryOverrides.id,
    })
    .from(accessoryMovements)
    .innerJoin(accessories, eq(accessories.id, accessoryMovements.accessoryId))
    .leftJoin(
      productionBatchAccessoryOverrides,
      and(
        eq(productionBatchAccessoryOverrides.productionBatchId, id),
        eq(productionBatchAccessoryOverrides.accessoryId, accessoryMovements.accessoryId),
      ),
    )
    .where(and(eq(accessoryMovements.refType, "production_batch"), eq(accessoryMovements.refId, id)))
    .orderBy(accessories.name);

  return rows.map((row) => ({
    accessoryId: row.accessoryId,
    accessoryName: row.accessoryName,
    qty: -row.qty,
    valueAmount: -row.valueAmount,
    overridden: row.overrideId !== null,
  }));
}

// ---------- Create / update / delete draft ----------

export interface BatchLineInput {
  sku: string;
  qty: number;
}

export interface ExtraCostLineInput {
  /** Omitted for a new line — present for an existing one, and MUST already belong to this
   * batch (see syncExtraCostLines, which rejects the whole save otherwise). */
  id?: string;
  costComponentId: string;
  /** No `quantity` field — NEVER submitted by the client for either cost_type. A 'variable'
   * line's quantity is always this batch's current total pcs, computed server-side on every
   * save (see syncExtraCostLines) and re-verified again at posting; a 'fixed' line's quantity is
   * always exactly 1 (its unit_price IS the flat per-batch amount). */
  unitPrice: number;
  /** Who is paid for this line (plan D9), with three meanings:
   *  - `undefined`: a NEW line takes the component's default supplier (if that supplier is
   *    still active, else none); an EXISTING line keeps whatever it has;
   *  - `null`: no supplier;
   *  - an id: that supplier. Must be ACTIVE when it is a new choice (a new line, or an existing
   *    line whose supplier changes); an existing line re-submitting its current, since-
   *    deactivated supplier is left alone. */
  supplierId?: string | null;
  /** "Berlaku untuk" (migration 0047), same three meanings as supplierId:
   *  - `undefined`: a NEW line applies to every product; an EXISTING line keeps its own;
   *  - `null`: "Semua produk", spread over the whole batch's pcs;
   *  - a product id: that product only. It must have SKUs in the lines being saved. */
  productId?: string | null;
}

export interface CreateDraftInput {
  fabricId: string;
  producedAt: string;
  /** Used only when `fabricUsages` is empty; otherwise fabric_yards is their sum. */
  fabricYards: number | null;
  notes?: string | null;
  lines: BatchLineInput[];
  /** The batch's fabric usage per source bucket (the whole set; omitted = none). Posting
   * requires at least one row. */
  fabricUsages?: FabricUsageInput[];
  /** `undefined` when the caller's session lacks finance.view_profit — see
   * ExtraCostLineInput/syncExtraCostLines' own doc comments for the `undefined`-means-"don't
   * touch" contract (not `?? []`, which would silently delete an existing owner-entered list on
   * an update by a session that can't see costs at all). Fabric cost itself is never part of
   * this input anymore — it's computed only at posting (see postBatch/fabric-usage.ts (estimateFabricUsageCost)). */
  extraCosts?: ExtraCostLineInput[];
}

/** One source bucket of a draft's fabric usage (docs/plans/fabric-colour-stock.md D6, A4). */
export interface FabricUsageInput {
  /** `null` = "Tanpa warna". Any colour of the batch's fabric, inactive included (it may still
   * hold stock). */
  fabricColorId: string | null;
  yards: number;
}

/** A stored usage row as the audit log records it (colour named, so the log reads without ids). */
interface FabricUsageAuditRow {
  fabricColorId: string | null;
  colorName: string;
  yards: number;
}

const MAX_FABRIC_USAGE_ROWS = 50;

/** Validates `usages` against the batch's fabric and replaces the batch's usage rows with them
 * (a draft's usage, like its lines, has no history worth keeping row by row). Returns the rows
 * with colour names for the audit entry. The composite FK (fabric_color_id, fabric_id) is the
 * real guarantee that a colour belongs to the fabric; the check here gives the message. */
async function replaceFabricUsages(
  tx: Tx,
  productionBatchId: string,
  fabricId: string,
  usages: readonly FabricUsageInput[],
): Promise<FabricUsageAuditRow[]> {
  const colors =
    usages.some((usage) => usage.fabricColorId !== null)
      ? await tx.select({ id: fabricColors.id, name: fabricColors.name }).from(fabricColors).where(eq(fabricColors.fabricId, fabricId))
      : [];
  const nameById = new Map(colors.map((color) => [color.id, color.name]));
  const seen = new Set<string>();
  const rows = usages.map((usage) => {
    const colorName = usage.fabricColorId === null ? "Tanpa warna" : nameById.get(usage.fabricColorId);
    if (colorName === undefined) throw new FieldError("fabricUsages", "Warna ini bukan warna bahan batch ini.");
    const key = usage.fabricColorId ?? "none";
    if (seen.has(key)) throw new FieldError("fabricUsages", `Warna ${colorName} muncul dua kali di pemakaian kain.`);
    seen.add(key);
    return { fabricColorId: usage.fabricColorId, colorName, yards: usage.yards };
  });

  await tx.delete(productionBatchFabricUsages).where(eq(productionBatchFabricUsages.productionBatchId, productionBatchId));
  if (rows.length > 0) {
    try {
      await tx
        .insert(productionBatchFabricUsages)
        .values(rows.map((row) => ({ productionBatchId, fabricId, fabricColorId: row.fabricColorId, yards: row.yards })));
    } catch (error) {
      // A colour deleted between the check above and this insert.
      if (isPostgresErrorCode(error, "23503")) throw new FieldError("fabricUsages", "Warna ini bukan warna bahan batch ini.");
      throw error;
    }
  }
  return rows;
}

/** The shape checks that need no database: row count and yards (> 0, 2 decimals, numeric(10,2)).
 * Run before anything is written, so fabric_yards = Σ rows can never hit a DB constraint first. */
function assertFabricUsageShape(usages: readonly FabricUsageInput[]): void {
  if (usages.length > MAX_FABRIC_USAGE_ROWS) throw new FieldError("fabricUsages", "Terlalu banyak baris pemakaian kain.");
  for (const usage of usages) {
    if (!Number.isFinite(usage.yards) || usage.yards <= 0) throw new FieldError("fabricUsages", "Yard pemakaian kain harus lebih dari 0.");
    if (Math.round(usage.yards * 100) / 100 !== usage.yards) throw new FieldError("fabricUsages", "Yard pemakaian kain maksimal 2 desimal.");
    if (usage.yards >= 100_000_000) throw new FieldError("fabricUsages", "Yard pemakaian kain terlalu besar.");
  }
  // fabric_yards = Σ rows is numeric(10,2) too: rows that each fit can still overflow together.
  if (usages.reduce((sum, usage) => sum + Math.round(usage.yards * 100), 0) >= 10_000_000_000) {
    throw new FieldError("fabricUsages", "Total yard pemakaian kain terlalu besar.");
  }
}

/** production_batches.fabric_yards for a save: the sum of the usage rows when there are any
 * (D6: the rows decide, so the old release and every reader of fabric_yards stay right), else the
 * typed total (a draft saved before any SKU, hence any colour, was picked). */
function fabricYardsFor(usages: readonly FabricUsageInput[], typedYards: number | null): number | null {
  if (usages.length === 0) return typedYards;
  return usages.reduce((sum, usage) => sum + Math.round(usage.yards * 100), 0) / 100;
}

async function insertLines(tx: Tx, productionBatchId: string, fabricId: string, lines: readonly BatchLineInput[]): Promise<void> {
  if (lines.length === 0) return;
  try {
    await tx.insert(productionBatchItems).values(
      lines.map((line) => ({
        productionBatchId,
        fabricId,
        sku: line.sku,
        qty: line.qty,
      })),
    );
  } catch (error) {
    // The composite FK (sku, fabric_id) -> product_variants(sku, fabric_id) is the real
    // guarantee that every line's SKU belongs to THIS batch's fabric — this just turns a raw
    // 23503 into a friendly, field-scoped message instead.
    if (isPostgresErrorCode(error, "23503")) {
      throw new FieldError("sku", "SKU ini bukan milik produk berbahan ini.");
    }
    // The action's own Zod schema already rejects a duplicate SKU within one submission (see
    // draftFieldsSchema), but this is also directly callable — mapUniqueViolation turns the DB's
    // own backstop (production_batch_items_batch_sku_key) into the same friendly message rather
    // than an opaque 23505 reaching the caller; rethrows anything else unrecognized.
    mapUniqueViolation(error, {
      production_batch_items_batch_sku_key: {
        field: "sku",
        message: "Satu SKU tidak boleh muncul dua kali dalam satu batch.",
      },
    });
  }
}

/** Diffs `lines` against whatever already exists for this batch — NOT a delete-all-reinsert
 * (unlike insertLines above): component_name/component_unit/cost_type must stay frozen at
 * whatever they were when a line was ORIGINALLY added, surviving later, unrelated edits to the
 * same draft (e.g. changing a different line's quantity must never re-snapshot this one). So:
 *  - a submitted line WITH an id updates ONLY unit_price (and recomputes quantity — see below);
 *    the component/name/unit/cost_type snapshot is never re-picked;
 *  - a submitted line with NO id is a fresh INSERT, snapshotting the component's CURRENT
 *    name/unit/cost_type, and must reference an ACTIVE component;
 *  - an existing row whose id is missing from the submitted set is DELETED.
 * Every id the client submits is checked against this batch's OWN rows FIRST — a mismatched id
 * (nonexistent, or belonging to a different batch entirely) rejects the WHOLE save rather than
 * silently no-op'ing on a scoped WHERE, since that could otherwise mask a real client bug.
 *
 * `quantity` is NEVER taken from the client for either existing or new lines (see
 * ExtraCostLineInput's own doc comment) — `totalPcs` (this batch's current `sum(qty)` across the
 * lines being saved in THIS SAME call) decides it: a 'variable' line's quantity is always
 * `totalPcs`, recomputed on every single save regardless of whether totalPcs actually changed, so
 * it can never silently drift; a 'fixed' line's quantity is always exactly 1. A 'variable' line
 * can't be saved while totalPcs is 0 (quantity > 0 is a DB CHECK) — rejected with a friendly
 * message rather than a raw constraint error.
 *
 * Supplier (plan D9, see ExtraCostLineInput.supplierId): unlike the component, a line's supplier
 * MAY change while the batch is a draft — it is who gets paid, not what the line is. Whenever it
 * is set or changed, `supplier_name` is snapshotted from the supplier's current name in the same
 * statement; an unchanged supplier is never re-snapshotted (a rename between two draft saves
 * doesn't silently rewrite the line). Every newly chosen supplier is checked and FOR SHARE-locked
 * by lockSelectableSuppliers before anything is written, so a concurrent deactivation can't slip
 * in between the check and the write. A posted batch never reaches here (updateDraft rejects it),
 * and prevent_posted_batch_cost_mutation rejects any change to its lines regardless.
 *
 * "Berlaku untuk" (migration 0047, see ExtraCostLineInput.productId): editable on an existing line
 * too while the batch is a draft. A scoped line's product must have pcs in `batchPcs` (the lines
 * being saved in this same call); a variable scoped line's quantity is that product's pcs (the
 * production_batch_costs_scoped_quantity trigger recomputes the same value). Returns the batch's
 * lines as saved, for the audit entry. */
async function syncExtraCostLines(
  tx: Tx,
  productionBatchId: string,
  lines: readonly ExtraCostLineInput[],
  batchPcs: BatchPcsByProduct,
): Promise<CostLineAuditRow[]> {
  const { totalPcs, pcsByProduct } = batchPcs;
  const existing = await tx
    .select()
    .from(productionBatchCosts)
    .where(eq(productionBatchCosts.productionBatchId, productionBatchId));
  const existingById = new Map(existing.map((row) => [row.id, row]));

  for (const line of lines) {
    if (line.id && !existingById.has(line.id)) {
      throw new ActionError("Salah satu baris biaya tidak ditemukan di batch ini.");
    }
  }

  const newLines = lines.filter((line) => !line.id);
  const componentIds = [...new Set(newLines.map((line) => line.costComponentId))];
  const components = componentIds.length > 0 ? await tx.select().from(costComponents).where(inArray(costComponents.id, componentIds)) : [];
  const componentById = new Map(components.map((component) => [component.id, component]));

  // "Berlaku untuk" each submitted line ends up with, checked before anything is written.
  const productIdOf = (line: ExtraCostLineInput): string | null =>
    line.productId !== undefined ? line.productId : line.id ? (existingById.get(line.id)!.productId ?? null) : null;
  const missingProductIds = [
    ...new Set(lines.map(productIdOf).filter((productId): productId is string => productId !== null && !pcsByProduct.has(productId))),
  ];
  if (missingProductIds.length > 0) {
    const names = await tx.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, missingProductIds));
    const nameById = new Map(names.map((row) => [row.id, row.name]));
    const line = lines.find((candidate) => productIdOf(candidate) === missingProductIds[0])!;
    const componentName = line.id ? existingById.get(line.id)!.componentName : (componentById.get(line.costComponentId)?.name ?? "ini");
    const productName = nameById.get(missingProductIds[0]!);
    throw new FieldError(
      "productId",
      productName
        ? `Biaya "${componentName}" berlaku untuk ${productName}, tetapi ${productName} tidak punya SKU di batch ini. Ubah "Berlaku untuk" atau hapus biaya itu dulu.`
        : `Produk untuk biaya "${componentName}" tidak ditemukan. Pilih "Berlaku untuk" lagi.`,
    );
  }

  // Explicit new choices: a new line naming a supplier, or an existing line changing to one.
  // These must be active, or the whole save is rejected.
  const chosenSupplierIds = lines
    .filter((line) => typeof line.supplierId === "string")
    .filter((line) => !line.id || existingById.get(line.id)!.supplierId !== line.supplierId)
    .map((line) => line.supplierId as string);
  const chosenSuppliers = await lockSelectableSuppliers(tx, chosenSupplierIds, "supplierId");

  // Implicit defaults: a new line that said nothing takes its component's default — but only
  // while that supplier is active. A deactivated default is silently not applied (the picker
  // never offered it either), rather than blocking the save over a prefill she never chose.
  const defaultSupplierIds = [
    ...new Set(
      newLines
        .filter((line) => line.supplierId === undefined)
        .map((line) => componentById.get(line.costComponentId)?.defaultSupplierId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
  const activeDefaults =
    defaultSupplierIds.length > 0
      ? await tx
          .select({ id: suppliers.id, name: suppliers.name })
          .from(suppliers)
          .where(and(inArray(suppliers.id, defaultSupplierIds), eq(suppliers.isActive, true)))
          .orderBy(suppliers.id)
          .for("share")
      : [];
  const activeDefaultById = new Map(activeDefaults.map((row) => [row.id, row]));

  const submittedIds = new Set(lines.filter((line) => line.id).map((line) => line.id!));
  const toDeleteIds = existing.filter((row) => !submittedIds.has(row.id)).map((row) => row.id);
  if (toDeleteIds.length > 0) {
    await tx
      .delete(productionBatchCosts)
      .where(and(inArray(productionBatchCosts.id, toDeleteIds), eq(productionBatchCosts.productionBatchId, productionBatchId)));
  }

  for (const line of lines) {
    if (!line.id) continue;
    const existingRow = existingById.get(line.id)!;
    if (existingRow.costType === "variable" && totalPcs <= 0) {
      throw new FieldError(
        "costComponentId",
        `Tambahkan minimal satu baris produksi (SKU) sebelum menyimpan biaya variabel "${existingRow.componentName}".`,
      );
    }
    const productId = productIdOf(line);
    const quantity = costLineQuantity({ costType: existingRow.costType, productId }, pcsByProduct, totalPcs);
    const supplierChange =
      line.supplierId === undefined || line.supplierId === existingRow.supplierId
        ? {}
        : line.supplierId === null
          ? { supplierId: null, supplierName: null }
          : { supplierId: line.supplierId, supplierName: chosenSuppliers.get(line.supplierId)!.name };
    await tx
      .update(productionBatchCosts)
      .set({ quantity, unitPrice: line.unitPrice, productId, ...supplierChange })
      .where(and(eq(productionBatchCosts.id, line.id), eq(productionBatchCosts.productionBatchId, productionBatchId)));
  }

  if (newLines.length > 0) {
    const values = newLines.map((line) => {
      const component = componentById.get(line.costComponentId);
      if (!component) throw new FieldError("costComponentId", "Komponen biaya tidak ditemukan.");
      // Only a NEW line requires an active component — an EXISTING line (handled in the update
      // loop above) never re-checks this, so a component deactivated after the line was added
      // keeps working, exactly as required.
      // KNOWN GAP (low impact, not fixed): this is read-then-write, not atomic — nothing stops a
      // concurrent setCostComponentActive(componentId, false) from committing between the SELECT
      // above and this INSERT, so a brand-new line could end up referencing a component that's
      // inactive by the time this transaction commits. The batch row lock only serializes against
      // another write to THIS batch, not against a write to cost_components. Soft validation rule,
      // not a financial double-count — accepted rather than adding FOR SHARE/a stricter check.
      if (!component.isActive) {
        throw new FieldError("costComponentId", `Komponen "${component.name}" sudah dinonaktifkan dan tidak bisa dipakai untuk baris baru.`);
      }
      if (component.costType === "variable" && totalPcs <= 0) {
        throw new FieldError(
          "costComponentId",
          `Tambahkan minimal satu baris produksi (SKU) sebelum menambah biaya variabel "${component.name}".`,
        );
      }
      const supplier =
        line.supplierId === undefined
          ? component.defaultSupplierId
            ? activeDefaultById.get(component.defaultSupplierId)
            : undefined
          : line.supplierId === null
            ? undefined
            : chosenSuppliers.get(line.supplierId);
      const productId = productIdOf(line);
      return {
        productionBatchId,
        costComponentId: component.id,
        componentName: component.name,
        componentUnit: component.unit,
        costType: component.costType,
        quantity: costLineQuantity({ costType: component.costType, productId }, pcsByProduct, totalPcs),
        unitPrice: line.unitPrice,
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? null,
        productId,
      };
    });
    await tx.insert(productionBatchCosts).values(values);
  }

  return listCostLinesForAudit(tx, productionBatchId);
}

/** A cost line as the audit log records it: amounts plus "Berlaku untuk" named, so the log reads
 * without ids. */
interface CostLineAuditRow {
  componentName: string;
  costType: CostComponentType;
  quantity: number;
  unitPrice: number;
  total: number;
  supplierName: string | null;
  productId: string | null;
  /** "Semua produk" for a batch-wide line. */
  productName: string;
}

async function listCostLinesForAudit(tx: Tx, productionBatchId: string): Promise<CostLineAuditRow[]> {
  const rows = await tx
    .select({
      componentName: productionBatchCosts.componentName,
      costType: productionBatchCosts.costType,
      quantity: productionBatchCosts.quantity,
      unitPrice: productionBatchCosts.unitPrice,
      total: productionBatchCosts.total,
      supplierName: productionBatchCosts.supplierName,
      productId: productionBatchCosts.productId,
      productName: products.name,
    })
    .from(productionBatchCosts)
    .leftJoin(products, eq(products.id, productionBatchCosts.productId))
    .where(eq(productionBatchCosts.productionBatchId, productionBatchId))
    .orderBy(productionBatchCosts.createdAt, productionBatchCosts.id);
  return rows.map((row) => ({ ...row, productName: row.productId === null ? "Semua produk" : (row.productName ?? row.productId) }));
}

async function namedUnitCosts<T extends { productId: string }>(tx: Tx, rows: readonly T[]): Promise<(T & { productName: string })[]> {
  if (rows.length === 0) return [];
  const names = await tx
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(inArray(products.id, rows.map((row) => row.productId)));
  const nameById = new Map(names.map((row) => [row.id, row.name]));
  return rows.map((row) => ({ ...row, productName: nameById.get(row.productId) ?? row.productId }));
}

/** The batch's pcs per product, read back from its saved lines (each SKU belongs to one product).
 * Read after the lines are written in the same transaction, under the batch row lock. */
interface BatchPcsByProduct {
  totalPcs: number;
  pcsByProduct: Map<string, number>;
}

async function readBatchPcsByProduct(tx: Tx, productionBatchId: string): Promise<BatchPcsByProduct> {
  const rows = await tx
    .select({ productId: productVariants.productId, pcs: sql<number>`sum(${productionBatchItems.qty})::int` })
    .from(productionBatchItems)
    .innerJoin(productVariants, eq(productVariants.sku, productionBatchItems.sku))
    .where(eq(productionBatchItems.productionBatchId, productionBatchId))
    .groupBy(productVariants.productId);
  const pcsByProduct = new Map(rows.map((row) => [row.productId, Number(row.pcs)]));
  return { totalPcs: rows.reduce((sum, row) => sum + Number(row.pcs), 0), pcsByProduct };
}

/** A save that doesn't touch the cost lines (a session without finance.view_profit) must still
 * not leave a scoped line whose product just lost every SKU in the batch. */
async function assertScopedCostLinesHaveProducts(tx: Tx, productionBatchId: string, batchPcs: BatchPcsByProduct): Promise<void> {
  const scoped = await tx
    .select({ componentName: productionBatchCosts.componentName, productId: productionBatchCosts.productId, productName: products.name })
    .from(productionBatchCosts)
    .innerJoin(products, eq(products.id, productionBatchCosts.productId))
    .where(eq(productionBatchCosts.productionBatchId, productionBatchId));
  const orphan = scoped.find((row) => row.productId !== null && !batchPcs.pcsByProduct.has(row.productId));
  if (orphan) {
    throw new FieldError(
      "productId",
      `Biaya "${orphan.componentName}" berlaku untuk ${orphan.productName}, tetapi ${orphan.productName} tidak punya SKU di batch ini. Ubah "Berlaku untuk" atau hapus biaya itu dulu.`,
    );
  }
}

export async function createDraft(input: CreateDraftInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  const fabricUsages = input.fabricUsages ?? [];
  assertFabricUsageShape(fabricUsages);
  return db.transaction(async (tx) => {
    const batchNo = await generateBatchNumber(tx);
    const [batch] = await tx
      .insert(productionBatches)
      .values({
        fabricId: input.fabricId,
        batchNo,
        producedAt: input.producedAt,
        fabricYards: fabricYardsFor(fabricUsages, input.fabricYards),
        notes: input.notes ?? null,
      })
      .returning();
    if (!batch) throw new Error("failed to insert production batch");

    await insertLines(tx, batch.id, input.fabricId, input.lines);
    const usageAudit = await replaceFabricUsages(tx, batch.id, input.fabricId, fabricUsages);
    const costAudit =
      input.extraCosts !== undefined
        ? await syncExtraCostLines(tx, batch.id, input.extraCosts, await readBatchPcsByProduct(tx, batch.id))
        : undefined;

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "create",
      entityType: "production_batch",
      entityId: batch.id,
      after: { ...batch, lines: input.lines, fabricUsages: usageAudit, ...(costAudit ? { extraCosts: costAudit } : {}) },
    });
    return batch;
  });
}

export interface UpdateDraftInput {
  producedAt: string;
  /** Same contract as CreateDraftInput.fabricYards. */
  fabricYards: number | null;
  notes?: string | null;
  lines: BatchLineInput[];
  /** The whole set, replacing the draft's rows (omitted = none), like `lines`. */
  fabricUsages?: FabricUsageInput[];
  /** Same `undefined`-means-"don't touch" contract as CreateDraftInput.extraCosts — when
   * omitted, syncExtraCostLines isn't even called, so an existing owner-entered list is never
   * read or written. */
  extraCosts?: ExtraCostLineInput[];
}

/** The row lock (step 1) MUST happen before touching productionBatchItems OR
 * productionBatchCosts — a concurrent postBatch locks the SAME row first and blocks until this
 * whole transaction commits or rolls back, so there is no window where postBatch can compute
 * HPP from a partially-synced set of lines. (The posted-batch triggers are a second, independent
 * backstop — see migration 0007 — but the row lock is what actually prevents the race itself,
 * same reasoning lockProductForUpdate's own doc comment gives for the products feature.) */
export async function updateDraft(id: string, input: UpdateDraftInput, actorStaffUserId: string | null, db: Database = defaultDb) {
  const fabricUsages = input.fabricUsages ?? [];
  assertFabricUsageShape(fabricUsages);
  return db.transaction(async (tx) => {
    const before = await lockProductionBatchForUpdate(tx, id);
    if (!before) throw new ActionError("Batch tidak ditemukan.");
    if (before.status !== "draft") throw new ActionError("Batch yang sudah diposting tidak bisa diubah.");

    const [after] = await tx
      .update(productionBatches)
      .set({
        producedAt: input.producedAt,
        fabricYards: fabricYardsFor(fabricUsages, input.fabricYards),
        notes: input.notes ?? null,
      })
      .where(eq(productionBatches.id, id))
      .returning();
    if (!after) throw new Error("failed to update production batch");

    // Full replace, not a diff — a draft's lines have no history worth preserving row-by-row
    // (unlike the extra-cost lines' frozen snapshots), so the simplest correct model is "the
    // lines the form submitted are now the whole set".
    await tx.delete(productionBatchItems).where(eq(productionBatchItems.productionBatchId, id));
    await insertLines(tx, id, before.fabricId, input.lines);
    const usageAudit = await replaceFabricUsages(tx, id, before.fabricId, fabricUsages);

    const batchPcs = await readBatchPcsByProduct(tx, id);
    let costAudit: CostLineAuditRow[] | undefined;
    let costsBefore: CostLineAuditRow[] | undefined;
    if (input.extraCosts !== undefined) {
      costsBefore = await listCostLinesForAudit(tx, id);
      costAudit = await syncExtraCostLines(tx, id, input.extraCosts, batchPcs);
    } else {
      await assertScopedCostLinesHaveProducts(tx, id, batchPcs);
    }

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update",
      entityType: "production_batch",
      entityId: id,
      before: costsBefore ? { ...before, extraCosts: costsBefore } : before,
      after: { ...after, lines: input.lines, fabricUsages: usageAudit, ...(costAudit ? { extraCosts: costAudit } : {}) },
    });
    return after;
  });
}

export async function deleteDraft(id: string, actorStaffUserId: string | null, db: Database = defaultDb): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await lockProductionBatchForUpdate(tx, id);
    if (!before) throw new ActionError("Batch tidak ditemukan.");
    if (before.status !== "draft") throw new ActionError("Batch yang sudah diposting tidak bisa dihapus.");

    await tx.delete(productionBatches).where(eq(productionBatches.id, id));
    await writeAuditLog(tx, { actorStaffUserId, action: "delete", entityType: "production_batch", entityId: id, before });
  });
}

// ---------- Post ----------

export interface PostedBatchResult {
  id: string;
  /** ceil(total batch cost / total pcs): the batch average. Each SKU's own HPP is in `unitCosts`
   * (they differ only when a cost line is scoped to one product). */
  unitCostAmount: number;
  totalPcs: number;
  /** HPP per pcs per product, as written to that product's lines. */
  unitCosts: { productId: string; pcs: number; unitCostAmount: number }[];
}

/** Steps (ALL inside one transaction):
 * 1. `SELECT ... FOR UPDATE` the batch row FIRST — serializes a concurrent second post attempt;
 *    it blocks until this transaction commits, then sees status='posted' and fails cleanly
 *    instead of double-posting. Also serializes against a concurrent updateDraft the same way.
 * 2. Must be a draft, with at least one line and fabric_yards > 0.
 * 3. Resolve the accessory recipe for every line (resolveAccessoryNeeds) — any unresolved
 *    size-group row rejects immediately with a message naming every product/size/group (a
 *    configuration problem, not a stock race).
 * 3b. Read the fabric usage rows (docs/plans/fabric-colour-stock.md D6): at least one, and their
 *    sum must equal fabric_yards (a draft saved by the release before S5 has none).
 * 4. Lock the fabric row (always exactly one; it covers every colour bucket, D3), then every
 *    NEEDED accessory row in sorted id order — deterministic, avoids a deadlock against a concurrent post/purchase/adjustment on
 *    the same items (same reasoning saveStockCount sorts SKUs before locking).
 * 5. Collect EVERY shortage (each fabric colour bucket against its OWN balance, never the
 *    fabric total) before writing anything — rejects listing every
 *    short item in ONE message, not fail-fast on the first.
 * 6. Re-verify every variable-cost line's quantity against the batch's ACTUAL total pcs (never
 *    trusts whatever a prior draft save computed, or a client-submitted value — there is none).
 * 7. Value the fabric and every accessory's consumption at their CURRENT moving-average cost
 *    (valueDeltaForConsumption — the same zero-residual rule accessories/fabric adjustments
 *    already use applies for free), write one fabric_stock_movements row per usage
 *    row (its colour bucket, valued at that bucket's average, A1) and one accessory_movements row
 *    per resolved accessory (ref_type='production_batch').
 * 8. HPP per product (batch-hpp.ts, migration 0047): shared = fabricCost + Σ(accessory
 *    consumption costs) + Σ(batch-wide production_batch_costs.total, variable AND fixed), spread
 *    over every pcs; each line scoped to one product is spread over that product's pcs only.
 *    unitCost = ceil(shared / totalPcs + scoped / productPcs), written to that product's lines;
 *    with no scoped lines it is ceil(totalCost / totalPcs) on every line, as before. Frozen from
 *    here on (HPP is never rewritten, D20).
 * 9. status='posted', posted_at, posted_by_staff_user_id, fabric_cost_amount (computed, not
 *    user-entered — see fabric-usage.ts (estimateFabricUsageCost) for the draft's own non-binding estimate).
 *    receipt_status stays at its 'pending' default.
 * 10. One audit_log entry for the whole post.
 *
 * Posting writes NO finished-goods stock (docs/plans/suppliers-goods-receipt.md D4, session S4):
 * material is really consumed at cutting/hand-off, but the sewn output arrives later. It enters
 * sellable stock only when received (postGoodsReceiptForBatch, lib/receipts/production.ts), as a
 * 'production' movement valued at this line's frozen unit_cost_amount. */
export async function postBatch(id: string, actorStaffUserId: string, db: Database = defaultDb): Promise<PostedBatchResult> {
  return db.transaction(async (tx) => {
    const before = await lockProductionBatchForUpdate(tx, id);
    if (!before) throw new ActionError("Batch tidak ditemukan.");
    if (before.status !== "draft") throw new ActionError("Batch ini sudah diposting.");

    const lines = await tx.select().from(productionBatchItems).where(eq(productionBatchItems.productionBatchId, id));
    if (lines.length === 0) throw new ActionError("Tambahkan minimal satu baris produksi sebelum posting.");
    if (before.fabricYards === null || before.fabricYards <= 0) {
      throw new ActionError("Isi jumlah yard bahan sebelum posting.");
    }
    const fabricYards = before.fabricYards;
    const totalPcs = lines.reduce((sum, line) => sum + line.qty, 0);

    // Fabric usage per colour bucket (docs/plans/fabric-colour-stock.md D6). Read after the batch
    // lock: a concurrent updateDraft (which replaces these rows) holds the same lock.
    const usages = await tx
      .select({
        fabricColorId: productionBatchFabricUsages.fabricColorId,
        colorName: fabricColors.name,
        yards: productionBatchFabricUsages.yards,
      })
      .from(productionBatchFabricUsages)
      .leftJoin(fabricColors, eq(fabricColors.id, productionBatchFabricUsages.fabricColorId))
      .where(eq(productionBatchFabricUsages.productionBatchId, id));
    // A draft last saved by the release before S5 has fabric_yards but no rows.
    if (usages.length === 0) throw new ActionError("Isi pemakaian kain per warna lalu simpan.");
    const usageCenti = usages.reduce((sum, usage) => sum + Math.round(usage.yards * 100), 0);
    // Saves since S5 keep fabric_yards = Σ rows; only the previous release can drift them apart
    // (it rewrites fabric_yards without touching the rows). Never guess which one is right.
    if (usageCenti !== Math.round(fabricYards * 100)) {
      throw new ActionError(
        `Pemakaian kain per warna (${(usageCenti / 100).toFixed(2)} yard) tidak sama dengan jumlah yard batch (${fabricYards.toFixed(2)} yard). Buka draf, periksa pemakaian kain, lalu simpan.`,
      );
    }
    usages.sort(byColorName);

    const { neededByAccessoryId, unresolved } = await resolveAccessoryNeeds(
      lines.map((line) => ({ sku: line.sku, qty: line.qty })),
      tx,
    );
    if (unresolved.length > 0) {
      const names = unresolved
        .map((row) => `${row.productName} (ukuran ${row.size === "ALLSIZE" ? "All Size" : row.size}, grup "${row.sizeGroup}")`)
        .join("; ");
      throw new ActionError(`Resep aksesoris belum lengkap untuk: ${names}.`);
    }

    // One lock for every colour of the fabric (D3), then each usage row's OWN bucket balance:
    // another colour's stock (or the fabric total) never covers this one.
    const fabric = await lockFabricForUpdate(tx, before.fabricId);
    if (!fabric) throw new Error("fabric not found for an existing production batch");
    const usageBalances = [];
    for (const usage of usages) {
      usageBalances.push({ ...usage, balance: await getFabricColorBalance(before.fabricId, usage.fabricColorId, tx) });
    }

    const accessoryIds = [...neededByAccessoryId.keys()].sort();
    const overrideRows =
      accessoryIds.length > 0
        ? await tx
            .select()
            .from(productionBatchAccessoryOverrides)
            .where(
              and(
                eq(productionBatchAccessoryOverrides.productionBatchId, id),
                inArray(productionBatchAccessoryOverrides.accessoryId, accessoryIds),
              ),
            )
        : [];
    const overrideByAccessoryId = new Map(overrideRows.map((row) => [row.accessoryId, row.overrideQty]));

    const accessoryBalanceBefore = new Map<string, RawMaterialBalance>();
    for (const accessoryId of accessoryIds) {
      const accessory = await lockAccessoryForUpdate(tx, accessoryId);
      if (!accessory) throw new Error("accessory not found for a resolved recipe need");
      accessoryBalanceBefore.set(accessoryId, await getAccessoryBalance(accessoryId, tx));
    }
    const accessoryRows = accessoryIds.length > 0 ? await tx.select().from(accessories).where(inArray(accessories.id, accessoryIds)) : [];
    const accessoryById = new Map(accessoryRows.map((row) => [row.id, row]));

    const effectiveNeedByAccessoryId = new Map<string, number>();
    // Every shortage, each colour bucket separately, in ONE message (whole hundredths of a yard,
    // never float compares).
    const shortages: string[] = [];
    for (const usage of usageBalances) {
      const shortCenti = Math.round(usage.yards * 100) - Math.round(usage.balance.qty * 100);
      if (shortCenti > 0) shortages.push(`${usage.colorName ?? "Tanpa warna"} kurang ${(shortCenti / 100).toFixed(2)} yard`);
    }
    for (const accessoryId of accessoryIds) {
      const computedQty = neededByAccessoryId.get(accessoryId)!;
      const effectiveQty = overrideByAccessoryId.get(accessoryId) ?? computedQty;
      effectiveNeedByAccessoryId.set(accessoryId, effectiveQty);
      const balance = accessoryBalanceBefore.get(accessoryId)!;
      if (effectiveQty > balance.qty) {
        shortages.push(`${accessoryById.get(accessoryId)?.name ?? accessoryId} kurang ${effectiveQty - balance.qty} pcs`);
      }
    }
    if (shortages.length > 0) {
      throw new ActionError(`Stok kurang: ${shortages.join(", ")}.`);
    }

    // Every scoped cost line's product must still have SKUs in the batch (a save by the previous
    // release could have removed them; the trigger rejects the line's next write, not this read).
    const batchPcs = await readBatchPcsByProduct(tx, id);
    const costLines = await tx
      .select({
        id: productionBatchCosts.id,
        componentName: productionBatchCosts.componentName,
        costType: productionBatchCosts.costType,
        productId: productionBatchCosts.productId,
        productName: products.name,
      })
      .from(productionBatchCosts)
      .leftJoin(products, eq(products.id, productionBatchCosts.productId))
      .where(eq(productionBatchCosts.productionBatchId, id));
    const orphan = costLines.find((line) => line.productId !== null && !batchPcs.pcsByProduct.has(line.productId));
    if (orphan) {
      throw new ActionError(
        `Biaya "${orphan.componentName}" berlaku untuk ${orphan.productName ?? "produk lain"}, tetapi produk itu tidak punya SKU di batch ini. Buka draf, ubah "Berlaku untuk" atau hapus biaya itu, lalu simpan.`,
      );
    }

    // Re-verify (never trust) every variable line's quantity — see this function's own doc
    // comment, step 6. Batch-wide lines take the batch's pcs; scoped lines their product's pcs.
    await tx
      .update(productionBatchCosts)
      .set({ quantity: totalPcs })
      .where(
        and(
          eq(productionBatchCosts.productionBatchId, id),
          eq(productionBatchCosts.costType, "variable"),
          isNull(productionBatchCosts.productId),
        ),
      );
    for (const line of costLines) {
      if (line.productId === null || line.costType !== "variable") continue;
      await tx
        .update(productionBatchCosts)
        .set({ quantity: costLineQuantity(line, batchPcs.pcsByProduct, totalPcs) })
        .where(eq(productionBatchCosts.id, line.id));
    }

    // One 'production' movement per usage row, valued at THAT bucket's moving average (A1). Each
    // bucket appears once (unique per batch), so its balance read above is still current. Exactly
    // -balance.qty when a row empties its bucket, so the zero-residual rule fires on an exact 0.
    const fabricConsumption = usageBalances.map((usage) => {
      const empties = Math.round(usage.yards * 100) === Math.round(usage.balance.qty * 100);
      // The ledger row's value (<= 0) and the cost it represents (>= 0) are kept apart.
      const movementValue = valueDeltaForConsumption(usage.balance, empties ? -usage.balance.qty : -usage.yards);
      return {
        fabricColorId: usage.fabricColorId,
        colorName: usage.colorName ?? "Tanpa warna",
        yards: usage.yards,
        movementValue,
        valueAmount: Math.abs(movementValue),
      };
    });
    await tx.insert(fabricStockMovements).values(
      fabricConsumption.map((row) => ({
        fabricId: before.fabricId,
        fabricColorId: row.fabricColorId,
        qty: -row.yards,
        valueAmount: row.movementValue,
        type: "production" as const,
        refType: "production_batch" as const,
        refId: id,
        createdByStaffUserId: actorStaffUserId,
      })),
    );
    const fabricCostAmount = fabricConsumption.reduce((sum, row) => sum + row.valueAmount, 0);

    let accessoryCostTotal = 0;
    // An override of exactly 0 means "none of this needed after all" — skipped entirely rather
    // than inserting a qty=0 movement, which the DB's own `qty <> 0` CHECK would reject anyway.
    const accessoryIdsToConsume = accessoryIds.filter((accessoryId) => (effectiveNeedByAccessoryId.get(accessoryId) ?? 0) > 0);
    if (accessoryIdsToConsume.length > 0) {
      const accessoryMovementValues = accessoryIdsToConsume.map((accessoryId) => {
        const effectiveQty = effectiveNeedByAccessoryId.get(accessoryId)!;
        const balance = accessoryBalanceBefore.get(accessoryId)!;
        const consumptionValue = valueDeltaForConsumption(balance, -effectiveQty);
        accessoryCostTotal += -consumptionValue;
        return {
          accessoryId,
          qty: -effectiveQty,
          valueAmount: consumptionValue,
          type: "production" as const,
          refType: "production_batch" as const,
          refId: id,
          createdByStaffUserId: actorStaffUserId,
        };
      });
      await tx.insert(accessoryMovements).values(accessoryMovementValues);
    }

    const extraCostRows = await tx
      .select({ total: productionBatchCosts.total, productId: productionBatchCosts.productId })
      .from(productionBatchCosts)
      .where(eq(productionBatchCosts.productionBatchId, id));
    const extraCostsTotal = extraCostRows.reduce((sum, row) => sum + row.total, 0);

    const totalCost = fabricCostAmount + accessoryCostTotal + extraCostsTotal;
    const unitCostAmount = calculateUnitCost(totalCost, totalPcs);
    const allocation = allocateBatchHpp({
      materialCost: fabricCostAmount + accessoryCostTotal,
      costLines: extraCostRows,
      products: [...batchPcs.pcsByProduct].map(([productId, pcs]) => ({ productId, pcs })),
    });

    // Each product's lines get that product's HPP (one UPDATE per product in the batch).
    for (const product of allocation.products) {
      await tx
        .update(productionBatchItems)
        .set({ unitCostAmount: product.unitCostAmount })
        .where(
          and(
            eq(productionBatchItems.productionBatchId, id),
            inArray(
              productionBatchItems.sku,
              tx.select({ sku: productVariants.sku }).from(productVariants).where(eq(productVariants.productId, product.productId)),
            ),
          ),
        );
    }
    const unitCosts = allocation.products.map(({ productId, pcs, unitCostAmount: productUnitCost }) => ({
      productId,
      pcs,
      unitCostAmount: productUnitCost,
    }));

    const [after] = await tx
      .update(productionBatches)
      .set({ status: "posted", postedAt: new Date(), postedByStaffUserId: actorStaffUserId, fabricCostAmount })
      .where(eq(productionBatches.id, id))
      .returning();
    if (!after) throw new Error("failed to update production batch");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "post",
      entityType: "production_batch",
      entityId: id,
      before,
      after: {
        ...after,
        unitCostAmount,
        totalPcs,
        fabricConsumption: fabricConsumption.map((row) => ({
          fabricColorId: row.fabricColorId,
          colorName: row.colorName,
          yards: row.yards,
          valueAmount: row.valueAmount,
        })),
        accessoryCostTotal,
        extraCostsTotal,
        // HPP per product (named, so the log reads without ids) and the cost lines with their
        // "Berlaku untuk" (migration 0047).
        unitCosts: await namedUnitCosts(tx, unitCosts),
        extraCosts: await listCostLinesForAudit(tx, id),
      },
    });

    return { id, unitCostAmount, totalPcs, unitCosts };
  });
}
