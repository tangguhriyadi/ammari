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
