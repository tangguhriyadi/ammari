import { shopeeAdapter } from "./shopee";
import { tiktokAdapter } from "./tiktok";
import type { MarketplaceAdapter } from "./types";

export const MARKETPLACE_ADAPTERS: Readonly<Record<MarketplaceAdapter["channelId"], MarketplaceAdapter>> = {
  shopee: shopeeAdapter,
  tiktok: tiktokAdapter,
};

/** The adapter for a channel id from a form, or null for anything else. */
export function adapterFor(channelId: string): MarketplaceAdapter | null {
  return Object.hasOwn(MARKETPLACE_ADAPTERS, channelId) ? MARKETPLACE_ADAPTERS[channelId as MarketplaceAdapter["channelId"]] : null;
}
