import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Halaman Tidak Ditemukan — Ammari",
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

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-20 text-center">
      <h1 className="font-serif text-2xl font-light text-brand">Halaman Tidak Ditemukan</h1>
      <p className="text-sm text-ink-muted">Halaman yang kamu cari tidak ada atau sudah dipindahkan.</p>
      <Link href="/" className="text-sm font-medium text-brand underline">
        Kembali ke halaman utama
      </Link>
    </div>
  );
}
