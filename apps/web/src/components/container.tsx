import type { ReactNode } from "react";
import { cn } from "@ammari/ui";

/** docs/design/storefront.md §3 "Spacing" — 16px page gutter on mobile, 40px on desktop,
 * container capped at 1440px. The one place that spacing lives, so every section agrees. */
export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-[1440px] px-4 lg:px-10", className)}>{children}</div>;
}
