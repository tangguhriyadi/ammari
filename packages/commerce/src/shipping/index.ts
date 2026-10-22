// @ammari/commerce/shipping (docs/plans/cart-checkout.md §4.5, D17, D18): the server-side rate
// layer. Server-only modules (DB, provider client); the pure rules and constants the checkout UI
// may also import live in @ammari/commerce/shipping-rules (./rules.ts) and are re-exported here.
import "server-only";

export {
  SHIPPING_PACKAGING_GRAMS,
  SHIPPING_SERVICE_ALLOWLIST,
  SHIPPING_SUBSIDY_MAX_AMOUNT,
  formatShippingAreaLabel,
  parcelWeightGrams,
  pickCheapestService,
  splitShippingCost,
  type AllowlistedService,
  type PickedService,
  type RatedService,
  type ShippingCostSplit,
} from "./rules";
export { ShippingRateError, type ShippingArea, type ShippingRateErrorReason, type ShippingRateProvider } from "./provider";
export { createBiteshipClient, type BiteshipClientOptions } from "./biteship";
export { FAKE_ORIGIN_AREA_ID, FAKE_SEARCH_FAILURE_WORD, FAKE_SHIPPING_AREAS, createFakeShippingRateProvider } from "./fake";
export { DEFAULT_DAILY_SHIPPING_BUDGETS, SHIPPING_BUDGET_ACTIONS, consumeShippingCallBudget, type ShippingBudgetKind } from "./budget";
export { DEFAULT_SHIPPING_QUOTE_CACHE_MINUTES, allowlistServicesKey } from "./cache";
export {
  SHIPPING_AREA_RESULT_LIMIT,
  loadShippingArea,
  searchShippingAreas,
  type ShippingAreaOption,
  type ShippingAreaRecord,
} from "./areas";
export {
  quoteShipping,
  type QuoteLine,
  type QuoteShippingResult,
  type ShippingQuote,
  type ShippingQuoteDeps,
  type ShippingQuoteRefusal,
} from "./quote";
export { shippingRuntimeFromEnv, type ShippingEnv, type ShippingRuntime, type ShippingRuntimeResult } from "./config";

// Phase K: courier booking and tracking (docs/plans/cart-checkout.md §15 Phase K).
export * from "./shipment-rules";
export {
  ShipmentProviderError,
  type CancelShipmentInput,
  type CancelledShipment,
  type CreateShipmentInput,
  type ProviderShipment,
  type ShipmentAddress,
  type ShipmentCallKind,
  type ShipmentCancelReasonCode,
  type ShipmentDriver,
  type ShipmentHistoryEntry,
  type ShipmentProvider,
  type ShipmentProviderErrorReason,
} from "./shipment-provider";
export { createBiteshipOrdersClient, parseBiteshipOrder, type BiteshipOrdersClientOptions } from "./biteship-orders";
export {
  FAKE_SHIPMENT_REFUSED_CODE,
  createFakeShipmentProvider,
  createFakeShipmentStore,
  processFakeShipmentStore,
  type FakeShipmentControls,
  type FakeShipmentStore,
} from "./fake-shipments";
export {
  FAKE_SHIPMENT_ORIGIN,
  FAKE_SHIPMENT_REFERENCE_PREFIX,
  shipmentRuntimeFromEnv,
  type ShipmentOrigin,
  type ShipmentRuntime,
  type ShipmentRuntimeResult,
} from "./shipment-config";
export {
  SHIPMENT_CANCEL_REASON_CODES,
  SHIPMENT_MESSAGES,
  bookShipment,
  cancelShipment,
  findLiveShipment,
  recheckBooking,
  refreshShipmentForLabel,
  type ShipmentActionOutcome,
} from "./bookings";
