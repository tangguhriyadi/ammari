import type { TikTokHeldReason } from "@ammari/db/schema";

// What the Integrasi TikTok Shop page says after a connect attempt (docs/plans/tiktok-shop-integration.md
// §7.3 step 3): an Indonesian message plus the short error code, never TikTok's raw answer. Shared
// by the callback (which redirects with `?error=<code>`) and the page (which shows the message).

export const TIKTOK_CONNECT_ERRORS = {
  not_configured: "Integrasi TikTok Shop belum diatur di server. Hubungi pengelola teknis.",
  missing_params: "Balasan dari TikTok tidak lengkap. Ulangi Hubungkan.",
  state_invalid: "Tautan penghubung sudah dipakai, kedaluwarsa, atau dimulai dari akun staf lain. Ulangi Hubungkan.",
  code_rejected: "Kode sudah dipakai, ulangi Hubungkan.",
  tiktok_unavailable: "TikTok sedang tidak bisa dihubungi. Coba lagi beberapa menit lagi.",
  invalid_response: "Balasan TikTok tidak dikenali. Coba lagi. Jika berulang, hubungi pengelola teknis.",
  no_shop: "Akun TikTok ini tidak memberi izin untuk toko mana pun.",
  multiple_shops: "Akun ini memberi izin untuk lebih dari satu toko. Saat ini hanya satu toko yang didukung.",
  other_shop_active: "Toko TikTok lain masih terhubung. Putuskan toko itu dulu, lalu hubungkan lagi.",
  failed: "Gagal menghubungkan TikTok Shop. Coba lagi.",
} as const;

export type TikTokConnectErrorCode = keyof typeof TIKTOK_CONNECT_ERRORS;

export function isTikTokConnectErrorCode(value: unknown): value is TikTokConnectErrorCode {
  return typeof value === "string" && Object.hasOwn(TIKTOK_CONNECT_ERRORS, value);
}

export const TIKTOK_CONNECTED_MESSAGE = "TikTok Shop terhubung.";
export const TIKTOK_RECONNECTED_MESSAGE = "TikTok Shop terhubung ulang. Token baru sudah disimpan.";
export const TIKTOK_DISCONNECTED_MESSAGE = "TikTok Shop diputuskan. Token sudah dihapus.";

/** Why the sync holds a TikTok order (docs/plans/tiktok-shop-integration.md §3.3, §4.4, T5). */
export const TIKTOK_HELD_REASON_LABELS: Record<TikTokHeldReason, string> = {
  unknown_sku: "SKU belum dipetakan",
  short_stock: "Stok tidak cukup. Catat stok masuk, lalu pesanan masuk otomatis",
  lines_differ: "Isi pesanan beda dengan pesanan yang dicatat manual",
  final_in_admin: "Pesanan sudah dibatalkan di admin, tapi TikTok masih memprosesnya",
  partial_shipping: "Dikirim sebagian",
  partial_refund: "Pengembalian dana sebagian",
  unknown_status: "Status TikTok tidak dikenal",
  money_format: "Jumlah uang bukan rupiah bulat",
  line_format: "Jumlah atau harga barang tidak bisa dibaca",
};
