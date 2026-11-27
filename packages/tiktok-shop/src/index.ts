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
  ORDER_DETAIL_MAX_IDS,
  SEARCH_ORDERS_MAX_PAGE_SIZE,
  TIKTOK_API_BASE_URL,
  TIKTOK_AUTH_BASE_URL,
  TIKTOK_AUTHORIZE_URL,
  TIKTOK_AUTH_ENDPOINTS,
  TIKTOK_ENDPOINTS,
} from "./endpoints";
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
