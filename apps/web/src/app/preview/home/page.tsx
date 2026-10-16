import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDraftHomepageContent } from "@ammari/db/storefront";
import { verifyHomepagePreviewToken } from "@/lib/preview/token";
import { StructuralHomepageSections } from "./structural-sections";

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

  return (
    <main className="flex min-h-screen flex-col gap-6 bg-neutral-50 px-4 py-8">
      <p className="rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900" data-testid="preview-draft-banner">
        Ini pratinjau draft — belum tayang di toko online. Tautan ini kedaluwarsa dalam beberapa
        menit.
      </p>
      <StructuralHomepageSections sections={sections} />
    </main>
  );
}
