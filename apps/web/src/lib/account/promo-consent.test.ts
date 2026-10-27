import { randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertCustomer } from "@ammari/db/test-fixtures";
import { auditLog, claimRateLimits, customers } from "@ammari/db/schema";

// "Kabar promo" on /account (docs/plans/growth.md owner answer A11, session S6): the buyer stops
// (or starts again) receiving promo themselves. One conditional UPDATE decides each change; the
// audit row keeps the cleared timestamp like the admin's "Catat penarikan", never contact data.
// The action runs against the real `ammari_test` database with the session and the IP replaced.

let sessionCustomerId: string | null = null;
let clientIp = "203.0.113.40";

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

const { setPromoConsent, PROMO_CONSENT_CHANGE_LIMIT } = await import("./promo-consent");
const { setPromoConsentAction } = await import("@/app/account/promo-consent-actions");

async function consentOf(db: TestDatabase, customerId: string): Promise<Date | null> {
  const [row] = await db.select({ promoConsentAt: customers.promoConsentAt }).from(customers).where(eq(customers.id, customerId));
  return row!.promoConsentAt;
}

async function auditsOf(db: TestDatabase, customerId: string) {
  return db
    .select({ action: auditLog.action, actor: auditLog.actorStaffUserId, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "customer"), eq(auditLog.entityId, customerId)));
}

describe("setPromoConsent", () => {
  test("withdraw clears the consent, audits the cleared timestamp as the buyer, and a second press changes nothing", async () => {
    await withRollback(async (tx) => {
      const consentAt = new Date("2026-10-01T03:00:00Z");
      const customer = await insertCustomer(tx, { promoConsentAt: consentAt });
      expect(await setPromoConsent(customer.id, false, tx)).toEqual({ changed: true });
      expect(await consentOf(tx, customer.id)).toBeNull();
      expect(await setPromoConsent(customer.id, false, tx)).toEqual({ changed: false });

      const audits = await auditsOf(tx, customer.id);
      expect(audits).toEqual([
        { action: "promo_consent_withdraw_self", actor: null, before: { promoConsentAt: consentAt.toISOString() }, after: { promoConsentAt: null, by: "customer" } },
      ]);
      // No contact data in the log.
      expect(JSON.stringify(audits)).not.toContain(customer.email!);
      expect(JSON.stringify(audits)).not.toContain(customer.phone!);
    });
  });

  test("opt in stamps now only when unset, audited; an existing consent keeps its date", async () => {
    await withRollback(async (tx) => {
      const customer = await insertCustomer(tx, { promoConsentAt: null });
      expect(await setPromoConsent(customer.id, true, tx)).toEqual({ changed: true });
      const stamped = await consentOf(tx, customer.id);
      expect(stamped).toBeInstanceOf(Date);
      expect(await setPromoConsent(customer.id, true, tx)).toEqual({ changed: false });
      expect(await consentOf(tx, customer.id)).toEqual(stamped);
      const audits = await auditsOf(tx, customer.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "promo_consent_grant_self", actor: null, before: { promoConsentAt: null }, after: { by: "customer", consentText: expect.stringContaining("kamu setuju dikirimi kabar koleksi baru dan promo") } });
    });
  });

  test("an unknown customer changes nothing", async () => {
    await withRollback(async (tx) => {
      expect(await setPromoConsent("00000000-0000-4000-8000-000000000000", false, tx)).toEqual({ changed: false });
    });
  });
});

describe("setPromoConsentAction", () => {
  const created = { customerIds: [] as string[], ips: new Set<string>() };

  beforeEach(async () => {
    sessionCustomerId = null;
    clientIp = `198.51.100.${randomInt(1, 254)}`;
    created.ips.add(clientIp);
    await testDb.delete(claimRateLimits).where(eq(claimRateLimits.ip, clientIp));
  });

  afterAll(async () => {
    if (created.customerIds.length > 0) {
      await testDb.delete(auditLog).where(inArray(auditLog.entityId, created.customerIds));
      await testDb.delete(customers).where(inArray(customers.id, created.customerIds));
    }
    if (created.ips.size > 0) await testDb.delete(claimRateLimits).where(inArray(claimRateLimits.ip, [...created.ips]));
  });

  async function consentingCustomer() {
    const customer = await insertCustomer(testDb, { promoConsentAt: new Date() });
    created.customerIds.push(customer.id);
    return customer;
  }

  test("without a session it sends the visitor to the login and changes nothing", async () => {
    const customer = await consentingCustomer();
    await expect(setPromoConsentAction(false)).rejects.toThrow("redirect:/login?next=%2Faccount");
    expect(await consentOf(testDb, customer.id)).not.toBeNull();
  });

  test("changes only the session customer's consent, both ways", async () => {
    const owner = await consentingCustomer();
    const stranger = await consentingCustomer();
    sessionCustomerId = owner.id;
    expect(await setPromoConsentAction(false)).toEqual({ ok: true });
    expect(await consentOf(testDb, owner.id)).toBeNull();
    expect(await consentOf(testDb, stranger.id)).not.toBeNull();
    expect(await setPromoConsentAction(true)).toEqual({ ok: true });
    expect(await consentOf(testDb, owner.id)).not.toBeNull();
  });

  test("anything but a boolean is refused", async () => {
    const owner = await consentingCustomer();
    sessionCustomerId = owner.id;
    expect(await setPromoConsentAction("false" as unknown as boolean)).toEqual({ ok: false, message: "Pilihan tidak dikenal. Muat ulang halaman ini." });
    expect(await consentOf(testDb, owner.id)).not.toBeNull();
  });

  test("is rate-limited per IP, counted before the change", async () => {
    const owner = await consentingCustomer();
    sessionCustomerId = owner.id;
    await testDb.insert(claimRateLimits).values(Array.from({ length: PROMO_CONSENT_CHANGE_LIMIT }, () => ({ ip: clientIp, action: "promo_consent_change" })));
    expect(await setPromoConsentAction(false)).toEqual({ ok: false, message: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi." });
    expect(await consentOf(testDb, owner.id)).not.toBeNull();
  });
});
