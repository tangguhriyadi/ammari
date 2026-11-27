import "server-only";
import { z } from "zod";
import type { TikTokClient } from "./client";
import { TIKTOK_ENDPOINTS } from "./endpoints";
import type { Secret } from "./secret";

// Get Authorized Shops (docs/plans/tiktok-shop-integration.md §0 "API", §7.3): the shops the token
// may act for, with the `shop_cipher` every shop-scoped call needs. Only the fields the connection
// row stores are kept; anything else TikTok returns is dropped by the schema.

const shopSchema = z.object({
  id: z.string().min(1).max(64),
  cipher: z.string().min(1).max(512),
  name: z.string().max(512).optional(),
  region: z.string().max(16).optional(),
  seller_type: z.string().max(64).optional(),
});

const authorizedShopsSchema = z.object({ shops: z.array(shopSchema).max(100).optional() });

export interface TikTokAuthorizedShop {
  shopId: string;
  shopCipher: string;
  shopName: string | null;
  region: string | null;
  sellerType: string | null;
}

export async function getAuthorizedShops(client: TikTokClient, accessToken: Secret, options: { deadline?: number } = {}): Promise<TikTokAuthorizedShop[]> {
  const data = await client.request({
    method: "GET",
    path: TIKTOK_ENDPOINTS.authorizedShops,
    accessToken,
    schema: authorizedShopsSchema,
    deadline: options.deadline,
  });
  return (data.shops ?? []).map((shop) => ({
    shopId: shop.id,
    shopCipher: shop.cipher,
    shopName: shop.name ?? null,
    region: shop.region ?? null,
    sellerType: shop.seller_type ?? null,
  }));
}
