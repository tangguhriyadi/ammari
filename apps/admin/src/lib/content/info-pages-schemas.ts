import { z } from "zod";
import { MAX_INFO_PAGE_HTML_LENGTH } from "@ammari/content-sanitize";

// ---------- Info page draft save (docs/plans/storefront-cms.md Phase 2, session 8) ----------
//
// Shape validation only — the actual sanitization (and the real, lower-level length cap check)
// happens in @ammari/content-sanitize's sanitizeInfoPageHtml, called unconditionally by the one
// function that writes info_pages.draft_body/published_body (info-pages.ts), same split
// products/actions.ts's updateProductStorefrontSchema already uses for storefrontDescriptionHtml.
// `.max()` here is just a fast, friendly pre-check against the sanitizer's own internal cap, so
// an oversized paste fails with a clean message instead of the sanitizer's own thrown error.

export const saveInfoPageDraftSchema = z.object({
  title: z.string().trim().min(1, "Judul wajib diisi.").max(100, "Judul terlalu panjang."),
  /** Raw TipTap HTML, UNSANITIZED — sanitizing it is saveInfoPageDraft's job, not the caller's. */
  bodyHtml: z.string().max(MAX_INFO_PAGE_HTML_LENGTH, "Konten terlalu panjang."),
});

export type SaveInfoPageDraftInput = z.infer<typeof saveInfoPageDraftSchema>;
