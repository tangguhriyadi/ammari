import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cara Pemesanan — Ammari",
};

// Placeholder content for the owner to fill in before launch — same pattern as
// /privacy-policy and /terms-of-service. Slug matches docs/plans/storefront-cms.md's Phase 2
// `info_pages` set ("how-to-order") — this route's content moves into that CMS once session 8
// ships, same migration privacy-policy/terms-of-service will also go through; the URL itself
// doesn't change.
export default function HowToOrderPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="font-serif text-2xl font-light text-brand">Cara Pemesanan</h1>
      <p className="text-sm text-ink-soft">
        Panduan cara memesan di Ammari akan dilengkapi di sini sebelum peluncuran.
      </p>
    </div>
  );
}
