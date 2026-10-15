import "server-only";
import { eq } from "drizzle-orm";
import { products } from "@ammari/db/schema";
import { ContentTooLargeError, sanitizeStorefrontDescriptionHtml } from "@ammari/content-sanitize";
import { ActionError, FieldError, isPostgresErrorCode } from "@/lib/errors";
import { hasImagesMissingAltText } from "./image-queries";
import { defaultDb, lockProductForUpdate, writeAuditLog, type Database } from "./db";

// ---------- Product storefront fields (docs/plans/storefront-cms.md) ----------
//
// Deliberately separate from queries.ts's createProduct/updateProduct (both gated by
// `products.manage`) — this is the ONE write path for the fields gated by `content.manage`
// instead (publish flag, storefront description, all-size fit note, size chart assignment). A
// staff user with `products.manage` but not `content.manage` can still edit everything
// updateProduct covers; only this function, reached only through
// updateProductStorefrontAction (actions.ts, `requirePermission("content.manage")`), can touch
// these 4 columns.

export interface UpdateProductStorefrontInput {
  isPublishedOnStorefront: boolean;
  /** Raw HTML straight from the TipTap editor, UNSANITIZED — sanitizing it is this function's
   * job, not the caller's (see sanitizeStorefrontDescriptionHtml's own doc comment on why the
   * save path can't trust the client even though the editor itself can't author anything else). */
  storefrontDescriptionHtml: string | null;
  allsizeFitNote: string | null;
  sizeChartId: string | null;
}

/** TipTap's own canonical "empty document" HTML — stored as `null`, not as a literal empty
 * paragraph, so "no description yet" stays a clean null rather than an HTML string that merely
 * LOOKS empty when rendered. */
const EMPTY_EDITOR_HTML = "<p></p>";

export async function updateProductStorefront(
  id: string,
  input: UpdateProductStorefrontInput,
  actorStaffUserId: string | null,
  db: Database = defaultDb,
): Promise<typeof products.$inferSelect> {
  return db.transaction(async (tx) => {
    // FOR UPDATE — same reasoning as updateProduct's own lock (queries.ts): serializes against a
    // concurrent photo upload/delete (which could change whether the alt-text check below still
    // holds) or another storefront save on this same product.
    const before = await lockProductForUpdate(tx, id);
    if (!before) throw new ActionError("Produk tidak ditemukan.");

    // Every one of these is ALSO a real DB guarantee or a pre-existing invariant somewhere else
    // (the is_active CHECK, the size_chart_id FK, the required-photo invariant's own alt-text
    // gap) — these checks exist purely to turn "publish rejected" into a friendly Indonesian
    // message pointing at the right field, the same "pre-check + friendly catch on the race"
    // pattern updateProduct already uses for fabric/closure immutability.
    if (input.isPublishedOnStorefront) {
      if (!before.isActive) {
        throw new FieldError("isPublishedOnStorefront", "Produk harus aktif sebelum bisa ditayangkan di storefront.");
      }
      if (before.sizeMode === "sized" && !input.sizeChartId) {
        throw new FieldError("sizeChartId", "Pilih size chart sebelum menayangkan produk ukuran XS-XL ini di storefront.");
      }
      if (await hasImagesMissingAltText(id, tx)) {
        throw new ActionError(
          "Semua foto produk harus memiliki teks alternatif sebelum bisa ditayangkan di storefront. Lengkapi di bagian Foto di bawah.",
        );
      }
    }

    let storefrontDescription: string | null;
    try {
      const sanitized = input.storefrontDescriptionHtml
        ? sanitizeStorefrontDescriptionHtml(input.storefrontDescriptionHtml)
        : null;
      storefrontDescription = sanitized && sanitized !== EMPTY_EDITOR_HTML ? sanitized : null;
    } catch (error) {
      if (error instanceof ContentTooLargeError) throw new FieldError("storefrontDescriptionHtml", "Deskripsi terlalu panjang.");
      throw error;
    }

    try {
      const [after] = await tx
        .update(products)
        .set({
          isPublishedOnStorefront: input.isPublishedOnStorefront,
          storefrontDescription,
          allsizeFitNote: input.allsizeFitNote,
          sizeChartId: input.sizeChartId,
        })
        .where(eq(products.id, id))
        .returning();
      if (!after) throw new Error("failed to update product storefront fields");
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "update_storefront",
        entityType: "product",
        entityId: id,
        before,
        after,
      });
      return after;
    } catch (error) {
      // 23503: products.size_chart_id -> size_charts(id) ON DELETE RESTRICT — reached if the
      // chart was deleted concurrently between the form loading its options and this save.
      if (isPostgresErrorCode(error, "23503")) throw new FieldError("sizeChartId", "Size chart tidak ditemukan.");
      // 23514: products_is_published_on_storefront_active_check — reachable only via a race
      // (product deactivated concurrently between the pre-check above and this UPDATE); the
      // pre-check above already covers the common, non-racy path with the same message.
      if (isPostgresErrorCode(error, "23514")) {
        throw new FieldError("isPublishedOnStorefront", "Produk harus aktif sebelum bisa ditayangkan di storefront.");
      }
      throw error;
    }
  });
}
