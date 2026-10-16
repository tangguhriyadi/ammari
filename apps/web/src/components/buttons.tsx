import type { ComponentProps } from "react";
import Link from "next/link";
import { cn } from "@ammari/ui";

// docs/design/storefront.md §3 "Buttons" — Jost 12px/500, letter-spacing 0.16-0.2em, uppercase,
// square corners, 52px tall (54px for "Bayar sekarang", not built this session). One place for
// the shared button shape so the hero CTA, PDP primary/secondary actions, and "LIHAT" links never
// drift from each other — deliberately NOT @ammari/ui's own `<Button>` (admin's dashboard shape:
// rounded-md, 44px, no letter-spacing) which doesn't match this spec at all.

const BASE = "inline-flex min-h-[52px] items-center justify-center gap-2 px-6 text-xs font-medium tracking-[0.18em] uppercase transition-colors duration-150";

export function PrimaryLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link {...props} className={cn(BASE, "bg-brand text-white hover:bg-ink", className)} />;
}

export function PrimaryButton({ className, disabled, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(BASE, "bg-brand text-white hover:bg-ink disabled:bg-disabled disabled:hover:bg-disabled", className)}
      {...props}
    />
  );
}

export function OutlineLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link {...props} className={cn(BASE, "border border-ink bg-bg text-ink hover:bg-surface", className)} />;
}
