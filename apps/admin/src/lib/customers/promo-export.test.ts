import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { checkoutOrderValues, insertCustomer, insertOrder, insertStaffUser } from "@ammari/db/test-fixtures";
import { auditLog, customerAuthUsers, customers } from "@ammari/db/schema";
import { withdrawPromoConsent } from "./consent";
import { listPromoContacts, recordPromoContactExport } from "./promo-export";

// docs/plans/growth.md §10 and §12.1 (session S6): only customers with promo consent now AND a
// main-site account, only four fields; the audit row has the count and never a contact.

async function withAccount(db: TestDatabase, customer: { id: string; name: string; email: string | null }) {
  await db.insert(customerAuthUsers).values({ customerId: customer.id, name: customer.name, email: customer.email ?? `${randomUUID()}@example.test`, emailVerified: true });
}

describe("listPromoContacts", () => {
  test("consenting account holders only, oldest consent first, exactly the four fields", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().slice(0, 8);
      const first = await insertCustomer(tx, { name: `Ekspor A ${marker}`, promoConsentAt: new Date("2026-01-02T03:00:00Z") });
      const second = await insertCustomer(tx, { name: `Ekspor B ${marker}`, phone: null, promoConsentAt: new Date("2026-03-02T03:00:00Z") });
      await withAccount(tx, first);
      await withAccount(tx, second);
      // Withdrawn: out.
      const withdrawn = await insertCustomer(tx, { name: `Ekspor ditarik ${marker}`, promoConsentAt: null });
      await withAccount(tx, withdrawn);
      // Consent without an account (never stamped that way today, guarded anyway): out.
      await insertCustomer(tx, { name: `Ekspor tanpa akun ${marker}`, promoConsentAt: new Date() });
      // A guest checkout that ticked promo on the order only: out.
      const guest = await insertCustomer(tx, { name: `Ekspor tamu ${marker}`, promoConsentAt: null });
      await insertOrder(tx, { customerId: guest.id, promoOptIn: true });

      const mine = (await listPromoContacts(tx)).filter((row) => row.name.endsWith(marker));
      expect(mine).toEqual([
        { name: first.name, email: first.email, phone: first.phone, promoConsentAt: new Date("2026-01-02T03:00:00Z") },
        { name: second.name, email: second.email, phone: null, promoConsentAt: new Date("2026-03-02T03:00:00Z") },
      ]);
      expect(Object.keys(mine[0]!).sort()).toEqual(["email", "name", "phone", "promoConsentAt"]);
    });
  });
});

// The account check is a correlated EXISTS (each customer against ITS OWN account). Every case below
// sits next to other customers who DO have accounts, so a correlation that compared the wrong
// columns (always true: "some account exists"; always false: "no customer matches") fails here.
describe("listPromoContacts: only current promo consent AND a site account", () => {
  const exported = async (db: TestDatabase, marker: string) =>
    (await listPromoContacts(db)).filter((row) => row.name.endsWith(marker)).map((row) => row.name);

  test("in: consent + account. Out: never consented, withdrawn, guest-only, guest-checkout consent only", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().slice(0, 8);
      const staff = await insertStaffUser(tx);

      const consenting = await insertCustomer(tx, { name: `in ${marker}`, promoConsentAt: new Date("2026-05-01T00:00:00Z") });
      await withAccount(tx, consenting);

      // Has an account, never consented.
      const neverConsented = await insertCustomer(tx, { name: `never ${marker}`, promoConsentAt: null });
      await withAccount(tx, neverConsented);

      // Consented, then withdrew through the real "Catat penarikan" path.
      const withdrawn = await insertCustomer(tx, { name: `withdrawn ${marker}`, promoConsentAt: new Date("2026-04-01T00:00:00Z") });
      await withAccount(tx, withdrawn);
      await withdrawPromoConsent({ customerId: withdrawn.id, source: "whatsapp" }, staff.id, tx);

      // Guest only: a consent timestamp but no site account (not stamped this way today; the
      // account guard must still keep it out).
      await insertCustomer(tx, { name: `guest ${marker}`, promoConsentAt: new Date("2026-03-01T00:00:00Z") });

      // Ticked promo only on a guest web checkout (orders.promo_opt_in, unverified email), and
      // later made an account: the order's tick is never consent on the customer.
      const guestCheckoutOnly = await insertCustomer(tx, { name: `checkout ${marker}`, promoConsentAt: null });
      await insertOrder(tx, { ...checkoutOrderValues(), customerId: guestCheckoutOnly.id, promoOptIn: true, placedWithSession: false });
      await withAccount(tx, guestCheckoutOnly);

      expect(await exported(tx, marker)).toEqual([consenting.name]);
    });
  });

  test("consent, withdrawn, re-consented: included again, with the NEW consent date", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().slice(0, 8);
      const staff = await insertStaffUser(tx);
      const customer = await insertCustomer(tx, { name: `again ${marker}`, promoConsentAt: new Date("2026-01-10T00:00:00Z") });
      await withAccount(tx, customer);
      expect(await exported(tx, marker)).toEqual([customer.name]);

      await withdrawPromoConsent({ customerId: customer.id, source: "email" }, staff.id, tx);
      expect(await exported(tx, marker)).toEqual([]);

      // Opting in again stamps a fresh timestamp only while it is NULL (place-order's and
      // /account's conditional UPDATE).
      const reconsentAt = new Date("2026-06-15T08:00:00Z");
      await tx.update(customers).set({ promoConsentAt: reconsentAt }).where(and(eq(customers.id, customer.id), isNull(customers.promoConsentAt)));

      const rows = (await listPromoContacts(tx)).filter((row) => row.name.endsWith(marker));
      expect(rows).toEqual([{ name: customer.name, email: customer.email, phone: customer.phone, promoConsentAt: reconsentAt }]);
    });
  });

  test("each customer is matched against its own account, not any account", async () => {
    await withRollback(async (tx) => {
      const marker = randomUUID().slice(0, 8);
      // Many account holders without consent around one consenting customer without an account.
      for (let index = 0; index < 3; index += 1) {
        await withAccount(tx, await insertCustomer(tx, { name: `holder ${index} ${marker}`, promoConsentAt: null }));
      }
      await insertCustomer(tx, { name: `no account ${marker}`, promoConsentAt: new Date() });
      expect(await exported(tx, marker)).toEqual([]);
    });
  });
});

describe("recordPromoContactExport", () => {
  test("audits who and how many, never a contact", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await recordPromoContactExport(staff.id, 7, tx);
      const [row] = await tx
        .select({ after: auditLog.after, entityId: auditLog.entityId })
        .from(auditLog)
        .where(and(eq(auditLog.actorStaffUserId, staff.id), eq(auditLog.action, "export_promo_contacts"), eq(auditLog.entityType, "customer_export")));
      expect(row).toMatchObject({ after: { filter: "promo_consent_with_account", rowCount: 7 } });
      expect(row!.entityId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
