import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { insertCustomer, insertOrder, insertStaffUser } from "@ammari/db/test-fixtures";
import { auditLog, customerAuthUsers } from "@ammari/db/schema";
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
