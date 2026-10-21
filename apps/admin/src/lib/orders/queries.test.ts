import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, insertStaffUser, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { orderNotifications, orders, payments, stockMovements, type OrderAttentionFlag } from "@ammari/db/schema";
import { createOrder } from "@ammari/commerce/orders";
import { eq } from "drizzle-orm";
import { countOrdersNeedingAttention, getOrderDetail, listOrders, stripOrderDetailCost } from "./queries";

// The write-path tests (createOrder, updateOrderItems, transitionOrderStatus,
// generateOrderNumber) moved with that code to packages/commerce/src/orders/lifecycle.test.ts.
// What stays here is the admin read model on top of it.

describe("getOrderDetail", () => {
  test("returns each line with the unit_cost locked when stock left, and stripOrderDetailCost hides it", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const staff = await insertStaffUser(tx);
      await tx.insert(stockMovements).values({ sku: variant.sku, qty: 10, valueAmount: 1_000_000, type: "production", refType: "manual" });

      const order = await createOrder(
        {
          channelId: "whatsapp",
          orderDate: "2026-10-09",
          items: [{ sku: variant.sku, qty: 2, unitPrice: 259_000 }],
          discountAmount: 0,
          shippingAmount: 10_000,
          status: "to_ship",
        },
        staff.id,
        tx,
      );

      const detail = await getOrderDetail(order.id, tx);
      expect(detail?.orderNo).toBe(order.orderNo);
      expect(detail?.totalAmount).toBe(528_000);
      expect(detail?.createdByName).toBe(staff.name);
      expect(detail?.cardClaimedAt).toBeNull();
      expect(detail?.items).toHaveLength(1);
      expect(detail?.items[0]).toMatchObject({ sku: variant.sku, size: variant.size, qty: 2, unitPrice: 259_000, unitCost: 100_000 });

      expect(stripOrderDetailCost(detail!, true).items[0]!.unitCost).toBe(100_000);
      expect(stripOrderDetailCost(detail!, false).items[0]!.unitCost).toBeNull();
    });
  });

  test("returns null for an unknown order", async () => {
    await withRollback(async (tx) => {
      expect(await getOrderDetail("00000000-0000-4000-8000-000000000000", tx)).toBeNull();
    });
  });
});

describe("web checkout orders (docs/plans/cart-checkout.md §7, session 16)", () => {
  async function checkoutOrder(tx: Parameters<Parameters<typeof withRollback>[0]>[0], flags: OrderAttentionFlag[] = []) {
    const quote = shippingQuoteValues(35_000);
    const order = await insertOrder(tx, {
      ...checkoutOrderValues(),
      ...quote,
      subtotalAmount: 259_000,
      totalAmount: 259_000 + (quote.shippingAmount ?? 0),
      contactEmail: "pembeli@example.test",
      contactPhone: "+6281234567890",
      recipientName: "Siti Aminah",
      shippingAddressSnapshot: {
        version: 2,
        recipientName: "Siti Aminah",
        phone: "+6281298765432",
        addressLine: "Jl. Mawar 1, RT 01/RW 02, Kel. Sukamaju",
        notes: "Pagar hijau",
        shippingAreaId: null,
        providerAreaId: "IDNP1",
        province: "Jawa Barat",
        city: "Kota Bandung",
        district: "Coblong",
        subdistrict: null,
        postalCode: "40132",
      },
    });
    if (flags.length > 0) await tx.update(orders).set({ needsAttention: flags }).where(eq(orders.id, order.id));
    return order;
  }

  test("the detail carries payment attempts, the locked quote, contact and address, emails; cost and subsidy stripped without finance.view_profit", async () => {
    await withRollback(async (tx) => {
      const order = await checkoutOrder(tx, ["refund_due"]);
      await tx.insert(payments).values({
        orderId: order.id,
        provider: "midtrans",
        providerOrderId: `T-${order.orderNo}-1`,
        attempt: 1,
        grossAmount: order.totalAmount,
        status: "pending",
        paymentType: "bank_transfer",
        lastStatus: { transaction_status: "pending", bank: "bca" },
      });
      await tx.insert(orderNotifications).values({ orderId: order.id, kind: "created", sentAt: new Date() });

      const detail = await getOrderDetail(order.id, tx);
      const checkout = detail?.checkout;
      expect(checkout).toMatchObject({
        paymentStatus: "pending",
        needsAttention: ["refund_due"],
        contactEmail: "pembeli@example.test",
        contactPhone: "+6281234567890",
        address: { recipientName: "Siti Aminah", phone: "+6281298765432", district: "Coblong", postalCode: "40132", notes: "Pagar hijau" },
        quote: { costAmount: 35_000, subsidyAmount: 20_000, buyerAmount: 15_000 },
        attempts: [{ attempt: 1, status: "pending", bank: "bca", gatewayStatus: "pending" }],
        emails: [{ kind: "created" }],
      });
      expect(stripOrderDetailCost(detail!, false).checkout?.quote).toMatchObject({ costAmount: null, subsidyAmount: null, buyerAmount: 15_000 });
      expect(stripOrderDetailCost(detail!, true).checkout?.quote).toMatchObject({ costAmount: 35_000, subsidyAmount: 20_000 });
    });
  });

  test("Pelanggan is the order's recipient name for a checkout order, never the linked customer's placeholder; other orders keep the customer's name", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx, { name: "Pelanggan Ammari" });
      const checkout = await checkoutOrder(tx);
      await tx.update(orders).set({ customerId: customer.id }).where(eq(orders.id, checkout.id));
      const manual = await insertOrder(tx, { channelId: "whatsapp", status: "to_ship", customerId: customer.id });

      expect((await getOrderDetail(checkout.id, tx))?.customerName).toBe("Siti Aminah");
      expect((await getOrderDetail(manual.id, tx))?.customerName).toBe("Pelanggan Ammari");
      const { rows } = await listOrders({ q: "Siti Aminah" }, undefined, "100", tx);
      expect(rows.find((row) => row.id === checkout.id)?.customerName).toBe("Siti Aminah");
    });
  });

  test("manual orders have no checkout data", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { channelId: "web", status: "awaiting_payment" });
      expect((await getOrderDetail(order.id, tx))?.checkout).toBeNull();
    });
  });

  test('"Perlu dicek" lists only orders carrying a flag, with their payment status', async () => {
    await withRollback(async (tx) => {
      const before = await countOrdersNeedingAttention(tx);
      const flagged = await checkoutOrder(tx, ["stock_short_at_payment"]);
      const clean = await checkoutOrder(tx);
      expect(await countOrdersNeedingAttention(tx)).toBe(before + 1);
      const { rows } = await listOrders({ needsAttention: true }, undefined, "100", tx);
      const ids = rows.map((row) => row.id);
      expect(ids).toContain(flagged.id);
      expect(ids).not.toContain(clean.id);
      expect(rows.find((row) => row.id === flagged.id)).toMatchObject({ paymentStatus: "pending", needsAttention: ["stock_short_at_payment"] });
    });
  });
});
