import type { HomepageSectionContent } from "@ammari/db/storefront";
import type { WhyAmmariIconKey } from "@ammari/db/why-ammari";

// Pure data-mapping from the homepage CMS's raw JSONB `HomepageSectionContent[]` (published OR
// draft — both shapes are identical, see @ammari/db/storefront) into a render-ready view model.
// Every field is read DEFENSIVELY (duck-typed, no trusting the shape) — same posture
// apps/web/src/app/preview/home/structural-sections.tsx already takes, and for the same reason:
// apps/web has no access to apps/admin's own Zod schemas across the monorepo boundary (see that
// file's own doc comment), so this is the one place a malformed/partial section's content gets
// turned into "skip this section" instead of a crash. A hidden section (`isVisible: false`) or
// one that was simply never published (`content: null`) is treated identically: no view, not
// rendered — the "hidden/empty sections not rendered" rule from docs/design/storefront.md §5.

export interface HomepageProductRefView {
  productId: string;
  fabricColorId: string | null;
}

export interface ContentImageView {
  storageKey: string;
  altText: string;
  mobileStorageKey: string | null;
}

export interface HeroView {
  eyebrow: string;
  headline: string;
  ctaLabel: string;
  ctaTarget: { type: "anchor" } | { type: "product"; ref: HomepageProductRefView };
  image: ContentImageView | null;
}

export interface ProductGridView {
  title: string;
  tiles: HomepageProductRefView[];
}

export interface FeatureBlockView {
  title: string;
  subtitle: string;
  ctaLabel: string;
  linkedProduct: HomepageProductRefView;
  image: ContentImageView | null;
}

export interface WhyAmmariPointView {
  icon: WhyAmmariIconKey;
  title: string;
  text: string;
}

export interface WhyAmmariView {
  eyebrow: string;
  heading: string;
  points: WhyAmmariPointView[];
}

export interface HomepageView {
  hero: HeroView | null;
  productGrid: ProductGridView | null;
  featureBlock: FeatureBlockView | null;
  whyAmmari: WhyAmmariView | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

const WHY_AMMARI_ICON_KEY_SET = new Set<string>([
  "syari_design",
  "premium_fabric",
  "careful_tailoring",
  "all_day_comfort",
  "easy_care",
  "not_see_through",
  "nursing_friendly",
  "responsive_service",
]);

function readProductRef(value: unknown): HomepageProductRefView | null {
  const row = record(value);
  if (typeof row.productId !== "string" || row.productId.length === 0) return null;
  const fabricColorId = typeof row.fabricColorId === "string" ? row.fabricColorId : null;
  return { productId: row.productId, fabricColorId };
}

function readContentImage(value: unknown): ContentImageView | null {
  const row = record(value);
  if (typeof row.storageKey !== "string" || row.storageKey.length === 0) return null;
  return {
    storageKey: row.storageKey,
    altText: text(row.altText),
    mobileStorageKey: typeof row.mobileStorageKey === "string" ? row.mobileStorageKey : null,
  };
}

function buildHero(content: unknown): HeroView | null {
  const row = record(content);
  const headline = text(row.headline);
  if (headline.length === 0) return null; // no real content to show — treat as empty, skip

  const targetRow = record(row.ctaTarget);
  let ctaTarget: HeroView["ctaTarget"] = { type: "anchor" };
  if (targetRow.type === "product") {
    const ref = readProductRef(targetRow);
    if (ref) ctaTarget = { type: "product", ref };
  }

  return {
    eyebrow: text(row.eyebrow),
    headline,
    ctaLabel: text(row.ctaLabel),
    ctaTarget,
    image: readContentImage(row.image),
  };
}

function buildProductGrid(content: unknown): ProductGridView | null {
  const row = record(content);
  const tiles = Array.isArray(row.tiles) ? row.tiles.map(readProductRef).filter((ref): ref is HomepageProductRefView => ref !== null) : [];
  if (tiles.length === 0) return null; // nothing to show

  return { title: text(row.title), tiles };
}

function buildFeatureBlock(content: unknown): FeatureBlockView | null {
  const row = record(content);
  const linkedProduct = readProductRef(row.linkedProduct);
  if (!linkedProduct) return null; // no product to link to — nothing to show

  return {
    title: text(row.title),
    subtitle: text(row.subtitle),
    ctaLabel: text(row.ctaLabel),
    linkedProduct,
    image: readContentImage(row.image),
  };
}

function buildWhyAmmari(content: unknown): WhyAmmariView | null {
  const row = record(content);
  const rawPoints = Array.isArray(row.points) ? row.points : [];
  const points: WhyAmmariPointView[] = [];
  for (const rawPoint of rawPoints) {
    const pointRow = record(rawPoint);
    const title = text(pointRow.title);
    if (title.length === 0) continue;
    const icon = typeof pointRow.icon === "string" && WHY_AMMARI_ICON_KEY_SET.has(pointRow.icon) ? (pointRow.icon as WhyAmmariIconKey) : null;
    if (!icon) continue; // an unrecognized icon key — skip this one point rather than crash
    points.push({ icon, title, text: text(pointRow.text) });
  }
  if (points.length === 0) return null;

  return { eyebrow: text(row.eyebrow), heading: text(row.heading), points: points.slice(0, 4) };
}

/** `sections` is either the published read (`getPublishedHomepageContent`) or the draft read
 * (`getDraftHomepageContent`, used by `/preview/home`) — identical shape either way, so this one
 * function backs both. A section with `isVisible: false`, or whose content doesn't parse into
 * anything meaningful, comes back `null` and the caller simply doesn't render it. */
export function buildHomepageView(sections: HomepageSectionContent[]): HomepageView {
  const byKey = new Map(sections.map((section) => [section.key, section]));

  const hero = byKey.get("hero");
  const productGrid = byKey.get("product_grid");
  const featureBlock = byKey.get("feature_block");
  const whyAmmari = byKey.get("why_ammari");

  return {
    hero: hero?.isVisible ? buildHero(hero.content) : null,
    productGrid: productGrid?.isVisible ? buildProductGrid(productGrid.content) : null,
    featureBlock: featureBlock?.isVisible ? buildFeatureBlock(featureBlock.content) : null,
    whyAmmari: whyAmmari?.isVisible ? buildWhyAmmari(whyAmmari.content) : null,
  };
}
