"use client";

import { useEffect, useRef } from "react";

/** Screen-reader text for `LoadingRegion`. A live region only announces text that changes after it
 * is in the DOM, so the node mounts empty and the label is written once it has mounted. Written
 * through the ref (not state) so it costs no re-render. A bare `aria-live` region, not
 * `role="status"`: the status role belongs to the app's toasts, and a skeleton still on screen
 * right after a save-and-redirect must not compete with the toast that reports it. */
export function LoadingAnnouncement({ label }: { label: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.textContent = label;
  }, [label]);
  return <span ref={ref} aria-live="polite" data-slot="loading-announcement" className="sr-only" />;
}
