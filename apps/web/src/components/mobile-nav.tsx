"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

const LINKS: { href: string; label: string }[] = [
  { href: "/#koleksi", label: "Koleksi" },
  { href: "/account", label: "Akun" },
  { href: "/terms-of-service", label: "Syarat & Ketentuan" },
  { href: "/privacy-policy", label: "Kebijakan Privasi" },
];

/** The mobile header's menu disclosure (docs/design/storefront.md §4 "Header" — "menu button
 * (left)"). There's no catalog/search page yet (Phase 3, separate work per docs/plans/
 * storefront-cms.md), so this links only to pages/anchors that actually exist today rather than
 * a dead search icon — see the session 7 implementation report for that scoping call. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="lg:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Tutup menu" : "Buka menu"}
        onClick={() => setOpen((value) => !value)}
        className="flex size-11 items-center justify-center text-ink"
      >
        {open ? <X className="size-5" strokeWidth={1.4} aria-hidden="true" /> : <Menu className="size-5" strokeWidth={1.4} aria-hidden="true" />}
      </button>
      {open && (
        <div
          id={panelId}
          className="absolute inset-x-0 top-14 z-40 border-b border-line bg-bg px-4 py-4 shadow-sm"
        >
          <nav aria-label="Navigasi utama" className="flex flex-col gap-1">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="flex min-h-11 items-center text-sm font-medium tracking-[0.04em] text-ink"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </div>
  );
}
