import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { withRollback } from "@ammari/db/test-utils";
import { auditLog } from "@ammari/db/schema";
import { ContentTooLargeError } from "@ammari/content-sanitize";
import { discardInfoPageDraft, getInfoPage, listInfoPages, publishInfoPage, saveInfoPageDraft } from "./info-pages";
import { infoPageHasUnpublishedChanges, type InfoPageRow } from "./info-pages-types";

const ACTOR_ID = null;

describe("infoPageHasUnpublishedChanges (pure, no DB)", () => {
  function row(overrides: Partial<InfoPageRow> = {}): InfoPageRow {
    return {
      id: "row-1",
      slug: "shipping",
      title: "Pengiriman",
      draftBody: "",
      draftUpdatedAt: new Date(),
      publishedBody: null,
      publishedAt: null,
      ...overrides,
    };
  }

  test("a never-published page with an empty draft reports no changes", () => {
    expect(infoPageHasUnpublishedChanges(row())).toBe(false);
  });

  test("a never-published page with a non-empty draft reports changes", () => {
    expect(infoPageHasUnpublishedChanges(row({ draftBody: "<p>Draf</p>" }))).toBe(true);
  });

  test("a published page whose draft equals its published body reports no changes", () => {
    expect(infoPageHasUnpublishedChanges(row({ draftBody: "<p>Sama</p>", publishedBody: "<p>Sama</p>" }))).toBe(false);
  });

  test("a published page edited since reports changes", () => {
    expect(infoPageHasUnpublishedChanges(row({ draftBody: "<p>Baru</p>", publishedBody: "<p>Lama</p>" }))).toBe(true);
  });
});

describe("listInfoPages", () => {
  test("always returns exactly 5 rows, in INFO_PAGE_SLUGS' canonical order", async () => {
    await withRollback(async (tx) => {
      const rows = await listInfoPages(tx);
      expect(rows.map((row) => row.slug)).toEqual([
        "privacy-policy",
        "terms-of-service",
        "returns-exchange",
        "how-to-order",
        "shipping",
      ]);
    });
  });
});

describe("saveInfoPageDraft", () => {
  test("sanitizes the HTML server-side and writes only the draft columns", async () => {
    await withRollback(async (tx) => {
      await saveInfoPageDraft(
        "shipping",
        { title: "Pengiriman", bodyHtml: '<h2>Area</h2><p onclick="x()">Dikirim ke seluruh Indonesia.</p>' },
        ACTOR_ID,
        tx,
      );

      const page = await getInfoPage("shipping", tx);
      expect(page?.draftBody).toBe("<h2>Area</h2><p>Dikirim ke seluruh Indonesia.</p>");
      expect(page?.publishedBody).toBeNull();
    });
  });

  test("strips a script tag entirely, same allowlist as sanitizeInfoPageHtml", async () => {
    await withRollback(async (tx) => {
      await saveInfoPageDraft("shipping", { title: "Pengiriman", bodyHtml: "<p>Halo</p><script>alert(1)</script>" }, ACTOR_ID, tx);
      const page = await getInfoPage("shipping", tx);
      expect(page?.draftBody).toBe("<p>Halo</p>");
    });
  });

  test("an oversized body throws a FieldError, not the raw ContentTooLargeError", async () => {
    await withRollback(async (tx) => {
      const huge = `<p>${"a".repeat(250_000)}</p>`;
      await expect(saveInfoPageDraft("shipping", { title: "Pengiriman", bodyHtml: huge }, ACTOR_ID, tx)).rejects.not.toBeInstanceOf(
        ContentTooLargeError,
      );
    });
  });

  test("writes an audit log row", async () => {
    await withRollback(async (tx) => {
      await saveInfoPageDraft("how-to-order", { title: "Cara Pemesanan", bodyHtml: "<p>Langkah 1</p>" }, ACTOR_ID, tx);
      const entries = await tx.select().from(auditLog).where(eq(auditLog.entityType, "info_page"));
      expect(entries.some((entry) => entry.action === "save_draft")).toBe(true);
    });
  });
});

describe("publishInfoPage", () => {
  test("promotes this page's draft to published, independent of other pages", async () => {
    await withRollback(async (tx) => {
      await saveInfoPageDraft("how-to-order", { title: "Cara Pemesanan", bodyHtml: "<p>Langkah 1</p>" }, ACTOR_ID, tx);
      await publishInfoPage("how-to-order", ACTOR_ID, tx);

      const published = await getInfoPage("how-to-order", tx);
      expect(published?.publishedBody).toBe("<p>Langkah 1</p>");
      expect(published?.publishedAt).not.toBeNull();

      // shipping was never touched — publishing one page must not publish another.
      const untouched = await getInfoPage("shipping", tx);
      expect(untouched?.publishedBody).toBeNull();
    });
  });
});

describe("discardInfoPageDraft", () => {
  test("resets the draft back to the published body", async () => {
    await withRollback(async (tx) => {
      await saveInfoPageDraft("how-to-order", { title: "Cara Pemesanan", bodyHtml: "<p>Published</p>" }, ACTOR_ID, tx);
      await publishInfoPage("how-to-order", ACTOR_ID, tx);
      await saveInfoPageDraft("how-to-order", { title: "Cara Pemesanan", bodyHtml: "<p>Unsaved edit</p>" }, ACTOR_ID, tx);

      const result = await discardInfoPageDraft("how-to-order", ACTOR_ID, tx);
      // The caller (InfoPageForm) needs this back to force the already-mounted TipTap editor to
      // remount with the reset content — a plain client-state update alone doesn't change what
      // an editor initialized with `useEditor({ content })` is currently displaying.
      expect(result.bodyHtml).toBe("<p>Published</p>");

      const page = await getInfoPage("how-to-order", tx);
      expect(page?.draftBody).toBe("<p>Published</p>");
    });
  });

  test("resets to empty for a page that was never published", async () => {
    await withRollback(async (tx) => {
      await saveInfoPageDraft("shipping", { title: "Pengiriman", bodyHtml: "<p>Unsaved</p>" }, ACTOR_ID, tx);
      const result = await discardInfoPageDraft("shipping", ACTOR_ID, tx);
      expect(result.bodyHtml).toBe("");
      const page = await getInfoPage("shipping", tx);
      expect(page?.draftBody).toBe("");
    });
  });
});
