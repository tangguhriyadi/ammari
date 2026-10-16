import Link from "next/link";
import { Mail, MapPin, MessageCircle } from "lucide-react";
import { buildWhatsappUrl, formatWhatsappNumber } from "@/lib/whatsapp";
import { Container } from "./container";
import { Wordmark } from "./wordmark";

// docs/design/storefront.md §4 "Footer" — of the five help links in the mockup, only two route
// to real pages today ("Syarat & ketentuan"/"Kebijakan privasi"). "Cara pemesanan"/"Pengiriman"/
// "Pengembalian & penukaran" are placeholder pages here (same "content to be filled in before
// launch" pattern /privacy-policy and /terms-of-service already use) that will read from
// `info_pages` once that CMS ships (docs/plans/storefront-cms.md Phase 2, session 8). "Panduan
// ukuran" has no page to link to at all — it isn't one of Phase 2's five fixed info_pages slugs,
// and a size guide only makes sense in a specific product's context (the PDP's own "Ukuran"
// accordion) — so it's left out of this list rather than linking somewhere misleading. See the
// session 7 implementation report for this scoping call.
const HELP_LINKS: { href: string; label: string }[] = [
  { href: "/how-to-order", label: "Cara pemesanan" },
  { href: "/shipping", label: "Pengiriman" },
  { href: "/returns-exchange", label: "Pengembalian & penukaran" },
  { href: "/terms-of-service", label: "Syarat & ketentuan" },
  { href: "/privacy-policy", label: "Kebijakan privasi" },
];

// Logos copied from packages/ui/assets/*-logo.svg into public/logos/ by
// packages/ui/assets/copy-brand-logos.mjs (re-run that script after replacing a source file).
// width/height are each logo's own intrinsic aspect ratio scaled to a shared 20px height, so the
// row lines up evenly. "Kartu kredit" removed (owner decision) — no logo for it and the brand
// chips below already cover the real payment methods on offer.
//
// Two of these four (QRIS, VA) are flat black marks with no background of their own — confirmed
// by rendering each against #695A5A (this footer's own background): both come out muddy, well
// under 3:1 contrast, which docs/design/storefront.md §8 requires for non-text UI. GoPay and
// ShopeePay each already carry their own solid-colour circular backing and read fine directly on
// brand. Rather than mix "some chips have a white backing, some don't," all four sit in the same
// white chip — the uniform, standard treatment real payment-badge rows use.
const PAYMENT_METHODS: { label: string; logo: string; width: number; height: number }[] = [
  { label: "QRIS", logo: "/logos/qris.svg", width: 53, height: 20 },
  { label: "Virtual Account", logo: "/logos/va.svg", width: 30, height: 20 },
  { label: "GoPay", logo: "/logos/gopay.svg", width: 17, height: 20 },
  { label: "ShopeePay", logo: "/logos/shopeepay.svg", width: 27, height: 20 },
];

export interface FooterContact {
  whatsappNumber: string | null;
  supportEmail: string | null;
  businessAddress: string | null;
}

/** docs/design/storefront.md §4 "Footer" — brand-coloured background, white text. The contact
 * block (WhatsApp/email/address) now reads from `store_settings` (docs/plans/storefront-cms.md
 * Phase 2, session 8) — the caller fetches it once (root layout.tsx) and passes it down, same
 * "page/layout awaits, pure component renders" split as the PDP's TrustRow. Still hidden
 * entirely when every field is empty (the owner hasn't filled in settings yet) — the design
 * spec's own "hide until it exists" rule, just no longer permanently true. Never names the
 * payment gateway (CLAUDE.md / design spec §2) — the chips below are generic payment-method
 * labels, not a provider name. */
export function Footer({ contact }: { contact: FooterContact }) {
  const year = new Date().getFullYear();
  const hasContact = Boolean(contact.whatsappNumber || contact.supportEmail || contact.businessAddress);

  return (
    <footer className="bg-brand text-footer-text">
      <Container className="flex flex-col gap-8 py-12">
        <div className="flex flex-col gap-2">
          <Wordmark size="footer" />
          <p className="text-sm text-footer-text/80">Graceful in every thread</p>
        </div>

        <nav aria-label="Tautan bantuan" className="flex flex-col gap-3 border-t border-footer-line pt-6">
          {HELP_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="w-fit text-sm text-footer-text hover:text-footer-text/80">
              {link.label}
            </Link>
          ))}
        </nav>

        {hasContact && (
          <div className="flex flex-col gap-3 border-t border-footer-line pt-6">
            <p className="text-[11px] font-medium tracking-[0.24em] text-footer-text/70 uppercase">Hubungi kami</p>
            <ul className="flex flex-col gap-2 text-sm text-footer-text">
              {contact.whatsappNumber && (
                <li className="flex items-center gap-2">
                  <MessageCircle className="size-4 shrink-0" strokeWidth={1.4} aria-hidden="true" />
                  <a href={buildWhatsappUrl(contact.whatsappNumber, "Halo, saya mau tanya tentang Ammari.")} className="hover:text-footer-text/80">
                    {formatWhatsappNumber(contact.whatsappNumber)}
                  </a>
                </li>
              )}
              {contact.supportEmail && (
                <li className="flex items-center gap-2">
                  <Mail className="size-4 shrink-0" strokeWidth={1.4} aria-hidden="true" />
                  <a href={`mailto:${contact.supportEmail}`} className="hover:text-footer-text/80">
                    {contact.supportEmail}
                  </a>
                </li>
              )}
              {contact.businessAddress && (
                <li className="flex items-start gap-2">
                  <MapPin className="mt-0.5 size-4 shrink-0" strokeWidth={1.4} aria-hidden="true" />
                  <span className="whitespace-pre-line">{contact.businessAddress}</span>
                </li>
              )}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-3 border-t border-footer-line pt-6">
          <p className="text-[11px] font-medium tracking-[0.24em] text-footer-text/70 uppercase">Pembayaran</p>
          <ul className="flex flex-wrap gap-2">
            {PAYMENT_METHODS.map((method) => (
              <li
                key={method.label}
                className="flex items-center gap-2 border border-footer-chip-border bg-bg px-3 py-1.5 text-xs text-ink"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a static public/ SVG brand mark; next/image's optimizer (disabled app-wide anyway, see next.config.ts) has nothing to add here */}
                <img src={method.logo} alt="" width={method.width} height={method.height} style={{ height: method.height, width: "auto" }} />
                {method.label}
              </li>
            ))}
          </ul>
        </div>

        <p className="border-t border-footer-line pt-6 text-xs text-footer-text/70">© {year} Ammari</p>
      </Container>
    </footer>
  );
}
