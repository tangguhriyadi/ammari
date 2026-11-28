import type { TikTokHeldReason, TikTokListingHoldReason } from "@ammari/db/schema";
import type { TikTokTargetHoldReason } from "@ammari/commerce/tiktok";

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
  duplicate_in_admin: "Ada dua pesanan manual dengan nomor TikTok yang sama. Batalkan yang salah",
};

/** "Ambil riwayat" / "Terapkan riwayat" refusals (docs/plans/tiktok-shop-integration.md T9). */
export const TIKTOK_BACKFILL_ERRORS = {
  not_connected: "Hubungkan TikTok Shop dulu.",
  already_open: "Riwayat sebelumnya belum selesai. Terapkan dulu riwayat itu sebelum mengambil lagi.",
  invalid_date: "Tanggal tidak valid.",
  before_floor: "Riwayat paling awal 1 Desember 2026, saat pembukuan dimulai.",
  not_in_past: "Pilih tanggal paling lambat kemarin. Pesanan hari ini sudah dibaca otomatis.",
  none: "Belum ada riwayat yang siap diterapkan.",
  still_fetching: "Riwayat masih dibaca. Tunggu sampai selesai, lalu cek pratinjaunya.",
} as const;

/** Why a TikTok listing SKU is not sent (Sinkron stok, docs/plans/tiktok-stock-sync.md §2). */
export const TIKTOK_STOCK_HOLD_LABELS: Record<TikTokListingHoldReason | TikTokTargetHoldReason, string> = {
  unmapped: "SKU penjual tidak cocok dengan SKU Ammari. Tidak disentuh",
  status_not_updatable: "Status produk di TikTok tidak bisa diubah stoknya",
  warehouse_unclear: "Gudang tidak jelas (bukan tepat satu gudang Ammari)",
  quantity_unreadable: "Stok TikTok tidak terbaca",
  variant_on_several_listings: "Varian ini ada di lebih dari satu listing TikTok",
  product_too_many_skus: "Produk punya lebih dari 100 SKU",
  not_listed: "Tidak ada lagi di TikTok",
  tiktok_order_unclear: "Ada pesanan TikTok ditahan yang jumlahnya tidak terbaca",
  invalid_input: "Data stok tidak terbaca",
};

/** Why TikTok refused a pushed quantity, or why the push could not finish (Sinkron stok, S2). Keys are the
 * stored codes: TikTok's numeric code (§0 of docs/plans/tiktok-stock-sync.md) or the client's error kind.
 * The raw code is always shown next to it, so an unlisted one is still named. */
export const TIKTOK_STOCK_PUSH_ERROR_LABELS: Record<string, string> = {
  "12052393": "Terkunci promo di TikTok: stok tidak boleh diturunkan di bawah stok promo. Akhiri atau ubah promonya, lalu Kirim ulang",
  "12052141": "Stok produk ini diatur di produk global TikTok. Ubah di sana, lalu Kirim ulang",
  "12052921": "Stok produk ini berbagi dengan toko sumber. Lepas pembagiannya, lalu Kirim ulang",
  "12052901": "Status produk di TikTok tidak bisa diubah stoknya. Dicoba lagi setelah dibaca ulang",
  "12052556": "SKU tidak dikenali TikTok. Dicoba lagi setelah dibaca ulang",
  "12052036": "SKU tidak dikenali TikTok. Dicoba lagi setelah dibaca ulang",
  "12052097": "Gudang tidak dikenali TikTok. Dicoba lagi setelah dibaca ulang",
  "12052530": "Gudang tidak cocok untuk SKU ini. Dicoba lagi setelah dibaca ulang",
  "12052531": "Gudang tidak cocok untuk SKU ini. Dicoba lagi setelah dibaca ulang",
  rate_limited: "TikTok sedang membatasi permintaan. Dicoba lagi otomatis",
  unavailable: "TikTok sedang tidak tersedia. Dicoba lagi otomatis",
  network: "Koneksi ke TikTok gagal. Dicoba lagi otomatis",
  budget_exhausted: "Waktu habis. Dicoba lagi otomatis",
  reauth_required: "TikTok Shop perlu dihubungkan ulang",
  refresh_failed: "Token TikTok belum bisa diperbarui. Dicoba lagi otomatis",
  invalid_response: "Balasan TikTok tidak terbaca. Dicoba lagi otomatis",
  clock_skew: "Jam server tidak cocok dengan TikTok. Dicoba lagi otomatis",
};

/** Why nothing is pushed right now (the gate), shown while the switch is on. */
export const TIKTOK_STOCK_PUSH_GATE_LABELS = {
  not_connected: "TikTok Shop belum terhubung.",
  reauth_required: "TikTok Shop perlu dihubungkan ulang.",
  switch_off: "Sinkron stok belum aktif.",
  no_scope: "Izin Modifikasi produk belum diberikan. Hubungkan ulang TikTok Shop setelah izinnya disetujui.",
  listings_never_read: "Produk TikTok belum pernah selesai dibaca. Stok dikirim setelah pembacaan pertama selesai.",
  listings_stale: "Produk TikTok tidak terbaca lebih dari 2 jam. Stok ditahan sampai dibaca ulang.",
  listings_failing: "Pembacaan produk TikTok terakhir gagal. Stok ditahan sampai pembacaan berikutnya berhasil.",
} as const;
