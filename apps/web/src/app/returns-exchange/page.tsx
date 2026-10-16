import type { Metadata } from "next";
import { getPublishedInfoPage } from "@ammari/db/storefront";
import { InfoPageBody } from "@/components/info-page";

export const metadata: Metadata = {
  title: "Pengembalian & Penukaran — Ammari",
};

// Now CMS-driven — see how-to-order/page.tsx's own comment for the pattern.
export const dynamic = "force-dynamic";

export default async function ReturnsExchangePage() {
  const page = await getPublishedInfoPage("returns-exchange");
  return <InfoPageBody title="Pengembalian & Penukaran" body={page?.body ?? null} />;
}
