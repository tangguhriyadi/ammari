import "server-only";

// TikTok Shop write paths (docs/plans/tiktok-shop-integration.md §2): the connection, OAuth state and
// tokens (T2), the webhook inbox (T3), the order read side: snapshots, projection, SKU mapping, the
// sync run and its dry-run preview (T4), applying orders to admin orders and stock behind the kill
// switch (T5), cancellations and returns (T6). T7 adds finance here.

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
export {
  RETURN_RECEIVED_MESSAGES,
  TIKTOK_AFTER_SALE_RECHECK_LIMIT,
  applyTikTokAfterSale,
  ingestTikTokAfterSale,
  listTikTokAfterSalesToApply,
  receiveMarketplaceReturn,
  type ApplyTikTokAfterSaleResult,
  type IngestTikTokAfterSaleResult,
} from "./after-sale";
export {
  TIKTOK_RESPONSE_WINDOW_MS,
  decideTikTokAfterSale,
  tiktokAfterSaleFlags,
  tiktokAfterSaleIsFinal,
  tiktokAfterSaleResponseDue,
  type AfterSaleDecideInput,
  type AfterSaleDecision,
} from "./after-sale-rules";
export {
  applyTikTokOrder,
  listTikTokOrdersToApply,
  setTikTokOrdersApply,
  tiktokOrdersApplyEnabled,
  type ApplyTikTokOrderOptions,
  type ApplyTikTokOrderResult,
  type SetTikTokOrdersApplyResult,
} from "./apply";
export {
  TIKTOK_PACKING_HOLD_MS,
  decideTikTokOrder,
  formatJakartaTime,
  tiktokPackingRefusal,
  tiktokPackingState,
  tiktokReadyToShip,
  type TikTokDecision,
  type TikTokGateInput,
  type TikTokPackingState,
} from "./apply-rules";
export { FAKE_TIKTOK_GOOD_CODE, FAKE_TIKTOK_SHOP } from "./fake";
export {
  TIKTOK_ORDER_PREVIEW_LIMIT,
  TIKTOK_ORDER_STATUSES,
  listTikTokOrderPreviews,
  previewTikTokOrder,
  tiktokMoneyProblem,
  type TikTokOrderPreview,
  type TikTokOrderPreviewRow,
  type TikTokPreviewInput,
  type TikTokPreviewOutcome,
} from "./order-preview";
export {
  TIKTOK_BUYER_MESSAGE_RETENTION_MS,
  TIKTOK_TERMINAL_STATUSES,
  ingestTikTokOrder,
  normalizeTikTokSellerSku,
  tiktokBuyerMessagePurgeAfter,
  type IngestTikTokOrderResult,
} from "./order-store";
export {
  TIKTOK_POLL_INITIAL_LOOKBACK_MS,
  TIKTOK_POLL_LAG_MS,
  TIKTOK_POLL_OVERLAP_MS,
  TIKTOK_POLL_SLICE_MS,
  planTikTokPollWindows,
  type TikTokPollCursor,
  type TikTokPollWindow,
} from "./order-windows";
export {
  listTikTokSkuMappings,
  listUnmappedTikTokSkus,
  mapTikTokSku,
  unmapTikTokSku,
  type MapTikTokSkuResult,
  type TikTokSkuMappingView,
  type UnmapTikTokSkuResult,
  type UnmappedTikTokSku,
} from "./sku-mappings";
export {
  TIKTOK_SYNC_BUDGET_MS,
  TIKTOK_WEBHOOK_DRAIN_BUDGET_MS,
  drainTikTokWebhookOrderEvent,
  runTikTokSync,
  type DrainTikTokWebhookEventResult,
  type TikTokAfterSaleCounts,
  type TikTokApplyCounts,
  type TikTokSyncDeps,
  type TikTokSyncSummary,
} from "./sync";
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
