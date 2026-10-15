import { z } from "zod";
import { WHY_AMMARI_ICON_KEYS } from "@ammari/db/why-ammari";

// ---------- Homepage content Zod schemas (docs/plans/storefront-cms.md, session 4) ----------
//
// Each section's `draft_content`/`published_content` JSONB is validated by exactly ONE of these
// schemas at save time — never trusted as-is from the client, same posture `products/actions.ts`
// already has for `highlights`. A tile/linked-product reference's EXISTENCE and
// "is it actually published on the storefront" are NOT checked here (Zod only checks shape) —
// that's `validateProductRef`/`validateNoDuplicateTiles` in homepage.ts, run against the DB
// inside the same transaction as the save.
//
// `image` is always `null` in every section this session builds — hero/feature-block image
// upload is session 5 (docs/plans/storefront-cms.md's own session split). Keeping the field in
// the shape now (rather than omitting it) means session 5 only has to loosen this schema, never
// migrate already-published JSONB that lacks the key.

export const homepageProductRefSchema = z.object({
  productId: z.string().uuid("Produk tidak valid."),
  fabricColorId: z.string().uuid("Warna tidak valid.").nullable(),
});
export type HomepageProductRef = z.infer<typeof homepageProductRefSchema>;

const ctaTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("anchor") }),
  z.object({
    type: z.literal("product"),
    productId: z.string().uuid("Produk tidak valid."),
    fabricColorId: z.string().uuid("Warna tidak valid.").nullable(),
  }),
]);
export type HomepageCtaTarget = z.infer<typeof ctaTargetSchema>;

export const heroContentSchema = z.object({
  eyebrow: z.string().trim().max(60, "Eyebrow maksimal 60 karakter."),
  // Literal "\n" line breaks are kept as-authored (docs/plans/storefront-cms.md) — the textarea
  // itself is where the admin types them, this schema just doesn't strip them.
  headline: z.string().trim().min(1, "Headline wajib diisi.").max(200, "Headline maksimal 200 karakter."),
  ctaLabel: z.string().trim().min(1, "Label tombol wajib diisi.").max(40, "Label tombol maksimal 40 karakter."),
  ctaTarget: ctaTargetSchema,
  image: z.null(), // session 5
});
export type HeroContent = z.infer<typeof heroContentSchema>;

export const productGridContentSchema = z.object({
  title: z.string().trim().min(1, "Judul wajib diisi.").max(100, "Judul maksimal 100 karakter."),
  tiles: z
    .array(homepageProductRefSchema)
    .refine(
      (tiles) => new Set(tiles.map((tile) => `${tile.productId}:${tile.fabricColorId ?? ""}`)).size === tiles.length,
      "Produk dan warna yang sama tidak boleh dipakai dua kali di grid.",
    ),
});
export type ProductGridContent = z.infer<typeof productGridContentSchema>;

export const featureBlockContentSchema = z.object({
  title: z.string().trim().min(1, "Judul wajib diisi.").max(100, "Judul maksimal 100 karakter."),
  subtitle: z.string().trim().min(1, "Subjudul wajib diisi.").max(200, "Subjudul maksimal 200 karakter."),
  ctaLabel: z.string().trim().min(1, "Label tombol wajib diisi.").max(40, "Label tombol maksimal 40 karakter."),
  linkedProduct: homepageProductRefSchema,
  image: z.null(), // session 5
});
export type FeatureBlockContent = z.infer<typeof featureBlockContentSchema>;

export const whyAmmariPointSchema = z.object({
  icon: z.enum(WHY_AMMARI_ICON_KEYS),
  title: z.string().trim().min(1, "Judul poin wajib diisi.").max(60, "Judul poin maksimal 60 karakter."),
  text: z.string().trim().min(1, "Teks poin wajib diisi.").max(160, "Teks poin maksimal 160 karakter."),
});
export type WhyAmmariPoint = z.infer<typeof whyAmmariPointSchema>;

export const whyAmmariContentSchema = z.object({
  eyebrow: z.string().trim().max(60, "Eyebrow maksimal 60 karakter."),
  heading: z.string().trim().min(1, "Judul wajib diisi.").max(100, "Judul maksimal 100 karakter."),
  points: z.array(whyAmmariPointSchema).max(4, "Maksimal 4 poin."),
});
export type WhyAmmariContent = z.infer<typeof whyAmmariContentSchema>;

/** Every homepage section's draft save action also carries its own `isVisible` flag — a column
 * on `storefront_homepage_sections`, not part of the JSONB content, so it's validated separately
 * from (and alongside) whichever schema above matches the section being saved. */
export const homepageSectionVisibilitySchema = z.object({ isVisible: z.boolean() });
