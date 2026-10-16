import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pengiriman — Ammari",
};

// Placeholder content — see how-to-order/page.tsx's doc comment for the pattern/Phase 2 plan.
// Never names the shipping origin city (CLAUDE.md / design spec §2) once real content lands here.
export default function ShippingPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="font-serif text-2xl font-light text-brand">Pengiriman</h1>
      <p className="text-sm text-ink-soft">
        Informasi pengiriman Ammari akan dilengkapi di sini sebelum peluncuran.
      </p>
    </div>
  );
}
