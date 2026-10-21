import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accessories,
  customers,
  fabricColors,
  fabrics,
  orderItems,
  orders,
  products,
  productVariants,
  roles,
  staffUsers,
  stockReservations,
  thankYouCards,
} from "../src/schema";
import type { Size, StockReservationStatus } from "../src/schema";
import type { TestDatabase } from "./helpers";

export async function insertCustomer(tx: TestDatabase, overrides: Partial<typeof customers.$inferInsert> = {}) {
  // Phone must satisfy customers_phone_format_check (^\+62[0-9]{8,13}$) — digits only.
  const suffix = Array.from({ length: 10 }, () => Math.floor(Math.random() * 10)).join("");
  const [customer] = await tx
    .insert(customers)
    .values({
      phone: `+628${suffix}`,
      email: `customer-${randomUUID()}@example.test`,
      name: "Test Customer",
      pdpConsentAt: new Date(),
      ...overrides,
    })
    .returning();
  if (!customer) throw new Error("failed to insert customer fixture");
  return customer;
}

export async function getRoleByKey(tx: TestDatabase, key: string) {
  const [role] = await tx.select().from(roles).where(eq(roles.key, key)).limit(1);
  if (!role) throw new Error(`role "${key}" was not seeded`);
  return role;
}

export async function insertStaffUser(tx: TestDatabase, roleKey = "owner") {
  const role = await getRoleByKey(tx, roleKey);
  const [staffUser] = await tx
    .insert(staffUsers)
    .values({
      name: "Test Staff",
      email: `staff-${randomUUID()}@example.test`,
      roleId: role.id,
    })
    .returning();
  if (!staffUser) throw new Error("failed to insert staff user fixture");
  return staffUser;
}

export async function insertFabricColor(
  tx: TestDatabase,
  fabricId: string,
  overrides: Partial<typeof fabricColors.$inferInsert> = {},
) {
  const [color] = await tx
    .insert(fabricColors)
    .values({ fabricId, name: `Black ${randomUUID().slice(0, 8)}`, ...overrides })
    .returning();
  if (!color) throw new Error("failed to insert fabric color fixture");
  return color;
}

