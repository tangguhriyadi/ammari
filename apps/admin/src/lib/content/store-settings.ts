import "server-only";
import { eq } from "drizzle-orm";
import { storeSettings } from "@ammari/db/schema";
import { ActionError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import type { SaveStoreSettingsInput } from "./store-settings-schema";

// ---------- Store settings: /content/settings, save = live (session 8) ----------
//
// A real singleton (migration 0020 guarantees exactly one row, id = 1, always exists — see that
// migration's own comment) — every function here reads/writes THAT one row, never creates one.
// No draft/publish pair: save = live, per the plan's own reasoning (single factual values, no
// "half-finished composition" risk).

export interface StoreSettingsRow {
  whatsappNumber: string | null;
  supportEmail: string | null;
  businessAddress: string | null;
  returnPolicySummary: string | null;
}

const SETTINGS_COLUMNS = {
  whatsappNumber: storeSettings.whatsappNumber,
  supportEmail: storeSettings.supportEmail,
  businessAddress: storeSettings.businessAddress,
  returnPolicySummary: storeSettings.returnPolicySummary,
};

export async function getStoreSettings(db: Database = defaultDb): Promise<StoreSettingsRow> {
  const [row] = await db.select(SETTINGS_COLUMNS).from(storeSettings).where(eq(storeSettings.id, 1)).limit(1);
  if (!row) throw new ActionError("Pengaturan toko tidak ditemukan.");
  return row;
}

/** Input is ALREADY normalized/validated (saveStoreSettingsSchema.parse — whatsappNumber in
 * `wa.me` format) — this function is a plain write, same "validation lives in the schema, this
 * layer only does the write + audit log" split info-pages.ts/homepage.ts already use. */
export async function saveStoreSettings(
  input: SaveStoreSettingsInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [before] = await tx.select(SETTINGS_COLUMNS).from(storeSettings).where(eq(storeSettings.id, 1)).limit(1);
    if (!before) throw new ActionError("Pengaturan toko tidak ditemukan.");

    const [after] = await tx.update(storeSettings).set(input).where(eq(storeSettings.id, 1)).returning();
    if (!after) throw new Error("failed to update store settings");

    await writeAuditLog(tx, {
      actorStaffUserId,
      action: "update",
      entityType: "store_settings",
      entityId: String(after.id),
      before,
      after: input,
    });
  });
}
