"use client";

import { type ReactNode, useState } from "react";
import { UserRound } from "lucide-react";
import { Sheet } from "./sheet";

// Receives `accountMenu` as an already-rendered slot rather than importing AccountMenu itself —
// AccountMenu has no hooks of its own and a Server Component ancestor can render it once and
// hand it down, so it never has to join this file's client bundle just because it's nested
// inside a Client Component's tree.
export function Topbar({ accountMenu }: { accountMenu: ReactNode }) {
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-4 pt-[env(safe-area-inset-top)] lg:hidden">
        <span className="font-serif text-xl font-light tracking-[0.2em] text-brand">AMMARI</span>
        <button
          type="button"
          aria-label="Akun"
          onClick={() => setAccountOpen(true)}
          className="flex size-11 items-center justify-center rounded-full text-neutral-700 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <UserRound aria-hidden="true" className="size-6" />
        </button>
      </header>
      <Sheet open={accountOpen} onOpenChange={setAccountOpen} title="Akun">
        {accountMenu}
      </Sheet>
    </>
  );
}