export async function insertProductVariant(tx: TestDatabase) {
  const [fabric] = await tx.insert(fabrics).values({ name: "Katun Rayon" }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");

  const color = await insertFabricColor(tx, fabric.id, { name: "Black" });

  const [product] = await tx
    .insert(products)
    .values({
      name: "Gamis Basic",
      code: `BASIC${randomUUID().slice(0, 8).toUpperCase()}`,
      slug: `gamis-basic-${randomUUID()}`,
      fabricId: fabric.id,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 259_000,
    })
    .returning();
  if (!product) throw new Error("failed to insert product fixture");

  const [variant] = await tx
    .insert(productVariants)
    .values({
      sku: `SKU-${randomUUID()}`,
      productId: product.id,
      fabricId: fabric.id,
      fabricColorId: color.id,
      closure: product.closure,
      size: "M",
    })
    .returning();
  if (!variant) throw new Error("failed to insert product variant fixture");

  return { fabric, color, product, variant };
}

/** A second (or third, ...) product + one variant sharing an EXISTING fabric/color pair (from a
 * prior insertProductVariant call) — for tests that need several products on the same batch, or
 * a specific sizeMode/size combination (e.g. an all_size product's ALLSIZE variant) that
 * insertProductVariant's own fixed shape (sized, size M) doesn't cover. */
export async function insertVariantForProduct(
  tx: TestDatabase,
  fabricId: string,
  colorId: string,
  overrides: Partial<typeof products.$inferInsert> = {},
  variantSize: Size = "M",
) {
  const [product] = await tx
    .insert(products)
    .values({
      name: "Produk Test",
      code: `PRD${randomUUID().slice(0, 8).toUpperCase()}`,
      slug: `produk-test-${randomUUID()}`,
      fabricId,
      closure: "front_zip",
      sizeMode: "sized",
      basePrice: 200_000,
      ...overrides,
    })
    .returning();
  if (!product) throw new Error("failed to insert product fixture");

  const [variant] = await tx
    .insert(productVariants)
    .values({
      sku: `SKU-${randomUUID()}`,
      productId: product.id,
      fabricId,
      fabricColorId: colorId,
      closure: product.closure,
      size: variantSize,
    })
    .returning();
  if (!variant) throw new Error("failed to insert product variant fixture");

  return { product, variant };
}

export async function insertAccessory(tx: TestDatabase, overrides: Partial<typeof accessories.$inferInsert> = {}) {
  const [accessory] = await tx
    .insert(accessories)
    .values({ name: `Kancing Test ${randomUUID().slice(0, 8)}`, ...overrides })
    .returning();
  if (!accessory) throw new Error("failed to insert accessory fixture");
  return accessory;
}

export async function insertOrder(
  tx: TestDatabase,
  overrides: Partial<typeof orders.$inferInsert> = {},
) {
  const subtotalAmount = overrides.subtotalAmount ?? 259_000;
  const shippingAmount = overrides.shippingAmount ?? 10_000;
  const discountAmount = overrides.discountAmount ?? 0;
  const [order] = await tx
    .insert(orders)
    .values({
      channelId: "shopee",
      orderNo: `ORD-TEST-${randomUUID()}`,
      channelOrderNo: `ORDER-${randomUUID()}`,
      orderDate: new Date(),
      subtotalAmount,
      shippingAmount,
      discountAmount,
      totalAmount: subtotalAmount + shippingAmount - discountAmount,
      ...overrides,
    })
    .returning();
  if (!order) throw new Error("failed to insert order fixture");
  return order;
}

export async function insertThankYouCard(
  tx: TestDatabase,
  orderId: string,
  overrides: Partial<typeof thankYouCards.$inferInsert> = {},
) {
  const staffUser = await insertStaffUser(tx, "owner");
  const [card] = await tx
    .insert(thankYouCards)
    .values({
      orderId,
      tokenHash: `hash-${randomUUID()}`,
      claimDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      printedByStaffUserId: staffUser.id,
      ...overrides,
    })
    .returning();
  if (!card) throw new Error("failed to insert thank_you_card fixture");
  return card;
}

/** A locked shipping quote (migration 0031's eight orders.shipping_* columns plus the buyer's
 * share in shipping_amount), as placeOrder writes it. Defaults to a Rp12.000 courier cost fully
 * covered by the subsidy, so the buyer's share is 0. */
export function shippingQuoteValues(
  costAmount = 12_000,
  subsidyAmount = Math.min(costAmount, 20_000),
): Partial<typeof orders.$inferInsert> {
  return {
    shippingAmount: costAmount - subsidyAmount,
    shippingCostAmount: costAmount,
    shippingSubsidyAmount: subsidyAmount,
    shippingCourierCode: "jne",
    shippingServiceCode: "reg",
    shippingCourierLabel: "JNE Reguler",
    shippingWeightGrams: 900,
    shippingDestinationId: "IDNP6IDNC148IDND843IDZ12250",
    shippingQuotedAt: new Date(),
  };
}

/** The columns placeOrder always writes for a checkout order (orders_checkout_fields_check,
 * orders_checkout_shipping_quote_check): awaiting_payment, payment pending, web channel, and a
 * quote whose cost the subsidy covers in full. */
export function checkoutOrderValues(): Partial<typeof orders.$inferInsert> {
  return {
    channelId: "web",
    channelOrderNo: null,
    status: "awaiting_payment",
    paymentStatus: "pending",
    paymentExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    checkoutAttemptId: randomUUID(),
    termsAcceptedAt: new Date(),
    promoOptIn: false,
    placedWithSession: false,
    ...shippingQuoteValues(),
  };
}

/** A checkout order with one line for `sku` and a stock hold on it, written directly (read-side
 * tests; the write path is @ammari/commerce/stock's reserveStockForOrder). `expiresAt` defaults
 * to 75 minutes from now; a `consumed`/`released` status gets its matching timestamp. */
export async function insertStockReservation(
  tx: TestDatabase,
  params: { sku: string; qty: number; status?: StockReservationStatus; expiresAt?: Date },
) {
  const order = await insertOrder(tx, checkoutOrderValues());
  const [item] = await tx
    .insert(orderItems)
    .values({ orderId: order.id, sku: params.sku, qty: params.qty, unitPrice: 259_000, unitCost: 0 })
    .returning();
  if (!item) throw new Error("failed to insert order item fixture");
  const status = params.status ?? "active";
  const [reservation] = await tx
    .insert(stockReservations)
    .values({
      orderId: order.id,
      orderItemId: item.id,
      sku: params.sku,
      qty: params.qty,
      status,
      expiresAt: params.expiresAt ?? new Date(Date.now() + 75 * 60 * 1000),
      consumedAt: status === "consumed" ? new Date() : null,
      releasedAt: status === "released" ? new Date() : null,
    })
    .returning();
  if (!reservation) throw new Error("failed to insert stock reservation fixture");
  return { order, item, reservation };
}
