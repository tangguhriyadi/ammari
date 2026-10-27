import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { customers } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { MAX_WITHDRAWAL_NOTE_LENGTH, PROMO_WITHDRAWAL_SOURCES, type PromoWithdrawalSource } from "./consent-options";

// "Catat penarikan persetujuan promo" (docs/plans/growth.md §8.3, owner answer A7): the published
// policy promises withdrawal on request ("kapan saja", by WhatsApp or email) and there is no
// self-serve toggle yet (A11), so staff with customers.manage record it. One conditional UPDATE
// decides (the row is locked first only so the audit records the exact timestamp it cleared); the
// audit entry keeps that timestamp and where the request came from. The customer can opt in again
// at checkout (place-order stamps only when null).

export const PROMO_WITHDRAWAL_MESSAGES = {
  notFound: "Pelanggan tidak ditemukan.",
  alreadyInactive: "Persetujuan promo sudah tidak aktif.",
  source: "Pilih sumber permintaan.",
  noteRequired: "Untuk sumber Lainnya, tulis catatan.",
  noteTooLong: `Catatan maksimal ${MAX_WITHDRAWAL_NOTE_LENGTH} karakter.`,
} as const;

export interface PromoWithdrawalInput {
  customerId: string;
  source: PromoWithdrawalSource;
  note?: string | null;
}

export async function withdrawPromoConsent(input: PromoWithdrawalInput, actorStaffUserId: string, db: Database = defaultDb) {
  if (!PROMO_WITHDRAWAL_SOURCES.includes(input.source)) throw new FieldError("source", PROMO_WITHDRAWAL_MESSAGES.source);
  const note = input.note?.trim() || null;
  if (note !== null && note.length > MAX_WITHDRAWAL_NOTE_LENGTH) throw new FieldError("note", PROMO_WITHDRAWAL_MESSAGES.noteTooLong);
  if (input.source === "other" && note === null) throw new FieldError("note", PROMO_WITHDRAWAL_MESSAGES.noteRequired);

  return db.transaction(async (tx) => {
    const [before] = await tx.select({ id: customers.id, promoConsentAt: customers.promoConsentAt }).from(customers).where(eq(customers.id, input.customerId)).for("update");
    if (!before) throw new ActionError(PROMO_WITHDRAWAL_MESSAGES.notFound);
    const [row] = await tx
      .update(customers)
      .set({ promoConsentAt: null })
      .where(and(eq(customers.id, input.customerId), isNotNull(customers.promoConsentAt)))
      .returning({ id: customers.id, promoConsentAt: customers.promoConsentAt });
    if (!row) throw new ActionError(PROMO_WITHDRAWAL_MESSAGES.alreadyInactive);

    // Only the consent field and the request's source: no contact data in the log.
    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "promo_consent_withdraw",
      entityType: "customer",
      entityId: row.id,
      before: { promoConsentAt: before.promoConsentAt },
      after: { promoConsentAt: null, source: input.source, note },
    });
    return row;
  });
}
