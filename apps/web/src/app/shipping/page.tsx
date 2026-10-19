import type { Metadata } from "next";
import { getPublishedInfoPage } from "@ammari/db/storefront";
import { InfoPageBody } from "@/components/info-page";

export const metadata: Metadata = {
  title: "Pengiriman | Ammari",
};

// Now CMS-driven — see how-to-order/page.tsx's own comment for the pattern. Never names the
// shipping origin city (CLAUDE.md / design spec §2) once the owner publishes real content —
// enforced by the admin editor's own content, not by this route.
export const dynamic = "force-dynamic";

export default async function ShippingPage() {
  const page = await getPublishedInfoPage("shipping");
  return <InfoPageBody title="Pengiriman" body={page?.body ?? null} />;
}
