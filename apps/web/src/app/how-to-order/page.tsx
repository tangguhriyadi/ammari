import type { Metadata } from "next";
import { InfoPageBody } from "@/components/info-page";
import { JsonLd } from "@/components/json-ld";
import { getCachedPublishedInfoPage, infoPageBreadcrumb, infoPageMetadata } from "@/lib/content/info-page-data";

const NAME = "Cara Pemesanan";

export function generateMetadata(): Promise<Metadata> {
  return infoPageMetadata("how-to-order", NAME, "Cara memesan busana syar'i Ammari secara online, dari memilih produk sampai pembayaran dan pengiriman.");
}

// Now CMS-driven (docs/plans/storefront-cms.md Phase 2, session 8) — seeded unpublished by
// migration 0020, so this renders the "sedang disiapkan" state (InfoPageBody) until the owner
// publishes it from /content/pages in admin. Same build-time-DB-unreachable reason as
// privacy-policy/page.tsx's own comment for `force-dynamic`, and deliberately uncached too.
export const dynamic = "force-dynamic";

export default async function HowToOrderPage() {
  const page = await getCachedPublishedInfoPage("how-to-order");
  return (
    <>
      <JsonLd data={infoPageBreadcrumb("how-to-order", NAME)} />
      <InfoPageBody title={NAME} body={page?.body ?? null} />
    </>
  );
}
