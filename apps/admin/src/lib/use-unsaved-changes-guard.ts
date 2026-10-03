"use client";

import { useEffect, useId } from "react";

const DEFAULT_MESSAGE = "Ada perubahan yang belum disimpan. Tinggalkan halaman ini?";

// A MODULE-LEVEL registry, not one listener pair per call site — a page can have several
// independent things unsaved at once (e.g. staged photo uploads AND an edited variant price
// table), and without sharing, each would pop its own window.confirm for a single navigation
// attempt. Every active caller registers itself here; the one shared listener pair just checks
// whether the registry is non-empty.
const activeGuards = new Map<string, string>();
let listenersAttached = false;

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (activeGuards.size === 0) return;
  event.preventDefault();
}

// Next's App Router renders <Link> as a plain <a>, so intercepting anchor clicks at the
// document level catches in-app navigation (sidebar, breadcrumbs, etc.) without having to wrap
// every Link app-wide in a custom blocking component — see node_modules/next/dist/docs's
// "Blocking navigation" guide, which documents this same window.confirm pattern for its own
// supported per-Link `onNavigate` hook. Known gap: the browser back/forward buttons (popstate)
// aren't caught this way — Next's own docs don't offer a supported hook for that case either.
function handleClick(event: MouseEvent) {
  if (activeGuards.size === 0) return;
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = (event.target as HTMLElement).closest("a[href]");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  // A new tab or a file download doesn't discard this page's unsaved state — only a same-tab
  // navigation does.
  const target = anchor.getAttribute("target");
  if ((target && target !== "_self") || anchor.hasAttribute("download")) return;
  const message = activeGuards.values().next().value ?? DEFAULT_MESSAGE;
  if (!window.confirm(message)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function ensureListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener("beforeunload", handleBeforeUnload);
  document.addEventListener("click", handleClick, true);
}

/** Warns before the user navigates away (in-app Link clicks, reload, close tab) while `active`
 * is true. Shared across every call site on the page via the module-level registry above — see
 * its comment for why this isn't just a per-call-site effect. */
export function useUnsavedChangesGuard(active: boolean, message: string = DEFAULT_MESSAGE): void {
  const id = useId();

  useEffect(() => {
    if (!active) {
      activeGuards.delete(id);
      return;
    }
    ensureListeners();
    activeGuards.set(id, message);
    return () => {
      activeGuards.delete(id);
    };
  }, [active, id, message]);
}
