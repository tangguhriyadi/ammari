import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  customers,
  fabrics,
  orders,
  products,
  productVariants,
  roles,
  staffUsers,
  thankYouCards,
} from "../src/schema";
import type { TestTx } from "./helpers";

export async function insertCustomer(tx: TestTx, overrides: Partial<typeof customers.$inferInsert> = {}) {
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

export async function getRoleByKey(tx: TestTx, key: string) {
  const [role] = await tx.select().from(roles).where(eq(roles.key, key)).limit(1);
  if (!role) throw new Error(`role "${key}" was not seeded`);
  return role;
}

export async function insertStaffUser(tx: TestTx, roleKey = "owner") {
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

export async function insertProductVariant(tx: TestTx) {
  const [fabric] = await tx.insert(fabrics).values({ name: "Katun Rayon" }).returning();
  if (!fabric) throw new Error("failed to insert fabric fixture");

  const [product] = await tx
    .insert(products)
    .values({
      name: "Gamis Basic",
      slug: `gamis-basic-${randomUUID()}`,
      fabricId: fabric.id,
      closure: "front_zip",
      basePrice: 259_000,
    })
    .returning();
  if (!product) throw new Error("failed to insert product fixture");

  const [variant] = await tx
    .insert(productVariants)
    .values({
      sku: `SKU-${randomUUID()}`,
      productId: product.id,
      color: "Black",
      size: "M",
    })
    .returning();
  if (!variant) throw new Error("failed to insert product variant fixture");

  return { fabric, product, variant };
}

export async function insertOrder(
  tx: TestTx,
  overrides: Partial<typeof orders.$inferInsert> = {},
) {
  const subtotalAmount = overrides.subtotalAmount ?? 259_000;
  const shippingAmount = overrides.shippingAmount ?? 10_000;
  const discountAmount = overrides.discountAmount ?? 0;
  const [order] = await tx
    .insert(orders)
    .values({
      channelId: "shopee",
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
  tx: TestTx,
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
