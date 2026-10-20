import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  cartItems,
  carts,
  customerAddresses,
  orderAccessTokens,
  orderItems,
  orderNotifications,
  orders,
  paymentNotifications,
  payments,
  shippingAreas,
  stockReservations,
} from "../src/schema";
import { withRollback, type TestTx } from "./helpers";
import { insertCustomer, insertOrder, insertProductVariant } from "./fixtures";

// Constraint tests for migration 0030 (docs/plans/cart-checkout.md §3, session 2). Each
// expected violation runs inside a savepoint (a nested drizzle transaction) so one test can
// check several constraints without the first failure aborting the outer rollback transaction.

/** Postgres's constraint name, from the error itself or drizzle's wrapped `cause`. */
function constraintOf(error: unknown): string | undefined {
  const fields = (value: unknown) => value as { constraint_name?: string; cause?: unknown } | undefined;
  return fields(error)?.constraint_name ?? fields(fields(error)?.cause)?.constraint_name;
}

async function expectViolation(tx: TestTx, constraint: string, write: (sp: TestTx) => Promise<unknown>) {
  let caught: unknown;
  try {
    await tx.transaction(async (sp) => {
      await write(sp);
    });
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a violation of ${constraint}`).toBeDefined();
  expect(constraintOf(caught)).toBe(constraint);
}

/** The columns placeOrder always writes for a checkout order (orders_checkout_fields_check). */
function checkoutOrderFields() {
  return {
    channelId: "web" as const,
    channelOrderNo: null,
    status: "awaiting_payment" as const,
    paymentStatus: "pending" as const,
    paymentExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    checkoutAttemptId: randomUUID(),
    termsAcceptedAt: new Date(),
    promoOptIn: false,
    placedWithSession: false,
    shippingAmount: 0,
  };
}

async function insertOrderItem(tx: TestTx, orderId: string, sku: string) {
  const [item] = await tx.insert(orderItems).values({ orderId, sku, qty: 1, unitPrice: 259_000, unitCost: 0 }).returning();
  if (!item) throw new Error("failed to insert order item fixture");
  return item;
}

async function insertShippingArea(tx: TestTx) {
  const [area] = await tx
    .insert(shippingAreas)
    .values({
      province: "Jawa Barat",
      city: "Kota Bandung",
      district: `Coblong ${randomUUID()}`,
      postalCode: "40132",
      searchText: "coblong kota bandung jawa barat 40132",
    })
    .returning();
  if (!area) throw new Error("failed to insert shipping area fixture");
  return area;
}

describe("orders checkout columns", () => {
  test("an order written without the new columns gets the defaults (previous release's insert)", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx);
      expect(order).toMatchObject({
        paymentStatus: null,
        cancelReason: null,
        needsAttention: [],
        placedWithSession: null,
        checkoutAttemptId: null,
      });
    });
  });

  test("a complete checkout order is accepted, a staff-entered web order needs none of it", async () => {
    await withRollback(async (tx) => {
      const area = await insertShippingArea(tx);
      const order = await insertOrder(tx, {
        ...checkoutOrderFields(),
        contactEmail: "Pembeli@Example.test",
        contactPhone: "+6281234567890",
        recipientName: "Siti",
        shippingAddressSnapshot: { addressLine: "Jl. Contoh 1", postalCode: "40132" },
        shippingAreaId: area.id,
      });
      expect(order.paymentStatus).toBe("pending");
      await expect(insertOrder(tx, { channelId: "web", channelOrderNo: null })).resolves.toMatchObject({
        paymentStatus: null,
      });
    });
  });

  test("payment_status is checkout-only, from the order-level set, with every checkout field", async () => {
    await withRollback(async (tx) => {
      await expectViolation(tx, "orders_payment_status_web_only_check", (sp) =>
        insertOrder(sp, { ...checkoutOrderFields(), channelId: "shopee", channelOrderNo: `X-${randomUUID()}` }),
      );
      for (const attemptOnly of ["created", "failed"]) {
        await expectViolation(tx, "orders_payment_status_check", (sp) =>
          // @ts-expect-error -- deliberately outside ORDER_PAYMENT_STATUSES
          insertOrder(sp, { ...checkoutOrderFields(), paymentStatus: attemptOnly }),
        );
      }
      for (const missing of ["paymentExpiresAt", "checkoutAttemptId", "termsAcceptedAt", "promoOptIn", "placedWithSession"]) {
        await expectViolation(tx, "orders_checkout_fields_check", (sp) =>
          insertOrder(sp, { ...checkoutOrderFields(), [missing]: null }),
        );
      }
      for (const afterPayment of ["paid", "refunded", "partially_refunded", "chargeback"] as const) {
        await expectViolation(tx, "orders_paid_at_check", (sp) =>
          insertOrder(sp, { ...checkoutOrderFields(), status: "to_ship", paymentStatus: afterPayment }),
        );
      }
      await expect(
        insertOrder(tx, { ...checkoutOrderFields(), status: "to_ship", paymentStatus: "paid", paidAt: new Date() }),
      ).resolves.toBeDefined();
    });
  });

  test("checkout_attempt_id makes a double submit collide", async () => {
    await withRollback(async (tx) => {
      const fields = checkoutOrderFields();
      await insertOrder(tx, fields);
      await expectViolation(tx, "orders_checkout_attempt_id_key", (sp) => insertOrder(sp, fields));
    });
  });

  test("cancel_reason is from the fixed set and only on a cancelled order", async () => {
    await withRollback(async (tx) => {
      await expectViolation(tx, "orders_cancel_reason_status_check", (sp) =>
        insertOrder(sp, { ...checkoutOrderFields(), cancelReason: "payment_expired" }),
      );
      await expectViolation(tx, "orders_cancel_reason_check", (sp) =>
        // @ts-expect-error -- deliberately outside ORDER_CANCEL_REASONS
        insertOrder(sp, { ...checkoutOrderFields(), status: "cancelled", cancelReason: "changed_mind" }),
      );
      const order = await insertOrder(tx, { ...checkoutOrderFields(), status: "awaiting_payment" });
      const [cancelled] = await tx
        .update(orders)
        .set({ status: "cancelled", cancelledAt: new Date(), paymentStatus: "expired", cancelReason: "payment_expired" })
        .where(eq(orders.id, order.id))
        .returning();
      expect(cancelled?.cancelReason).toBe("payment_expired");
    });
  });

  test("contact_phone must be +62 when present", async () => {
    await withRollback(async (tx) => {
      await expectViolation(tx, "orders_contact_phone_format_check", (sp) =>
        insertOrder(sp, { ...checkoutOrderFields(), contactPhone: "081234567890" }),
      );
    });
  });

  test("needs_attention is a set of known flags; adding and clearing one leaves the others", async () => {
    await withRollback(async (tx) => {
      await expectViolation(tx, "orders_needs_attention_allowed_check", (sp) =>
        // @ts-expect-error -- deliberately outside ORDER_ATTENTION_FLAGS
        insertOrder(sp, { needsAttention: ["something_else"] }),
      );
      await expectViolation(tx, "orders_needs_attention_no_duplicates_check", (sp) =>
        insertOrder(sp, { needsAttention: ["refund_due", "refund_due"] }),
      );

      const order = await insertOrder(tx, { ...checkoutOrderFields(), needsAttention: ["stock_short_at_payment"] });
      // The idioms the later sessions use: append only if absent, remove one flag.
      const add = (flag: string) =>
        tx
          .update(orders)
          .set({
            needsAttention: sql`case when ${flag} = any(${orders.needsAttention}) then ${orders.needsAttention} else array_append(${orders.needsAttention}, ${flag}) end`,
          })
          .where(eq(orders.id, order.id))
          .returning({ needsAttention: orders.needsAttention });
      await add("refund_due");
      const [again] = await add("refund_due");
      expect(again?.needsAttention).toEqual(["stock_short_at_payment", "refund_due"]);

      const [cleared] = await tx
        .update(orders)
        .set({ needsAttention: sql`array_remove(${orders.needsAttention}, 'stock_short_at_payment')` })
        .where(eq(orders.id, order.id))
        .returning({ needsAttention: orders.needsAttention });
      expect(cleared?.needsAttention).toEqual(["refund_due"]);

      const flagged = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(sql`${orders.id} = ${order.id} and cardinality(${orders.needsAttention}) > 0`);
      expect(flagged).toHaveLength(1);
    });
  });
});

describe("carts", () => {
  test("a cart needs a token hash or a customer, each unique", async () => {
    await withRollback(async (tx) => {
      await expectViolation(tx, "carts_owner_check", (sp) => sp.insert(carts).values({}));
      const customer = await insertCustomer(tx);
      const tokenHash = `hash-${randomUUID()}`;
      await tx.insert(carts).values({ tokenHash });
      await tx.insert(carts).values({ customerId: customer.id });
      await expectViolation(tx, "carts_token_hash_key", (sp) => sp.insert(carts).values({ tokenHash }));
      await expectViolation(tx, "carts_customer_id_key", (sp) => sp.insert(carts).values({ customerId: customer.id }));
    });
  });

  test("cart lines: 1 to 10, one row per SKU, removed with the cart", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const [cart] = await tx.insert(carts).values({ tokenHash: `hash-${randomUUID()}` }).returning();
      if (!cart) throw new Error("failed to insert cart");
      for (const qty of [0, 11]) {
        await expectViolation(tx, "cart_items_qty_check", (sp) => sp.insert(cartItems).values({ cartId: cart.id, sku: variant.sku, qty }));
      }
      await tx.insert(cartItems).values({ cartId: cart.id, sku: variant.sku, qty: 10 });
      await expectViolation(tx, "cart_items_cart_id_sku_key", (sp) =>
        sp.insert(cartItems).values({ cartId: cart.id, sku: variant.sku, qty: 1 }),
      );
      await expectViolation(tx, "cart_items_sku_product_variants_sku_fk", (sp) =>
        sp.insert(cartItems).values({ cartId: cart.id, sku: `NOPE-${randomUUID()}`, qty: 1 }),
      );
      await tx.delete(carts).where(eq(carts.id, cart.id));
      expect(await tx.select().from(cartItems).where(eq(cartItems.cartId, cart.id))).toHaveLength(0);
    });
  });

  test("updated_at is maintained by the trigger", async () => {
    await withRollback(async (tx) => {
      const [cart] = await tx
        .insert(carts)
        .values({ tokenHash: `hash-${randomUUID()}`, updatedAt: new Date("2026-01-01T00:00:00Z") })
        .returning();
      if (!cart) throw new Error("failed to insert cart");
      const [updated] = await tx.update(carts).set({ lastActivityAt: new Date() }).where(eq(carts.id, cart.id)).returning();
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(new Date("2026-01-01T00:00:00Z").getTime());
    });
  });
});

describe("stock_reservations", () => {
  test("must match its order line exactly, one per line, and blocks deleting that line", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const { variant: other } = await insertProductVariant(tx);
      const order = await insertOrder(tx, checkoutOrderFields());
      const otherOrder = await insertOrder(tx, checkoutOrderFields());
      const item = await insertOrderItem(tx, order.id, variant.sku);
      const expiresAt = new Date(Date.now() + 75 * 60 * 1000);
      const base = { orderId: order.id, orderItemId: item.id, sku: variant.sku, qty: 1, expiresAt };

      await expectViolation(tx, "stock_reservations_order_item_fk", (sp) =>
        sp.insert(stockReservations).values({ ...base, sku: other.sku }),
      );
      await expectViolation(tx, "stock_reservations_order_item_fk", (sp) =>
        sp.insert(stockReservations).values({ ...base, orderId: otherOrder.id }),
      );
      await expectViolation(tx, "stock_reservations_qty_check", (sp) => sp.insert(stockReservations).values({ ...base, qty: 0 }));

      const [reservation] = await tx.insert(stockReservations).values(base).returning();
      expect(reservation?.status).toBe("active");
      await expectViolation(tx, "stock_reservations_order_item_id_key", (sp) => sp.insert(stockReservations).values(base));
      await expectViolation(tx, "stock_reservations_order_item_fk", (sp) =>
        sp.delete(orderItems).where(eq(orderItems.id, item.id)),
      );
    });
  });

  test("status and its timestamp move together", async () => {
    await withRollback(async (tx) => {
      const { variant } = await insertProductVariant(tx);
      const order = await insertOrder(tx, checkoutOrderFields());
      const item = await insertOrderItem(tx, order.id, variant.sku);
      const [reservation] = await tx
        .insert(stockReservations)
        .values({ orderId: order.id, orderItemId: item.id, sku: variant.sku, qty: 1, expiresAt: new Date(Date.now() + 60_000) })
        .returning();
      if (!reservation) throw new Error("failed to insert reservation");
      const byId = eq(stockReservations.id, reservation.id);

      await expectViolation(tx, "stock_reservations_consumed_consistency_check", (sp) =>
        sp.update(stockReservations).set({ status: "consumed" }).where(byId),
      );
      await expectViolation(tx, "stock_reservations_released_consistency_check", (sp) =>
        sp.update(stockReservations).set({ releasedAt: new Date() }).where(byId),
      );
      // @ts-expect-error -- deliberately outside STOCK_RESERVATION_STATUSES
      await expectViolation(tx, "stock_reservations_status_check", (sp) => sp.update(stockReservations).set({ status: "expired" }).where(byId));
      const [released] = await tx
        .update(stockReservations)
        .set({ status: "released", releasedAt: new Date() })
        .where(byId)
        .returning();
      expect(released?.status).toBe("released");
    });
  });
});

describe("payments", () => {
  test("attempts are unique per order and by provider ids; amounts and statuses are checked", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, checkoutOrderFields());
      const base = {
        orderId: order.id,
        provider: "midtrans" as const,
        attempt: 1,
        grossAmount: 259_000,
      };
      const [payment] = await tx
        .insert(payments)
        .values({ ...base, providerOrderId: `LOCAL-${order.orderNo}-1`, providerRef: `ref-${randomUUID()}` })
        .returning();
      if (!payment) throw new Error("failed to insert payment");
      expect(payment).toMatchObject({ status: "created", refundedAmount: 0 });

      await expectViolation(tx, "payments_order_id_attempt_key", (sp) =>
        sp.insert(payments).values({ ...base, providerOrderId: `LOCAL-${order.orderNo}-1b` }),
      );
      await expectViolation(tx, "payments_provider_order_id_key", (sp) =>
        sp.insert(payments).values({ ...base, attempt: 2, providerOrderId: payment.providerOrderId }),
      );
      await expectViolation(tx, "payments_provider_ref_key", (sp) =>
        sp.insert(payments).values({ ...base, attempt: 2, providerOrderId: `LOCAL-${order.orderNo}-2`, providerRef: payment.providerRef }),
      );
      // Several attempts may still lack a gateway transaction id.
      await tx.insert(payments).values({ ...base, attempt: 2, providerOrderId: `LOCAL-${order.orderNo}-2` });
      await tx.insert(payments).values({ ...base, attempt: 3, providerOrderId: `LOCAL-${order.orderNo}-3` });

      const byId = eq(payments.id, payment.id);
      await expectViolation(tx, "payments_attempt_check", (sp) =>
        sp.insert(payments).values({ ...base, attempt: 0, providerOrderId: `LOCAL-${randomUUID()}` }),
      );
      await expectViolation(tx, "payments_gross_amount_check", (sp) => sp.update(payments).set({ grossAmount: 0 }).where(byId));
      await expectViolation(tx, "payments_refunded_amount_check", (sp) =>
        sp.update(payments).set({ refundedAmount: 259_001 }).where(byId),
      );
      for (const afterPayment of ["paid", "refunded", "chargeback"] as const) {
        await expectViolation(tx, "payments_paid_at_check", (sp) => sp.update(payments).set({ status: afterPayment }).where(byId));
      }
      await tx.update(payments).set({ status: "expired" }).where(byId);
      // @ts-expect-error -- deliberately outside PAYMENT_STATUSES (a card-only status)
      await expectViolation(tx, "payments_status_check", (sp) => sp.update(payments).set({ status: "capture" }).where(byId));
      // @ts-expect-error -- deliberately outside PAYMENT_PROVIDERS
      await expectViolation(tx, "payments_provider_check", (sp) => sp.update(payments).set({ provider: "xendit" }).where(byId));
    });
  });

  test("notifications log anything, even for an unknown attempt", async () => {
    await withRollback(async (tx) => {
      const [row] = await tx
        .insert(paymentNotifications)
        .values({ providerOrderId: `DEV-ORD-${randomUUID()}`, signatureValid: false, payload: { transaction_status: "settlement" } })
        .returning();
      expect(row?.receivedAt).toBeInstanceOf(Date);
    });
  });
});

describe("customer_addresses", () => {
  test("format checks and at most one default per customer", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx);
      const area = await insertShippingArea(tx);
      const base = {
        customerId: customer.id,
        recipientName: "Siti",
        phone: "+6281234567890",
        addressLine: "Jl. Contoh 1",
        shippingAreaId: area.id,
        province: area.province,
        city: area.city,
        district: area.district,
        postalCode: area.postalCode,
      };
      await tx.insert(customerAddresses).values({ ...base, isDefault: true });
      await tx.insert(customerAddresses).values(base);
      await expectViolation(tx, "customer_addresses_default_customer_id_key", (sp) =>
        sp.insert(customerAddresses).values({ ...base, isDefault: true }),
      );
      await expectViolation(tx, "customer_addresses_phone_format_check", (sp) =>
        sp.insert(customerAddresses).values({ ...base, phone: "0812" }),
      );
      await expectViolation(tx, "customer_addresses_postal_code_format_check", (sp) =>
        sp.insert(customerAddresses).values({ ...base, postalCode: "4013" }),
      );
      await expectViolation(tx, "customer_addresses_coordinates_pair_check", (sp) =>
        sp.insert(customerAddresses).values({ ...base, latitude: "-6.9" }),
      );
      await expectViolation(tx, "customer_addresses_coordinates_range_check", (sp) =>
        sp.insert(customerAddresses).values({ ...base, latitude: "-91", longitude: "107.6" }),
      );
      // Plain-text fallback (plan D12): no area row.
      await tx.insert(customerAddresses).values({ ...base, shippingAreaId: null });
    });
  });
});

describe("shipping_areas", () => {
  test("one row per province/city/district/postal code, postal code is 5 digits", async () => {
    await withRollback(async (tx) => {
      const area = await insertShippingArea(tx);
      await expectViolation(tx, "shipping_areas_province_city_district_postal_code_key", (sp) =>
        sp.insert(shippingAreas).values({ ...area, id: undefined }),
      );
      await expectViolation(tx, "shipping_areas_postal_code_format_check", (sp) =>
        sp.insert(shippingAreas).values({ ...area, id: undefined, district: "Lain", postalCode: "ABCDE" }),
      );
    });
  });
});

describe("order_access_tokens and order_notifications", () => {
  test("token hashes are unique and must expire after issuance", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, checkoutOrderFields());
      const tokenHash = `hash-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
      await tx.insert(orderAccessTokens).values({ orderId: order.id, tokenHash, expiresAt });
      // A second email for the same order gets its own row.
      await tx.insert(orderAccessTokens).values({ orderId: order.id, tokenHash: `hash-${randomUUID()}`, expiresAt });
      await expectViolation(tx, "order_access_tokens_token_hash_key", (sp) =>
        sp.insert(orderAccessTokens).values({ orderId: order.id, tokenHash, expiresAt }),
      );
      await expectViolation(tx, "order_access_tokens_expires_after_created_check", (sp) =>
        sp.insert(orderAccessTokens).values({ orderId: order.id, tokenHash: `hash-${randomUUID()}`, expiresAt: new Date(Date.now() - 1000) }),
      );
    });
  });

  test("one notification per order and kind", async () => {
    await withRollback(async (tx) => {
      const order = await insertOrder(tx, checkoutOrderFields());
      await tx.insert(orderNotifications).values({ orderId: order.id, kind: "created" });
      await tx.insert(orderNotifications).values({ orderId: order.id, kind: "owner_paid" });
      await expectViolation(tx, "order_notifications_order_id_kind_key", (sp) =>
        sp.insert(orderNotifications).values({ orderId: order.id, kind: "created" }),
      );
      await expectViolation(tx, "order_notifications_kind_check", (sp) =>
        // @ts-expect-error -- deliberately outside ORDER_NOTIFICATION_KINDS
        sp.insert(orderNotifications).values({ orderId: order.id, kind: "reminder" }),
      );
    });
  });
});
