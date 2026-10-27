import type { Metadata } from "next";
import { storefrontFontVariables } from "@/lib/fonts";
import { getAnnouncementBarText, getStoreContact, getWhatsappNumber } from "@/lib/store-settings";
import { getSiteOgImage, siteOgImageMetadata } from "@/lib/content/site-og-image";
import { siteOrigin } from "@/lib/site-origin";
import { publicPageRobots } from "@/lib/seo/indexing";
import { HOMEPAGE_META_DESCRIPTION_DEFAULT } from "@ammari/db/storefront-settings";
import { AnnouncementBar } from "@/components/announcement-bar";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import "./globals.css";

// `metadataBase` resolves every page's relative OG/canonical URLs against this app's own origin
// (same var Better Auth itself uses as its baseURL, apps/web/.env.example) — pages that already
// build absolute URLs themselves (e.g. /products/[slug]'s OG image, off storageImageUrl()) don't
// strictly need it, but Next warns without one set at all, and other metadata still benefits.
//
// The Open Graph image set here (the published Hero's generated 1200x630 JPEG, see
// lib/content/site-og-image.ts) is inherited by every page that doesn't set its own
// `openGraph`: info pages, account/login/claim, not-found. `/` sets its own (it also needs its
// editable og:title/og:description), and `/products/[slug]` replaces it with the product photo.
// og:title/og:description are left unset here: Next fills them from each page's own title and
// description, which keeps every page's "Name | Ammari" title in its social preview.
//
// `robots` here is the default for every page that sets none: noindex off production (the meta
// tag; src/proxy.ts sends the X-Robots-Tag header), nothing on production. A private page sets its
// own NOINDEX_ROBOTS, which replaces this (docs/plans/seo.md §2).
export async function generateMetadata(): Promise<Metadata> {
  const { images, twitter } = siteOgImageMetadata(await getSiteOgImage());
  return {
    metadataBase: new URL(siteOrigin()),
    title: "Ammari",
    description: HOMEPAGE_META_DESCRIPTION_DEFAULT,
    robots: publicPageRobots(process.env.DEPLOY_ENV),
    openGraph: { type: "website", siteName: "Ammari", locale: "id_ID", images },
    twitter,
  };
}

// Header/Footer wrap EVERY route (including claim/account/login/consent/privacy-policy/
// terms-of-service) from here, so those pages pick up the storefront's chrome and design tokens
// without any change to their own logic — docs/plans/storefront-cms.md session 7's own scope.
// Header is a plain server component (no session/DB lookup — see its own doc comment). The
// footer's contact block now IS a DB read (session 8, store_settings) — safe to add here because
// every remaining route in this app is already forced dynamic for an unrelated reason (a session
// cookie read, an awaited `searchParams`/dynamic `params`, or an explicit `dynamic =
// "force-dynamic"` on `/` and the 5 info pages) before this layout even renders, so there is no
// longer any route left that `next build` would attempt to prerender with this DB call in its
// tree. The read itself is still `unstable_cache`d (lib/content/store-settings-data.ts) so it
// doesn't become a query on every request regardless.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [contact, whatsappNumber, announcementText] = await Promise.all([getStoreContact(), getWhatsappNumber(), getAnnouncementBarText()]);

  return (
    <html lang="id" className={storefrontFontVariables}>
      <body className="flex min-h-screen flex-col font-sans text-base text-ink">
        {announcementText && <AnnouncementBar text={announcementText} />}
        <Header />
        <div className="flex-1">{children}</div>
        <Footer
          contact={{
            whatsappNumber,
            supportEmail: contact.supportEmail,
            businessAddress: contact.businessAddress,
          }}
        />
      </body>
    </html>
  );
}
