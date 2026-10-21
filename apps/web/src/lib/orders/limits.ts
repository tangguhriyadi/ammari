// Per-IP limit on order access by token (docs/plans/cart-checkout.md §9.2, `order_view` on
// `claim_rate_limits`): every "Lihat pesanan" link opened and every order page shown through its
// cookie counts. Generous for a buyer who reopens the email or refreshes the page, a brake on
// anyone probing tokens (which are 256-bit random anyway).
export const ORDER_VIEW_WINDOW_SECONDS = 10 * 60;
export const ORDER_VIEW_LIMIT = 60;
