import type { Metadata } from "next";
import { InfoPageBody } from "@/components/info-page";
import { JsonLd } from "@/components/json-ld";
import { getCachedPublishedInfoPage, infoPageBreadcrumb, infoPageMetadata } from "@/lib/content/info-page-data";

const NAME = "Pengembalian & Penukaran";

export function generateMetadata(): Promise<Metadata> {
  return infoPageMetadata("returns-exchange", NAME, "Ketentuan pengembalian dan penukaran ukuran untuk pesanan Ammari.");
}

// Now CMS-driven — see how-to-order/page.tsx's own comment for the pattern.
export const dynamic = "force-dynamic";

export default async function ReturnsExchangePage() {
  const page = await getCachedPublishedInfoPage("returns-exchange");
  return (
    <>
      <JsonLd data={infoPageBreadcrumb("returns-exchange", NAME)} />
      <InfoPageBody title={NAME} body={page?.body ?? null} />
    </>
  );
}
