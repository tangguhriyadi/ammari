import { listTikTokSkuMappings, listUnmappedTikTokSkus } from "@ammari/commerce/tiktok";
import { requirePermission } from "@/lib/auth/require-permission";
import { defaultDb } from "@/lib/db";
import { TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { TikTokSkuMappingLists } from "./_components/tiktok-sku-mapping-lists";

// Pemetaan SKU TikTok (docs/plans/tiktok-shop-integration.md §3.3, decided Q12; T4): TikTok SKUs seen
// on orders not yet in admin with no mapping, and the active mappings. integrations.manage on the
// server.

export default async function TikTokSkuMappingsPage() {
  await requirePermission(TIKTOK_PERMISSION);
  const [unmapped, mappings] = await Promise.all([listUnmappedTikTokSkus(defaultDb), listTikTokSkuMappings(defaultDb)]);
  return (
    <>
      <TikTokSkuMappingLists unmapped={unmapped} mappings={mappings} />
    </>
  );
}
