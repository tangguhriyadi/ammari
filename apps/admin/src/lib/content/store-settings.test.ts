import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { auditLog } from "@ammari/db/schema";
import { getStoreSettings, saveStoreSettings } from "./store-settings";

const ACTOR_ID = null;

describe("getStoreSettings", () => {
  test("the singleton row always exists (seeded by migration 0020) — every field null before anyone saves", async () => {
    await withRollback(async (tx) => {
      const settings = await getStoreSettings(tx);
      expect(settings).toEqual({
        whatsappNumber: null,
        supportEmail: null,
        businessAddress: null,
        returnPolicySummary: null,
      });
    });
  });
});

describe("saveStoreSettings", () => {
  test("writes every field and they come back on the next read (save = live)", async () => {
    await withRollback(async (tx) => {
      await saveStoreSettings(
        {
          whatsappNumber: "6281234567890",
          supportEmail: "halo@ammari.id",
          businessAddress: "Jl. Contoh No. 1",
          returnPolicySummary: "Tukar ukuran dalam 3 hari",
        },
        ACTOR_ID,
        tx,
      );

      const settings = await getStoreSettings(tx);
      expect(settings).toEqual({
        whatsappNumber: "6281234567890",
        supportEmail: "halo@ammari.id",
        businessAddress: "Jl. Contoh No. 1",
        returnPolicySummary: "Tukar ukuran dalam 3 hari",
      });
    });
  });

  test("writes an audit log row", async () => {
    await withRollback(async (tx) => {
      await saveStoreSettings({ whatsappNumber: null, supportEmail: null, businessAddress: null, returnPolicySummary: null }, ACTOR_ID, tx);
      const entries = await tx.select().from(auditLog).where(eq(auditLog.entityType, "store_settings"));
      expect(entries.some((entry) => entry.action === "update")).toBe(true);
    });
  });

  test("a field left out clears back to null — this is a full replace, not a partial merge", async () => {
    await withRollback(async (tx) => {
      await saveStoreSettings(
        { whatsappNumber: "6281234567890", supportEmail: "halo@ammari.id", businessAddress: "Jl. Contoh", returnPolicySummary: "Ringkasan" },
        ACTOR_ID,
        tx,
      );
      await saveStoreSettings({ whatsappNumber: "6281234567890", supportEmail: null, businessAddress: null, returnPolicySummary: null }, ACTOR_ID, tx);

      const settings = await getStoreSettings(tx);
      expect(settings).toEqual({ whatsappNumber: "6281234567890", supportEmail: null, businessAddress: null, returnPolicySummary: null });
    });
  });
});
