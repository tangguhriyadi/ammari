"use server";

import { z } from "zod";
import { CHANNEL_IDS, ORDER_STATUSES } from "@ammari/db/schema";
import type { OrderStatus } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { moneyString, optionalMoneyString } from "@/lib/products/money-schema";
import { runAction, type ActionResult } from "@/lib/action-result";
import { createOrder, transitionOrderStatus } from "@/lib/orders/queries";
import { createCustomer, searchCustomers, type CustomerOption } from "@/lib/customers/queries";

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

export async function createOrderAction(input: z.input<typeof createOrderSchema>): Promise<ActionResult<{ id: string }>> {
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
    return { id: order.id };
  });
}

const transitionSchema = z.object({
  orderId: z.string().uuid(),
  toStatus: z.enum(ORDER_STATUSES),
});

export async function transitionOrderStatusAction(input: z.input<typeof transitionSchema>): Promise<ActionResult<{ status: OrderStatus }>> {
  const session = await requirePermission("orders.manage");
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    const order = await transitionOrderStatus(parsed.data.orderId, parsed.data.toStatus, session.staffUser.id);
    return { status: order.status };
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
    return { id: customer.id, name: customer.name, phone: customer.phone };
  });
}
