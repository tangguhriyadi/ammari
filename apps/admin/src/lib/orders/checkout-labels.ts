import type { OrderAttentionFlag, OrderPaymentStatus, PaymentStatus } from "@ammari/db/schema";
import type { BadgeVariant } from "@ammari/ui";

// Indonesian labels for web checkout orders on the admin order pages (docs/plans/cart-checkout.md
// §7, session 16). Staff-facing, so the gateway may be named here (never on the storefront).

export const ORDER_PAYMENT_STATUS_LABELS: Record<OrderPaymentStatus, string> = {
  pending: "Belum dibayar",
  paid: "Dibayar",
  expired: "Kedaluwarsa",
  cancelled: "Pembayaran dibatalkan",
  refunded: "Dana dikembalikan",
  partially_refunded: "Dana dikembalikan sebagian",
  chargeback: "Chargeback",
};

export const ORDER_PAYMENT_STATUS_BADGE_VARIANT: Record<OrderPaymentStatus, BadgeVariant> = {
  pending: "warning",
  paid: "success",
  expired: "neutral",
  cancelled: "neutral",
  refunded: "neutral",
  partially_refunded: "warning",
  chargeback: "danger",
};

export const PAYMENT_ATTEMPT_STATUS_LABELS: Record<PaymentStatus, string> = {
  created: "Dibuat",
  pending: "Menunggu",
  paid: "Dibayar",
  failed: "Gagal",
  expired: "Kedaluwarsa",
  cancelled: "Dibatalkan",
  refunded: "Dana dikembalikan",
  partially_refunded: "Dikembalikan sebagian",
  chargeback: "Chargeback",
};

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  qris: "QRIS",
  other_qris: "QRIS",
  gopay: "GoPay",
  shopeepay: "ShopeePay",
  echannel: "Mandiri Bill",
  credit_card: "Kartu kredit",
};

/** "Virtual account BCA", "QRIS", ...; the raw Midtrans value for anything unknown. */
export function paymentMethodLabel(paymentType: string | null, bank: string | null): string | null {
  if (!paymentType) return null;
  if (paymentType === "bank_transfer") return bank ? `Virtual account ${bank.toUpperCase()}` : "Virtual account";
  if (paymentType === "permata") return "Virtual account PERMATA";
  return PAYMENT_TYPE_LABELS[paymentType] ?? paymentType;
}

export interface AttentionFlagCopy {
  label: string;
  /** What happened and what staff do about it. */
  meaning: string;
}

/** Every flag in ORDER_ATTENTION_FLAGS (plan §3, §6.2), Phase K's included. */
export const ATTENTION_FLAG_COPY: Record<OrderAttentionFlag, AttentionFlagCopy> = {
  stock_short_at_payment: {
    label: "Dibayar, stok kurang",
    meaning: "Pembayaran masuk saat stok fisik tidak cukup, jadi belum ada barang yang terjual. Tambah stok lalu tekan Proses, atau batalkan pesanan dan kembalikan dananya.",
  },
  paid_after_cancel: {
    label: "Dibayar setelah dibatalkan",
    meaning: "Pembayaran masuk setelah pesanan dibatalkan. Tidak ada barang yang terjual. Kembalikan dana ke pembeli, lalu catat di sini.",
  },
  amount_mismatch: {
    label: "Nominal pembayaran beda",
    meaning: "Nominal atau mata uang yang dilaporkan Midtrans tidak sama dengan tagihan, jadi pesanan tidak ditandai dibayar. Cek transaksinya di dashboard Midtrans.",
  },
  refund_due: {
    label: "Dana perlu dikembalikan",
    meaning: "Pembeli sudah membayar tapi uangnya harus kembali (pesanan dibatalkan, atau pembayaran ganda). Kembalikan lewat transfer bank atau dashboard Midtrans, lalu catat di sini.",
  },
  refund_received: {
    label: "Refund dari Midtrans",
    meaning: "Midtrans melaporkan pengembalian dana untuk pesanan ini. Cek apakah status pesanan perlu diubah, lalu tandai beres.",
  },
  payment_anomaly: {
    label: "Pembayaran tidak wajar",
    meaning: "Midtrans melaporkan status atau metode yang tidak kami pakai (misalnya kartu kredit), jadi pesanan tidak ditandai dibayar. Cek transaksinya di dashboard Midtrans.",
  },
  tracking_stale: {
    label: "Pelacakan berhenti",
    meaning: "Tidak ada kabar pengiriman baru selama beberapa hari. Cek ke kurir.",
  },
  delivery_problem: {
    label: "Masalah pengiriman",
    meaning: "Kurir melaporkan masalah atau paket kembali. Cek ke kurir sebelum mengubah status pesanan.",
  },
};

/** "1,4 kg" for 1400 g; "800 g" below a kilogram. */
export function formatWeight(grams: number): string {
  if (grams < 1000) return `${grams} g`;
  return `${(grams / 1000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} kg`;
}
