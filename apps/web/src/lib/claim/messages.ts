import type { CardRejectionReason } from "./queries";

// One fixed, generic Indonesian message per reason — never more detail than necessary (decided
// plan). `order_cancelled` deliberately reuses the exact same copy as `void`: saying anything
// that distinguishes "this order was cancelled" from "this card was voided" would itself leak
// order information to someone who was never shown it (requirement: rejection messages must
// never reveal order details, pre- or post-login).
export const CLAIM_REJECTION_MESSAGES: Record<CardRejectionReason, string> = {
  not_found: "Kode voucher tidak ditemukan. Periksa kembali kode atau tautan yang kamu gunakan.",
  void: "Voucher ini sudah tidak berlaku.",
  claimed: "Voucher ini sudah diklaim.",
  expired: "Batas waktu klaim voucher ini sudah lewat.",
  order_cancelled: "Voucher ini sudah tidak berlaku.",
};

export const CLAIM_ALREADY_MINE_MESSAGE = "Voucher ini sudah kamu klaim.";
export const CLAIM_RATE_LIMITED_MESSAGE = "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.";

/** The claim action's own generic fallback for anything unexpected (should never actually be
 * reached — every known `ClaimRejectionReason` has its own entry above, and `consent_required`
 * is handled as a redirect, not a message) — exists purely so a future new reason fails loud in
 * review rather than rendering `undefined` to a buyer. */
export const CLAIM_GENERIC_ERROR_MESSAGE = "Voucher ini tidak bisa diklaim saat ini.";
