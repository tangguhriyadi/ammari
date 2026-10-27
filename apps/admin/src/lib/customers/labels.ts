import type { VoucherAdjustmentKind, VoucherStatus } from "@ammari/db/schema";
import type { BadgeVariant } from "@ammari/ui";
import type { CustomerOrigin, SignInMethod } from "./directory";

// Indonesian labels for Pelanggan & Voucher (docs/plans/growth.md §8, §9). Badge colours reuse the
// design-token variants (muted earth tones, CLAUDE.md).

export const CUSTOMER_ORIGIN_LABELS: Record<CustomerOrigin, string> = {
  account: "Akun situs",
  guest: "Checkout tamu",
  staff: "Dibuat staf",
};

export const SIGN_IN_METHOD_LABELS: Record<SignInMethod, string> = {
  google: "Google",
  email_code: "Kode email",
};

export const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  retail: "Ritel",
  reseller: "Reseller",
};

export const VOUCHER_STATUS_BADGE: Record<VoucherStatus, BadgeVariant> = {
  active: "success",
  used: "neutral",
  expired: "warning",
  void: "danger",
};

export const VOUCHER_ADJUSTMENT_LABELS: Record<VoucherAdjustmentKind, string> = {
  void: "Dibatalkan",
  extend: "Diperpanjang",
};

export const THANK_YOU_CARD_STATUS_LABELS: Record<string, string> = {
  active: "Belum diklaim",
  claimed: "Diklaim",
  void: "Dibatalkan",
};
