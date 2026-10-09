// Deliberately no imports from ./token here — this module (and THANK_YOU_CARD_MESSAGE
// specifically) is rendered client-side by print-cards-overlay.tsx, but token.ts carries
// `import "server-only"` (it wraps node:crypto).

/** The card's thank-you message — one editable constant (docs/plans/packing-cards.md) so the
 * owner can change the wording without touching any rendering code. `{nama}` is the only
 * placeholder, resolved by `resolveCardBuyerName` below. Deliberately never mentions leaving the
 * marketplace or ordering direct next time (SPEC §4.1) — the 🤍 is decorative only, the card's
 * layout never depends on it rendering (some print drivers/fonts drop emoji silently). */
export const THANK_YOU_CARD_MESSAGE = {
  greeting: (name: string) => `Halo, ${name},`,
  body: [
    "Terima kasih sudah berbelanja bersama Ammari 🤍",
    "Sebagai ucapan terima kasih, kami titipkan voucher",
    "Rp20.000 untuk belanja berikutnya di ammari.id.",
  ],
  // The QR sits ABOVE this text in the printed card layout (print-cards-overlay.tsx), not
  // beside it — "di samping" was wrong.
  qrHint: ["Pindai QR di atas untuk klaim vouchermu,", "atau kunjungi:"],
};

/** The buyer-facing name for a card/order: a resolved `customers.name` when it exists and isn't
 * marketplace-masked, else the marketplace `buyerUsername`, else a generic, still-warm fallback.
 * Marketplace exports sometimes mask a buyer's real name for privacy (e.g. "Bu S***i") — using
 * that literal masked string on a printed card would look like a rendering bug, not privacy, so
 * a name containing `*` is treated exactly like a missing one. */
export function resolveCardBuyerName(order: { customerName: string | null; buyerUsername: string | null }): string {
  if (order.customerName && !order.customerName.includes("*")) return order.customerName;
  if (order.buyerUsername) return order.buyerUsername;
  return "Kakak";
}
