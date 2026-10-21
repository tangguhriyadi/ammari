// Paths of the "Masuk ke akun" login link (docs/plans/cart-checkout.md §9.3, session 14), without
// server-only so the auth route's response mapping can be unit-tested on its own.

/** The confirm page; also the plugin's failure target (`createCustomerAuth`'s default). */
export const LOGIN_LINK_PAGE_PATH = "/login/link";
/** Where the confirm page's form posts (the orderLoginLink plugin's endpoint). */
export const LOGIN_LINK_CONSUME_ACTION = "/api/auth/order-login-link/consume";
/** Where a login by link lands: the account page until the order list exists (`/orders`, session
 * 15; switch it in createCustomerAuth's `orderLoginLink.successPath` default and here together). */
export const LOGIN_LINK_SUCCESS_PATH = "/account";
