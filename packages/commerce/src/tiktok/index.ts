import "server-only";

// TikTok Shop write paths (docs/plans/tiktok-shop-integration.md §2): the connection, OAuth state and
// tokens (T2), the webhook inbox (T3). Later sessions add snapshots, order apply and finance here.

export {
  consumeTikTokOAuthState,
  createTikTokOAuthState,
  deauthorizeTikTokShop,
  disconnectTikTokShop,
  getTikTokConnectionView,
  loadTikTokCredentials,
  recordTikTokExpiryWarning,
  refreshTikTokToken,
  saveTikTokConnection,
  tiktokAuthErrorRefresher,
  tiktokErrorCode,
  type RefreshTikTokTokenDeps,
  type RefreshTikTokTokenOptions,
  type RefreshTikTokTokenOutcome,
  type SaveTikTokConnectionInput,
  type SaveTikTokConnectionResult,
  type TikTokConnectionView,
  type TikTokCredentials,
  type TikTokCredentialsResult,
  type TikTokReauthReason,
} from "./connection";
export { FAKE_TIKTOK_GOOD_CODE, FAKE_TIKTOK_SHOP } from "./fake";
export { tiktokRuntimeFromEnv, type TikTokRuntime, type TikTokRuntimeOptions, type TikTokRuntimeResult } from "./runtime";
export {
  TIKTOK_OAUTH_STATE_TTL_MS,
  TIKTOK_REAUTH_WARNING_MS,
  TIKTOK_REFRESH_WHEN_LEFT_MS,
  tiktokConnectionBanner,
  tiktokRefreshDue,
  type TikTokBanner,
  type TikTokBannerInput,
} from "./status";
export {
  TIKTOK_WEBHOOK_ALLOWLIST,
  TIKTOK_WEBHOOK_MAX_ATTEMPTS,
  TIKTOK_WEBHOOK_MAX_BODY_BYTES,
  TIKTOK_WEBHOOK_TOPICS,
  parseTikTokWebhookBody,
  processDueTikTokConnectionEvents,
  processTikTokWebhookEvent,
  recordTikTokWebhookEvent,
  tiktokWebhookInitialStatus,
  tiktokWebhookRetryDelayMs,
  touchTikTokLastWebhook,
  type ParseTikTokWebhookResult,
  type ProcessTikTokWebhookResult,
  type RecordTikTokWebhookResult,
  type TikTokWebhookEvent,
} from "./webhook";
