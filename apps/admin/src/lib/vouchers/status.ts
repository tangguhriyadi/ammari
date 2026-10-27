import type { VoucherStatus } from "@ammari/db/schema";

// A voucher's real state (docs/plans/growth.md §9.1, session S1). The stored status is not
// enough: an ordinary voucher that ran out still says `active` (only a cancelled order's restore
// writes `expired`), and checkout redeems only while `expires_at > now()`. Every admin count,
// filter and action decides from this, or from SQL that matches it.

/** "Segera berakhir": an active voucher expiring within this many days. */
export const EXPIRING_SOON_DAYS = 14;

export const VOUCHER_STATUS_LABELS: Record<VoucherStatus, string> = {
  active: "Aktif",
  used: "Terpakai",
  expired: "Kedaluwarsa",
  void: "Dibatalkan",
};

export function effectiveVoucherStatus(
  voucher: { status: VoucherStatus; expiresAt: Date },
  now: Date = new Date(),
): { status: VoucherStatus; expiringSoon: boolean } {
  if (voucher.status === "used" || voucher.status === "void") return { status: voucher.status, expiringSoon: false };
  const remainingMs = voucher.expiresAt.getTime() - now.getTime();
  if (voucher.status === "expired" || remainingMs <= 0) return { status: "expired", expiringSoon: false };
  return { status: "active", expiringSoon: remainingMs <= EXPIRING_SOON_DAYS * 86_400_000 };
}
