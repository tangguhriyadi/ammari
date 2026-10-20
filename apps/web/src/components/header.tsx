import Link from "next/link";
import { User } from "lucide-react";
import { Container } from "./container";
import { Wordmark } from "./wordmark";
import { MobileNav } from "./mobile-nav";
import { CartLink } from "./cart-link";
import { isCartEnabled } from "@/lib/cart-flag";

/** docs/design/storefront.md §4 "Header" — 56px, white, bottom hairline, sticky. A plain server
 * component: no session/DB lookup here (that would make `headers()` dynamic and defeat `/`'s and
 * `/products/[slug]`'s `revalidate = 3600` static generation) — the account icon always links to
 * `/account`, which already redirects an unauthenticated visitor to `/login` itself
 * (requireConsentedSession). No search icon: there's no catalog/search page yet (Phase 3); the
 * cart icon is behind the cart flag (see below).
 *
 * Desktop (lg+) is wordmark left, account right, and an EMPTY center column: the center used to
 * hold a one-item "Navigasi utama" nav with a "Koleksi" link (to /#koleksi), removed on the
 * owner's request since a lone link read as a page title. The 3-column grid
 * (`1fr auto 1fr`) is kept as is: the mobile wordmark still needs the centered `auto` column,
 * and on desktop the two `1fr` columns keep the logo and account icon pinned to the edges at the
 * same positions as before. Mobile is unchanged (its menu, MobileNav, still links Koleksi).
 *
 * Cart (docs/plans/cart-checkout.md §4.2): only while STOREFRONT_CART_ENABLED is on, a bag icon
 * at the right edge, after the account icon, on every width (the design's mobile "search + cart"
 * pair, with account in the slot until a search page exists). Reading the flag here is just an
 * env read, not a dynamic API, so ISR still applies. The count itself is never rendered here:
 * `CartLink` fetches it per page in the browser (an ISR-cached page must not carry one visitor's
 * cart). Flag off: no icon, no fetch, the header is exactly as before. */
export function Header() {
  return (
    <header className="sticky top-0 z-30 h-14 border-b border-line bg-bg">
      <Container className="relative grid h-full grid-cols-[1fr_auto_1fr] items-center">
        <div className="flex items-center">
          <MobileNav />
          <Link href="/" aria-label="Ammari, beranda" className="hidden lg:block">
            <Wordmark />
          </Link>
        </div>

        <div className="flex items-center justify-center">
          <Link href="/" aria-label="Ammari, beranda" className="lg:hidden">
            <Wordmark />
          </Link>
        </div>

        <div className="flex items-center justify-end">
          <Link
            href="/account"
            aria-label="Akun saya"
            className="flex size-11 items-center justify-center text-ink hover:text-ink-muted"
          >
            <User className="size-5" strokeWidth={1.4} aria-hidden="true" />
          </Link>
          {isCartEnabled() && <CartLink />}
        </div>
      </Container>
    </header>
  );
}
