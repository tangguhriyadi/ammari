import type { Metadata } from "next";
import { requireConsentedSession } from "@/lib/auth/require-customer";
import { CompleteProfileForm } from "./complete-profile-form";
import { NOINDEX_ROBOTS } from "@/lib/seo/indexing";

// Per-visitor page: never indexed (docs/plans/seo.md).
export const metadata: Metadata = {
  title: "Lengkapi Profil | Ammari",
  robots: NOINDEX_ROBOTS,
};

export default async function CompleteProfilePage() {
  const customer = await requireConsentedSession("/account/complete-profile");

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
      <h1 className="font-serif text-2xl font-light text-brand">Lengkapi Profil</h1>
      <p className="text-sm text-neutral-700">
        Opsional, bisa dilengkapi sekarang atau nanti dari halaman akun.
      </p>
      <CompleteProfileForm name={customer.name} phone={customer.phone} />
    </div>
  );
}
