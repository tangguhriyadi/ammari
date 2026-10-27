import type { Metadata } from "next";
import { InfoPageBody } from "@/components/info-page";
import { JsonLd } from "@/components/json-ld";
import { getCachedPublishedInfoPage, infoPageBreadcrumb, infoPageMetadata } from "@/lib/content/info-page-data";

const NAME = "Syarat & Ketentuan";

export function generateMetadata(): Promise<Metadata> {
  return infoPageMetadata("terms-of-service", NAME, "Syarat dan ketentuan berbelanja di toko resmi Ammari: pemesanan, pembayaran, pengiriman, dan penukaran.");
}

// Same pattern as privacy-policy/page.tsx's own comment — this URL also keeps its exact path
// (Google OAuth consent screen, payment-gateway verification), and is deliberately uncached too.
export const dynamic = "force-dynamic";

export default async function TermsOfServicePage() {
  const page = await getCachedPublishedInfoPage("terms-of-service");
  return (
    <>
      <JsonLd data={infoPageBreadcrumb("terms-of-service", NAME)} />
      <InfoPageBody title={NAME} body={page?.body ?? null} />
    </>
  );
}
