import type { Metadata } from "next";
import { getPublishedInfoPage } from "@ammari/db/storefront";
import { InfoPageBody } from "@/components/info-page";

export const metadata: Metadata = {
  title: "Cara Pemesanan — Ammari",
};

// Now CMS-driven (docs/plans/storefront-cms.md Phase 2, session 8) — seeded unpublished by
// migration 0020, so this renders the "sedang disiapkan" state (InfoPageBody) until the owner
// publishes it from /content/pages in admin. Same build-time-DB-unreachable reason as
// privacy-policy/page.tsx's own comment for `force-dynamic`, and deliberately uncached too.
export const dynamic = "force-dynamic";

export default async function HowToOrderPage() {
  const page = await getPublishedInfoPage("how-to-order");
  return <InfoPageBody title="Cara Pemesanan" body={page?.body ?? null} />;
}
