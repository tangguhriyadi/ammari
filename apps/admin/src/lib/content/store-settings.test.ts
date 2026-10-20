import { eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { auditLog, storeSettings } from "@ammari/db/schema";
import { ANNOUNCEMENT_BAR_DEFAULT_TEXT } from "@ammari/db/storefront-settings";
import { getStoreSettings, saveStoreSettings } from "./store-settings";

const ACTOR_ID = null;

const STOREFRONT_DEFAULTS = {
  announcementBarEnabled: true,
  announcementBarText: "Gratis Ongkir Ke Seluruh Indonesia",
  homepageMetaTitle: null,
  homepageMetaDescription: null,
};

describe("getStoreSettings", () => {
  test("the singleton row always exists (seeded by migration 0020): contact fields null, the bar on with its default text (0029)", async () => {
    await withRollback(async (tx) => {
      await tx
        .update(storeSettings)
        .set({
          whatsappNumber: null,
          supportEmail: null,
          businessAddress: null,
          returnPolicySummary: null,
          announcementBarEnabled: sql`DEFAULT`,
          announcementBarText: sql`DEFAULT`,
          homepageMetaTitle: null,
          homepageMetaDescription: null,
        })
        .where(eq(storeSettings.id, 1));
      const settings = await getStoreSettings(tx);
      expect(settings).toEqual({
        whatsappNumber: null,
        supportEmail: null,
        businessAddress: null,
        returnPolicySummary: null,
        announcementBarEnabled: true,
        announcementBarText: ANNOUNCEMENT_BAR_DEFAULT_TEXT,
        homepageMetaTitle: null,
        homepageMetaDescription: null,
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
          announcementBarEnabled: false,
          announcementBarText: "Diskon akhir tahun",
          homepageMetaTitle: "Ammari | Gamis syar'i",
          homepageMetaDescription: "Gamis syar'i yang nyaman dipakai seharian.",
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
        announcementBarEnabled: false,
        announcementBarText: "Diskon akhir tahun",
        homepageMetaTitle: "Ammari | Gamis syar'i",
        homepageMetaDescription: "Gamis syar'i yang nyaman dipakai seharian.",
      });
    });
  });

  test("writes an audit log row", async () => {
    await withRollback(async (tx) => {
      await saveStoreSettings({ whatsappNumber: null, supportEmail: null, businessAddress: null, returnPolicySummary: null, ...STOREFRONT_DEFAULTS }, ACTOR_ID, tx);
      const entries = await tx.select().from(auditLog).where(eq(auditLog.entityType, "store_settings"));
      expect(entries.some((entry) => entry.action === "update")).toBe(true);
    });
  });

  test("a field left out clears back to null — this is a full replace, not a partial merge", async () => {
    await withRollback(async (tx) => {
      await saveStoreSettings(
        { whatsappNumber: "6281234567890", supportEmail: "halo@ammari.id", businessAddress: "Jl. Contoh", returnPolicySummary: "Ringkasan", ...STOREFRONT_DEFAULTS, homepageMetaTitle: "Judul" },
        ACTOR_ID,
        tx,
      );
      await saveStoreSettings({ whatsappNumber: "6281234567890", supportEmail: null, businessAddress: null, returnPolicySummary: null, ...STOREFRONT_DEFAULTS }, ACTOR_ID, tx);

      const settings = await getStoreSettings(tx);
      expect(settings).toEqual({ whatsappNumber: "6281234567890", supportEmail: null, businessAddress: null, returnPolicySummary: null, ...STOREFRONT_DEFAULTS });
    });
  });
});
