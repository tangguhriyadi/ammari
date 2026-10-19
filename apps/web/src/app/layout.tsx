import type { Metadata } from "next";
import { storefrontFontVariables } from "@/lib/fonts";
import { getStoreContact, getWhatsappNumber } from "@/lib/store-settings";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import "./globals.css";

// `metadataBase` resolves every page's relative OG/canonical URLs against this app's own origin
// (same var Better Auth itself uses as its baseURL, apps/web/.env.example) — pages that already
// build absolute URLs themselves (e.g. /products/[slug]'s OG image, off storageImageUrl()) don't
// strictly need it, but Next warns without one set at all, and other metadata still benefits.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000"),
  title: "Ammari",
  description: "Ammari | syar'i gamis",
};

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
  const [contact, whatsappNumber] = await Promise.all([getStoreContact(), getWhatsappNumber()]);

  return (
    <html lang="id" className={storefrontFontVariables}>
      <body className="flex min-h-screen flex-col font-sans text-base text-ink">
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
