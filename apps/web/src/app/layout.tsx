import type { Metadata } from "next";
import { storefrontFontVariables } from "@/lib/fonts";
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
  description: "Ammari — syar'i gamis",
};

// Header/Footer wrap EVERY route (including claim/account/login/consent/privacy-policy/
// terms-of-service) from here, so those pages pick up the storefront's chrome and design tokens
// without any change to their own logic — docs/plans/storefront-cms.md session 7's own scope.
// Header is a plain server component (no session/DB lookup — see its own doc comment), so this
// layout stays static-safe and never forces `/`/`/products/[slug]` out of their `revalidate =
// 3600` static generation.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="id" className={storefrontFontVariables}>
      <body className="flex min-h-screen flex-col font-sans text-base text-ink">
        <Header />
        <div className="flex-1">{children}</div>
        <Footer />
      </body>
    </html>
  );
}
