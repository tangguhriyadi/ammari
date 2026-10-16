import type { Metadata } from "next";
import { getPublishedInfoPage } from "@ammari/db/storefront";
import { InfoPageBody } from "@/components/info-page";

export const metadata: Metadata = {
  title: "Kebijakan Privasi — Ammari",
};

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
  const page = await getPublishedInfoPage("privacy-policy");
  return <InfoPageBody title="Kebijakan Privasi" body={page?.body ?? null} />;
}
