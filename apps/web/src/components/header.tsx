import Link from "next/link";
import { User } from "lucide-react";
import { Container } from "./container";
import { Wordmark } from "./wordmark";
import { MobileNav } from "./mobile-nav";

const DESKTOP_NAV_LINKS: { href: string; label: string }[] = [{ href: "/#koleksi", label: "Koleksi" }];

/** docs/design/storefront.md §4 "Header" — 56px, white, bottom hairline, sticky. A plain server
 * component: no session/DB lookup here (that would make `headers()` dynamic and defeat `/`'s and
 * `/products/[slug]`'s `revalidate = 3600` static generation) — the account icon always links to
 * `/account`, which already redirects an unauthenticated visitor to `/login` itself
 * (requireConsentedSession). No search/cart icon: there's no catalog/search page yet (Phase 3)
 * and cart is feature-flagged off by default this session — see the implementation report for
 * this scoping decision instead of rendering dead UI. */
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
          <nav aria-label="Navigasi utama" className="hidden items-center gap-8 lg:flex">
            {DESKTOP_NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-xs font-medium tracking-[0.16em] text-ink uppercase hover:text-ink-muted"
              >
                {link.label}
              </Link>
            ))}
          </nav>
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
