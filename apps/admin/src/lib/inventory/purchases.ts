import "server-only";
import { and, count, desc, eq, ilike, sql } from "drizzle-orm";
import { accessories, accessoryMovements, fabricStockMovements, fabrics, staffUsers } from "@ammari/db/schema";
import { resolvePagination, type Pagination } from "@ammari/ui/lib";
import { defaultDb, type Database } from "@/lib/db";

export type PurchaseItemType = "fabric" | "accessory";
export type PurchaseTypeFilter = PurchaseItemType | undefined;

// A purchase's own value_amount (the exact amount paid for THAT movement, never a running
// total) is cost data — gated by finance.view_profit, same as every other value_amount this
// codebase surfaces. `null` here means "stripped for this viewer", not "unknown": the CALLER
// (the page, not this function) strips it via stripPurchaseAmount/stripPurchaseAmounts below,
// same discipline accessories/page.tsx already applies to its own valueAmount column.
export interface PurchaseListRow {
  id: string;
  itemType: PurchaseItemType;
  itemId: string;
  itemName: string;
  qty: number;
  totalAmountPaid: number | null;
  // The column itself is nullable (purchased_at is only required for type='purchase' rows —
  // see fabric_stock_movements_purchased_at_pair_check/accessory_movements_... of the same
  // name), but every query in this file filters `type = 'purchase'`, so it is NEVER actually
  // null here — asserted non-null at each mapping site below rather than widened to
  // `string | null` and re-checked at every call site for a case that can't occur.
  purchasedAt: string;
  supplier: string | null;
  voidedAt: Date | null;
  createdAt: Date;
}

export interface PurchaseDetail extends PurchaseListRow {
  note: string | null;
  createdByName: string | null;
}

/** Strips a purchase's amount (and therefore its derived unit price, which the caller computes
 * FROM this field) for a viewer without finance.view_profit — a pure, directly testable
 * function rather than ad hoc `canViewProfit ? x : null` inline at each call site. */
export function stripPurchaseAmount<T extends { totalAmountPaid: number | null }>(row: T, canViewProfit: boolean): T {
  return canViewProfit ? row : { ...row, totalAmountPaid: null };
}

export function stripPurchaseAmounts<T extends { totalAmountPaid: number | null }>(rows: T[], canViewProfit: boolean): T[] {
  return canViewProfit ? rows : rows.map((row) => stripPurchaseAmount(row, canViewProfit));
}

function fabricPurchaseConditions(q: string | undefined) {
  return [eq(fabricStockMovements.type, "purchase"), q ? ilike(fabrics.name, `%${q}%`) : undefined].filter((c) => c !== undefined);
}

function accessoryPurchaseConditions(q: string | undefined) {
  return [eq(accessoryMovements.type, "purchase"), q ? ilike(accessories.name, `%${q}%`) : undefined].filter((c) => c !== undefined);
}

async function listFabricPurchasesOnly(
  q: string | undefined,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database,
): Promise<{ rows: PurchaseListRow[]; pagination: Pagination }> {
  const where = and(...fabricPurchaseConditions(q));

  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(fabricStockMovements)
    .innerJoin(fabrics, eq(fabrics.id, fabricStockMovements.fabricId))
    .where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const rows = await db
    .select({
      id: fabricStockMovements.id,
      itemId: fabricStockMovements.fabricId,
      itemName: fabrics.name,
      qty: fabricStockMovements.qty,
      totalAmountPaid: fabricStockMovements.valueAmount,
      purchasedAt: fabricStockMovements.purchasedAt,
      supplier: fabricStockMovements.supplier,
      voidedAt: fabricStockMovements.voidedAt,
      createdAt: fabricStockMovements.createdAt,
    })
    .from(fabricStockMovements)
    .innerJoin(fabrics, eq(fabrics.id, fabricStockMovements.fabricId))
    .where(where)
    .orderBy(desc(fabricStockMovements.createdAt), desc(fabricStockMovements.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return {
    rows: rows.map((row) => ({
      ...row,
      itemType: "fabric" as const,
      qty: Number(row.qty),
      totalAmountPaid: Number(row.totalAmountPaid),
      purchasedAt: row.purchasedAt!,
    })),
    pagination,
  };
}

async function listAccessoryPurchasesOnly(
  q: string | undefined,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database,
): Promise<{ rows: PurchaseListRow[]; pagination: Pagination }> {
  const where = and(...accessoryPurchaseConditions(q));

  const [totalCountRow] = await db
    .select({ totalCount: count() })
    .from(accessoryMovements)
    .innerJoin(accessories, eq(accessories.id, accessoryMovements.accessoryId))
    .where(where);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount: totalCountRow?.totalCount ?? 0 });

  const rows = await db
    .select({
      id: accessoryMovements.id,
      itemId: accessoryMovements.accessoryId,
      itemName: accessories.name,
      qty: accessoryMovements.qty,
      totalAmountPaid: accessoryMovements.valueAmount,
      purchasedAt: accessoryMovements.purchasedAt,
      supplier: accessoryMovements.supplier,
      voidedAt: accessoryMovements.voidedAt,
      createdAt: accessoryMovements.createdAt,
    })
    .from(accessoryMovements)
    .innerJoin(accessories, eq(accessories.id, accessoryMovements.accessoryId))
    .where(where)
    .orderBy(desc(accessoryMovements.createdAt), desc(accessoryMovements.id))
    .limit(pagination.limit)
    .offset(pagination.offset);

  return {
    rows: rows.map((row) => ({
      ...row,
      itemType: "accessory" as const,
      qty: Number(row.qty),
      totalAmountPaid: Number(row.totalAmountPaid),
      purchasedAt: row.purchasedAt!,
    })),
    pagination,
  };
}

