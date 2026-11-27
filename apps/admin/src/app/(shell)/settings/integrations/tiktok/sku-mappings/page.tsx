import { Breadcrumb, PageHeader } from "@ammari/ui";
import { listTikTokSkuMappings, listUnmappedTikTokSkus } from "@ammari/commerce/tiktok";
import { requirePermission } from "@/lib/auth/require-permission";
import { defaultDb } from "@/lib/db";
import { TIKTOK_PERMISSION } from "@/lib/integrations/tiktok";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { TikTokSkuMappingLists } from "./_components/tiktok-sku-mapping-lists";

// Pemetaan SKU TikTok (docs/plans/tiktok-shop-integration.md §3.3, decided Q12; T4): TikTok SKUs seen
// on orders not yet in admin with no mapping, and the active mappings. integrations.manage on the
// server.

export default async function TikTokSkuMappingsPage() {
  await requirePermission(TIKTOK_PERMISSION);
  const [unmapped, mappings] = await Promise.all([listUnmappedTikTokSkus(defaultDb), listTikTokSkuMappings(defaultDb)]);
  return (
    <>
      <Breadcrumb items={rootCrumbs("/settings/integrations/tiktok/sku-mappings")} />
      <PageHeader title="Pemetaan SKU TikTok" description="Hubungkan setiap SKU di TikTok Shop ke satu varian Ammari, supaya pesanan TikTok bisa masuk ke admin." />
      <TikTokSkuMappingLists unmapped={unmapped} mappings={mappings} />
    </>
  );
}
