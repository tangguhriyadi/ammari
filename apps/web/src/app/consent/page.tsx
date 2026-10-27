import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { needsConsent } from "@/lib/auth/consent";
import { COLLECTION_PATH, sanitizeNextPath } from "@/lib/auth/next-path";
import { ConsentForm } from "./consent-form";
import { NOINDEX_ROBOTS } from "@/lib/seo/indexing";

// Per-visitor page: never indexed (docs/plans/seo.md).
export const metadata: Metadata = {
  title: "Sebelum Lanjut | Ammari",
  robots: NOINDEX_ROBOTS,
};

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // No `next` asked for: once consented, straight to the collection to shop. An explicit one
  // (e.g. the claim page that sent the buyer here) is always kept.
  const safeNext = sanitizeNextPath(next, COLLECTION_PATH);

  const customer = await getCustomerSession();
  if (!customer) redirect(`/login?next=${encodeURIComponent(safeNext)}`);
  if (!needsConsent(customer)) redirect(safeNext); // idempotent — already consented, nothing to do here

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-50 px-4 py-10">
      <h1 className="font-serif text-2xl font-light text-brand">Sebelum lanjut</h1>
      <p className="max-w-sm text-center text-sm text-neutral-700">
        Kami butuh persetujuanmu untuk memproses data pribadimu, sesuai UU Pelindungan Data
        Pribadi.
      </p>
      <ConsentForm next={safeNext} />
    </div>
  );
}
