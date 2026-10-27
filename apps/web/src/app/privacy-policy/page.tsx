import type { Metadata } from "next";
import { InfoPageBody } from "@/components/info-page";
import { JsonLd } from "@/components/json-ld";
import { getCachedPublishedInfoPage, infoPageBreadcrumb, infoPageMetadata } from "@/lib/content/info-page-data";

const NAME = "Kebijakan Privasi";

export function generateMetadata(): Promise<Metadata> {
  return infoPageMetadata("privacy-policy", NAME, "Kebijakan privasi Ammari: data apa yang kami kumpulkan saat kamu berbelanja, untuk apa dipakai, dan bagaimana kami menjaganya.");
}

// `/privacy-policy` must keep this EXACT URL — registered in the Google OAuth consent screen and
// used for payment-gateway verification (docs/plans/storefront-cms.md Phase 2). Content now comes
// from `info_pages` (migration 0020 seeds it with the page's former hard-coded placeholder text,
// already "published" on day one so this route never 404s or goes blank) instead of hard-coded
// JSX — the URL itself never changed. `force-dynamic` for the same reason `/` (app/page.tsx) is:
// this route now reads the database, which is unreachable during `next build`'s own prerender
// attempt. Deliberately uncached (no `unstable_cache`) — tried, then reverted (see this
// session's own implementation report): it didn't reliably reflect a fresh publish within the
// same server lifetime. A `SELECT` by unique slug is cheap enough per request to skip caching.
export const dynamic = "force-dynamic";

export default async function PrivacyPolicyPage() {
  const page = await getCachedPublishedInfoPage("privacy-policy");
  return (
    <>
      <JsonLd data={infoPageBreadcrumb("privacy-policy", NAME)} />
      <InfoPageBody title={NAME} body={page?.body ?? null} />
    </>
  );
}
