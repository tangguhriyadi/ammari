import "server-only";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { channels, fabricColors, orderItems, orders, products, productVariants, vouchers } from "@ammari/db/schema";
import { defaultDb, type Database } from "@/lib/db";

export interface MyOrderItem {
  productName: string;
  colorName: string;
  size: string;
  qty: number;
}

export interface MyOrderRow {
  id: string;
  orderNo: string;
  channelName: string;
  orderDate: Date;
  items: MyOrderItem[];
}

/** Read-only, no cost data anywhere in this query (customer-facing — CLAUDE.md's "never only a
 * UI hide" principle applies the other way too: a figure this page never selects can never leak
 * through a future UI bug). Newest order first. */
export async function listMyOrders(customerId: string, db: Database = defaultDb): Promise<MyOrderRow[]> {
  const orderRows = await db
    .select({
      id: orders.id,
      orderNo: orders.orderNo,
      channelName: channels.name,
      orderDate: orders.orderDate,
    })
    .from(orders)
    .innerJoin(channels, eq(channels.id, orders.channelId))
    .where(eq(orders.customerId, customerId))
    .orderBy(desc(orders.orderDate));

  const orderIds = orderRows.map((row) => row.id);
  const items = orderIds.length > 0 ? await listItemsForOrders(orderIds, db) : new Map<string, MyOrderItem[]>();

  return orderRows.map((row) => ({ ...row, items: items.get(row.id) ?? [] }));
}

async function listItemsForOrders(orderIds: string[], db: Database): Promise<Map<string, MyOrderItem[]>> {
  const rows = await db
    .select({
      orderId: orderItems.orderId,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      qty: orderItems.qty,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.createdAt));

  const map = new Map<string, MyOrderItem[]>();
  for (const { orderId, ...item } of rows) {
    const list = map.get(orderId) ?? [];
    list.push(item);
    map.set(orderId, list);
  }
  return map;
}

export interface MyVoucherRow {
  id: string;
  amount: number;
  status: string;
  issuedAt: Date;
  expiresAt: Date;
}

export async function listMyVouchers(customerId: string, db: Database = defaultDb): Promise<MyVoucherRow[]> {
  return db
    .select({
      id: vouchers.id,
      amount: vouchers.amount,
      status: vouchers.status,
      issuedAt: vouchers.issuedAt,
      expiresAt: vouchers.expiresAt,
    })
    .from(vouchers)
    .where(eq(vouchers.customerId, customerId))
    .orderBy(desc(vouchers.issuedAt));
}
