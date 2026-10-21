// Checkout action messages and limits, outside actions.ts because a "use server" module may only
// export async functions. Indonesian, no em dash, never naming the payment gateway or the shipping
// provider (docs/plans/cart-checkout.md §4.3).

export const CHECKOUT_UNAVAILABLE_MESSAGE = "Checkout belum tersedia.";
export const CHECKOUT_INVALID_INPUT_MESSAGE = "Permintaan tidak valid. Muat ulang halaman lalu coba lagi.";
export const CHECKOUT_GENERIC_ERROR_MESSAGE = "Terjadi kesalahan. Coba lagi.";
/** No payment provider configured (fail closed, nothing created). Same retry wording as the
 * shipping outage. */
export const CHECKOUT_PAYMENT_UNAVAILABLE_MESSAGE = "Pembayaran belum bisa diproses. Coba lagi sebentar lagi.";

/** Per IP, "Bayar sekarang" submits that pass validation (plan §5 step 1 `checkout_submit`: 10 per
 * 10 minutes; counted by placeOrder's `admit` hook, so form corrections never count). */
export const CHECKOUT_SUBMIT_WINDOW_SECONDS = 600;
export const CHECKOUT_SUBMIT_LIMIT = 10;

/** The checkout quote (plan §4.5.4, session 10): per IP `shipping_quote` 30 per 10 minutes, and per
 * cart (session 8 security review) 20 per 10 minutes. The page quotes once per picked area (and
 * on "Coba lagi"), so a buyer changing their mind a few times stays far below both. */
export const SHIPPING_QUOTE_WINDOW_SECONDS = 600;
export const SHIPPING_QUOTE_IP_LIMIT = 30;
export const SHIPPING_QUOTE_CART_LIMIT = 20;
export const SHIPPING_QUOTE_RATE_LIMITED_MESSAGE = "Terlalu banyak percobaan hitung ongkir. Coba lagi beberapa menit lagi.";
/** Section 3 before an area is picked (plan §4.3). */
export const SHIPPING_PICK_AREA_MESSAGE = "Pilih alamat dulu untuk menghitung ongkir.";
/** "Bayar sekarang" while a quote is still on its way. */
export const SHIPPING_QUOTE_PENDING_MESSAGE = "Ongkir sedang dihitung. Tunggu sebentar lalu coba lagi.";
/** "Bayar sekarang" whose answer never arrived (connection lost, a 5xx). Pressing again is safe:
 * the same page-load attempt id answers with the order if it was placed (plan §5). */
export const CHECKOUT_CALL_LOST_MESSAGE = "Koneksi terputus sebelum ada jawaban. Tekan Bayar sekarang sekali lagi; pesanan yang sama tidak akan dibuat dua kali.";
