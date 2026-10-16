import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDraftHomepageContent, getStorefrontProductTiles } from "@ammari/db/storefront";
import { verifyHomepagePreviewToken } from "@/lib/preview/token";
import { buildHomepageView } from "@/lib/content/homepage-view";
import { collectHomepageProductRefs, resolveHomepageView } from "@/lib/content/homepage-resolve";
import { HomepageSections } from "@/components/homepage/homepage-sections";

// Draft content, gated by a short-lived signed token — must never be served from Next's data or
// full-route cache (next.config.ts's headers() also sets Cache-Control/X-Robots-Tag for this
// exact path, since metadata.robots below only controls the <meta> tag, not an HTTP header).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pratinjau — Ammari",
  robots: { index: false, follow: false },
};

export default async function PreviewHomePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  // Every rejection reason (missing, malformed, expired, tampered) renders the exact same 404 —
  // never distinguished, so a bad guess learns nothing about which part was wrong (same posture
  // token.ts's own verify function takes).
  if (!token || !verifyHomepagePreviewToken(token)) notFound();

  const sections = await getDraftHomepageContent();
  const draftView = buildHomepageView(sections);
  const refs = collectHomepageProductRefs(draftView);
  const tiles = refs.length > 0 ? await getStorefrontProductTiles(refs) : [];
  const view = resolveHomepageView(draftView, tiles);

  return (
    <div className="flex flex-col">
      <p className="bg-warning-50 px-4 py-2 text-center text-sm text-warning-700" data-testid="preview-draft-banner">
        Ini pratinjau draft — belum tayang di toko online. Tautan ini kedaluwarsa dalam beberapa
        menit.
      </p>
      <HomepageSections view={view} />
    </div>
  );
}
