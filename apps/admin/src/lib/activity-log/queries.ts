import "server-only";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, notInArray, or, sql, type AnyColumn, type SQL, type Table } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { addCalendarDays, jakartaMidnight } from "@ammari/commerce/jakarta-day";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import {
  accessories,
  accessoryMovements,
  auditLog,
  costComponents,
  customers,
  defectMovements,
  fabricColors,
  fabricStockMovements,
  fabrics,
  goodsReceipts,
  importBatches,
  infoPages,
  orders,
  productImages,
  productTypes,
  productVariants,
  productionBatches,
  products,
  purchaseAttachments,
  purchases,
  roles,
  sizeCharts,
  staffUsers,
  stockMovements,
  storefrontHomepageSections,
  supplierPayments,
  suppliers,
  thankYouCards,
} from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { ACTIVITY_AREAS, NON_STAFF_ACTOR_LABELS, areaMembership, describeAction, type ActivityArea } from "./catalog";
import { type ActivityLogFilters, NON_STAFF_ACTOR_FILTER, isUuid } from "./filters";

// Read side of Log Aktivitas (docs/plans/activity-log.md). audit_log is append-only from this
// module's point of view: it only ever SELECTs, except exportActivityLog's own audit row.
// Indexes: every query is bounded by created_at (audit_log_created_at_idx); the actor and entity
// filters can also use audit_log_actor_staff_user_id_idx and audit_log_entity_idx; entity search
// resolves ids first so it can too (benchmarked at 1M rows, plan §1).

export type ActivityActor = { kind: "staff"; id: string; name: string; email: string } | { kind: "buyer" | "system"; label: string };

export interface EntityRef {
  typeLabel: string;
  label: string;
  href: string | null;
}

export interface ActivityLogRow {
  id: string;
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string;
  actionLabel: string;
  area: ActivityArea;
  areaLabel: string;
  actor: ActivityActor;
  entity: EntityRef;
}

export interface ActivityLogEntry extends ActivityLogRow {
  before: unknown;
  after: unknown;
}

/** Hard cap for the CSV download (plan §3). */
export const EXPORT_ROW_CAP = 5000;

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function areaCondition(area: ActivityArea): SQL | undefined {
  const membership = areaMembership(area);
  const parts: SQL[] = [];
  for (const { entityType, exceptActions } of membership.entityTypes) {
    parts.push(exceptActions.length > 0 ? and(eq(auditLog.entityType, entityType), notInArray(auditLog.action, exceptActions))! : eq(auditLog.entityType, entityType));
  }
  for (const { entityType, action } of membership.pairs) parts.push(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action))!);
  if (membership.excludeEntityTypes) parts.push(notInArray(auditLog.entityType, membership.excludeEntityTypes));
  return parts.length > 0 ? or(...parts) : sql`false`;
}

/** Entity search resolves at most this many matching entities; a broader search is flagged so
 * the page can ask for a narrower term (plan §3). */
export const SEARCH_TARGET_CAP = 500;

export interface SearchTargets {
  /** entity_type -> matching entity_id values (as stored: uuid text, product_type code, sku). */
  byType: Map<string, string[]>;
  /** production_batch_accessory_override rows are keyed "<batchId>:<accessoryId>". */
  overrideBatchIds: string[];
  truncated: boolean;
}

/** Step 1 of entity search (plan §1, review): one UNION ALL over the entity tables, capped, that
 * turns a name/number into (entity_type, id) pairs. Step 2 (searchCondition) filters audit_log on
 * literal id lists, which can use audit_log_entity_idx; an `entity_id IN (subquery)` per type
 * could not, and degraded to filtering every row in the date range. Every subquery here is
 * uncorrelated and reads only its own table. */
