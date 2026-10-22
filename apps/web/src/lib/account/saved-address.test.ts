import { randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder } from "@ammari/db/test-fixtures";
import { auditLog, claimRateLimits, customerAddresses, customers, orders, shippingAreas } from "@ammari/db/schema";

// "Alamat tersimpan" on /account: the buyer sees and deletes their own saved address; nobody else's,
// orders untouched, the audit row without the address. The action runs against the real
// `ammari_test` database with the session and the client IP replaced.

let sessionCustomerId: string | null = null;
let clientIp = "203.0.113.30";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": clientIp }) }));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/auth/customer-session", () => ({
  getCustomerSession: async () => (sessionCustomerId ? { id: sessionCustomerId, pdpConsentAt: new Date() } : null),
}));
vi.mock("@/lib/db", async () => {
  const { testDb: db } = await import("@ammari/db/test-utils");
  const { auditLog: table } = await import("@ammari/db/schema");
  return {
    defaultDb: db,
    writeAuditLog: async (tx: TestDatabase, params: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown }) => {
      await tx.insert(table).values({ actorStaffUserId: null, action: params.action, entityType: params.entityType, entityId: params.entityId, before: params.before ?? null, after: params.after ?? null });
    },
  };
});

const { deleteSavedAddresses, loadSavedAddressSummary, SAVED_ADDRESS_DELETE_LIMIT } = await import("./saved-address");
const { deleteSavedAddressAction } = await import("@/app/account/saved-address-actions");

async function insertArea(tx: TestDatabase, overrides: Partial<typeof shippingAreas.$inferInsert> = {}) {
  const [area] = await tx
    .insert(shippingAreas)
    .values({ province: "Jawa Barat", city: "Kota Bandung", district: "Coblong", postalCode: "40132", searchText: "coblong", label: null, providerAreaId: `TEST${randomUUID()}`, ...overrides })
    .returning();
  return area!;
}

async function insertAddress(tx: TestDatabase, customerId: string, areaId: string, overrides: Partial<typeof customerAddresses.$inferInsert> = {}) {
  await tx.insert(customerAddresses).values({
    customerId,
    recipientName: "Siti Aminah",
    phone: "+6281234567890",
    addressLine: "Jl. Melati 5 RT 01/02",
    shippingAreaId: areaId,
    province: "Jawa Barat",
    city: "Kota Bandung",
    district: "Coblong",
    postalCode: "40132",
    notes: "Pagar hijau",
    isDefault: true,
    ...overrides,
  });
}

async function countAddresses(db: TestDatabase, customerId: string): Promise<number> {
  return (await db.select({ id: customerAddresses.id }).from(customerAddresses).where(eq(customerAddresses.customerId, customerId))).length;
}

describe("loadSavedAddressSummary", () => {
  test("the customer's default address with its area label; nobody else's", async () => {
    await withRollback(async (tx) => {
      const owner = await insertCustomer(tx);
      const stranger = await insertCustomer(tx);
      const area = await insertArea(tx);
      await insertAddress(tx, owner.id, area.id);
      expect(await loadSavedAddressSummary(owner.id, tx)).toEqual({
        recipientName: "Siti Aminah",
        phone: "+6281234567890",
        addressLine: "Jl. Melati 5 RT 01/02",
        notes: "Pagar hijau",
        areaLabel: "Coblong, Kota Bandung, Jawa Barat 40132",
      });
      expect(await loadSavedAddressSummary(stranger.id, tx)).toBeNull();
    });
  });

  test("an area without a kode pos shows the one the buyer typed", async () => {
    await withRollback(async (tx) => {
      const owner = await insertCustomer(tx);
      const area = await insertArea(tx, { postalCode: null, label: "Coblong, Kota Bandung, Jawa Barat" });
      await insertAddress(tx, owner.id, area.id, { postalCode: "40135" });
      expect((await loadSavedAddressSummary(owner.id, tx))?.areaLabel).toBe("Coblong, Kota Bandung, Jawa Barat 40135");
    });
  });
});