interface RawUnionRow {
  [key: string]: unknown;
  id: string;
  itemType: PurchaseItemType;
  itemId: string;
  itemName: string;
  qty: string;
  totalAmountPaid: string;
  purchasedAt: string;
  supplier: string | null;
  voidedAt: Date | null;
  createdAt: Date;
}

/** No type filter: fabric and accessory purchases share one newest-first, paginated list — a
 * JS-side merge of two independently-paginated queries can't produce a correct page boundary
 * (page 2 might need 3 fabric rows and 17 accessory rows, decided only by their shared
 * created_at order), so this orders and paginates a genuine UNION ALL in the database instead,
 * via a raw `sql` query (drizzle's `unionAll` combinator doesn't chain `.orderBy/.limit/.offset`
 * cleanly across two differently-shaped source tables here). Totals are two simple counts summed
 * in JS — only the ORDER BY/LIMIT/OFFSET needs to see the real union. */
async function listAllPurchases(
  q: string | undefined,
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database,
): Promise<{ rows: PurchaseListRow[]; pagination: Pagination }> {
  const [fabricCountRow] = await db
    .select({ totalCount: count() })
    .from(fabricStockMovements)
    .innerJoin(fabrics, eq(fabrics.id, fabricStockMovements.fabricId))
    .where(and(...fabricPurchaseConditions(q)));
  const [accessoryCountRow] = await db
    .select({ totalCount: count() })
    .from(accessoryMovements)
    .innerJoin(accessories, eq(accessories.id, accessoryMovements.accessoryId))
    .where(and(...accessoryPurchaseConditions(q)));
  const totalCount = (fabricCountRow?.totalCount ?? 0) + (accessoryCountRow?.totalCount ?? 0);
  const pagination = resolvePagination({ rawPage, rawPerPage, totalCount });

  const qPattern = q ? `%${q}%` : null;
  const unioned = sql`
    (
      select ${fabricStockMovements.id} as id, 'fabric' as "itemType", ${fabricStockMovements.fabricId} as "itemId",
             ${fabrics.name} as "itemName", ${fabricStockMovements.qty}::numeric as qty,
             ${fabricStockMovements.valueAmount} as "totalAmountPaid", ${fabricStockMovements.purchasedAt} as "purchasedAt",
             ${fabricStockMovements.supplier} as supplier, ${fabricStockMovements.voidedAt} as "voidedAt",
             ${fabricStockMovements.createdAt} as "createdAt"
      from ${fabricStockMovements}
      inner join ${fabrics} on ${fabrics.id} = ${fabricStockMovements.fabricId}
      where ${fabricStockMovements.type} = 'purchase'
      ${qPattern ? sql`and ${fabrics.name} ilike ${qPattern}` : sql``}
    )
    union all
    (
      select ${accessoryMovements.id} as id, 'accessory' as "itemType", ${accessoryMovements.accessoryId} as "itemId",
             ${accessories.name} as "itemName", ${accessoryMovements.qty}::numeric as qty,
             ${accessoryMovements.valueAmount} as "totalAmountPaid", ${accessoryMovements.purchasedAt} as "purchasedAt",
             ${accessoryMovements.supplier} as supplier, ${accessoryMovements.voidedAt} as "voidedAt",
             ${accessoryMovements.createdAt} as "createdAt"
      from ${accessoryMovements}
      inner join ${accessories} on ${accessories.id} = ${accessoryMovements.accessoryId}
      where ${accessoryMovements.type} = 'purchase'
      ${qPattern ? sql`and ${accessories.name} ilike ${qPattern}` : sql``}
    )
  `;

  const result = await db.execute<RawUnionRow>(
    sql`select * from (${unioned}) t order by t."createdAt" desc, t.id desc limit ${pagination.limit} offset ${pagination.offset}`,
  );

  return {
    rows: result.map((row) => ({
      id: row.id,
      itemType: row.itemType,
      itemId: row.itemId,
      itemName: row.itemName,
      qty: Number(row.qty),
      totalAmountPaid: Number(row.totalAmountPaid),
      purchasedAt: row.purchasedAt,
      supplier: row.supplier,
      voidedAt: row.voidedAt,
      createdAt: row.createdAt,
    })),
    pagination,
  };
}

