import Link from "next/link";
import { User } from "lucide-react";
import { Container } from "./container";
import { Wordmark } from "./wordmark";
import { MobileNav } from "./mobile-nav";

/** docs/design/storefront.md §4 "Header" — 56px, white, bottom hairline, sticky. A plain server
 * component: no session/DB lookup here (that would make `headers()` dynamic and defeat `/`'s and
 * `/products/[slug]`'s `revalidate = 3600` static generation) — the account icon always links to
 * `/account`, which already redirects an unauthenticated visitor to `/login` itself
 * (requireConsentedSession). No search/cart icon: there's no catalog/search page yet (Phase 3)
 * and cart is feature-flagged off by default this session — see the implementation report for
 * this scoping decision instead of rendering dead UI.
 *
 * Desktop (lg+) is wordmark left, account right, and an EMPTY center column: the center used to
 * hold a one-item "Navigasi utama" nav with a "Koleksi" link (to /#koleksi), removed on the
 * owner's request since a lone link read as a page title. The 3-column grid
 * (`1fr auto 1fr`) is kept as is: the mobile wordmark still needs the centered `auto` column,
 * and on desktop the two `1fr` columns keep the logo and account icon pinned to the edges at the
 * same positions as before. Mobile is unchanged (its menu, MobileNav, still links Koleksi). */
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
        </div>
      </Container>
    </header>
  );
}
