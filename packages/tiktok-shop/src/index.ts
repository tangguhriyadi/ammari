import "server-only";

// Everything that talks to TikTok Shop (docs/plans/tiktok-shop-integration.md §2): signing,
// webhook verification, the HTTP client, money parsing, token encryption and the allowlist helper.
// No database import, no `apps/*` import; packages/commerce owns every write.

export { buildAuthorizeUrl, createTikTokAuthClient, type TikTokAuthClient, type TikTokAuthClientOptions, type TikTokTokenSet } from "./auth";
export { applyAllowlist, type AllowlistRule, type AllowlistSpec, type AllowlistedObject, type AllowlistedValue } from "./allowlist";
export {
  MAX_RATE_LIMIT_TRIES,
  RATE_LIMIT_CODE,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_MIN_DELAY_MS,
  SHORT_RETRY_DELAYS_MS,
  parseRetryAfterMs,
  rateLimitDelayMs,
} from "./backoff";
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  TikTokApiError,
  createTikTokClient,
  type FetchLike,
  type TikTokClient,
  type TikTokClientOptions,
  type TikTokErrorKind,
  type TikTokRequest,
} from "./client";
export { tiktokConfigFromEnv, type TikTokConfig, type TikTokConfigOptions, type TikTokConfigResult, type TikTokEnv } from "./config";
export {
  FINANCE_MAX_PAGE_SIZE,
  ORDER_DETAIL_MAX_IDS,
  SEARCH_AFTER_SALES_MAX_ORDER_IDS,
  SEARCH_AFTER_SALES_MAX_PAGE_SIZE,
  SEARCH_ORDERS_MAX_PAGE_SIZE,
  SEARCH_PRODUCTS_MAX_PAGE_SIZE,
  TIKTOK_API_BASE_URL,
  TIKTOK_AUTH_BASE_URL,
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_AUTH_ENDPOINTS,
  TIKTOK_ENDPOINTS,
  UPDATE_INVENTORY_MAX_SKUS,
} from "./endpoints";
export {
  TIKTOK_BUYER_MESSAGE_MAX_CHARS,
  TIKTOK_ORDER_ALLOWLIST,
  canonicalJson,
  getTikTokOrderDetails,
  isTikTokOrderId,
  projectTikTokOrder,
  searchTikTokOrders,
  tiktokSeconds,
  type ProjectTikTokOrderResult,
  type SearchTikTokOrdersInput,
  type SearchTikTokOrdersPage,
  type TikTokOrderDetailsResult,
  type TikTokOrderProjection,
} from "./orders";
export {
  TIKTOK_CANCELLATION_ALLOWLIST,
  TIKTOK_RETURN_ALLOWLIST,
  projectTikTokAfterSale,
  searchTikTokAfterSales,
  type ProjectTikTokAfterSaleResult,
  type SearchTikTokAfterSalesInput,
  type SearchTikTokAfterSalesPage,
  type TikTokAfterSaleKind,
  type TikTokAfterSaleProjection,
} from "./returns";
export {
  TIKTOK_FEE_GROUPS,
  TIKTOK_ORDER_TRANSACTION_TYPES,
  TIKTOK_PAYMENT_ALLOWLIST,
  TIKTOK_STATEMENT_ALLOWLIST,
  TIKTOK_STATEMENT_TRANSACTION_ALLOWLIST,
  TIKTOK_UNSETTLED_ALLOWLIST,
  getTikTokOrderTransactions,
  getTikTokPayments,
  getTikTokStatementTransactions,
  getTikTokStatements,
  getTikTokUnsettledTransactions,
  projectTikTokOrderTransactions,
  projectTikTokPayment,
  projectTikTokStatement,
  projectTikTokStatementTransaction,
  projectTikTokUnsettledTransaction,
  type FinanceWindowCall,
  type TikTokFeeGroup,
  type TikTokFeeLine,
  type TikTokFinancePage,
  type TikTokFinanceProblem,
  type TikTokOrderTransaction,
  type TikTokOrderTransactionsProjection,
  type TikTokPaymentProjection,
  type TikTokStatementAmounts,
  type TikTokStatementProjection,
  type TikTokStatementTransactionProjection,
  type TikTokTransactionAmounts,
  type TikTokUnsettledProjection,
} from "./finance";
export {
  TIKTOK_PRODUCT_TITLE_MAX_CHARS,
  getTikTokWarehouses,
  ownTikTokWarehouseIds,
  searchTikTokProducts,
  type SearchTikTokProductsInput,
  type SearchTikTokProductsPage,
  type TikTokInventoryEntry,
  type TikTokListingProductRecord,
  type TikTokListingSkuRecord,
  type TikTokWarehouse,
} from "./products";
export { updateTikTokInventory, type TikTokInventorySkuResult, type TikTokInventoryUpdateSku, type UpdateTikTokInventoryInput } from "./inventory";
export { TikTokMoneyFormatError, parseRupiah, type ParseRupiahOptions } from "./rupiah";
export { Secret } from "./secret";
export { getAuthorizedShops, type TikTokAuthorizedShop } from "./shops";
export { SIGN_EXCLUDED_PARAMS, buildStringToSign, signRequest, type QueryParams, type SignInput } from "./sign";
export {
  TOKEN_KEY_BYTES,
  TokenDecryptError,
  decryptToken,
  encryptToken,
  tokenKeyVersion,
  type TokenAad,
  type TokenColumn,
  type TokenDecryptFailure,
  type TokenKeyring,
} from "./token-crypto";
export { computeWebhookSignature, verifyWebhookSignature, type WebhookVerifyInput } from "./webhook";
