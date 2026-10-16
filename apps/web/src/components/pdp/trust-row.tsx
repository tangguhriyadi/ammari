import { CreditCard, Truck } from "lucide-react";

// docs/design/storefront.md §6 item 7 — 3 small items, the 3rd ("store exchange policy") reads
// from store settings, which doesn't exist until docs/plans/storefront-cms.md Phase 2 (session
// 8) — the spec itself says to hide it until then, same as the footer's contact block and this
// page's WhatsApp CTA (see lib/store-settings.ts). Never names the payment gateway or shipping
// origin city (CLAUDE.md / design spec §2).
const ITEMS = [
  { icon: CreditCard, label: "Pembayaran aman" },
  { icon: Truck, label: "Ongkir otomatis saat checkout" },
];

export function TrustRow() {
  return (
    <ul className="grid grid-cols-2 gap-4 border-t border-b border-line py-5">
      {ITEMS.map(({ icon: Icon, label }) => (
        <li key={label} className="flex flex-col items-center gap-2 text-center">
          <Icon className="size-5 text-ink" strokeWidth={1.4} aria-hidden="true" />
          <span className="text-xs text-ink-muted">{label}</span>
        </li>
      ))}
    </ul>
  );
}
