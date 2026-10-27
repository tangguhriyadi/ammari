import "server-only";
import { and, asc, exists, isNotNull, sql } from "drizzle-orm";
import { customerAuthUsers, customers } from "@ammari/db/schema";
import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";

// "Unduh kontak promo" (docs/plans/growth.md §10, owner answer A9). Lawful only narrowly: the
// privacy policy allows promo messages to someone who gave promo consent separately, and names
// the only parties data is shared with. So the export holds exactly the customers whose
// promo_consent_at is set now (withdrawn consent is NULL, so an export always reflects current
// consent) AND who have a main-site account: promo_consent_at is only ever stamped while logged
// in, the account guard keeps it that way even if another writer appears. Never a guest order's
// promo_opt_in (unverified email), never a staff-created customer. Four columns, nothing else.
// The route checks customers.view + customers.export first; the download is audited with the
// count only, never a row.

export interface PromoContact {
  name: string;
  email: string;
  phone: string | null;
  promoConsentAt: Date;
}

export async function listPromoContacts(db: Database = defaultDb): Promise<PromoContact[]> {
  const rows = await db
    .select({ name: customers.name, email: customers.email, phone: customers.phone, promoConsentAt: customers.promoConsentAt })
    .from(customers)
    .where(
      and(
        isNotNull(customers.promoConsentAt),
        isNotNull(customers.email),
        exists(db.select({ one: sql`1` }).from(customerAuthUsers).where(sql`${customerAuthUsers.customerId} = ${customers.id}`)),
      ),
    )
    .orderBy(asc(customers.promoConsentAt), asc(customers.id));
  return rows.map((row) => ({ name: row.name, email: row.email!, phone: row.phone, promoConsentAt: row.promoConsentAt! }));
}

/** Who exported, when and how many: never a name, email or phone. */
export async function recordPromoContactExport(actorStaffUserId: string, rowCount: number, db: Database = defaultDb): Promise<void> {
  await writeAuditLog(db, {
    actorStaffUserId,
    action: "export_promo_contacts",
    entityType: "customer_export",
    entityId: jakartaDate(),
    after: { filter: "promo_consent_with_account", rowCount },
  });
}
