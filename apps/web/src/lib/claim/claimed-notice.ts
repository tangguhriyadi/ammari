import { formatDate } from "@ammari/ui/lib";
import { COLLECTION_PATH } from "@/lib/auth/next-path";

/** After a successful claim the buyer lands on the homepage collection to shop right away, with
 * a one-time "voucher is in your account" notice (components/voucher-claimed-notice.tsx). The
 * query param only carries "show the notice", never the amount, dates or anything about the
 * card: the dates are read server-side from the signed-in buyer's own voucher
 * (claimed-notice-data.ts). */
export const VOUCHER_CLAIMED_PARAM = "voucher";
export const VOUCHER_CLAIMED_VALUE = "claimed";
export const VOUCHER_CLAIMED_REDIRECT = `/?${VOUCHER_CLAIMED_PARAM}=${VOUCHER_CLAIMED_VALUE}${COLLECTION_PATH.slice(1)}`;

/** When claimed vouchers become usable on ammari.id (the vouchers table has no start column; the
 * claim page's old success screen showed this same fixed date). */
export const VOUCHER_USABLE_FROM = "1 Desember 2026";

const VOUCHER_CLAIMED_MESSAGE = "Voucher sudah masuk ke akunmu.";

/** With the claimed voucher's expiry: both dates (formatDate is WIB). Without it (no session, no
 * fresh voucher, a failed read): the plain message, never a guessed date. */
export function voucherClaimedMessage(expiresAt: Date | null): string {
  if (!expiresAt) return VOUCHER_CLAIMED_MESSAGE;
  return `${VOUCHER_CLAIMED_MESSAGE} Bisa dipakai mulai ${VOUCHER_USABLE_FROM} sampai ${formatDate(expiresAt)}.`;
}
