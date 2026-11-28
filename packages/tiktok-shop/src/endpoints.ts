import "server-only";

// API versions are pinned per endpoint in this one file (docs/plans/tiktok-shop-integration.md
// §11 "API versions"), so a TikTok deprecation is a change in one place. Only the endpoints the
// plan names are listed; later sessions add the rest (Search Returns/Cancellations, statements,
// payouts) once their versions are confirmed.

export const TIKTOK_API_BASE_URL = "https://open-api.tiktokglobalshop.com";
export const TIKTOK_AUTH_BASE_URL = "https://auth.tiktok-shops.com";
/** Where the seller authorizes the app (§0 "Auth"): `?service_id=...&state=...`. */
export const TIKTOK_AUTHORIZE_URL = "https://services.tiktokshop.com/open/authorize";

export const TIKTOK_ENDPOINTS = {
  /** GET, gives `shop_cipher`. */
  authorizedShops: "/authorization/202309/shops",
  /** POST, `page_size` 1-100, sorted by `update_time` ASC. */
  searchOrders: "/order/202309/orders/search",
  /** GET, up to 50 ids. */
  orderDetail: "/order/202507/orders",
  /** POST (T6, read only, Q15): `page_size` 1-50, sorted by `update_time` ASC, by window or by order ids. */
  searchReturns: "/return_refund/202309/returns/search",
  searchCancellations: "/return_refund/202309/cancellations/search",
  /** GET, SKU-level fees for one order. */
  orderStatementTransactions: (orderId: string) => `/finance/202501/orders/${encodeURIComponent(orderId)}/statement_transactions`,
} as const;

export const TIKTOK_AUTH_ENDPOINTS = {
  tokenGet: "/api/v2/token/get",
  tokenRefresh: "/api/v2/token/refresh",
} as const;

export const ORDER_DETAIL_MAX_IDS = 50;
export const SEARCH_ORDERS_MAX_PAGE_SIZE = 100;
export const SEARCH_AFTER_SALES_MAX_PAGE_SIZE = 50;
/** Order ids per Search Returns/Cancellations call made for a topic 11/12 trigger. */
export const SEARCH_AFTER_SALES_MAX_ORDER_IDS = 20;
