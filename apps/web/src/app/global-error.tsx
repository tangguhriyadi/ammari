"use client";

import "./globals.css";
import { storefrontFontVariables } from "@/lib/fonts";
import { PrimaryButton } from "@/components/buttons";
import { StalePageNotice } from "@/components/stale-page-notice";
import { isStaleDeploymentError } from "@/lib/stale-deployment";

// An error in the root layout itself replaces the whole document (Next's global-error): never a
// blank page. Same stale-deployment handling as app/error.tsx.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="id" className={storefrontFontVariables}>
      <body className="bg-bg font-sans text-base text-ink">
        <title>Ammari</title>
        {isStaleDeploymentError(error) ? (
          <StalePageNotice />
        ) : (
          <div className="mx-auto flex max-w-md flex-col items-start gap-6 px-4 py-10">
            <h1 className="font-serif text-[30px] font-normal text-ink">Terjadi kesalahan</h1>
            <p className="text-sm text-ink-muted">Halaman ini tidak bisa dimuat sekarang. Coba lagi sebentar lagi.</p>
            <PrimaryButton onClick={() => retry()} className="w-full md:w-auto">
              Coba lagi
            </PrimaryButton>
          </div>
        )}
      </body>
    </html>
  );
}
