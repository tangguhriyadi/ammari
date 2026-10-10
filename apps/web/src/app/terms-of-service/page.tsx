import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Syarat & Ketentuan — Ammari",
};

// Placeholder content for the owner to fill in before launch — publicly accessible (linked from
// /consent and /login before any sign-in), English path per CLAUDE.md's URL convention.
export default function TermsOfServicePage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="font-serif text-2xl font-light text-brand">Syarat & Ketentuan</h1>
      <p className="text-sm text-neutral-700">
        Syarat dan ketentuan penggunaan layanan Ammari, termasuk aturan voucher dan belanja di
        ammari.id, akan dilengkapi di sini sebelum peluncuran.
      </p>
    </div>
  );
}