export async function resolveSearchTargets(db: Database, q: string, cap: number = SEARCH_TARGET_CAP): Promise<SearchTargets> {
  const pattern = likePattern(q);
  const asText = (table: Table, column: AnyColumn) => sql<string>`${qualifiedColumn(table, column)}::text`;
  const typed = (entityType: string) => sql<string>`${entityType}::text`;

  const matchedOrderIds = db.select({ id: orders.id }).from(orders).where(or(ilike(orders.orderNo, pattern), ilike(orders.channelOrderNo, pattern)));
  const variantMatchProductIds = db.select({ id: productVariants.productId }).from(productVariants).where(ilike(productVariants.sku, pattern));
  const matchedProductIds = db.select({ id: products.id }).from(products).where(or(ilike(products.name, pattern), ilike(products.code, pattern), inArray(products.id, variantMatchProductIds)));
  const matchedFabricIds = db.select({ id: fabrics.id }).from(fabrics).where(ilike(fabrics.name, pattern));
  const matchedAccessoryIds = db.select({ id: accessories.id }).from(accessories).where(ilike(accessories.name, pattern));
  const matchedPurchaseIds = db.select({ id: purchases.id }).from(purchases).where(ilike(purchases.purchaseNo, pattern));

  const query = unionAll(
    db.select({ entityType: typed("order"), id: asText(orders, orders.id) }).from(orders).where(inArray(orders.id, matchedOrderIds)),
    db.select({ entityType: typed("thank_you_card"), id: asText(thankYouCards, thankYouCards.id) }).from(thankYouCards).where(inArray(thankYouCards.orderId, matchedOrderIds)),
    // Product ids also cover product_variant/recipe rows and product_image "reorder" rows.
    db.select({ entityType: typed("product"), id: asText(products, products.id) }).from(products).where(inArray(products.id, matchedProductIds)),
    db.select({ entityType: typed("product_image"), id: asText(productImages, productImages.id) }).from(productImages).where(inArray(productImages.productId, matchedProductIds)),
    db.select({ entityType: typed("product_variant"), id: productVariants.sku }).from(productVariants).where(inArray(productVariants.productId, matchedProductIds)),
    db
      .select({ entityType: typed("stock_movement"), id: asText(stockMovements, stockMovements.id) })
      .from(stockMovements)
      .where(inArray(stockMovements.sku, db.select({ sku: productVariants.sku }).from(productVariants).where(inArray(productVariants.productId, matchedProductIds)))),
    db.select({ entityType: typed("product_type"), id: productTypes.code }).from(productTypes).where(or(ilike(productTypes.code, pattern), ilike(productTypes.name, pattern))),
    db.select({ entityType: typed("fabric"), id: asText(fabrics, fabrics.id) }).from(fabrics).where(inArray(fabrics.id, matchedFabricIds)),
    db.select({ entityType: typed("fabric_color"), id: asText(fabricColors, fabricColors.id) }).from(fabricColors).where(or(ilike(fabricColors.name, pattern), inArray(fabricColors.fabricId, matchedFabricIds))),
    db.select({ entityType: typed("fabric_stock_movement"), id: asText(fabricStockMovements, fabricStockMovements.id) }).from(fabricStockMovements).where(inArray(fabricStockMovements.fabricId, matchedFabricIds)),
    db.select({ entityType: typed("accessory"), id: asText(accessories, accessories.id) }).from(accessories).where(inArray(accessories.id, matchedAccessoryIds)),
    db.select({ entityType: typed("accessory_movement"), id: asText(accessoryMovements, accessoryMovements.id) }).from(accessoryMovements).where(inArray(accessoryMovements.accessoryId, matchedAccessoryIds)),
    db.select({ entityType: typed("supplier"), id: asText(suppliers, suppliers.id) }).from(suppliers).where(ilike(suppliers.name, pattern)),
    db.select({ entityType: typed("supplier_payment"), id: asText(supplierPayments, supplierPayments.id) }).from(supplierPayments).where(or(ilike(supplierPayments.paymentNo, pattern), ilike(supplierPayments.supplierName, pattern))),
    db.select({ entityType: typed("purchase"), id: asText(purchases, purchases.id) }).from(purchases).where(inArray(purchases.id, matchedPurchaseIds)),
    db.select({ entityType: typed("purchase_attachment"), id: asText(purchaseAttachments, purchaseAttachments.id) }).from(purchaseAttachments).where(inArray(purchaseAttachments.purchaseId, matchedPurchaseIds)),
    db.select({ entityType: typed("goods_receipt"), id: asText(goodsReceipts, goodsReceipts.id) }).from(goodsReceipts).where(ilike(goodsReceipts.receiptNo, pattern)),
    db.select({ entityType: typed("production_batch"), id: asText(productionBatches, productionBatches.id) }).from(productionBatches).where(ilike(productionBatches.batchNo, pattern)),
    db.select({ entityType: typed("cost_component"), id: asText(costComponents, costComponents.id) }).from(costComponents).where(ilike(costComponents.name, pattern)),
    db.select({ entityType: typed("size_chart"), id: asText(sizeCharts, sizeCharts.id) }).from(sizeCharts).where(ilike(sizeCharts.name, pattern)),
    db.select({ entityType: typed("info_page"), id: asText(infoPages, infoPages.id) }).from(infoPages).where(or(ilike(infoPages.title, pattern), ilike(infoPages.slug, pattern))),
    db.select({ entityType: typed("import_batch"), id: asText(importBatches, importBatches.id) }).from(importBatches).where(ilike(importBatches.filename, pattern)),
    db.select({ entityType: typed("customer"), id: asText(customers, customers.id) }).from(customers).where(or(ilike(customers.name, pattern), ilike(customers.email, pattern), ilike(customers.phone, pattern))),
    db.select({ entityType: typed("staff_user"), id: asText(staffUsers, staffUsers.id) }).from(staffUsers).where(or(ilike(staffUsers.name, pattern), ilike(staffUsers.email, pattern))),
    db.select({ entityType: typed("role"), id: asText(roles, roles.id) }).from(roles).where(or(ilike(roles.name, pattern), ilike(roles.key, pattern))),
  ).limit(cap + 1);

  const found = await query;
  const truncated = found.length > cap;
  const byType = new Map<string, string[]>();
  const add = (entityType: string, id: string) => byType.set(entityType, [...(byType.get(entityType) ?? []), id]);
  for (const { entityType, id } of truncated ? found.slice(0, cap) : found) {
    add(entityType, id);
    if (entityType === "product") for (const alias of PRODUCT_ID_ENTITY_TYPES) add(alias, id);
  }
  return { byType, overrideBatchIds: byType.get("production_batch") ?? [], truncated };
}

