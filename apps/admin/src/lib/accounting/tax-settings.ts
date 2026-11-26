import "server-only";
import { desc, eq } from "drizzle-orm";
import { taxSettings } from "@ammari/db/schema";
import { ActionError, FieldError, isPostgresErrorCode } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { TAX_SETTING_MESSAGES, validateTaxSetting, type TaxSettingFormInput } from "./tax-settings-input";

// Pengaturan pajak (D-20, docs/plans/accounting.md §2.1, Session 3): the PPh final settings, one
// row per "effective from" month; the row in force for a month is the latest one on or before it.
// The accountant edits them (never constants in code); each change is audited. Callers check
// accounting.view (reads) or accounting.view + accounting.manage (writes). The monthly accrual that
// reads them is Session 11; its journals are immutable once posted, so a later edit only affects
// months not yet accrued (D-23: changes apply going forward).

export type TaxSettingRow = typeof taxSettings.$inferSelect;

export async function listTaxSettings(db: Database = defaultDb): Promise<TaxSettingRow[]> {
  return db.select().from(taxSettings).orderBy(desc(taxSettings.effectiveFrom));
}

export async function getTaxSetting(effectiveFrom: string, db: Database = defaultDb): Promise<TaxSettingRow | null> {
  if (!/^\d{4}-\d{2}-01$/.test(effectiveFrom)) return null;
  const [row] = await db.select().from(taxSettings).where(eq(taxSettings.effectiveFrom, effectiveFrom)).limit(1);
  return row ?? null;
}

/** A new effective row. A month that already has one is refused by the primary key, not pre-checked. */
export async function createTaxSetting(input: TaxSettingFormInput, actorStaffUserId: string, db: Database = defaultDb) {
  const values = validateTaxSetting(input);
  return db.transaction(async (tx) => {
    try {
      const [created] = await tx.insert(taxSettings).values({ ...values, updatedByStaffUserId: actorStaffUserId }).returning();
      if (!created) throw new Error("failed to insert tax setting");
      await writeAuditLog(tx, { actorStaffUserId, action: "create", entityType: "tax_setting", entityId: created.effectiveFrom, after: created });
      return created;
    } catch (error) {
      if (isPostgresErrorCode(error, "23505")) throw new FieldError("effectiveFrom", TAX_SETTING_MESSAGES.effectiveFromTaken);
      throw error;
    }
  });
}

/** Every field but the month (the row's key). Most often: the rate's end date, once the PP 55
 * revision is confirmed. */
export async function updateTaxSetting(effectiveFrom: string, input: TaxSettingFormInput, actorStaffUserId: string, db: Database = defaultDb) {
  return db.transaction(async (tx) => {
    const [before] = /^\d{4}-\d{2}-01$/.test(effectiveFrom)
      ? await tx.select().from(taxSettings).where(eq(taxSettings.effectiveFrom, effectiveFrom)).for("update")
      : [];
    if (!before) throw new ActionError(TAX_SETTING_MESSAGES.notFound);
    // The month is the row's key: validateTaxSetting returns it unchanged, and it is not re-set.
    const values = validateTaxSetting(input, before.effectiveFrom);
    const [after] = await tx
      .update(taxSettings)
      .set({
        taxpayerType: values.taxpayerType,
        taxpayerLabel: values.taxpayerLabel,
        npwpRegisteredYear: values.npwpRegisteredYear,
        rateBps: values.rateBps,
        annualExemptionAmount: values.annualExemptionAmount,
        rateValidUntil: values.rateValidUntil,
        note: values.note,
        updatedByStaffUserId: actorStaffUserId,
      })
      .where(eq(taxSettings.effectiveFrom, before.effectiveFrom))
      .returning();
    if (!after) throw new Error("failed to update tax setting");
    await writeAuditLog(tx, { actorStaffUserId, action: "update", entityType: "tax_setting", entityId: before.effectiveFrom, before, after });
    return after;
  });
}
