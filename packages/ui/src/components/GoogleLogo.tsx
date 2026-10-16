import { cn } from "../lib/cn";

/** The unaltered, full-colour Google "G" mark for a "Sign in with Google" button
 * (packages/ui/assets/google-logo.svg, copied into both apps' public/logos/google.svg at build
 * time by packages/ui/assets/copy-brand-logos.mjs — Next.js only serves static files from an
 * app's own public/, so the file can't be referenced directly from this package). Shared so
 * apps/web's and apps/admin's Google buttons render identically, per Google's sign-in branding
 * guidance (the logo itself is never recoloured/altered). `alt=""`: every call site places this
 * right next to a "Masuk dengan Google" label, which already carries the meaning. */
export function GoogleLogo({ className }: { className?: string }) {
  return <img src="/logos/google.svg" alt="" width={18} height={18} className={cn("size-[18px] shrink-0", className)} />;
}
