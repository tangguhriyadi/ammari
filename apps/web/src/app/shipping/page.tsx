import type { Metadata } from "next";
import { InfoPageBody } from "@/components/info-page";
import { JsonLd } from "@/components/json-ld";
import { getCachedPublishedInfoPage, infoPageBreadcrumb, infoPageMetadata } from "@/lib/content/info-page-data";

const NAME = "Pengiriman";

export function generateMetadata(): Promise<Metadata> {
  return infoPageMetadata("shipping", NAME, "Informasi pengiriman pesanan Ammari: kurir, ongkos kirim, dan perkiraan waktu tiba.");
}

// Now CMS-driven — see how-to-order/page.tsx's own comment for the pattern. Never names the
// shipping origin city (CLAUDE.md / design spec §2) once the owner publishes real content —
// enforced by the admin editor's own content, not by this route.
export const dynamic = "force-dynamic";

export default async function ShippingPage() {
  const page = await getCachedPublishedInfoPage("shipping");
  return (
    <>
      <JsonLd data={infoPageBreadcrumb("shipping", NAME)} />
      <InfoPageBody title={NAME} body={page?.body ?? null} />
    </>
  );
}
