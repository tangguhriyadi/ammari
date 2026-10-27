import "server-only";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { customers } from "@ammari/db/schema";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { PROMO_CONSENT_TEXT } from "./promo-consent-messages";

// "Kabar promo" on /account (docs/plans/growth.md owner answer A11, session S6): the published
// policy promises promo consent can be withdrawn "kapan saja"; before this the only way was a
// WhatsApp or email request recorded by staff (admin "Catat penarikan persetujuan promo"). The
// buyer now stops it here, and can start it again: consent given while logged in, by pressing a
// button that says what they get, which is the same standard checkout's tick and the contact offer
// already meet. Only the session's own row: the customer id always comes from the session.
//
// Each change is one conditional UPDATE (no check-then-write): withdraw only while set, opt in only
// while unset (an existing consent keeps its original date). The row is locked first only so the
// audit keeps the exact timestamp it cleared, as the admin withdrawal does. Audited with the
// consent field alone, never contact data; actor_staff_user_id stays null (a buyer).

/** Per IP (`promo_consent_change` on claim_rate_limits): a real buyer presses it once or twice;
 * this only brakes a script filling the audit log. As generous as "Hapus alamat" (shared CGNAT). */
export const PROMO_CONSENT_CHANGE_WINDOW_SECONDS = 10 * 60;
export const PROMO_CONSENT_CHANGE_LIMIT = 30;

export async function setPromoConsent(customerId: string, wanted: boolean, db: Database = defaultDb): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select({ promoConsentAt: customers.promoConsentAt }).from(customers).where(eq(customers.id, customerId)).for("update");
    if (!before) return { changed: false };
    const [row] = await tx
      .update(customers)
      .set({ promoConsentAt: wanted ? sql`now()` : null })
      .where(and(eq(customers.id, customerId), wanted ? isNull(customers.promoConsentAt) : isNotNull(customers.promoConsentAt)))
      .returning({ id: customers.id, promoConsentAt: customers.promoConsentAt });
    if (!row) return { changed: false };
    await writeAuditLog(tx, {
      action: wanted ? "promo_consent_grant_self" : "promo_consent_withdraw_self",
      entityType: "customer",
      entityId: row.id,
      before: { promoConsentAt: before.promoConsentAt },
      // An opt-in also keeps the exact sentence the button showed (the consent evidence).
      after: wanted ? { promoConsentAt: row.promoConsentAt, by: "customer", consentText: PROMO_CONSENT_TEXT } : { promoConsentAt: row.promoConsentAt, by: "customer" },
    });
    return { changed: true };
  });
}
