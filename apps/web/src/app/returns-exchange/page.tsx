import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pengembalian & Penukaran — Ammari",
};

// Placeholder content — see how-to-order/page.tsx's doc comment for the pattern/Phase 2 plan.
export default function ReturnsExchangePage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="font-serif text-2xl font-light text-brand">Pengembalian & Penukaran</h1>
      <p className="text-sm text-ink-soft">
        Kebijakan pengembalian dan penukaran Ammari akan dilengkapi di sini sebelum peluncuran.
      </p>
    </div>
  );
}
