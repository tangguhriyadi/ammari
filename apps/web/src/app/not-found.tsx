import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Halaman Tidak Ditemukan | Ammari",
};

// Next ships a default not-found page for every app, composed through the ROOT layout like any
// other route — which means it inherits layout.tsx's own store-settings DB read for the footer.
// Without an override here, Next still tries to prerender that default `/_not-found` route once
// at `next build` time (confirmed empirically: building against an unreachable DATABASE_URL
// throws ECONNREFUSED from exactly this layout read, the same way `/` did before switching to
// `force-dynamic` — see app/page.tsx's own comment). A custom not-found.tsx with its own
// `force-dynamic` is what actually prevents that: Next's static/dynamic decision is made for the
// whole route (every layout in its tree together), not file-by-file, so this one export is
// enough to pull the ENTIRE `/_not-found` route — including the root layout's render of it — out
// of build-time prerendering.
export const dynamic = "force-dynamic";

// Next answers with a real 404 status for this page (e2e/seo-meta.spec.ts checks it), so it is
// never indexed; the links give a visitor from a stale search result somewhere to go.
export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-20 text-center">
      <h1 className="font-serif text-2xl font-light text-brand">Halaman Tidak Ditemukan</h1>
      <p className="text-sm text-ink-muted">
        Halaman yang kamu cari tidak ada atau sudah dipindahkan. Produk yang sudah tidak dijual juga tidak lagi punya halaman.
      </p>
      <nav aria-label="Tautan halaman tidak ditemukan" className="flex flex-col items-center gap-3 sm:flex-row sm:gap-6">
        <Link href="/#koleksi" className="text-sm font-medium text-brand underline">
          Lihat koleksi
        </Link>
        <Link href="/" className="text-sm font-medium text-brand underline">
          Kembali ke halaman utama
        </Link>
        <Link href="/how-to-order" className="text-sm font-medium text-brand underline">
          Cara pemesanan
        </Link>
      </nav>
    </div>
  );
}
