import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { insertCustomer, insertStaffUser } from "@ammari/db/test-fixtures";
import { auditLog, customers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { PROMO_WITHDRAWAL_MESSAGES, withdrawPromoConsent } from "./consent";

// docs/plans/growth.md §8.3 (session S4). Opting in again at checkout afterwards is covered in
// packages/commerce/src/checkout/place-order.test.ts.

describe("withdrawPromoConsent", () => {
  test("clears the consent; the audit keeps the old timestamp and the source, no contact data", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx, "customer_service");
      const consentedAt = new Date("2026-09-01T03:00:00Z");
      const customer = await insertCustomer(tx, { promoConsentAt: consentedAt });
      await withdrawPromoConsent({ customerId: customer.id, source: "whatsapp", note: "  Chat 27 Okt  " }, staff.id, tx);

      const [after] = await tx.select().from(customers).where(eq(customers.id, customer.id));
      expect(after?.promoConsentAt).toBeNull();
      expect(after?.pdpConsentAt).toEqual(customer.pdpConsentAt);
      const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, customer.id), eq(auditLog.action, "promo_consent_withdraw")));
      expect(audit).toMatchObject({
        entityType: "customer",
        actorStaffUserId: staff.id,
        before: { promoConsentAt: consentedAt.toISOString() },
        after: { promoConsentAt: null, source: "whatsapp", note: "Chat 27 Okt" },
      });
      expect(JSON.stringify(audit)).not.toContain(customer.email);
      expect(JSON.stringify(audit)).not.toContain(customer.phone);
    });
  });

  test("a second withdrawal reports it is already inactive and writes nothing", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const customer = await insertCustomer(tx, { promoConsentAt: new Date() });
      await withdrawPromoConsent({ customerId: customer.id, source: "email" }, staff.id, tx);
      await expect(withdrawPromoConsent({ customerId: customer.id, source: "email" }, staff.id, tx)).rejects.toThrow(PROMO_WITHDRAWAL_MESSAGES.alreadyInactive);
      expect(await tx.select().from(auditLog).where(eq(auditLog.entityId, customer.id))).toHaveLength(1);
    });
  });

  test("source Lainnya needs a note; an unknown source or customer is refused", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const customer = await insertCustomer(tx, { promoConsentAt: new Date() });
      await expect(withdrawPromoConsent({ customerId: customer.id, source: "other", note: "  " }, staff.id, tx)).rejects.toThrow(FieldError);
      await expect(withdrawPromoConsent({ customerId: customer.id, source: "sms" as never }, staff.id, tx)).rejects.toThrow(PROMO_WITHDRAWAL_MESSAGES.source);
      await expect(withdrawPromoConsent({ customerId: customer.id, source: "email", note: "x".repeat(301) }, staff.id, tx)).rejects.toThrow(PROMO_WITHDRAWAL_MESSAGES.noteTooLong);
      await expect(withdrawPromoConsent({ customerId: randomUUID(), source: "email" }, staff.id, tx)).rejects.toThrow(ActionError);
      await withdrawPromoConsent({ customerId: customer.id, source: "other", note: "Telepon langsung" }, staff.id, tx);
    });
  });
});
