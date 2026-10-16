import { CreditCard, RotateCcw, Truck } from "lucide-react";

// docs/design/storefront.md §6 item 7 — 3 small items. The 3rd ("store exchange policy") is now
// store_settings.return_policy_summary (docs/plans/storefront-cms.md Phase 2, session 8) — the
// caller passes it as a prop (fetched once in products/[slug]/page.tsx, same as whatsappNumber),
// rather than this component reading it itself, so TrustRow stays a plain, pure component. `null`
// (not yet filled in by the owner) omits the 3rd item entirely, same "hide until it exists"
// contract this component already followed. Never names the payment gateway or shipping origin
// city (CLAUDE.md / design spec §2).
const BASE_ITEMS = [
  { icon: CreditCard, label: "Pembayaran aman" },
  { icon: Truck, label: "Ongkir otomatis saat checkout" },
];

export function TrustRow({ returnPolicySummary }: { returnPolicySummary: string | null }) {
  const items = returnPolicySummary ? [...BASE_ITEMS, { icon: RotateCcw, label: returnPolicySummary }] : BASE_ITEMS;
  return (
    <ul className={`grid gap-4 border-t border-b border-line py-5 ${items.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
      {items.map(({ icon: Icon, label }) => (
        <li key={label} className="flex flex-col items-center gap-2 text-center">
          <Icon className="size-5 text-ink" strokeWidth={1.4} aria-hidden="true" />
          <span className="text-xs text-ink-muted">{label}</span>
        </li>
      ))}
    </ul>
  );
}
