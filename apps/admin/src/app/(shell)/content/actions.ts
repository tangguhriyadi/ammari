"use server";

import { z } from "zod";
import { INFO_PAGE_SLUGS, type InfoPageSlug } from "@ammari/db/schema";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import * as homepage from "@/lib/content/homepage";
import * as infoPages from "@/lib/content/info-pages";
import {
  featureBlockContentSchema,
  heroContentSchema,
  homepageSectionVisibilitySchema,
  productGridContentSchema,
  whyAmmariContentSchema,
} from "@/lib/content/homepage-schemas";
import { saveInfoPageDraftSchema } from "@/lib/content/info-pages-schemas";
import { uploadContentImage, type UploadedContentImage } from "@/lib/content/content-image-queries";
import { revalidateHomepage } from "@/lib/revalidate";
import { getMainSiteUrl } from "@/lib/main-site-url";
import { generateHomepagePreviewToken } from "@/lib/content/preview-token";

// ---------- Homepage section drafts + publish (docs/plans/storefront-cms.md, session 4) ----------
//
// Every action here is gated by `content.manage` — same permission as the product form's
// Storefront section and /content/size-charts, never a role-name check (CLAUDE.md's dynamic
// RBAC rule). Zod shape validation happens HERE (a bad shape becomes a friendly top-level error);
// business-rule checks that need the database (does a referenced product still resolve to
// something published) happen in @/lib/content/homepage, surfaced via thrown
// FieldError/ActionError -> runAction.

const heroInputSchema = homepageSectionVisibilitySchema.extend({ content: heroContentSchema });
const productGridInputSchema = homepageSectionVisibilitySchema.extend({ content: productGridContentSchema });
const featureBlockInputSchema = homepageSectionVisibilitySchema.extend({ content: featureBlockContentSchema });
const whyAmmariInputSchema = homepageSectionVisibilitySchema.extend({ content: whyAmmariContentSchema });

export async function saveHeroDraftAction(input: z.input<typeof heroInputSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = heroInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await homepage.saveHeroDraft(parsed.data, session.staffUser.id);
    return undefined;
  });
}

export async function saveProductGridDraftAction(input: z.input<typeof productGridInputSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = productGridInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await homepage.saveProductGridDraft(parsed.data, session.staffUser.id);
    return undefined;
  });
}

export async function saveFeatureBlockDraftAction(input: z.input<typeof featureBlockInputSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = featureBlockInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await homepage.saveFeatureBlockDraft(parsed.data, session.staffUser.id);
    return undefined;
  });
}

export async function saveWhyAmmariDraftAction(input: z.input<typeof whyAmmariInputSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsed = whyAmmariInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await homepage.saveWhyAmmariDraft(parsed.data, session.staffUser.id);
    return undefined;
  });
}

const sectionKeySchema = z.enum(["hero", "product_grid", "feature_block", "why_ammari"]);

export async function setHomepageSectionVisibilityAction(key: string, isVisible: boolean): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsedKey = sectionKeySchema.safeParse(key);
  if (!parsedKey.success) return { ok: false, error: "Bagian tidak valid." };
  return runAction(async () => {
    await homepage.setHomepageSectionDraftVisibility(parsedKey.data, isVisible, session.staffUser.id);
    return undefined;
  });
}

export async function publishHomepageAction(): Promise<ActionResult<{ revalidationOk: boolean }>> {
  const session = await requirePermission("content.manage");
  return runAction(async () => {
    await homepage.publishHomepageSections(session.staffUser.id);
    // revalidateHomepage() never throws (lib/revalidate.ts) — a failure here can only ever
    // surface as `revalidationOk: false`, never as a failed publish (CLAUDE.md/the plan: "a
    // failed revalidation must never fail the admin action").
    const revalidationOk = (await revalidateHomepage()).ok;
    return { revalidationOk };
  });
}

/** Re-runs ONLY the revalidation call, for the "Coba lagi" button the UI shows when
 * `publishHomepageAction` reports `revalidationOk: false`. Does not touch the DB. */
export async function retryHomepageRevalidationAction(): Promise<ActionResult<{ revalidationOk: boolean }>> {
  await requirePermission("content.manage");
  return runAction(async () => ({ revalidationOk: (await revalidateHomepage()).ok }));
}

