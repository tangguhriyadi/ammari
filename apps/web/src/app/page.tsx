import type { Metadata } from "next";
import { buildHomepageView } from "@/lib/content/homepage-view";
import { collectHomepageProductRefs, resolveHomepageView } from "@/lib/content/homepage-resolve";
import { getCachedHomepageProductTiles, getCachedPublishedHomepageContent } from "@/lib/content/homepage-data";
import { priceTiles } from "@/lib/content/storefront-price";
import { HomepageSections } from "@/components/homepage/homepage-sections";
import { getHomepageMeta, getStoreContact, getWhatsappNumber } from "@/lib/store-settings";
import { getSiteOgImage, siteOgImageMetadata } from "@/lib/content/site-og-image";
import { VOUCHER_CLAIMED_PARAM, VOUCHER_CLAIMED_VALUE, voucherClaimedMessage } from "@/lib/claim/claimed-notice";
import { findJustClaimedVoucherExpiry } from "@/lib/claim/claimed-notice-data";
import { getCustomerSession } from "@/lib/auth/customer-session";
import { VoucherClaimedNotice } from "@/components/voucher-claimed-notice";
import { JsonLd } from "@/components/json-ld";
import { buildOrganizationJsonLd, buildWebSiteJsonLd } from "@/lib/seo/json-ld";
import { siteOrigin } from "@/lib/site-origin";

// `/` has no dynamic route segment, so without this Next would attempt to prerender it once
// during `next build` itself — which runs against a non-connecting placeholder DATABASE_URL in
// this repo's Docker build (apps/web/Dockerfile; confirmed empirically: an actual `next build`
// run against that exact placeholder throws ECONNREFUSED on the first real query). An earlier
// version of this page worked around that by special-casing the build phase to render an empty
// view instead — but that empty, build-time-rendered HTML then shipped as the page's ISR cache
// entry and was served as-is after every fresh deploy, for up to the 1h `revalidate` window, even
// though real published content already existed in the database (this is exactly the bug: the
// homepage rendered blank right after a deploy until someone re-published, which only triggers
// revalidation as a side effect).
//
// `force-dynamic` removes the build-time prerender attempt entirely — this route is now always
// rendered at request time, from the real database, same as `/products/[slug]` already was (see
// that page's own comment on why it never hit this bug: no `generateStaticParams` means Next
// never attempts to prerender ANY concrete slug at build either). The DB reads this page needs
// are cached independently via `unstable_cache` (lib/content/homepage-data.ts) so re-rendering on
// every request doesn't mean a database query on every request.
export const dynamic = "force-dynamic";

// Title/description are editable in admin Pengaturan Toko (store_settings, migration 0029), with
// a shared default. `title.absolute` so the root layout's plain "Ammari" never wraps it. The
// openGraph block is repeated here in full, not inherited: a page's `openGraph` replaces the
// layout's as a whole, and this one needs its own og:title/og:description.
export async function generateMetadata(): Promise<Metadata> {
  const [{ title, description }, ogImage] = await Promise.all([getHomepageMeta(), getSiteOgImage()]);
  const { images, twitter } = siteOgImageMetadata(ogImage);
  return {
    title: { absolute: title },
    description,
    // The claimed-voucher notice adds a query param; the page is the same.
    alternates: { canonical: "/" },
    openGraph: { type: "website", siteName: "Ammari", locale: "id_ID", url: "/", title, description, images },
    twitter,
  };
}

async function getHomepageView() {
  const sections = await getCachedPublishedHomepageContent();
  const view = buildHomepageView(sections);
  const refs = collectHomepageProductRefs(view);
  const tiles = refs.length > 0 ? await getCachedHomepageProductTiles(refs) : [];
  // Priced per request, never inside the cache: a discount shows exactly from its start.
  return resolveHomepageView(view, priceTiles(tiles, new Date()));
}

/** The claimed notice's dates come from the signed-in buyer's own just-claimed voucher. Any
 * miss (no session, nothing fresh, a failed read) gives the plain message instead: the notice
 * is a courtesy and must never break the homepage. */
async function getVoucherClaimedMessage(): Promise<string> {
  try {
    const customer = await getCustomerSession();
    const expiresAt = customer ? await findJustClaimedVoucherExpiry(customer.id) : null;
    return voucherClaimedMessage(expiresAt);
  } catch (error) {
    console.error("[claim] reading the just-claimed voucher for the homepage notice failed", error);
    return voucherClaimedMessage(null);
  }
}

export default async function HomePage({ searchParams }: PageProps<"/">) {
  const resolvedSearchParams = await searchParams;
  // Where a successful voucher claim lands (lib/claim/claimed-notice.ts).
  const voucherClaimed = resolvedSearchParams[VOUCHER_CLAIMED_PARAM] === VOUCHER_CLAIMED_VALUE;
  const [view, claimedMessage, meta, contact, whatsappNumber] = await Promise.all([
    getHomepageView(),
    voucherClaimed ? getVoucherClaimedMessage() : null,
    getHomepageMeta(),
    getStoreContact(),
    getWhatsappNumber(),
  ]);
  const origin = siteOrigin();
  return (
    <>
      <JsonLd data={buildOrganizationJsonLd({ origin, supportEmail: contact.supportEmail, whatsappNumber })} />
      <JsonLd data={buildWebSiteJsonLd({ origin, description: meta.description })} />
      {/* The Hero carries the page's h1; without a published Hero the page still gets one. */}
      {!view.hero && <h1 className="sr-only">Ammari, busana syar&apos;i</h1>}
      <HomepageSections view={view} />
      {claimedMessage && <VoucherClaimedNotice message={claimedMessage} />}
    </>
  );
}
