import type { Metadata } from "next";
import { getPublishedInfoPage } from "@ammari/db/storefront";
import { InfoPageBody } from "@/components/info-page";

export const metadata: Metadata = {
  title: "Syarat & Ketentuan — Ammari",
};

// Same pattern as privacy-policy/page.tsx's own comment — this URL also keeps its exact path
// (Google OAuth consent screen, payment-gateway verification), and is deliberately uncached too.
export const dynamic = "force-dynamic";

export default async function TermsOfServicePage() {
  const page = await getPublishedInfoPage("terms-of-service");
  return <InfoPageBody title="Syarat & Ketentuan" body={page?.body ?? null} />;
}