/** Entity types whose entity_id can be a product id. */
const PRODUCT_ID_ENTITY_TYPES = ["product_variant", "product_accessory_recipe", "product_image"];

/** Step 2: an exact entity id (any type), or one of the resolved (entity_type, id) pairs. */
function searchCondition(q: string, targets: SearchTargets): SQL {
  const exact = isUuid(q) ? q.toLowerCase() : q;
  const branches: SQL[] = [eq(auditLog.entityId, exact)];
  for (const [entityType, ids] of targets.byType) branches.push(and(eq(auditLog.entityType, entityType), inArray(auditLog.entityId, ids))!);
  if (targets.overrideBatchIds.length > 0) {
    branches.push(and(eq(auditLog.entityType, "production_batch_accessory_override"), inArray(sql`split_part(${qualifiedColumn(auditLog, auditLog.entityId)}, ':', 1)`, targets.overrideBatchIds))!);
  }
  return or(...branches)!;
}

export interface ResolvedFilters {
  where: SQL;
  /** The entity search matched more than SEARCH_TARGET_CAP entities; only the first are used. */
  searchTruncated: boolean;
}

export async function activityLogWhere(filters: ActivityLogFilters, db: Database = defaultDb): Promise<ResolvedFilters> {
  const targets = filters.q ? await resolveSearchTargets(db, filters.q) : null;
  const conditions: (SQL | undefined)[] = [
    gte(auditLog.createdAt, jakartaMidnight(filters.from)),
    lt(auditLog.createdAt, jakartaMidnight(addCalendarDays(filters.to, 1))),
    filters.actor === NON_STAFF_ACTOR_FILTER ? isNull(auditLog.actorStaffUserId) : filters.actor ? eq(auditLog.actorStaffUserId, filters.actor) : undefined,
    filters.area ? areaCondition(filters.area) : undefined,
    filters.q && targets ? searchCondition(filters.q, targets) : undefined,
  ];
  return { where: and(...conditions.filter((condition) => condition !== undefined))!, searchTruncated: targets?.truncated ?? false };
}

/** Payload keys that name an entity, for a row whose entity no longer exists. Deliberately no
 * `code`/`key`/`email`: a fallback label is shown unredacted on the list and in the CSV. */
const PAYLOAD_LABEL_KEYS = ["orderNo", "paymentNo", "purchaseNo", "receiptNo", "batchNo", "name", "title", "sku"] as const;

/** The first label-like value in `after`, then `before`, computed in SQL so the list and the CSV
 * never load whole payloads (only the detail page does). `->>` on a non-object is NULL. */