/** Mints a short-lived signed link to the DRAFT homepage on apps/web, for the "Pratinjau" button
 * (docs/plans/storefront-cms.md session 6). Server-side only — the token is never generated
 * client-side and never stored anywhere; the admin's browser just opens the returned URL in a
 * new tab. Points at `getMainSiteUrl()` (the PUBLIC origin) deliberately, not WEB_INTERNAL_URL:
 * unlike /api/revalidate (machine-to-machine, internal-only), this link is opened by the owner's
 * OWN browser, which has no route to the internal Docker network at all. */
export async function createHomepagePreviewLinkAction(): Promise<ActionResult<{ url: string }>> {
  await requirePermission("content.manage");
  return runAction(async () => {
    const token = generateHomepagePreviewToken();
    return { url: `${getMainSiteUrl()}/preview/home?token=${encodeURIComponent(token)}` };
  });
}

export async function discardHomepageDraftAction(): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  return runAction(async () => {
    await homepage.discardHomepageDraft(session.staffUser.id);
    return undefined;
  });
}

// ---------- Content image upload (session 5) ----------
//
// Upload-only — never touches the database. The returned ContentImage fields are held in the
// editor form's own client state and only become part of a section's draft_content once the
// admin clicks "Simpan" (saveHeroDraftAction/saveFeatureBlockDraftAction above, validated again
// there by contentImageSchema). An image uploaded here but never saved into a draft is a
// harmless orphan (see content-image-queries.ts/homepage.ts's cleanup, which only ever reaches
// objects that WERE referenced by a draft at some point) — same accepted tradeoff
// apps/admin/src/lib/products/image-queries.ts's own "an orphaned object in the bucket is a
// harmless no-op" comment already makes for product photos.

const uploadContentImageInputSchema = z.object({
  sectionKey: z.enum(["hero", "feature_block"]),
  variant: z.enum(["desktop", "mobile"]),
});

export async function uploadContentImageAction(formData: FormData): Promise<ActionResult<UploadedContentImage>> {
  await requirePermission("content.manage");

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "File tidak ditemukan." };

  const parsed = uploadContentImageInputSchema.safeParse({
    sectionKey: formData.get("sectionKey"),
    variant: formData.get("variant"),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };

  return runAction(async () => {
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    return uploadContentImage({ sectionKey: parsed.data.sectionKey, variant: parsed.data.variant, fileBuffer });
  });
}

// ---------- Info pages (session 8) ----------
//
// Each page's draft save / publish / discard is independent — no atomic-all-5 action the way the
// homepage's publishHomepageAction promotes all 4 sections together (see lib/content/
// info-pages.ts's own doc comment for why that's the right model here).

const infoPageSlugSchema = z.enum(INFO_PAGE_SLUGS);

function parseInfoPageSlug(slug: string): InfoPageSlug | null {
  const parsed = infoPageSlugSchema.safeParse(slug);
  return parsed.success ? parsed.data : null;
}

export async function saveInfoPageDraftAction(slug: string, input: z.input<typeof saveInfoPageDraftSchema>): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsedSlug = parseInfoPageSlug(slug);
  if (!parsedSlug) return { ok: false, error: "Halaman tidak valid." };
  const parsed = saveInfoPageDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Input tidak valid." };
  return runAction(async () => {
    await infoPages.saveInfoPageDraft(parsedSlug, parsed.data, session.staffUser.id);
    return undefined;
  });
}

// No revalidation call here — unlike the homepage, apps/web's info-page routes read
// `info_pages` uncached on every request (see lib/revalidate.ts's own comment), so a publish is
// visible on the very next request with nothing to invalidate.
export async function publishInfoPageAction(slug: string): Promise<ActionResult> {
  const session = await requirePermission("content.manage");
  const parsedSlug = parseInfoPageSlug(slug);
  if (!parsedSlug) return { ok: false, error: "Halaman tidak valid." };
  return runAction(async () => {
    await infoPages.publishInfoPage(parsedSlug, session.staffUser.id);
    return undefined;
  });
}

export async function discardInfoPageDraftAction(slug: string): Promise<ActionResult<{ bodyHtml: string }>> {
  const session = await requirePermission("content.manage");
  const parsedSlug = parseInfoPageSlug(slug);
  if (!parsedSlug) return { ok: false, error: "Halaman tidak valid." };
  return runAction(() => infoPages.discardInfoPageDraft(parsedSlug, session.staffUser.id));
}
