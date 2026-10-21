"use server";

import { z } from "zod";
import { CHANNEL_IDS, ORDER_ATTENTION_FLAGS, ORDER_STATUSES } from "@ammari/db/schema";
import type { OrderStatus } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { moneyString, optionalMoneyString } from "@/lib/products/money-schema";
import { runAction, type ActionResult } from "@/lib/action-result";
import { createOrder, transitionOrderStatus } from "@ammari/commerce/orders";
import { REFUND_NOTE_MAX_LENGTH, cancelCheckoutOrderByStaff, clearAttentionFlag, recordManualRefund } from "@ammari/commerce/payments";
import { defaultDb } from "@/lib/db";
import { getAdminPaymentProvider } from "@/lib/payments/provider";
import { createCustomer, searchCustomers, type CustomerOption } from "@/lib/customers/queries";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { revalidateStorefrontForSkus, skusForOrder } from "@/lib/storefront-stock";

// An order and its status show on the orders pages, the packing queue, and SKU stock.
const ORDER_SECTIONS = ["/orders", "/packing", "/stock"] as const;

const orderItemSchema = z.object({
  sku: z.string().min(1),
  qty: z.coerce.number().int("Jumlah harus bilangan bulat.").positive("Jumlah harus lebih dari 0."),
  unitPrice: moneyString,
});

const createOrderSchema = z.object({
  channelId: z.enum(CHANNEL_IDS),
  channelOrderNo: z.string().trim().optional(),
  orderDate: z.string().date("Tanggal tidak valid."),
  customerId: z.string().uuid().optional(),
  buyerUsername: z.string().trim().optional(),
  shippingAddress: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  items: z.array(orderItemSchema).min(1, "Pesanan harus punya minimal 1 item."),
  discountAmount: optionalMoneyString,
  shippingAmount: optionalMoneyString,
  status: z.enum(["awaiting_payment", "to_ship"]),
});

export async function createOrderAction(input: z.input<typeof createOrderSchema>): Promise<ActionResult<{ id: string; storefrontOk: boolean }>> {
  const session = await requirePermission("orders.manage");
  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const order = await createOrder(
      {
        channelId: parsed.data.channelId,
        channelOrderNo: parsed.data.channelOrderNo || null,
        orderDate: parsed.data.orderDate,
        customerId: parsed.data.customerId ?? null,
        buyerUsername: parsed.data.buyerUsername || null,
        shippingAddress: parsed.data.shippingAddress || null,
        notes: parsed.data.notes || null,
        items: parsed.data.items,
        discountAmount: parsed.data.discountAmount ?? 0,
        shippingAmount: parsed.data.shippingAmount ?? 0,
        status: parsed.data.status,
      },
      session.staffUser.id,
    );
    revalidateAdmin(...ORDER_SECTIONS);
    // Only an order created already past awaiting_payment deducts stock.
    const storefront =
      parsed.data.status === "awaiting_payment" ? { ok: true } : await revalidateStorefrontForSkus(parsed.data.items.map((item) => item.sku));
    return { id: order.id, storefrontOk: storefront.ok };
  });
}

const transitionSchema = z.object({
  orderId: z.string().uuid(),
  toStatus: z.enum(ORDER_STATUSES),
});

export async function transitionOrderStatusAction(input: z.input<typeof transitionSchema>): Promise<ActionResult<{ status: OrderStatus; storefrontOk: boolean }>> {
  const session = await requirePermission("orders.manage");
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const order = await transitionOrderStatus(parsed.data.orderId, parsed.data.toStatus, session.staffUser.id);
    revalidateAdmin(...ORDER_SECTIONS);
    // Payment confirmed (stock deducted), cancelled or returned (stock restored). Shipped and
    // completed move no stock.
    const movesStock = parsed.data.toStatus === "to_ship" || parsed.data.toStatus === "cancelled" || parsed.data.toStatus === "returned";
    const storefront = movesStock ? await revalidateStorefrontForSkus(() => skusForOrder(parsed.data.orderId)) : { ok: true };
    return { status: order.status, storefrontOk: storefront.ok };
  });
}

export async function searchCustomersAction(q: string): Promise<CustomerOption[]> {
  await requirePermission("orders.manage");
  return searchCustomers(q);
}

const createCustomerSchema = z.object({
  name: z.string().trim().min(1, "Nama wajib diisi."),
  phone: z.string().trim().optional(),
});

export async function createCustomerAction(
  input: z.input<typeof createCustomerSchema>,
): Promise<ActionResult<{ id: string; name: string; phone: string | null }>> {
  await requirePermission("orders.manage");
  const parsed = createCustomerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const customer = await createCustomer({ name: parsed.data.name, phone: parsed.data.phone || null });
    revalidateAdmin("/orders");
    return { id: customer.id, name: customer.name, phone: customer.phone };
  });
}

// ---------- Web checkout orders (docs/plans/cart-checkout.md §6.5, §7, session 16) ----------

const orderIdSchema = z.object({ orderId: z.string().uuid() });

/** "Batalkan pesanan" for a web checkout order: an unpaid one is closed at the payment gateway
 * first, a paid one is flagged "Dana perlu dikembalikan" (@ammari/commerce/payments staff.ts). */
export async function cancelCheckoutOrderAction(
  input: z.input<typeof orderIdSchema>,
): Promise<ActionResult<{ outcome: "cancelled" | "already_cancelled"; refundDue: boolean; storefrontOk: boolean }>> {
  const session = await requirePermission("orders.manage");
  const parsed = orderIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const result = await cancelCheckoutOrderByStaff(defaultDb, getAdminPaymentProvider(), parsed.data.orderId, session.staffUser.id);
    revalidateAdmin(...ORDER_SECTIONS);
    // Stock came back (released hold or restored sale): the product pages show it again.
    const storefront = result.outcome === "cancelled" ? await revalidateStorefrontForSkus(() => skusForOrder(parsed.data.orderId)) : { ok: true };
    return { outcome: result.outcome, refundDue: result.outcome === "cancelled" && result.refundDue, storefrontOk: storefront.ok };
  });
}

const recordRefundSchema = z.object({
  orderId: z.string().uuid(),
  paymentId: z.string().uuid(),
  note: z.string().trim().min(3, "Tulis catatan pengembalian dana, misalnya bank dan tanggal transfer.").max(REFUND_NOTE_MAX_LENGTH, `Catatan maksimal ${REFUND_NOTE_MAX_LENGTH} karakter.`),
});

/** "Catat dana dikembalikan": Ammari refunded one paid attempt by hand (owner decision 43). */
export async function recordRefundAction(input: z.input<typeof recordRefundSchema>): Promise<ActionResult<{ amount: number; settled: boolean }>> {
  const session = await requirePermission("orders.manage");
  const parsed = recordRefundSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const result = await recordManualRefund(defaultDb, parsed.data, session.staffUser.id);
    revalidateAdmin("/orders");
    return { amount: result.amount, settled: result.settled };
  });
}

const clearFlagSchema = z.object({ orderId: z.string().uuid(), flag: z.enum(ORDER_ATTENTION_FLAGS) });

/** "Tandai beres" on one needs_attention flag (never touches another). */
export async function clearAttentionFlagAction(input: z.input<typeof clearFlagSchema>): Promise<ActionResult> {
  const session = await requirePermission("orders.manage");
  const parsed = clearFlagSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await clearAttentionFlag(defaultDb, parsed.data.orderId, parsed.data.flag, session.staffUser.id);
    revalidateAdmin("/orders");
    return undefined;
  });
}
