import { describe, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { seed } from "../src/seed";
import { testDb } from "./helpers";
import {
  channels,
  costAssumptions,
  infoPages,
  permissions,
  rolePermissions,
  roles,
  staffUsers,
  storefrontHomepageSections,
  storeSettings,
} from "../src/schema";

async function count(table: PgTable) {
  const [row] = await testDb.select({ count: sql<number>`count(*)::int` }).from(table);
  if (!row) throw new Error("count query returned no rows");
  return row.count;
}

async function rowCounts() {
  const [channelCount, permissionCount, roleCount, rolePermissionCount, costAssumptionCount, staffUserCount] =
    await Promise.all([
      count(channels),
      count(permissions),
      count(roles),
      count(rolePermissions),
      count(costAssumptions),
      count(staffUsers),
    ]);
  return { channelCount, permissionCount, roleCount, rolePermissionCount, costAssumptionCount, staffUserCount };
}

describe("db:seed", () => {
  test("running the seed again does not change row counts (global-setup already ran it once)", async () => {
    const before = await rowCounts();

    await seed(testDb);
    const afterFirstRerun = await rowCounts();
    expect(afterFirstRerun).toEqual(before);

    await seed(testDb);
    const afterSecondRerun = await rowCounts();
    expect(afterSecondRerun).toEqual(before);
  });

  // This is the one table seed.ts touches that holds genuine owner-authored content (every
  // other seed-touched table — channels, permissions, system roles/role_permissions — is a pure
  // code-defined catalog with no admin-facing edit path at all, confirmed by grepping apps/admin
  // and apps/web for any write to those tables before this test was added: none exists, so
  // upsertChannels/syncPermissionCatalog/upsertSystemRole's own onConflictDoUpdate calls can't
  // currently clobber anything an owner typed in). seedHomepageSections must stay
  // onConflictDoNothing forever — this runs on the deployed dev server (staff bootstrap) and
  // will on prod, so an upsert here would silently wipe a live homepage draft/publish on the
  // next deploy. Not wrapped in a transaction/rollback (same direct-testDb style as the test
  // above, which this file already shares ammari_test with) — restores the row in `finally` so
  // it never leaks into another test.
  test("re-running the seed never overwrites existing homepage section draft/published content", async () => {
    const [before] = await testDb
      .select()
      .from(storefrontHomepageSections)
      .where(eq(storefrontHomepageSections.key, "hero"))
      .limit(1);
    if (!before) throw new Error('"hero" row missing — migration 0019 / seedHomepageSections did not run');

    const ownerDraftContent = {
      eyebrow: "Ditulis pemilik",
      headline: "Jangan ditimpa seed",
      ctaLabel: "Belanja",
      ctaTarget: { type: "anchor" },
      image: null,
    };
    const ownerPublishedContent = {
      eyebrow: "Sudah terbit",
      headline: "Jangan ditimpa seed juga",
      ctaLabel: "Lihat",
      ctaTarget: { type: "anchor" },
      image: null,
    };

    try {
      await testDb
        .update(storefrontHomepageSections)
        .set({
          draftContent: ownerDraftContent,
          draftIsVisible: false,
          publishedContent: ownerPublishedContent,
          publishedIsVisible: true,
          publishedAt: new Date(),
        })
        .where(eq(storefrontHomepageSections.key, "hero"));

      await seed(testDb);
      await seed(testDb); // twice, same "idempotent across reruns" posture as the test above

      const [after] = await testDb
        .select()
        .from(storefrontHomepageSections)
        .where(eq(storefrontHomepageSections.key, "hero"))
        .limit(1);
      expect(after?.draftContent).toEqual(ownerDraftContent);
      expect(after?.draftIsVisible).toBe(false);
      expect(after?.publishedContent).toEqual(ownerPublishedContent);
      expect(after?.publishedIsVisible).toBe(true);
    } finally {
      await testDb
        .update(storefrontHomepageSections)
        .set({
          draftContent: before.draftContent,
          draftIsVisible: before.draftIsVisible,
          publishedContent: before.publishedContent,
          publishedIsVisible: before.publishedIsVisible,
          publishedAt: before.publishedAt,
          publishedByStaffUserId: before.publishedByStaffUserId,
        })
        .where(eq(storefrontHomepageSections.key, "hero"));
    }
  });

  // Session 8 — same reasoning/pattern as the homepage-sections test above: a
  // packages/db/test/e2e-db.ts TRUNCATE-and-reseed run must restore these 5 rows (seedInfoPages),
  // but re-running the seed against an EXISTING, already-edited-by-the-owner row must never
  // clobber it.
  test("the 5 info_pages rows exist after seeding, and re-running the seed never overwrites an owner's published page", async () => {
    const [before] = await testDb.select().from(infoPages).where(eq(infoPages.slug, "shipping")).limit(1);
    if (!before) throw new Error('"shipping" row missing — migration 0020 / seedInfoPages did not run');

    const ownerBody = "<p>Ditulis pemilik, jangan ditimpa seed</p>";
    try {
      await testDb.update(infoPages).set({ draftBody: ownerBody, publishedBody: ownerBody, publishedAt: new Date() }).where(eq(infoPages.slug, "shipping"));

      await seed(testDb);
      await seed(testDb);

      const rows = await testDb.select({ slug: infoPages.slug }).from(infoPages);
      expect(rows.map((r) => r.slug).sort()).toEqual(["how-to-order", "privacy-policy", "returns-exchange", "shipping", "terms-of-service"]);

      const [after] = await testDb.select().from(infoPages).where(eq(infoPages.slug, "shipping")).limit(1);
      expect(after?.draftBody).toBe(ownerBody);
      expect(after?.publishedBody).toBe(ownerBody);
    } finally {
      await testDb
        .update(infoPages)
        .set({ draftBody: before.draftBody, publishedBody: before.publishedBody, publishedAt: before.publishedAt, publishedByStaffUserId: before.publishedByStaffUserId })
        .where(eq(infoPages.slug, "shipping"));
    }
  });

  test("privacy-policy/terms-of-service are seeded already-published with their placeholder text", async () => {
    const rows = await testDb
      .select({ slug: infoPages.slug, publishedBody: infoPages.publishedBody })
      .from(infoPages)
      .where(eq(infoPages.slug, "privacy-policy"));
    expect(rows[0]?.publishedBody).toContain("Undang-Undang Pelindungan Data Pribadi");
  });

  test("the store_settings singleton row exists after seeding, and re-running the seed never overwrites the owner's saved settings", async () => {
    const [before] = await testDb.select().from(storeSettings).where(eq(storeSettings.id, 1)).limit(1);
    if (!before) throw new Error("store_settings row missing — migration 0020 / seedStoreSettings did not run");

    try {
      await testDb.update(storeSettings).set({ whatsappNumber: "6281234567890", supportEmail: "owner@ammari.id" }).where(eq(storeSettings.id, 1));

      await seed(testDb);
      await seed(testDb);

      const [after] = await testDb.select().from(storeSettings).where(eq(storeSettings.id, 1)).limit(1);
      expect(after?.whatsappNumber).toBe("6281234567890");
      expect(after?.supportEmail).toBe("owner@ammari.id");
    } finally {
      await testDb
        .update(storeSettings)
        .set({ whatsappNumber: before.whatsappNumber, supportEmail: before.supportEmail, businessAddress: before.businessAddress, returnPolicySummary: before.returnPolicySummary })
        .where(eq(storeSettings.id, 1));
    }
  });
});
