import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertProductVariant, insertStaffUser, insertVariantForProduct, shippingQuoteValues } from "@ammari/db/test-fixtures";
import { orderNotifications, orders, payments, products, productVariants, shipments, stockMovements, type OrderAttentionFlag } from "@ammari/db/schema";
import { createOrder } from "@ammari/commerce/orders";
import { eq } from "drizzle-orm";
import { countOrdersNeedingAttention, getOrderDetail, listOrderableVariants, listOrders, stripOrderDetailCost } from "./queries";

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

describe("getOrderDetail courier bookings (Phase K2)", () => {
  test("lists every attempt newest first, and stripOrderDetailCost hides the booked cost but keeps whether it is known", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, { ...checkoutOrderValues(), status: "to_ship", paymentStatus: "paid", paidAt: new Date() });
      await tx.insert(shipments).values([
        { orderId: order.id, attempt: 1, referenceId: `T-${order.id}-K1`, provider: "biteship", courier: "jne", service: "reg", status: "cancelled", providerOrderId: "aaaaaaaaaaaaaaaaaaaaaaaa", cancelledAt: new Date(), costAmount: 12_000 },
        { orderId: order.id, attempt: 2, referenceId: `T-${order.id}-K2`, provider: "biteship", courier: "jne", service: "reg", status: "pickup_requested", providerOrderId: "bbbbbbbbbbbbbbbbbbbbbbbb", awb: "JNE0002", costAmount: 18_000 },
      ]);
      const detail = (await getOrderDetail(order.id, tx))!;
      expect(detail.checkout!.shipments.map((row) => [row.attempt, row.status, row.costAmount])).toEqual([
        [2, "pickup_requested", 18_000],
        [1, "cancelled", 12_000],
      ]);
      const stripped = stripOrderDetailCost(detail, false);
      expect(stripped.checkout!.shipments.map((row) => [row.costAmount, row.costKnown])).toEqual([
        [null, true],
        [null, true],
      ]);
      expect(stripped.checkout!.quote!.costAmount).toBeNull();
    });
  });
});


describe("listOrderableVariants prefill with a product discount (docs/plans/product-discount.md §5.2)", () => {
  const NOW = new Date("2026-10-23T05:00:00Z");

  async function discountedProduct(tx: Parameters<Parameters<typeof withRollback>[0]>[0], discount: Partial<typeof products.$inferInsert>) {
    const { fabric, color } = await insertProductVariant(tx);
    const { product, variant } = await insertVariantForProduct(tx, fabric.id, color.id, {
      basePrice: 350_000,
      discountPriceAmount: 279_000,
      discountEnabled: true,
      ...discount,
    });
    return { product, variant };
  }

  async function row(tx: Parameters<Parameters<typeof withRollback>[0]>[0], sku: string) {
    return (await listOrderableVariants(tx, NOW)).find((candidate) => candidate.sku === sku);
  }

  test("an active discount prefills the sale price and keeps the list price for the note", async () => {
    await withRollback(async (tx) => {
      const { variant } = await discountedProduct(tx, {});
      expect(await row(tx, variant.sku)).toMatchObject({ effectivePrice: 279_000, listPrice: 350_000, discounted: true });
    });
  });

  test("a scheduled, ended or switched-off discount prefills the normal price", async () => {
    await withRollback(async (tx) => {
      const scheduled = await discountedProduct(tx, { discountStartsAt: new Date("2026-11-01T00:00:00Z") });
      const ended = await discountedProduct(tx, { discountEndsAt: new Date("2026-10-23T05:00:00Z") });
      const off = await discountedProduct(tx, { discountEnabled: false });
      for (const { variant } of [scheduled, ended, off]) {
        expect(await row(tx, variant.sku)).toMatchObject({ effectivePrice: 350_000, listPrice: 350_000, discounted: false });
      }
    });
  });

  test("a variant override above the sale price gets the sale price; one at or below it keeps its override", async () => {
    await withRollback(async (tx) => {
      const { variant } = await discountedProduct(tx, {});
      await tx.update(productVariants).set({ priceOverrideAmount: 375_000 }).where(eq(productVariants.sku, variant.sku));
      expect(await row(tx, variant.sku)).toMatchObject({ effectivePrice: 279_000, listPrice: 375_000, discounted: true });

      await tx.update(productVariants).set({ priceOverrideAmount: 260_000 }).where(eq(productVariants.sku, variant.sku));
      expect(await row(tx, variant.sku)).toMatchObject({ effectivePrice: 260_000, listPrice: 260_000, discounted: false });
    });
  });
});
