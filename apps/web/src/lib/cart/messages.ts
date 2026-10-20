// Cart action messages and the per-IP write limit, outside actions.ts because a "use server"
// module may only export async functions.

export const CART_UNAVAILABLE_MESSAGE = "Keranjang belum tersedia.";
export const CART_RATE_LIMITED_MESSAGE = "Terlalu banyak percobaan. Coba lagi beberapa menit lagi.";
export const CART_INVALID_INPUT_MESSAGE = "Permintaan tidak valid. Muat ulang halaman lalu coba lagi.";
export const CART_GENERIC_ERROR_MESSAGE = "Terjadi kesalahan. Coba lagi.";

/** Per IP, all cart writes together (docs/plans/cart-checkout.md §3 `cart_write`). Generous on
 * purpose: Indonesian carriers put many buyers behind one CGNAT address (same reasoning as the
 * OTP per-IP guard, SPEC §10.1), and every stepper tap is a write. */
export const CART_WRITE_WINDOW_SECONDS = 600;
export const CART_WRITE_LIMIT = 120;

/** Per IP, new guest carts (a first "Tambah ke keranjang" from a browser without a cart cookie),
 * so one address cannot mint thousands of cart rows inside the general write limit. */
export const CART_CREATE_WINDOW_SECONDS = 60 * 60;
export const CART_CREATE_LIMIT = 20;
