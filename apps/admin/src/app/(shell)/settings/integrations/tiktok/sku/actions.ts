"use server";

import { z } from "zod";
import { mapTikTokSku, unmapTikTokSku } from "@ammari/commerce/tiktok";
import { requirePermission } from "@/lib/auth/require-permission";
import { runAction, type ActionResult } from "@/lib/action-result";
import { revalidateAdmin } from "@/lib/admin-revalidate";
import { defaultDb } from "@/lib/db";
import { ActionError } from "@/lib/errors";
import { TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { pushTikTokStockAfterResponse } from "@/lib/integrations/tiktok-stock-push";
import { searchMatchVariants, type MatchVariantOption } from "@/lib/marketplace-import/variant-search";

// Pemetaan SKU TikTok (docs/plans/tiktok-shop-integration.md §3.3, Q12; T4). integrations.manage
// on the server for every action; every change is audited by the commerce write path.

const searchSchema = z.string().trim().min(2).max(100);
const skuIdSchema = z.string().trim().min(1).max(128);
const variantSkuSchema = z.string().trim().min(1).max(128);

/** "Cocokkan ke varian": the same variant search the file import uses (§8.1 of marketplace-import.md). */
export async function searchTikTokMatchVariantsAction(q: string): Promise<MatchVariantOption[]> {
  await requirePermission(TIKTOK_PERMISSION);
  const parsed = searchSchema.safeParse(q);
  if (!parsed.success) return [];
  return searchMatchVariants(parsed.data);
}

const MAP_ERRORS = {
  invalid_sku_id: "SKU TikTok tidak valid.",
  unknown_tiktok_sku: "SKU TikTok ini belum pernah terlihat di pesanan. Muat ulang halaman.",
  variant_not_found: "Varian tidak ditemukan. Cari lagi lalu pilih.",
} as const;

export async function mapTikTokSkuAction(tiktokSkuId: string, variantSku: string): Promise<ActionResult> {
  const session = await requirePermission(TIKTOK_PERMISSION);
  return runAction(async () => {
    const skuId = skuIdSchema.safeParse(tiktokSkuId);
    const variant = variantSkuSchema.safeParse(variantSku);
    if (!skuId.success || !variant.success) throw new ActionError(MAP_ERRORS.invalid_sku_id);
    const result = await mapTikTokSku(defaultDb, { tiktokSkuId: skuId.data, variantSku: variant.data, staffUserId: session.staffUser.id });
    if (!result.ok) throw new ActionError(MAP_ERRORS[result.reason]);
    // A mapping moves which variant a TikTok SKU follows (and R2's held pieces): push after the commit.
    pushTikTokStockAfterResponse();
    revalidateAdmin("/settings");
    return undefined;
  });
}

export async function unmapTikTokSkuAction(tiktokSkuId: string): Promise<ActionResult> {
  const session = await requirePermission(TIKTOK_PERMISSION);
  return runAction(async () => {
    const skuId = skuIdSchema.safeParse(tiktokSkuId);
    if (!skuId.success) throw new ActionError(MAP_ERRORS.invalid_sku_id);
    const result = await unmapTikTokSku(defaultDb, { tiktokSkuId: skuId.data, staffUserId: session.staffUser.id });
    if (!result.ok) throw new ActionError("Pemetaan ini sudah tidak ada. Muat ulang halaman.");
    pushTikTokStockAfterResponse();
    revalidateAdmin("/settings");
    return undefined;
  });
}