export async function listPurchases(
  filters: { type?: PurchaseTypeFilter; q?: string },
  rawPage: string | undefined,
  rawPerPage: string | undefined,
  db: Database = defaultDb,
): Promise<{ rows: PurchaseListRow[]; pagination: Pagination }> {
  if (filters.type === "fabric") return listFabricPurchasesOnly(filters.q, rawPage, rawPerPage, db);
  if (filters.type === "accessory") return listAccessoryPurchasesOnly(filters.q, rawPage, rawPerPage, db);
  return listAllPurchases(filters.q, rawPage, rawPerPage, db);
}

/** Looks up a single purchase by id, trying the fabric ledger then the accessory ledger — the
 * two tables each generate their own independent UUIDs (gen_random_uuid()), so a cross-table
 * collision is not a realistic concern. Filters on `type = 'purchase'` in the WHERE clause
 * itself (not just at the call site): a production/adjustment/purchase_void movement id returns
 * `null` here, same as an id that doesn't exist at all, so the page 404s instead of rendering a
 * movement that was never a purchase. */
export async function getPurchaseById(id: string, db: Database = defaultDb): Promise<PurchaseDetail | null> {
  const [fabricRow] = await db
    .select({
      id: fabricStockMovements.id,
      itemId: fabricStockMovements.fabricId,
      itemName: fabrics.name,
      qty: fabricStockMovements.qty,
      totalAmountPaid: fabricStockMovements.valueAmount,
      purchasedAt: fabricStockMovements.purchasedAt,
      supplier: fabricStockMovements.supplier,
      note: fabricStockMovements.note,
      voidedAt: fabricStockMovements.voidedAt,
      createdAt: fabricStockMovements.createdAt,
      createdByName: staffUsers.name,
    })
    .from(fabricStockMovements)
    .innerJoin(fabrics, eq(fabrics.id, fabricStockMovements.fabricId))
    .leftJoin(staffUsers, eq(staffUsers.id, fabricStockMovements.createdByStaffUserId))
    .where(and(eq(fabricStockMovements.id, id), eq(fabricStockMovements.type, "purchase")))
    .limit(1);
  if (fabricRow)
    return {
      ...fabricRow,
      itemType: "fabric",
      qty: Number(fabricRow.qty),
      totalAmountPaid: Number(fabricRow.totalAmountPaid),
      purchasedAt: fabricRow.purchasedAt!,
    };

  const [accessoryRow] = await db
    .select({
      id: accessoryMovements.id,
      itemId: accessoryMovements.accessoryId,
      itemName: accessories.name,
      qty: accessoryMovements.qty,
      totalAmountPaid: accessoryMovements.valueAmount,
      purchasedAt: accessoryMovements.purchasedAt,
      supplier: accessoryMovements.supplier,
      note: accessoryMovements.note,
      voidedAt: accessoryMovements.voidedAt,
      createdAt: accessoryMovements.createdAt,
      createdByName: staffUsers.name,
    })
    .from(accessoryMovements)
    .innerJoin(accessories, eq(accessories.id, accessoryMovements.accessoryId))
    .leftJoin(staffUsers, eq(staffUsers.id, accessoryMovements.createdByStaffUserId))
    .where(and(eq(accessoryMovements.id, id), eq(accessoryMovements.type, "purchase")))
    .limit(1);
  if (accessoryRow)
    return {
      ...accessoryRow,
      itemType: "accessory",
      qty: Number(accessoryRow.qty),
      totalAmountPaid: Number(accessoryRow.totalAmountPaid),
      purchasedAt: accessoryRow.purchasedAt!,
    };

  return null;
}
