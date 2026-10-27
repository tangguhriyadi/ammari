import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
import { LoadingAnnouncement } from "./LoadingAnnouncement";

/** One placeholder block. Decorative only (`aria-hidden`): the surrounding `LoadingRegion` is
 * what tells assistive tech that content is loading. The pulse stops under
 * `prefers-reduced-motion`, leaving a static block. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-neutral-200 motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export interface LoadingRegionProps {
  children: ReactNode;
  /** Screen-reader text; the skeleton blocks themselves are hidden from assistive tech. */
  label?: string;
  className?: string;
}

/** Wraps a page or section skeleton: one short "Memuat..." for screen readers instead of a pile of
 * empty boxes, and `aria-busy` on the skeleton itself. The status sits outside the busy subtree
 * so assistive tech does not hold back its announcement. */
export function LoadingRegion({ children, label = "Memuat...", className }: LoadingRegionProps) {
  return (
    <div data-slot="loading-region">
      <LoadingAnnouncement label={label} />
      <div aria-busy="true" className={className}>
        {children}
      </div>
    </div>
  );
}