describe("deleteSavedAddresses", () => {
  test("deletes the customer's own rows, audits the count only, and leaves orders alone", async () => {
    await withRollback(async (tx) => {
      const owner = await insertCustomer(tx);
      const area = await insertArea(tx);
      await insertAddress(tx, owner.id, area.id);
      await insertAddress(tx, owner.id, area.id, { isDefault: false, addressLine: "Jl. Kenanga 2" });
      const order = await insertOrder(tx, { customerId: owner.id });
      const [orderBefore] = await tx.select().from(orders).where(eq(orders.id, order.id));

      expect(await deleteSavedAddresses(owner.id, tx)).toBe(2);
      expect(await countAddresses(tx, owner.id)).toBe(0);
      expect(await loadSavedAddressSummary(owner.id, tx)).toBeNull();

      const [orderAfter] = await tx.select().from(orders).where(eq(orders.id, order.id));
      expect(orderAfter).toEqual(orderBefore);

      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, owner.id), eq(auditLog.action, "customer_address_deleted")));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ entityType: "customer", actorStaffUserId: null, before: null, after: { deletedCount: 2, by: "customer" } });
      const logged = JSON.stringify(audits[0]);
      for (const text of ["Siti", "Melati", "Kenanga", "Pagar", "+6281234567890", "40132"]) expect(logged).not.toContain(text);
    });
  });

  test("never deletes another customer's address", async () => {
    await withRollback(async (tx) => {
      const owner = await insertCustomer(tx);
      const stranger = await insertCustomer(tx);
      const area = await insertArea(tx);
      await insertAddress(tx, owner.id, area.id);
      await insertAddress(tx, stranger.id, area.id, { recipientName: "Orang Lain" });

      expect(await deleteSavedAddresses(owner.id, tx)).toBe(1);
      expect(await countAddresses(tx, stranger.id)).toBe(1);
      expect((await loadSavedAddressSummary(stranger.id, tx))?.recipientName).toBe("Orang Lain");
    });
  });

  test("a second delete removes nothing, is no error and writes no second audit row", async () => {
    await withRollback(async (tx) => {
      const owner = await insertCustomer(tx);
      const area = await insertArea(tx);
      await insertAddress(tx, owner.id, area.id);

      expect(await deleteSavedAddresses(owner.id, tx)).toBe(1);
      expect(await deleteSavedAddresses(owner.id, tx)).toBe(0);
      const audits = await tx.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.entityId, owner.id), eq(auditLog.action, "customer_address_deleted")));
      expect(audits).toHaveLength(1);
    });
  });
});

describe("deleteSavedAddressAction", () => {
  const created = { customerIds: [] as string[], areaIds: [] as string[], ips: new Set<string>() };

  beforeEach(async () => {
    sessionCustomerId = null;
    clientIp = `198.51.100.${randomInt(1, 254)}`;
    created.ips.add(clientIp);
    await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, clientIp));
  });

  afterAll(async () => {
    if (created.customerIds.length > 0) {
      await testDb.delete(customerAddresses).where(inArray(customerAddresses.customerId, created.customerIds));
      await testDb.delete(auditLog).where(inArray(auditLog.entityId, created.customerIds));
      await testDb.delete(customers).where(inArray(customers.id, created.customerIds));
    }
    if (created.areaIds.length > 0) await testDb.delete(shippingAreas).where(inArray(shippingAreas.id, created.areaIds));
    if (created.ips.size > 0) await testDb.delete(claimRateLimits).where(inArray(claimRateLimits.ip, [...created.ips]));
  });

  async function customerWithAddress() {
    const customer = await insertCustomer(testDb);
    const area = await insertArea(testDb);
    created.customerIds.push(customer.id);
    created.areaIds.push(area.id);
    await insertAddress(testDb, customer.id, area.id);
    return customer;
  }

  test("without a session it sends the visitor to the login and deletes nothing", async () => {
    const customer = await customerWithAddress();
    await expect(deleteSavedAddressAction()).rejects.toThrow("redirect:/login?next=%2Faccount");
    expect(await countAddresses(testDb, customer.id)).toBe(1);
  });

  test("deletes only the session customer's address, and a second press still answers ok", async () => {
    const owner = await customerWithAddress();
    const stranger = await customerWithAddress();
    sessionCustomerId = owner.id;
    expect(await deleteSavedAddressAction()).toEqual({ ok: true });
    expect(await countAddresses(testDb, owner.id)).toBe(0);
    expect(await countAddresses(testDb, stranger.id)).toBe(1);
    expect(await deleteSavedAddressAction()).toEqual({ ok: true });
  });

  test("is rate-limited per IP, counted before the delete", async () => {
    const owner = await customerWithAddress();
    sessionCustomerId = owner.id;
    await testDb.insert(claimRateLimits).values(Array.from({ length: SAVED_ADDRESS_DELETE_LIMIT }, () => ({ ip: clientIp, action: "saved_address_delete" })));
    expect(await deleteSavedAddressAction()).toEqual({ ok: false, message: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi." });
    expect(await countAddresses(testDb, owner.id)).toBe(1);

    // Another address (a fresh window) goes through.
    clientIp = `198.51.100.${randomInt(1, 254)}`;
    created.ips.add(clientIp);
    await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, clientIp));
    expect(await deleteSavedAddressAction()).toEqual({ ok: true });
    expect(await countAddresses(testDb, owner.id)).toBe(0);
  });
});
