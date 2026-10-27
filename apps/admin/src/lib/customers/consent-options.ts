// Promo-withdrawal sources and the length limits the dialogs share with the server
// (docs/plans/growth.md §8.3, §9.3). A plain module, so the client components can import it;
// consent.ts and @ammari/commerce/voucher-adjustments (server-only) check the same values.

export const PROMO_WITHDRAWAL_SOURCES = ["whatsapp", "email", "other"] as const;
export type PromoWithdrawalSource = (typeof PROMO_WITHDRAWAL_SOURCES)[number];

export const PROMO_WITHDRAWAL_SOURCE_LABELS: Record<PromoWithdrawalSource, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  other: "Lainnya",
};

export const MAX_WITHDRAWAL_NOTE_LENGTH = 300;

/** Same as MAX_ADJUSTMENT_REASON_LENGTH in @ammari/commerce/voucher-adjustments (consent-options.test.ts
 * checks they agree). */
export const MAX_VOUCHER_REASON_LENGTH = 500;

export function isPromoWithdrawalSource(value: string): value is PromoWithdrawalSource {
  return (PROMO_WITHDRAWAL_SOURCES as readonly string[]).includes(value);
}
