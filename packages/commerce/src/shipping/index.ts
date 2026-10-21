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
export { DEFAULT_DAILY_SHIPPING_BUDGETS, SHIPPING_BUDGET_ACTIONS, consumeShippingCallBudget } from "./budget";
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
