// Buyer-facing checkout refusals (docs/plans/cart-checkout.md §4.5.5, §5). Indonesian, no em dash,
// never naming the payment gateway, the shipping provider or any city. No server-only import: the
// checkout UI (session 10) shows the same texts.

import { CART_MAX_PIECES, CART_MAX_QTY_PER_LINE } from "../cart/limits";

/** Why placeOrder refused. Nothing was written for any of them (the order transaction rolled
 * back, or never started). */
export type PlaceOrderRefusal =
  | "invalid_input"
  | "unknown_area"
  | "cart_empty"
  | "cart_unavailable"
  | "line_limit"
  | "cart_limit"
  | "cart_changed"
  | "insufficient_stock"
  | "shipping_unavailable"
  | "shipping_no_service"
  | "shipping_missing_weight"
  | "too_many_unpaid"
  | "voucher_unusable"
  | "total_changed"
  | "rate_limited"
  | "busy";

/** At most this many unpaid checkout orders per contact email (guests) or per session customer in
 * UNPAID_ORDER_WINDOW_MINUTES (plan §5 step 1, against inventory hoarding). */
export const MAX_UNPAID_ORDERS_PER_EMAIL = 3;
export const UNPAID_ORDER_WINDOW_MINUTES = 120;

export const PLACE_ORDER_MESSAGES: Record<PlaceOrderRefusal, string> = {
  invalid_input: "Periksa lagi data yang ditandai.",
  unknown_area: "Pilih kecamatan dari daftar.",
  cart_empty: "Keranjang kamu kosong.",
  cart_unavailable: "Ada barang yang habis atau tidak tersedia lagi. Cek keranjang dulu.",
  line_limit: `Maksimal ${CART_MAX_QTY_PER_LINE} per item.`,
  cart_limit: `Maksimal ${CART_MAX_PIECES} barang per pesanan.`,
  cart_changed: "Isi keranjang berubah. Cek ringkasan lagi.",
  // Replaced by the reservation's own message, which names product, colour and size.
  insufficient_stock: "Stok tidak cukup untuk jumlah ini.",
  shipping_unavailable: "Ongkir belum bisa dihitung. Coba lagi sebentar lagi.",
  shipping_no_service: "Pengiriman ke alamat ini belum tersedia lewat website. Hubungi kami lewat WhatsApp.",
  shipping_missing_weight: "Ongkir belum bisa dihitung untuk pesanan ini. Hubungi kami lewat WhatsApp.",
  too_many_unpaid: `Masih ada ${MAX_UNPAID_ORDERS_PER_EMAIL} pesanan yang menunggu pembayaran. Selesaikan pembayarannya atau coba lagi nanti.`,
  voucher_unusable: "Voucher tidak bisa dipakai.",
  total_changed: "Harga, ongkir atau voucher berubah. Cek ringkasan lagi.",
  rate_limited: "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.",
  busy: "Pesanan belum bisa diproses. Coba lagi sebentar lagi.",
};

/** Field errors placeOrder adds beside parseShippingAddress's own (`recipientName`, `phone`,
 * `shippingAreaId`, `postalCode`, `addressLine`, `notes`). The contact number is `contactPhone`,
 * so it never collides with the recipient's `phone`. */
export type CheckoutField = "contactEmail" | "contactPhone" | "termsAccepted" | "voucherId";

export const CHECKOUT_FIELD_MESSAGES = {
  emailRequired: "Email wajib diisi.",
  emailInvalid: "Email tidak valid.",
  phoneRequired: "Nomor WhatsApp wajib diisi.",
  phoneInvalid: "Nomor WhatsApp tidak valid. Contoh: 0812 3456 7890.",
  termsRequired: "Setujui Syarat & Ketentuan dan Kebijakan privasi untuk melanjutkan.",
  voucherNeedsLogin: "Masuk untuk pakai voucher.",
} as const;
