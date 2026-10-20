import { CreditCard, Truck, Zap } from "lucide-react";

// docs/design/storefront.md §6 item 7 — exactly 3 small items, fixed copy (owner decision, Oct
// 2026). The store's return policy summary is NOT here any more: it is the first paragraph of the
// "Pengiriman & Pengembalian" accordion (products/[slug]/page.tsx). Never names the payment
// gateway or shipping origin city (CLAUDE.md / design spec §2).
export const TRUST_ITEMS = [
  { icon: CreditCard, label: "Pembayaran Aman" },
  { icon: Truck, label: "Gratis Ongkir Ke Seluruh Indonesia" },
  { icon: Zap, label: "Proses Cepat" },
];

export function TrustRow() {
  return (
    <ul className="grid grid-cols-3 gap-4 border-t border-b border-line py-5">
      {TRUST_ITEMS.map(({ icon: Icon, label }) => (
        <li key={label} className="flex flex-col items-center gap-2 text-center">
          <Icon className="size-5 text-ink" strokeWidth={1.4} aria-hidden="true" />
          <span className="text-xs text-ink-muted">{label}</span>
        </li>
      ))}
    </ul>
  );
}