const LABEL_HINT = sql<string | null>`coalesce(${sql.join(
  (["after", "before"] as const).flatMap((side) => PAYLOAD_LABEL_KEYS.map((key) => sql`nullif(${qualifiedColumn(auditLog, auditLog[side])} ->> ${key}, '')`)),
  sql`, `,
)})`;

const ROW_COLUMNS = {
  id: auditLog.id,
  createdAt: auditLog.createdAt,
  action: auditLog.action,
  entityType: auditLog.entityType,
  entityId: auditLog.entityId,
  labelHint: LABEL_HINT,
  actorId: staffUsers.id,
  actorName: staffUsers.name,
  actorEmail: staffUsers.email,
};

type RawRow = { id: string; createdAt: Date; action: string; entityType: string; entityId: string; labelHint: string | null; actorId: string | null; actorName: string | null; actorEmail: string | null };

function selectRows(db: Database, where: SQL) {
  return db
    .select(ROW_COLUMNS)
    .from(auditLog)
    .leftJoin(staffUsers, eq(staffUsers.id, auditLog.actorStaffUserId))
    .where(where)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id));
}

export async function listActivityLog(
  filters: ActivityLogFilters,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: ActivityLogRow[]; pagination: Pagination; searchTruncated: boolean }> {
  const { where, searchTruncated } = await activityLogWhere(filters, db);
  const [countRow] = await db.select({ totalCount: sql<number>`count(*)::int` }).from(auditLog).where(where);
  // The page query needs the clamped page from the count, so the two run in sequence.
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: countRow?.totalCount ?? 0 });
  const raw = await selectRows(db, where).limit(pagination.limit).offset(pagination.offset);
  return { rows: await toRows(db, raw), pagination, searchTruncated };
}

/** At most `cap` rows plus whether more matched. Summary columns only: payloads never leave. */
export async function exportActivityLogRows(filters: ActivityLogFilters, cap: number = EXPORT_ROW_CAP, db: Database = defaultDb): Promise<{ rows: ActivityLogRow[]; truncated: boolean }> {
  const { where } = await activityLogWhere(filters, db);
  const raw = await selectRows(db, where).limit(cap + 1);
  const truncated = raw.length > cap;
  return { rows: await toRows(db, truncated ? raw.slice(0, cap) : raw), truncated };
}

/** The CSV download's own audit row (plan §3): who exported which filters, how many rows. */
export async function recordActivityLogExport(actorStaffUserId: string, filters: ActivityLogFilters, rowCount: number, truncated: boolean, db: Database = defaultDb): Promise<void> {
  await writeAuditLog(db, {
    actorStaffUserId,
    action: "export",
    entityType: "audit_log",
    entityId: `${filters.from}..${filters.to}`,
    after: { filters, rowCount, truncated },
  });
}

