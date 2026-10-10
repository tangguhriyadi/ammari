import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Kebijakan Privasi — Ammari",
};

// Placeholder content for the owner to fill in before launch — publicly accessible (linked from
// /consent and /login before any sign-in), English path per CLAUDE.md's URL convention.
export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="font-serif text-2xl font-light text-brand">Kebijakan Privasi</h1>
      <p className="text-sm text-neutral-700">
        Konten kebijakan privasi Ammari akan dilengkapi di sini sebelum peluncuran. Halaman ini
        menjelaskan bagaimana Ammari mengumpulkan, menggunakan, dan melindungi data pribadimu
        sesuai Undang-Undang Pelindungan Data Pribadi (UU PDP).
      </p>
    </div>
  );
}
