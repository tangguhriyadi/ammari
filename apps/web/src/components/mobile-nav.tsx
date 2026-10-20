"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Curtain } from "./curtain";

const LINKS: { href: string; label: string }[] = [
  { href: "/#koleksi", label: "Koleksi" },
  { href: "/account", label: "Akun" },
  { href: "/terms-of-service", label: "Syarat & Ketentuan" },
  { href: "/privacy-policy", label: "Kebijakan Privasi" },
];

/** The mobile header's menu disclosure (docs/design/storefront.md §4 "Header" — "menu button
 * (left)"). There's no catalog/search page yet (Phase 3, separate work per docs/plans/
 * storefront-cms.md), so this links only to pages/anchors that actually exist today rather than
 * a dead search icon — see the session 7 implementation report for that scoping call.
 *
 * The panel unrolls from under the header and rolls back up (Curtain); every way of closing it
 * (toggle, a link, Escape, a route change) runs the same close animation. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on navigation (back/forward, or any link outside the menu). Adjusted during render
  // rather than in an effect, so the closing render is the same one that sees the new route.
  const pathname = usePathname();
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Tutup menu" : "Buka menu"}
        onClick={() => setOpen((value) => !value)}
        className="flex size-11 items-center justify-center text-ink"
      >
        {open ? <X className="size-5" strokeWidth={1.4} aria-hidden="true" /> : <Menu className="size-5" strokeWidth={1.4} aria-hidden="true" />}
      </button>
      <Curtain
        open={open}
        id={panelId}
        className="absolute inset-x-0 top-14 z-40 border-b border-line bg-bg shadow-sm"
        contentClassName="px-4 py-4"
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
      </Curtain>
    </div>
  );
}