export async function getActivityLogEntry(id: string, db: Database = defaultDb): Promise<ActivityLogEntry | null> {
  if (!isUuid(id)) return null;
  const [raw] = await db
    .select({ ...ROW_COLUMNS, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .leftJoin(staffUsers, eq(staffUsers.id, auditLog.actorStaffUserId))
    .where(eq(auditLog.id, id.toLowerCase()))
    .limit(1);
  if (!raw) return null;
  const [row] = await toRows(db, [raw]);
  return { ...row!, before: raw.before, after: raw.after };
}

export interface ActorOption {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
}

/** Every staff account, active or not: a deactivated person's past actions stay filterable. */
export async function listActorOptions(db: Database = defaultDb): Promise<ActorOption[]> {
  return db
    .select({ id: staffUsers.id, name: staffUsers.name, email: staffUsers.email, isActive: staffUsers.isActive })
    .from(staffUsers)
    .orderBy(desc(staffUsers.isActive), asc(staffUsers.name));
}

async function toRows(db: Database, raw: RawRow[]): Promise<ActivityLogRow[]> {
  const entities = await resolveEntities(db, raw);
  return raw.map((row) => {
    const described = describeAction(row.entityType, row.action);
    const actor: ActivityActor =
      row.actorId !== null
        ? { kind: "staff", id: row.actorId, name: row.actorName ?? "", email: row.actorEmail ?? "" }
        : { kind: described.nonStaffActor, label: NON_STAFF_ACTOR_LABELS[described.nonStaffActor] };
    return {
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actionLabel: described.label,
      area: described.area,
      areaLabel: ACTIVITY_AREAS[described.area],
      actor,
      entity: entities.get(entityKey(row.entityType, row.entityId)) ?? fallbackEntity(row),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Entity labels and links. One lookup per entity type present on the page (ids batched), all in
// parallel. A row whose entity no longer exists (deleted fabric, batch) falls back to a
// name/number found in its own payload, then to a short id.

type Found = { label: string; href: string | null };
type Lookup = (db: Database, ids: string[]) => Promise<Map<string, Found>>;

const HOMEPAGE_SECTIONS: Record<string, Found> = {
  hero: { label: "Hero", href: "/content/hero" },
  product_grid: { label: "Grid produk", href: "/content/product-grid" },
  feature_block: { label: "Blok fitur", href: "/content/feature-block" },
  why_ammari: { label: "Kenapa Ammari", href: "/content/why-ammari" },
};

function entityKey(entityType: string, entityId: string): string {
  return `${entityType}\u0000${entityId}`;
}

function byId<T extends { id: string }>(rows: T[], toFound: (row: T) => Found): Map<string, Found> {
  return new Map(rows.map((row) => [row.id, toFound(row)]));
}

function uuids(ids: string[]): string[] {
  return ids.filter(isUuid);
}

const productLookup: Lookup = async (db, ids) => {
  const valid = uuids(ids);
  if (valid.length === 0) return new Map();
  const rows = await db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, valid));
  return byId(rows, (row) => ({ label: row.name, href: `/products/${row.id}` }));
};

const LOOKUPS: Record<string, Lookup> = {
  order: async (db, ids) => {
    const rows = await db.select({ id: orders.id, orderNo: orders.orderNo }).from(orders).where(inArray(orders.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.orderNo, href: `/orders/${row.id}` }));
  },
  thank_you_card: async (db, ids) => {
    const rows = await db
      .select({ id: thankYouCards.id, orderId: orders.id, orderNo: orders.orderNo })
      .from(thankYouCards)
      .innerJoin(orders, eq(orders.id, thankYouCards.orderId))
      .where(inArray(thankYouCards.id, uuids(ids)));
    return byId(rows, (row) => ({ label: `Kartu ${row.orderNo}`, href: `/orders/${row.orderId}` }));
  },
  customer: async (db, ids) => {
    const rows = await db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.name, href: null }));
  },
  product: productLookup,
  product_accessory_recipe: productLookup,
  product_variant: async (db, ids) => {
    const found = await productLookup(db, ids);
    const skus = ids.filter((id) => !isUuid(id));
    if (skus.length > 0) {
      const rows = await db.select({ sku: productVariants.sku, productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.sku, skus));
      for (const row of rows) found.set(row.sku, { label: row.sku, href: `/products/${row.productId}` });
    }
    return found;
  },
  product_image: async (db, ids) => {
    // upload/update/delete point at the image, reorder at the product.
    const found = await productLookup(db, ids);
    const rows = await db
      .select({ id: productImages.id, productId: products.id, name: products.name })
      .from(productImages)
      .innerJoin(products, eq(products.id, productImages.productId))
      .where(inArray(productImages.id, uuids(ids)));
    for (const row of rows) found.set(row.id, { label: `Foto ${row.name}`, href: `/products/${row.productId}` });
    return found;
  },
  product_type: async (db, ids) => {
    const rows = await db.select({ id: productTypes.code, name: productTypes.name }).from(productTypes).where(inArray(productTypes.code, ids));
    return byId(rows, (row) => ({ label: `${row.name} (${row.id})`, href: `/product-types/${encodeURIComponent(row.id)}` }));
  },
  fabric: async (db, ids) => {
    const rows = await db.select({ id: fabrics.id, name: fabrics.name }).from(fabrics).where(inArray(fabrics.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.name, href: `/fabrics/${row.id}` }));
  },
  fabric_color: async (db, ids) => {
    const rows = await db
      .select({ id: fabricColors.id, name: fabricColors.name, fabricId: fabrics.id, fabricName: fabrics.name })
      .from(fabricColors)
      .innerJoin(fabrics, eq(fabrics.id, fabricColors.fabricId))
      .where(inArray(fabricColors.id, uuids(ids)));
    return byId(rows, (row) => ({ label: `${row.fabricName} ${row.name}`, href: `/fabrics/${row.fabricId}` }));
  },
  fabric_stock_movement: async (db, ids) => {
    const rows = await db
      .select({ id: fabricStockMovements.id, fabricId: fabrics.id, name: fabrics.name })
      .from(fabricStockMovements)
      .innerJoin(fabrics, eq(fabrics.id, fabricStockMovements.fabricId))
      .where(inArray(fabricStockMovements.id, uuids(ids)));
    return byId(rows, (row) => ({ label: `Stok ${row.name}`, href: `/stock/fabrics/${row.fabricId}` }));
  },
  accessory: async (db, ids) => {
    const rows = await db.select({ id: accessories.id, name: accessories.name }).from(accessories).where(inArray(accessories.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.name, href: `/accessories/${row.id}` }));
  },
  accessory_movement: async (db, ids) => {
    const rows = await db
      .select({ id: accessoryMovements.id, accessoryId: accessories.id, name: accessories.name })
      .from(accessoryMovements)
      .innerJoin(accessories, eq(accessories.id, accessoryMovements.accessoryId))
      .where(inArray(accessoryMovements.id, uuids(ids)));
    return byId(rows, (row) => ({ label: `Stok ${row.name}`, href: `/stock/accessories/${row.accessoryId}` }));
  },
  stock_movement: async (db, ids) => {
    const rows = await db.select({ id: stockMovements.id, sku: stockMovements.sku }).from(stockMovements).where(inArray(stockMovements.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.sku, href: `/stock/${encodeURIComponent(row.sku)}` }));
  },
  defect_movement: async (db, ids) => {
    const rows = await db
      .select({ id: defectMovements.id, sku: defectMovements.sku, fabricName: fabrics.name, accessoryName: accessories.name })
      .from(defectMovements)
      .leftJoin(fabrics, eq(fabrics.id, defectMovements.fabricId))
      .leftJoin(accessories, eq(accessories.id, defectMovements.accessoryId))
      .where(inArray(defectMovements.id, uuids(ids)));
    return byId(rows, (row) => ({ label: `Cacat ${row.sku ?? row.fabricName ?? row.accessoryName ?? ""}`.trim(), href: "/stock/defects" }));
  },
  goods_receipt: async (db, ids) => {
    const rows = await db
      .select({ id: goodsReceipts.id, receiptNo: goodsReceipts.receiptNo, purchaseId: goodsReceipts.purchaseId, batchId: goodsReceipts.productionBatchId })
      .from(goodsReceipts)
      .where(inArray(goodsReceipts.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.receiptNo, href: row.purchaseId ? `/purchases/${row.purchaseId}` : row.batchId ? `/production/${row.batchId}` : "/receipts" }));
  },
  purchase: async (db, ids) => {
    const rows = await db.select({ id: purchases.id, purchaseNo: purchases.purchaseNo }).from(purchases).where(inArray(purchases.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.purchaseNo, href: `/purchases/${row.id}` }));
  },
  purchase_attachment: async (db, ids) => {
    const rows = await db
      .select({ id: purchaseAttachments.id, purchaseId: purchases.id, purchaseNo: purchases.purchaseNo })
      .from(purchaseAttachments)
      .innerJoin(purchases, eq(purchases.id, purchaseAttachments.purchaseId))
      .where(inArray(purchaseAttachments.id, uuids(ids)));
    return byId(rows, (row) => ({ label: `Lampiran ${row.purchaseNo}`, href: `/purchases/${row.purchaseId}` }));
  },
  supplier: async (db, ids) => {
    const rows = await db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(inArray(suppliers.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.name, href: `/suppliers/${row.id}` }));
  },
  supplier_payment: async (db, ids) => {
    const rows = await db
      .select({ id: supplierPayments.id, paymentNo: supplierPayments.paymentNo, purchaseId: supplierPayments.purchaseId, batchId: supplierPayments.productionBatchId, supplierId: supplierPayments.supplierId })
      .from(supplierPayments)
      .where(inArray(supplierPayments.id, uuids(ids)));
    return byId(rows, (row) => ({
      label: row.paymentNo,
      href: row.purchaseId ? `/purchases/${row.purchaseId}` : row.batchId ? `/production/${row.batchId}` : row.supplierId ? `/suppliers/${row.supplierId}` : null,
    }));
  },
  production_batch: async (db, ids) => {
    const rows = await db.select({ id: productionBatches.id, batchNo: productionBatches.batchNo }).from(productionBatches).where(inArray(productionBatches.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.batchNo, href: `/production/${row.id}` }));
  },
  production_batch_accessory_override: async (db, ids) => {
    const batchIdOf = (id: string) => id.split(":")[0] ?? "";
    const batchIds = uuids(ids.map(batchIdOf));
    if (batchIds.length === 0) return new Map();
    const rows = await db.select({ id: productionBatches.id, batchNo: productionBatches.batchNo }).from(productionBatches).where(inArray(productionBatches.id, batchIds));
    const batches = new Map(rows.map((row) => [row.id, row.batchNo]));
    const found = new Map<string, Found>();
    for (const id of ids) {
      const batchNo = batches.get(batchIdOf(id));
      if (batchNo) found.set(id, { label: batchNo, href: `/production/${batchIdOf(id)}` });
    }
    return found;
  },
  cost_component: async (db, ids) => {
    const rows = await db.select({ id: costComponents.id, name: costComponents.name }).from(costComponents).where(inArray(costComponents.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.name, href: `/production/cost-components/${row.id}` }));
  },
  size_chart: async (db, ids) => {
    const rows = await db.select({ id: sizeCharts.id, name: sizeCharts.name }).from(sizeCharts).where(inArray(sizeCharts.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.name, href: `/content/size-charts/${row.id}` }));
  },
  info_page: async (db, ids) => {
    const rows = await db.select({ id: infoPages.id, slug: infoPages.slug, title: infoPages.title }).from(infoPages).where(inArray(infoPages.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.title, href: `/content/pages/${encodeURIComponent(row.slug)}` }));
  },
  storefront_homepage_section: async (db, ids) => {
    const rows = await db.select({ id: storefrontHomepageSections.id, key: storefrontHomepageSections.key }).from(storefrontHomepageSections).where(inArray(storefrontHomepageSections.id, uuids(ids)));
    return byId(rows, (row) => HOMEPAGE_SECTIONS[row.key] ?? { label: row.key, href: "/content" });
  },
  store_settings: async (_db, ids) => new Map(ids.map((id) => [id, { label: "Pengaturan toko", href: "/content/settings" }])),
  sales_goal: async (_db, ids) => new Map(ids.map((id) => [id, { label: "Target penjualan", href: "/settings" }])),
  import_batch: async (db, ids) => {
    const rows = await db.select({ id: importBatches.id, filename: importBatches.filename }).from(importBatches).where(inArray(importBatches.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.filename, href: `/import/${row.id}` }));
  },
  staff_user: async (db, ids) => {
    const rows = await db.select({ id: staffUsers.id, name: staffUsers.name, email: staffUsers.email }).from(staffUsers).where(inArray(staffUsers.id, uuids(ids)));
    return byId(rows, (row) => ({ label: `${row.name} (${row.email})`, href: `/roles-staff/staff/${row.id}` }));
  },
  role: async (db, ids) => {
    const rows = await db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, uuids(ids)));
    return byId(rows, (row) => ({ label: row.name, href: `/roles-staff/roles/${row.id}` }));
  },
  audit_log: async (_db, ids) => new Map(ids.map((id) => [id, { label: id.replace("..", " s.d. "), href: null }])),
};

async function resolveEntities(db: Database, rows: RawRow[]): Promise<Map<string, EntityRef>> {
  const idsByType = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!Object.hasOwn(LOOKUPS, row.entityType)) continue;
    const ids = idsByType.get(row.entityType) ?? new Set<string>();
    ids.add(row.entityId);
    idsByType.set(row.entityType, ids);
  }
  const resolved = new Map<string, EntityRef>();
  await Promise.all(
    [...idsByType].map(async ([entityType, ids]) => {
      const list = [...ids];
      // inArray with an empty list is valid SQL in drizzle (renders false), but skip the round trip.
      const found = list.length > 0 ? await LOOKUPS[entityType]!(db, list) : new Map<string, Found>();
      const typeLabel = describeAction(entityType, "").entityTypeLabel;
      for (const [id, entry] of found) resolved.set(entityKey(entityType, id), { typeLabel, ...entry });
    }),
  );
  return resolved;
}

function fallbackEntity(row: RawRow): EntityRef {
  const typeLabel = describeAction(row.entityType, row.action).entityTypeLabel;
  const label = row.labelHint ?? (isUuid(row.entityId) ? row.entityId.slice(0, 8) : row.entityId);
  return { typeLabel, label, href: null };
}
